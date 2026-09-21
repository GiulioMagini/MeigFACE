//! Frontend/backend command bridge.
//!
//! Tauri commands the Svelte frontend invokes to control the local inference
//! engines: the LLM (llama-server) and speech-to-text (whisper-server). Both
//! run as HTTP-server sidecars managed by [`crate::sidecar`]; this layer
//! validates the user-selected paths, builds each server's arguments and
//! reports status. Executables and models are referenced by absolute paths
//! the user selected, so the user points at files they know the location of.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use serde::{Serialize, Deserialize};
use tauri::ipc::Response;
use tauri::{AppHandle, Manager, State};

use crate::sidecar::{ChatMessage, Engines, HttpSidecar, Readiness, SidecarParams};

/// Loopback port for the LLM server.
const LLM_PORT: u16 = 8080;
/// Loopback port for the speech-to-text server (distinct from the LLM's).
const STT_PORT: u16 = 8081;
/// Context window (in tokens) passed to llama-server.
const LLM_CTX_SIZE: u32 = 4096;

/// Status of one engine, serialised back to the frontend.
#[derive(Debug, Serialize)]
pub struct EngineStatus {
    /// Whether the server is currently running.
    pub running: bool,
    /// Base URL of the running server, or `null` when not running.
    pub base_url: Option<String>,
}

impl EngineStatus {
    fn from_sidecar(sidecar: &HttpSidecar) -> Self {
        Self {
            running: sidecar.is_running(),
            base_url: sidecar.base_url(),
        }
    }
}

/// Return an error if `path` is not an existing file.
fn require_file(path: &Path, what: &str) -> Result<(), String> {
    if path.is_file() {
        Ok(())
    } else {
        Err(format!("{what} not found: {}", path.display()))
    }
}

/// Start the LLM (llama-server) with the selected executable and GGUF model.
/// `n_gpu_layers` controls GPU offloading (omitted or 0 = CPU only).
#[tauri::command]
pub async fn llm_start(
    engines: State<'_, Engines>,
    server_path: String,
    model_path: String,
    n_gpu_layers: Option<u32>,
) -> Result<EngineStatus, String> {
    let model = PathBuf::from(&model_path);
    let is_gguf = model
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("gguf"))
        .unwrap_or(false);
    if !is_gguf {
        return Err("the selected model file must be a .gguf".to_string());
    }
    require_file(&model, "model file")?;

    let args: Vec<OsString> = vec![
        "--model".into(),
        model.into(),
        "--ctx-size".into(),
        LLM_CTX_SIZE.to_string().into(),
        "--n-gpu-layers".into(),
        n_gpu_layers.unwrap_or(0).to_string().into(),
        // Use the model's embedded chat template; required for correct Qwen
        // formatting and for `chat_template_kwargs` (thinking toggle) to apply.
        "--jinja".into(),
    ];
    let params = SidecarParams {
        executable: PathBuf::from(server_path),
        args,
        port: LLM_PORT,
        readiness: Readiness {
            path: "/health",
            require_success: true,
        },
    };

    engines.llm.start(params).await.map_err(|e| e.to_string())?;
    Ok(EngineStatus::from_sidecar(&engines.llm))
}

/// Start the speech-to-text engine (whisper-server) with the selected
/// executable and ggml model.
#[tauri::command]
pub async fn stt_start(
    engines: State<'_, Engines>,
    server_path: String,
    model_path: String,
    gpu_device: Option<u32>,
) -> Result<EngineStatus, String> {
    let model = PathBuf::from(&model_path);
    require_file(&model, "whisper model file")?;

    let mut args: Vec<OsString> = vec!["--model".into(), model.into()];
    // Explicit device index, mirroring llm_start's --n-gpu-layers: on
    // multi-GPU systems whisper-server's own default pick (device 0) is not
    // guaranteed to be the discrete GPU — see -dev in its --help output.
    if let Some(dev) = gpu_device {
        args.push("-dev".into());
        args.push(dev.to_string().into());
    }
    let params = SidecarParams {
        executable: PathBuf::from(server_path),
        args,
        port: STT_PORT,
        // whisper-server has no /health and binds only after loading the
        // model, so any HTTP response from the root means it is ready.
        readiness: Readiness {
            path: "/",
            require_success: false,
        },
    };

    engines.stt.start(params).await.map_err(|e| e.to_string())?;
    Ok(EngineStatus::from_sidecar(&engines.stt))
}

/// Stop the LLM server. No-op if it is not running.
#[tauri::command]
pub fn llm_stop(engines: State<'_, Engines>) -> Result<(), String> {
    engines.llm.stop().map_err(|e| e.to_string())
}

/// Stop the speech-to-text server. No-op if it is not running.
#[tauri::command]
pub fn stt_stop(engines: State<'_, Engines>) -> Result<(), String> {
    engines.stt.stop().map_err(|e| e.to_string())
}

/// Return the current status of the LLM server.
#[tauri::command]
pub fn llm_status(engines: State<'_, Engines>) -> EngineStatus {
    EngineStatus::from_sidecar(&engines.llm)
}

/// Return the current status of the speech-to-text server.
#[tauri::command]
pub fn stt_status(engines: State<'_, Engines>) -> EngineStatus {
    EngineStatus::from_sidecar(&engines.stt)
}

/// Probe the selected llama-server build and suggest a `--n-gpu-layers`
/// value: 0 when no usable GPU is found, otherwise a value that offloads all
/// layers. Used by the frontend to pre-fill the GPU-layers field.
#[tauri::command]
pub async fn llm_suggest_gpu_layers(server_path: String) -> Result<u32, String> {
    crate::sidecar::suggest_gpu_layers(Path::new(&server_path))
        .await
        .map_err(|e| e.to_string())
}

/// Synthesize `text` with Piper and return the audio as WAV bytes. The voice is
/// chosen from the bundled voices by `language` and `gender`; `voice` optionally
/// picks a specific `.onnx` file name (otherwise the first one is used).
/// `speed` is the relative speaking-rate multiplier from session setup; omitted
/// means the voice's own tuned rate. The bytes arrive in the frontend as an
/// ArrayBuffer for playback.
#[tauri::command]
pub async fn tts_synthesize(
    app: AppHandle,
    piper_path: String,
    language: String,
    gender: String,
    text: String,
    voice: Option<String>,
    speed: Option<f32>,
) -> Result<Response, String> {
    let piper = PathBuf::from(&piper_path);
    require_file(&piper, "piper executable")?;
    let voice_path = resolve_voice(&app, &language, &gender, voice.as_deref())?;
    let wav = crate::sidecar::synthesize_speech(&piper, &voice_path, &text, speed.unwrap_or(1.0))
        .await
        .map_err(|e| e.to_string())?;
    Ok(Response::new(wav))
}

/// Locate the bundled `voices/` directory.
///
/// In a packaged build the folder is shipped under the resource directory; in
/// development the bundler usually does not copy it, so fall back to the
/// project-root `voices/` relative to the working directory (`src-tauri/`
/// while `tauri dev` runs).
fn voices_base(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    if let Ok(resources) = app.path().resource_dir() {
        let bundled = resources.join("voices");
        if bundled.is_dir() {
            return Ok(bundled);
        }
    }
    #[cfg(debug_assertions)]
    if let Ok(cwd) = std::env::current_dir() {
        let dev = cwd.join("..").join("voices");
        if dev.is_dir() {
            return Ok(dev);
        }
    }
    Err("voices directory not found".to_string())
}

/// Resolve the voices directory *path* (whether or not it currently exists),
/// so it can be recreated if the user deleted it. Uses the existing folder when
/// present, otherwise the canonical location for this build: the project root
/// in dev, next to the bundled resources in release.
fn voices_root(app: &AppHandle) -> Result<PathBuf, String> {
    if let Ok(existing) = voices_base(app) {
        return Ok(existing);
    }
    #[cfg(debug_assertions)]
    if let Ok(cwd) = std::env::current_dir() {
        return Ok(cwd.join("..").join("voices"));
    }
    app.path()
        .resource_dir()
        .map(|r| r.join("voices"))
        .map_err(|e| format!("cannot resolve voices directory: {e}"))
}

/// Ensure the base voices layout exists: voices/{it,en,fr,de,es,pt}/{male,female}. Recreates
/// it if the user deleted the folder, so recalibration always has folders to
/// look in (empty = "no voices" until voices are added). Does not restore
/// deleted voice files.
pub fn ensure_base_voices(app: &AppHandle) -> Result<(), String> {
    let root = voices_root(app)?;
    for language in ["it", "en", "fr", "de", "es", "pt"] {
        for gender in ["male", "female"] {
            std::fs::create_dir_all(root.join(language).join(gender))
                .map_err(|e| format!("cannot create voice directory: {e}"))?;
        }
    }
    Ok(())
}

/// Name of the English reference dictionary written into the i18n folder. The
/// name makes clear it is not loaded by the app, only a base for translating
/// into a new language. Skipped by list_custom_locales.
const LOCALE_REFERENCE_FILE: &str = "en - for translation.json";

/// Resolve the on-disk "i18n" folder next to the voices directory (same place
/// as the app), creating it if missing so users can drop custom locale files.
fn i18n_base(app: &AppHandle) -> Result<PathBuf, String> {
    let base = voices_root(app)?
        .parent()
        .ok_or_else(|| "cannot resolve i18n directory".to_string())?
        .join("i18n");
    std::fs::create_dir_all(&base)
        .map_err(|e| format!("cannot create i18n directory: {e}"))?;
    Ok(base)
}

/// Validate a locale code so it can safely be used as a file/folder name.
/// Rejects path separators and dots (a code is a bare tag like "fr" or "pt-BR").
fn sanitize_locale_code(code: &str) -> Result<String, String> {
    let trimmed = code.trim();
    if trimmed.is_empty() {
        return Err("locale code is empty".to_string());
    }
    const FORBIDDEN: &[char] = &['/', '\\', ':', '*', '?', '"', '<', '>', '|', '\0', '.'];
    if trimmed.contains(FORBIDDEN) {
        return Err(format!("invalid locale code: {code}"));
    }
    Ok(trimmed.to_string())
}

/// A custom locale file found in the i18n folder: its code (file stem) and raw
/// JSON content. The frontend validates the structure against English.
#[derive(Serialize)]
pub struct CustomLocale {
    code: String,
    content: String,
}

/// List user-provided locale files in the i18n folder (creating the folder if
/// missing), excluding the built-in `en`/`it` references. Returns each file's
/// code and raw content for the frontend to validate and register.
#[tauri::command]
pub fn list_custom_locales(app: AppHandle) -> Result<Vec<CustomLocale>, String> {
    let dir = i18n_base(&app)?;
    let mut out = Vec::new();
    let entries =
        std::fs::read_dir(&dir).map_err(|e| format!("cannot read i18n directory: {e}"))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        // Skip the English reference template (a base for translations, not a
        // loadable locale).
        if path.file_name().and_then(|n| n.to_str()) == Some(LOCALE_REFERENCE_FILE) {
            continue;
        }
        let stem = match path.file_stem().and_then(|s| s.to_str()) {
            Some(s) => s.to_string(),
            None => continue,
        };
        // Built-in dictionaries are shipped as references only, not loaded here.
        if stem == "en" || stem == "it" {
            continue;
        }
        if sanitize_locale_code(&stem).is_err() {
            continue;
        }
        match std::fs::read_to_string(&path) {
            Ok(content) => out.push(CustomLocale { code: stem, content }),
            Err(e) => eprintln!("[meigface] cannot read locale {stem}: {e}"),
        }
    }
    Ok(out)
}

/// Create `voices/<code>/male` and `voices/<code>/female` for a custom locale,
/// so the user has folders to drop matching Piper voices into.
#[tauri::command]
pub fn ensure_voice_dirs(app: AppHandle, code: String) -> Result<(), String> {
    let code = sanitize_locale_code(&code)?;
    let base = voices_root(&app)?.join(&code);
    for gender in ["male", "female"] {
        std::fs::create_dir_all(base.join(gender))
            .map_err(|e| format!("cannot create voice directory: {e}"))?;
    }
    Ok(())
}

/// Write a reference dictionary (`i18n/<code>.json`) only if it does not exist,
/// so users can base custom translations on it without clobbering their edits.
#[tauri::command]
pub fn ensure_locale_reference(app: AppHandle, content: String) -> Result<(), String> {
    let path = i18n_base(&app)?.join(LOCALE_REFERENCE_FILE);
    // Write the reference only if absent, so user edits are never overwritten.
    if path.exists() {
        return Ok(());
    }
    std::fs::write(&path, content).map_err(|e| format!("cannot write locale reference: {e}"))?;
    Ok(())
}

/// Resolve and validate the directory for a language/gender pair, e.g.
/// `voices/it/female`. Gender is mathced against a fixed
/// allowlist, so they can never be used to escape the voices directory.
fn voices_dir(app: &AppHandle, language: &str, gender: &str) -> Result<PathBuf, String> {
    // Any locale code is allowed (built-in or user-added); sanitize it so it is
    // safe as a folder name (no path traversal), then look it up under the
    // voices directory. Custom languages resolve here exactly like it/en.
    let language = sanitize_locale_code(language)?;
    let gender = match gender {
        "male" | "female" => gender,
        other => return Err(format!("unsupported gender: {other}")),
    };
    Ok(voices_base(app)?.join(&language).join(gender))
}

/// List the available Piper voices (the `.onnx` file names) for a language and
/// gender, sorted. Returns an empty list if the folder has none or is missing.
#[tauri::command]
pub fn list_voices(
    app: AppHandle,
    language: String,
    gender: String,
) -> Result<Vec<String>, String> {
    let dir = voices_dir(&app, &language, &gender)?;
    let entries = match std::fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(_) => return Ok(Vec::new()), // no folder yet = no voices
    };
    let mut voices: Vec<String> = entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) == Some("onnx") {
                path.file_name().and_then(|n| n.to_str()).map(String::from)
            } else {
                None
            }
        })
        .collect();
    voices.sort();
    Ok(voices)
}

/// Resolve the Piper voice `.onnx` for a language/gender. With `voice`, the
/// named file is used (validated to be a bare `.onnx` file name inside the
/// folder); without it, the first voice found is used.
fn resolve_voice(
    app: &AppHandle,
    language: &str,
    gender: &str,
    voice: Option<&str>,
) -> Result<PathBuf, String> {
    let dir = voices_dir(app, language, gender)?;

    if let Some(name) = voice {
        // Accept only a bare file name ending in .onnx (no path segments), so
        // the selection cannot point outside the voices directory.
        let is_bare = Path::new(name).file_name().and_then(|n| n.to_str()) == Some(name);
        if !is_bare || !name.ends_with(".onnx") {
            return Err(format!("invalid voice name: {name}"));
        }
        let path = dir.join(name);
        return if path.is_file() {
            Ok(path)
        } else {
            Err(format!("voice not found: {}", path.display()))
        };
    }

    let entries = std::fs::read_dir(&dir)
        .map_err(|e| format!("cannot read voices in {}: {e}", dir.display()))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) == Some("onnx") {
            return Ok(path);
        }
    }
    Err(format!("no .onnx voice found in {}", dir.display()))
}

/// Send a chat conversation to the running LLM and return the assistant's
/// reply. `messages` is the full conversation (system prompt, history, latest
/// user turn) built by the caller; `temperature` and `max_tokens` are optional
/// overrides.
#[tauri::command]
pub async fn llm_chat(
    engines: State<'_, Engines>,
    messages: Vec<ChatMessage>,
    temperature: Option<f32>,
    max_tokens: Option<u32>,
) -> Result<String, String> {
    let base_url = engines
        .llm
        .base_url()
        .ok_or_else(|| "the LLM is not running".to_string())?;
    crate::sidecar::chat_completion(&base_url, &messages, temperature, max_tokens)
        .await
        .map_err(|e| e.to_string())
}

/// Resolve the writable prompts directory (`<app config>/prompts`), creating
/// it if needed. This sits alongside the store's `settings.json`, so saved
/// prompts live in the same per-user, writable location on every platform —
/// unlike the bundled (read-only) resource dir.
fn prompts_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("cannot resolve app config directory: {e}"))?;
    let dir = base.join("prompts");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("cannot create prompts directory: {e}"))?;
    Ok(dir)
}

/// Validate a user-supplied prompt name and turn it into its `.txt` file name.
///
/// Rejects empty names, path separators and characters illegal in file names
/// (which also blocks traversal like `..` or absolute paths), so the name can
/// never escape the prompts directory.
fn sanitize_prompt_name(name: &str) -> Result<String, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("prompt name is empty".to_string());
    }
    const FORBIDDEN: &[char] = &['/', '\\', ':', '*', '?', '"', '<', '>', '|', '\0'];
    if trimmed.contains(FORBIDDEN) || trimmed == "." || trimmed == ".." {
        return Err(format!("invalid prompt name: {name}"));
    }
    let file = format!("{trimmed}.txt");
    // Defensive: the file name must stay a bare name with no path component.
    if Path::new(&file).file_name().and_then(|n| n.to_str()) != Some(file.as_str()) {
        return Err(format!("invalid prompt name: {name}"));
    }
    Ok(file)
}

/// List the saved prompt names (the `.txt` files in the prompts directory,
/// without their extension), sorted. Returns an empty list if there are none.
#[tauri::command]
pub fn list_prompts(app: AppHandle) -> Result<Vec<String>, String> {
    let dir = prompts_dir(&app)?;
    let entries = match std::fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(_) => return Ok(Vec::new()), // no folder yet = no prompts
    };
    let mut names: Vec<String> = entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) == Some("txt") {
                path.file_stem().and_then(|n| n.to_str()).map(String::from)
            } else {
                None
            }
        })
        .collect();
    names.sort();
    Ok(names)
}

/// Read the saved prompt `name` and return its text content.
#[tauri::command]
pub fn read_prompt(app: AppHandle, name: String) -> Result<String, String> {
    let dir = prompts_dir(&app)?;
    let file = sanitize_prompt_name(&name)?;
    std::fs::read_to_string(dir.join(&file))
        .map_err(|e| format!("cannot read prompt {name}: {e}"))
}

/// Save `content` as the prompt `name` (`<name>.txt`), overwriting any existing
/// prompt with the same name.
#[tauri::command]
pub fn save_prompt(app: AppHandle, name: String, content: String) -> Result<(), String> {
    let dir = prompts_dir(&app)?;
    let file = sanitize_prompt_name(&name)?;
    std::fs::write(dir.join(&file), content)
        .map_err(|e| format!("cannot save prompt {name}: {e}"))
}

/// Delete the saved prompt `name` (`<name>.txt`). Deleting a prompt that does
/// not exist is treated as success, so a stale selection never surfaces an
/// error to the user.
#[tauri::command]
pub fn delete_prompt(app: AppHandle, name: String) -> Result<(), String> {
    let dir = prompts_dir(&app)?;
    let file = sanitize_prompt_name(&name)?;
    match std::fs::remove_file(dir.join(&file)) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("cannot delete prompt {name}: {e}")),
    }
}

/// A named pair of listening-timing parameters, saved as a profile so the
/// settings can be switched per person (e.g. a therapist with several
/// children, or several family members). `silence_sec` is the pause before
/// the avatar replies; `max_listen_sec` caps a single utterance. Serialized
/// with camelCase keys to match the frontend's field names.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParamProfile {
    pub silence_sec: f64,
    pub max_listen_sec: u32,
}

/// Resolve the writable parameter-profiles directory (`<app config>/params`),
/// creating it if needed. Mirrors `prompts_dir`: profiles live in the same
/// per-user, writable config location, but in their own subfolder so the
/// `.json` profiles never mix with the prompts' `.txt` files.
fn params_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("cannot resolve app config directory: {e}"))?;
    let dir = base.join("params");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("cannot create params directory: {e}"))?;
    Ok(dir)
}

/// Validate a user-supplied profile name and turn it into its `.json` file
/// name. Same rules as `sanitize_prompt_name` (rejects empty names, path
/// separators and characters illegal in file names, blocking traversal), kept
/// separate to leave the prompt path untouched.
fn sanitize_profile_name(name: &str) -> Result<String, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("profile name is empty".to_string());
    }
    const FORBIDDEN: &[char] = &['/', '\\', ':', '*', '?', '"', '<', '>', '|', '\0'];
    if trimmed.contains(FORBIDDEN) || trimmed == "." || trimmed == ".." {
        return Err(format!("invalid profile name: {name}"));
    }
    let file = format!("{trimmed}.json");
    // Defensive: the file name must stay a bare name with no path component.
    if Path::new(&file).file_name().and_then(|n| n.to_str()) != Some(file.as_str()) {
        return Err(format!("invalid profile name: {name}"));
    }
    Ok(file)
}

/// List the saved parameter-profile names (the `.json` files in the params
/// directory, without their extension), sorted. Empty list if there are none.
#[tauri::command]
pub fn list_param_profiles(app: AppHandle) -> Result<Vec<String>, String> {
    let dir = params_dir(&app)?;
    let entries = match std::fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(_) => return Ok(Vec::new()), // no folder yet = no profiles
    };
    let mut names: Vec<String> = entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) == Some("json") {
                path.file_stem().and_then(|n| n.to_str()).map(String::from)
            } else {
                None
            }
        })
        .collect();
    names.sort();
    Ok(names)
}

/// Read the saved parameter profile `name` and return its timing values.
#[tauri::command]
pub fn read_param_profile(app: AppHandle, name: String) -> Result<ParamProfile, String> {
    let dir = params_dir(&app)?;
    let file = sanitize_profile_name(&name)?;
    let raw = std::fs::read_to_string(dir.join(&file))
        .map_err(|e| format!("cannot read profile {name}: {e}"))?;
    serde_json::from_str(&raw).map_err(|e| format!("invalid profile {name}: {e}"))
}

/// Save `profile` under `name` (`<name>.json`), overwriting any existing
/// profile with the same name.
#[tauri::command]
pub fn save_param_profile(
    app: AppHandle,
    name: String,
    profile: ParamProfile,
) -> Result<(), String> {
    let dir = params_dir(&app)?;
    let file = sanitize_profile_name(&name)?;
    let json = serde_json::to_string_pretty(&profile)
        .map_err(|e| format!("cannot serialize profile {name}: {e}"))?;
    std::fs::write(dir.join(&file), json).map_err(|e| format!("cannot save profile {name}: {e}"))
}

/// Delete the saved parameter profile `name` (`<name>.json`). Deleting a
/// profile that does not exist is treated as success, so a stale selection
/// never surfaces an error to the user.
#[tauri::command]
pub fn delete_param_profile(app: AppHandle, name: String) -> Result<(), String> {
    let dir = params_dir(&app)?;
    let file = sanitize_profile_name(&name)?;
    match std::fs::remove_file(dir.join(&file)) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("cannot delete profile {name}: {e}")),
    }
}