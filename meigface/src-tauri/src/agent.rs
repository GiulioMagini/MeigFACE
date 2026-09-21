//! Local session-history persistence
//!
//! Owns the SQLite database that stores, per user (identified by the selected
//! parameter-profile name), one row per completed training session: its
//! eye-contact metrics and an LLM-generated topic summary. All access stays in
//! Rust, behind a Mutex-guarded connection in Tauri managed state, so no SQL is
//! ever exposed to the webview. The database is only touched when a profile is
//! selected; with no profile the application runs without any DB access.

use std::path::PathBuf;
use std::sync::Mutex;

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

/// Schema version written to `PRAGMA user_version`, bumped if the schema ever
/// changes so a future migration step can branch on it.
const SCHEMA_VERSION: i64 = 1;

/// Thread-safe handle to the SQLite connection, placed in Tauri managed state.
/// `Connection` is `Send` but not `Sync`, so the `Mutex` makes shared access
/// sound; sessions are written/read rarely and the queries are tiny, so the
/// brief lock contention is negligible.
pub struct Database {
    conn: Mutex<Connection>,
}

impl Database {
    /// Open (creating if missing) the session database under the app data
    /// directory, configure pragmas and initialise the schema. Called once
    /// from the Tauri setup hook.
    pub fn open(app: &AppHandle) -> Result<Self, String> {
        let path = db_path(app)?;
        let conn =
            Connection::open(&path).map_err(|e| format!("cannot open session database: {e}"))?;
        // WAL improves crash-safety and read/write concurrency; foreign_keys
        // must be ON for ON DELETE CASCADE to remove a profile's sessions;
        // synchronous=NORMAL is the recommended durability/speed trade-off
        // under WAL.
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA foreign_keys = ON;
             PRAGMA synchronous = NORMAL;",
        )
        .map_err(|e| format!("cannot configure session database: {e}"))?;
        init_schema(&conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }
}

/// Resolve the database file path (`<app data dir>/meigface.db`), creating the
/// parent directory if it does not exist yet.
fn db_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("cannot resolve app data directory: {e}"))?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("cannot create app data directory: {e}"))?;
    Ok(dir.join("meigface.db"))
}

/// Create the tables and index if absent and record the schema version.
/// Idempotent: safe to run on every launch.
fn init_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS profiles (
             name TEXT PRIMARY KEY
         );
         CREATE TABLE IF NOT EXISTS sessions (
             id           INTEGER PRIMARY KEY AUTOINCREMENT,
             profile_name TEXT NOT NULL REFERENCES profiles(name) ON DELETE CASCADE,
             started_at   TEXT NOT NULL,
             ended_at     TEXT NOT NULL,
             language     TEXT NOT NULL,
             duration_sec INTEGER NOT NULL,
             contact_pct  REAL NOT NULL,
             streak_sec   REAL NOT NULL,
             pauses       INTEGER NOT NULL,
             summary      TEXT NOT NULL DEFAULT ''
         );
         CREATE INDEX IF NOT EXISTS idx_sessions_profile_time
             ON sessions(profile_name, ended_at DESC);",
    )
    .map_err(|e| format!("cannot initialise session schema: {e}"))?;
    // user_version is a constant set by us (no user input), so formatting it
    // into the statement is safe and avoids the typed pragma_update API.
    conn.execute_batch(&format!("PRAGMA user_version = {SCHEMA_VERSION};"))
        .map_err(|e| format!("cannot set schema version: {e}"))?;
    Ok(())
}

/// Metrics of a single completed session, supplied by the frontend when the
/// session ends. Serialized with camelCase keys to match the frontend fields.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRecord {
    pub started_at: String,
    pub ended_at: String,
    pub language: String,
    pub duration_sec: u32,
    pub contact_pct: f64,
    pub streak_sec: f64,
    pub pauses: u32,
}

/// One stored session as returned to the frontend (history popup and the
/// startup context block). camelCase to match the frontend fields.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRow {
    pub id: i64,
    pub started_at: String,
    pub ended_at: String,
    pub language: String,
    pub duration_sec: u32,
    pub contact_pct: f64,
    pub streak_sec: f64,
    pub pauses: u32,
    pub summary: String,
}

/// Aggregate statistics over all of a profile's sessions, shown on the results
/// screen. camelCase to match the frontend fields.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileStats {
    pub count: u32,
    pub avg_contact_pct: f64,
    pub avg_streak_sec: f64,
    pub avg_pauses: f64,
}

/// Insert the profile row if it does not exist yet. Called when the user
/// creates/saves a parameter profile; a no-op on an existing name, so it is
/// also safe on overwrite (editing a profile keeps its sessions).
#[tauri::command]
pub fn agent_ensure_profile(db: State<'_, Database>, name: String) -> Result<(), String> {
    let conn = db
        .conn
        .lock()
        .map_err(|_| "session database lock poisoned".to_string())?;
    conn.execute(
        "INSERT OR IGNORE INTO profiles (name) VALUES (?1)",
        params![name],
    )
    .map_err(|e| format!("cannot ensure profile: {e}"))?;
    Ok(())
}

/// Delete a profile and, via ON DELETE CASCADE, all of its sessions. Called
/// when the user deletes a parameter profile.
#[tauri::command]
pub fn agent_delete_profile(db: State<'_, Database>, name: String) -> Result<(), String> {
    let conn = db
        .conn
        .lock()
        .map_err(|_| "session database lock poisoned".to_string())?;
    conn.execute("DELETE FROM profiles WHERE name = ?1", params![name])
        .map_err(|e| format!("cannot delete profile: {e}"))?;
    Ok(())
}

/// Record a completed session's metrics with an empty summary and return its
/// new id. Done first (no LLM needed) so metrics persist and averages update
/// even if the later summary generation fails or the LLM is stopped.
#[tauri::command]
pub fn agent_record_session(
    db: State<'_, Database>,
    name: String,
    session: SessionRecord,
) -> Result<i64, String> {
    let conn = db
        .conn
        .lock()
        .map_err(|_| "session database lock poisoned".to_string())?;
    // Self-heal: guarantee the parent row exists before inserting the child,
    // even if the profile was created before the database existed.
    conn.execute(
        "INSERT OR IGNORE INTO profiles (name) VALUES (?1)",
        params![name],
    )
    .map_err(|e| format!("cannot ensure profile: {e}"))?;
    conn.execute(
        "INSERT INTO sessions
             (profile_name, started_at, ended_at, language, duration_sec,
              contact_pct, streak_sec, pauses, summary)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, '')",
        params![
            name,
            session.started_at,
            session.ended_at,
            session.language,
            session.duration_sec,
            session.contact_pct,
            session.streak_sec,
            session.pauses
        ],
    )
    .map_err(|e| format!("cannot record session: {e}"))?;
    Ok(conn.last_insert_rowid())
}

/// Set the LLM-generated topic summary on a previously recorded session,
/// addressed by the id returned from `agent_record_session`.
#[tauri::command]
pub fn agent_set_session_summary(
    db: State<'_, Database>,
    id: i64,
    summary: String,
) -> Result<(), String> {
    let conn = db
        .conn
        .lock()
        .map_err(|_| "session database lock poisoned".to_string())?;
    conn.execute(
        "UPDATE sessions SET summary = ?1 WHERE id = ?2",
        params![summary, id],
    )
    .map_err(|e| format!("cannot update session summary: {e}"))?;
    Ok(())
}

/// Aggregate statistics over all of a profile's sessions. COALESCE keeps the
/// result numeric for an empty profile (AVG over zero rows is NULL), so it
/// reports zeros instead of failing to deserialize.
#[tauri::command]
pub fn agent_profile_stats(db: State<'_, Database>, name: String) -> Result<ProfileStats, String> {
    let conn = db
        .conn
        .lock()
        .map_err(|_| "session database lock poisoned".to_string())?;
    conn.query_row(
        "SELECT COUNT(*),
                COALESCE(AVG(contact_pct), 0.0),
                COALESCE(AVG(streak_sec), 0.0),
                COALESCE(AVG(pauses), 0.0)
         FROM sessions WHERE profile_name = ?1",
        params![name],
        |row| {
            Ok(ProfileStats {
                count: row.get::<_, i64>(0)? as u32,
                avg_contact_pct: row.get(1)?,
                avg_streak_sec: row.get(2)?,
                avg_pauses: row.get(3)?,
            })
        },
    )
    .map_err(|e| format!("cannot read profile stats: {e}"))
}

/// List a profile's sessions, newest first. `limit` caps the result (`Some(5)`
/// for the startup context block); `None` returns all of them (history popup).
#[tauri::command]
pub fn agent_list_sessions(
    db: State<'_, Database>,
    name: String,
    limit: Option<u32>,
) -> Result<Vec<SessionRow>, String> {
    let conn = db
        .conn
        .lock()
        .map_err(|_| "session database lock poisoned".to_string())?;
    // SQLite treats LIMIT -1 as "no limit", so None maps to -1.
    let lim: i64 = limit.map(|n| n as i64).unwrap_or(-1);
    let mut stmt = conn
        .prepare(
            "SELECT id, started_at, ended_at, language, duration_sec,
                    contact_pct, streak_sec, pauses, summary
             FROM sessions WHERE profile_name = ?1
             ORDER BY ended_at DESC, id DESC
             LIMIT ?2",
        )
        .map_err(|e| format!("cannot prepare session query: {e}"))?;
    let rows = stmt
        .query_map(params![name, lim], |row| {
            Ok(SessionRow {
                id: row.get(0)?,
                started_at: row.get(1)?,
                ended_at: row.get(2)?,
                language: row.get(3)?,
                duration_sec: row.get::<_, i64>(4)? as u32,
                contact_pct: row.get(5)?,
                streak_sec: row.get(6)?,
                pauses: row.get::<_, i64>(7)? as u32,
                summary: row.get(8)?,
            })
        })
        .map_err(|e| format!("cannot read sessions: {e}"))?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| format!("cannot read session rows: {e}"))?;
    Ok(rows)
}

/// Delete a single session, addressed by the same id used by
/// `agent_set_session_summary`. Complements `agent_delete_sessions` (which
/// prunes by age): here the user removes one specific run that is not
/// representative - an aborted session, or one spoiled by a tracking or engine
/// problem - so it stops polluting the averages and the topic summaries fed
/// back to the model. Deleting an id that no longer exists is reported as an
/// error rather than silently succeeding, so a stale list in the UI surfaces as
/// a visible message instead of a row that appears to survive the delete.
#[tauri::command]
pub fn agent_delete_session(db: State<'_, Database>, id: i64) -> Result<(), String> {
    let conn = db
        .conn
        .lock()
        .map_err(|_| "session database lock poisoned".to_string())?;
    let removed = conn
        .execute("DELETE FROM sessions WHERE id = ?1", params![id])
        .map_err(|e| format!("cannot delete session: {e}"))?;
    if removed == 0 {
        return Err(format!("session {id} not found"));
    }
    Ok(())
}

/// Prune a profile's sessions: `Some(n)` deletes the n oldest, `None` deletes
/// them all. Lets the user keep the history from growing or from holding data
/// no longer representative of their current progress.
#[tauri::command]
pub fn agent_delete_sessions(
    db: State<'_, Database>,
    name: String,
    older_count: Option<u32>,
) -> Result<(), String> {
    let conn = db
        .conn
        .lock()
        .map_err(|_| "session database lock poisoned".to_string())?;
    match older_count {
        Some(n) => {
            conn.execute(
                "DELETE FROM sessions
                 WHERE id IN (
                     SELECT id FROM sessions WHERE profile_name = ?1
                     ORDER BY ended_at ASC, id ASC
                     LIMIT ?2
                 )",
                params![name, n as i64],
            )
            .map_err(|e| format!("cannot delete oldest sessions: {e}"))?;
        }
        None => {
            conn.execute("DELETE FROM sessions WHERE profile_name = ?1", params![name])
                .map_err(|e| format!("cannot delete sessions: {e}"))?;
        }
    }
    Ok(())
}
