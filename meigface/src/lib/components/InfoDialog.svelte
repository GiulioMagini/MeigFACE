<script lang="ts">
  // Generic, reusable info modal. Two modes via `busy`:
  //  - busy=true  → shows a spinner and no buttons (work in progress); the
  //                 dialog cannot be dismissed.
  //  - busy=false → shows the OK button; Esc, backdrop click or OK all call
  //                 `onOk`. All texts are supplied by the parent (already
  //                 translated), so the component stays domain-agnostic.

  interface Props {
    /** Whether the dialog is visible. */
    open: boolean;
    /** Dialog heading. */
    title: string;
    /** Dialog body text (e.g. the current step, or the success message). */
    message: string;
    /** Label of the OK button (shown only when not busy). */
    okLabel: string;
    /** While true, show a spinner and no dismissable controls. */
    busy?: boolean;
    /** Called when the user acknowledges (button, Esc, or backdrop click). */
    onOk: () => void;
  }

  let { open, title, message, okLabel, busy = false, onOk }: Props = $props();

  // Unique ids so multiple dialog instances never collide on aria targets.
  const uid = Math.random().toString(36).slice(2);

  let okBtn = $state<HTMLButtonElement | null>(null);

  // Dismissing is only allowed when the dialog is not busy.
  function dismiss(): void {
    if (!busy) onOk();
  }

  // While open and idle, focus OK and let Escape acknowledge the dialog.
  $effect(() => {
    if (!open || busy) return;
    okBtn?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onOk();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
</script>

{#if open}
  <div class="overlay">
    <button
      type="button"
      class="backdrop"
      aria-label={okLabel}
      onclick={dismiss}
    ></button>

    <div
      class="dialog"
      role="dialog"
      aria-modal="true"
      aria-busy={busy}
      aria-labelledby="info-title-{uid}"
      aria-describedby="info-msg-{uid}"
    >
      <h2 id="info-title-{uid}">{title}</h2>
      <div class="body">
        {#if busy}
          <span class="spinner" aria-hidden="true"></span>
        {/if}
        <p id="info-msg-{uid}">{message}</p>
      </div>
      {#if !busy}
        <div class="actions">
          <button type="button" class="confirm" bind:this={okBtn} onclick={onOk}>
            {okLabel}
          </button>
        </div>
      {/if}
    </div>
  </div>
{/if}

<style>
  /* Self-contained styling, mirroring ConfirmDialog so the dialogs read as a
     family regardless of the page they appear on. */
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
    cursor: default;
  }
  .dialog {
    position: relative;
    z-index: 1;
    width: 100%;
    max-width: 400px;
    background: #ffffff;
    color: #1c2128;
    border-radius: 14px;
    padding: 22px 22px 18px;
    box-shadow: 0 24px 60px -18px rgba(0, 0, 0, 0.55);
    font-family: "Hanken Grotesk", system-ui, sans-serif;
  }
  .dialog h2 {
    margin: 0 0 8px;
    font-size: 18px;
    font-weight: 600;
  }
  .body {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .body p {
    margin: 0;
    font-size: 14px;
    line-height: 1.5;
    color: #45505d;
  }
  .spinner {
    flex: none;
    width: 22px;
    height: 22px;
    border-radius: 50%;
    border: 3px solid #e3e6ea;
    border-top-color: #c9a24b;
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 10px;
    margin-top: 18px;
  }
  .actions button {
    font-family: inherit;
    font-size: 14px;
    padding: 9px 16px;
    border-radius: 10px;
    cursor: pointer;
    border: 1px solid transparent;
    transition: background 0.15s;
  }
  .confirm {
    background: #c9a24b;
    color: #1c2128;
  }
  .confirm:hover {
    background: #bb9440;
  }
  .actions button:focus-visible {
    outline: 2px solid #1c2128;
    outline-offset: 2px;
  }
  @media (prefers-reduced-motion: reduce) {
    .spinner {
      animation-duration: 1.6s;
    }
    .actions button {
      transition: none;
    }
  }
</style>