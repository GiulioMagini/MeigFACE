<script lang="ts">
  // Large popup that shows a profile's full session history as a scrollable
  // list of cards (date, language, eye-contact metrics, topic summary), lets
  // the user edit each topic summary in place (small LLMs can produce poor
  // summaries), delete a single session that is not representative, and trim
  // the history (delete the oldest 5/10, or all). It loads the sessions itself
  // from the database and reloads after any deletion, calling `onChanged` so
  // the parent can refresh any derived view (e.g. the averages).

  import { onMount } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import { t } from "$lib/i18n";
  import ConfirmDialog from "$lib/components/ConfirmDialog.svelte";

  interface Props {
    /** Param-profile name whose sessions are shown. */
    profileName: string;
    /** Close the popup. */
    onClose: () => void;
    /** Called after a successful prune, so the parent can refresh stats. */
    onChanged?: () => void;
  }

  let { profileName, onClose, onChanged }: Props = $props();

  // One stored session as returned by the backend (camelCase mirrors the Rust
  // SessionRow struct).
  interface SessionRow {
    id: number;
    endedAt: string;
    language: string;
    durationSec: number;
    contactPct: number;
    streakSec: number;
    pauses: number;
    summary: string;
  }

  let sessions = $state<SessionRow[]>([]);
  let loaded = $state(false); // false until the first load resolves
  let error = $state<string | null>(null);
  let pruneChoice = $state(""); // "", "oldest5", "oldest10" or "all"
  let confirmOpen = $state(false); // prune-confirmation dialog visibility
  // Inline summary editing: id of the session being edited (null = none) and
  // the editor's working text. Only one card can be edited at a time.
  let editingId = $state<number | null>(null);
  let editText = $state("");
  // Per-session deletion: id of the session awaiting confirmation (null = no
  // pending request). Doubles as the delete dialog's visibility flag.
  let deleteTargetId = $state<number | null>(null);

  // Unique ids so aria targets never collide with other dialog instances.
  const uid = Math.random().toString(36).slice(2);
  let closeBtn = $state<HTMLButtonElement | null>(null);

  // Localized label of the currently selected prune action, used in the
  // confirmation message.
  const actionLabel = $derived(
    pruneChoice === "oldest5"
      ? $t("session.pruneOldest5")
      : pruneChoice === "oldest10"
        ? $t("session.pruneOldest10")
        : pruneChoice === "all"
          ? $t("session.pruneAll")
          : "",
  );

  // Load (or reload) this profile's sessions, newest first.
  async function loadSessions(): Promise<void> {
    error = null;
    try {
      sessions = await invoke<SessionRow[]>("agent_list_sessions", {
        name: profileName,
        limit: null, // null = all sessions
      });
    } catch (e) {
      error = String(e);
      sessions = [];
    } finally {
      loaded = true;
    }
  }

  onMount(loadSessions);

  // Focus the close button on open and let Escape dismiss the popup, except
  // while a nested confirm dialog is open (each handles its own Escape).
  $effect(() => {
    closeBtn?.focus();
    const onKey = (e: KeyboardEvent) => {
      // While a summary is being edited, Escape cancels the edit instead of
      // closing the whole popup, so an open editor is never lost by accident.
      if (e.key === "Escape" && !confirmOpen && deleteTargetId === null) {
        if (editingId !== null) cancelEdit();
        else onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // Run the confirmed prune, then reload and notify the parent.
  async function confirmPrune(): Promise<void> {
    confirmOpen = false;
    const olderCount =
      pruneChoice === "oldest5" ? 5 : pruneChoice === "oldest10" ? 10 : null;
    error = null;
    try {
      await invoke("agent_delete_sessions", { name: profileName, olderCount });
      pruneChoice = "";
      await loadSessions();
      onChanged?.();
    } catch (e) {
      error = String(e);
    }
  }

  /** Open the inline editor for a session's summary. */
  function startEdit(s: SessionRow): void {
    editingId = s.id;
    editText = s.summary;
  }

  /** Close the inline editor without saving. */
  function cancelEdit(): void {
    editingId = null;
    editText = "";
  }

  /** Ask for confirmation before removing one session from the history. */
  function requestDeleteSession(s: SessionRow): void {
    deleteTargetId = s.id;
  }

  // Delete the confirmed session, then reload the list and notify the parent:
  // removing a run changes the historic averages, so the derived views must be
  // refreshed exactly as they are after a prune.
  async function confirmDeleteSession(): Promise<void> {
    const id = deleteTargetId;
    deleteTargetId = null;
    if (id === null) return;
    error = null;
    try {
      await invoke("agent_delete_session", { id });
      // Drop the inline editor if it was open on the row just removed.
      if (editingId === id) cancelEdit();
      await loadSessions();
      onChanged?.();
    } catch (e) {
      error = String(e);
    }
  }

  // Persist the edited summary via the existing backend command, then patch
  // the local list so the card reflects the change without a full reload.
  async function saveEdit(): Promise<void> {
    if (editingId === null) return;
    const id = editingId;
    const summary = editText.trim();
    error = null;
    try {
      await invoke("agent_set_session_summary", { id, summary });
      sessions = sessions.map((s) => (s.id === id ? { ...s, summary } : s));
      cancelEdit();
    } catch (e) {
      error = String(e);
    }
  }

  // Format seconds as m:ss for streak and duration.
  function formatTime(totalSec: number): string {
    const s = Math.max(0, Math.floor(totalSec));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  }

  // Format an ISO-8601 timestamp in the session's own language.
  function formatDate(iso: string, lang: string): string {
    const tag = lang === "it" ? "it-IT" : "en-US";
    return new Date(iso).toLocaleString(tag, {
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }
</script>

<div class="overlay">
  <!-- Native button as backdrop: clickable and keyboard-accessible. -->
  <button
    type="button"
    class="backdrop"
    aria-label={$t("session.resultsClose")}
    onclick={onClose}
  ></button>

  <div
    class="dialog"
    role="dialog"
    aria-modal="true"
    aria-labelledby="sh-title-{uid}"
  >
    <h2 id="sh-title-{uid}">{$t("session.historyTitle")}</h2>
    <p class="profile">{$t("session.historyProfile", { name: profileName })}</p>

    {#if error}
      <p class="error">{error}</p>
    {/if}

    {#if loaded && sessions.length === 0}
      <p class="empty">{$t("session.historyEmpty")}</p>
    {/if}

    {#if sessions.length > 0}
      <ul class="list">
        {#each sessions as s (s.id)}
          <li class="card">
            <div class="card-head">
              <span class="date">{formatDate(s.endedAt, s.language)}</span>
              <span class="lang">{s.language.toUpperCase()}</span>
            </div>
            <div class="metrics">
              <span class="chip"
                >{$t("session.scoreContact")}: {Math.round(
                  s.contactPct * 100,
                )}%</span
              >
              <span class="chip"
                >{$t("session.scoreStreak")}: {formatTime(s.streakSec)}</span
              >
              <span class="chip">{$t("session.scorePauses")}: {s.pauses}</span>
              <span class="chip"
                >{$t("session.resultsDuration")}: {formatTime(
                  s.durationSec,
                )}</span
              >
            </div>
            {#if editingId === s.id}
              <!-- Inline editor for the topic summary: small LLMs sometimes
                   produce poor summaries, so the user can fix the text that
                   later feeds the next session's system prompt. -->
              <div class="summary-edit">
                <textarea class="summary-input" rows="3" bind:value={editText}
                ></textarea>
                <div class="summary-actions">
                  <button type="button" class="save" onclick={saveEdit}>
                    {$t("session.historySaveSummary")}
                  </button>
                  <button type="button" class="cancel" onclick={cancelEdit}>
                    {$t("session.historyCancelEdit")}
                  </button>
                </div>
              </div>
            {:else}
              <p class="topics">
                <span class="topics-label">{$t("session.historyTopics")}:</span>
                {s.summary.trim() !== ""
                  ? s.summary
                  : $t("session.historyNoSummary")}
                <button type="button" class="edit" onclick={() => startEdit(s)}>
                  {$t("session.historyEditSummary")}
                </button>
                <button
                  type="button"
                  class="delete"
                  onclick={() => requestDeleteSession(s)}
                >
                  {$t("session.historyDeleteSession")}
                </button>
              </p>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}

    <div class="footer">
      {#if sessions.length > 0}
        <div class="prune">
          <label class="prune-label" for="prune-{uid}"
            >{$t("session.pruneLabel")}</label
          >
          <select id="prune-{uid}" bind:value={pruneChoice}>
            <option value="">{$t("session.prunePlaceholder")}</option>
            <option value="oldest5">{$t("session.pruneOldest5")}</option>
            <option value="oldest10">{$t("session.pruneOldest10")}</option>
            <option value="all">{$t("session.pruneAll")}</option>
          </select>
          <button
            type="button"
            class="apply"
            disabled={pruneChoice === ""}
            onclick={() => (confirmOpen = true)}
          >
            {$t("session.pruneApply")}
          </button>
        </div>
      {/if}
      <button
        type="button"
        class="close-btn"
        bind:this={closeBtn}
        onclick={onClose}
      >
        {$t("session.resultsClose")}
      </button>
    </div>
  </div>
</div>

<!-- Destructive confirmation for removing a single session. -->
<ConfirmDialog
  open={deleteTargetId !== null}
  title={$t("session.historyDeleteConfirmTitle")}
  message={$t("session.historyDeleteConfirmMessage")}
  confirmLabel={$t("session.pruneConfirmConfirm")}
  cancelLabel={$t("session.pruneConfirmCancel")}
  destructive
  onConfirm={confirmDeleteSession}
  onCancel={() => (deleteTargetId = null)}
/>

<!-- Destructive confirmation for the chosen prune action. -->
<ConfirmDialog
  open={confirmOpen}
  title={$t("session.pruneConfirmTitle")}
  message={$t("session.pruneConfirmMessage", { action: actionLabel })}
  confirmLabel={$t("session.pruneConfirmConfirm")}
  cancelLabel={$t("session.pruneConfirmCancel")}
  destructive
  onConfirm={confirmPrune}
  onCancel={() => (confirmOpen = false)}
/>

<style>
  /* Self-contained styling, consistent with the app's dialogs. */
  .overlay {
    position: fixed;
    inset: 0;
    z-index: 1000;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 20px;
  }
  .backdrop {
    position: absolute;
    inset: 0;
    border: 0;
    padding: 0;
    margin: 0;
    background: rgba(10, 12, 16, 0.55);
    cursor: pointer;
  }
  .dialog {
    position: relative;
    z-index: 1;
    display: flex;
    flex-direction: column;
    width: 100%;
    max-width: 720px;
    max-height: 85vh;
    background: #ffffff;
    color: #1c2128;
    border-radius: 14px;
    padding: 22px 22px 18px;
    box-shadow: 0 24px 60px -18px rgba(0, 0, 0, 0.55);
    font-family: "Hanken Grotesk", system-ui, sans-serif;
  }
  .dialog h2 {
    margin: 0 0 12px;
    font-size: 18px;
    font-weight: 600;
  }
  .dialog .profile {
    margin: -4px 0 14px;
    font-size: 13px;
    color: #45505d;
  }
  .error {
    margin: 0 0 12px;
    font-size: 14px;
    color: #d24b3e;
  }
  .empty {
    margin: 8px 0 16px;
    font-size: 14px;
    color: #45505d;
  }
  /* Scrollable list of session cards; takes the remaining height. */
  .list {
    list-style: none;
    margin: 0 0 16px;
    padding: 0;
    overflow-y: auto;
    flex: 1 1 auto;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .card {
    border: 1px solid #e3e6ea;
    border-radius: 10px;
    padding: 12px 14px;
    background: #fafbfc;
  }
  .card-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    margin-bottom: 8px;
  }
  .date {
    font-size: 13px;
    font-weight: 600;
    color: #1c2128;
  }
  .lang {
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.04em;
    color: #45505d;
    background: #eef0f3;
    border: 1px solid #d8dce2;
    border-radius: 6px;
    padding: 2px 6px;
  }
  .metrics {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-bottom: 8px;
  }
  .chip {
    font-size: 12px;
    color: #1c2128;
    background: #eef0f3;
    border-radius: 6px;
    padding: 3px 8px;
  }
  .topics {
    margin: 0;
    font-size: 13px;
    line-height: 1.45;
    color: #45505d;
  }
  .topics-label {
    font-weight: 600;
    color: #1c2128;
  }
  /* Inline summary editor (textarea + save/cancel) shown in place of the
     topics paragraph while a card is being edited. */
  .summary-edit {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .summary-input {
    font-family: inherit;
    font-size: 13px;
    line-height: 1.45;
    color: #1c2128;
    background: #ffffff;
    border: 1px solid #d8dce2;
    border-radius: 8px;
    padding: 8px 10px;
    resize: vertical;
  }
  .summary-actions {
    display: flex;
    gap: 8px;
  }
  .summary-actions button,
  .edit,
  .delete {
    font-family: inherit;
    font-size: 12px;
    padding: 5px 10px;
    border-radius: 8px;
    cursor: pointer;
    border: 1px solid #d8dce2;
    background: #eef0f3;
    color: #1c2128;
  }
  .summary-actions .save {
    background: #3a7bd5;
    border-color: #3a7bd5;
    color: #ffffff;
  }
  .edit,
  .delete {
    margin-left: 6px;
    padding: 2px 8px;
  }
  /* Destructive per-session action: same red as the prune button, so both
     deletions read as the same kind of action. */
  .delete {
    background: #d24b3e;
    border-color: #d24b3e;
    color: #ffffff;
  }
  .delete:hover {
    background: #bf4135;
  }
  /* Footer pins the prune controls and the close button below the list. */
  .footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
    border-top: 1px solid #e3e6ea;
    padding-top: 14px;
  }
  .prune {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .prune-label {
    font-size: 13px;
    color: #45505d;
  }
  .prune select {
    font-family: inherit;
    font-size: 13px;
    padding: 7px 10px;
    border-radius: 8px;
    border: 1px solid #d8dce2;
    background: #ffffff;
    color: #1c2128;
  }
  .footer button {
    font-family: inherit;
    font-size: 14px;
    padding: 9px 16px;
    border-radius: 10px;
    cursor: pointer;
    border: 1px solid transparent;
    transition:
      background 0.15s,
      border-color 0.15s;
  }
  .apply {
    background: #d24b3e;
    color: #ffffff;
  }
  .apply:hover:not(:disabled) {
    background: #bf4135;
  }
  .apply:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .close-btn {
    background: #eef0f3;
    color: #1c2128;
    border-color: #d8dce2;
  }
  .close-btn:hover {
    background: #e3e6ea;
  }
  .footer button:focus-visible {
    outline: 2px solid #1c2128;
    outline-offset: 2px;
  }
  @media (prefers-reduced-motion: reduce) {
    .footer button {
      transition: none;
    }
  }
</style>