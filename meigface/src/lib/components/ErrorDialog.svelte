<script lang="ts">
  // Generic, reusable error modal: a red-accented title, a message and a
  // single OK button. Esc, backdrop click or OK all call `onOk`. Texts are
  // supplied by the parent (already translated).

  interface Props {
    /** Whether the dialog is visible. */
    open: boolean;
    /** Dialog heading. */
    title: string;
    /** Error description shown to the user. */
    message: string;
    /** Label of the OK button. */
    okLabel: string;
    /** Called when the user acknowledges (button, Esc, or backdrop click). */
    onOk: () => void;
  }

  let { open, title, message, okLabel, onOk }: Props = $props();

  const uid = Math.random().toString(36).slice(2);

  let okBtn = $state<HTMLButtonElement | null>(null);

  $effect(() => {
    if (!open) return;
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
      onclick={onOk}
    ></button>

    <div
      class="dialog"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="err-title-{uid}"
      aria-describedby="err-msg-{uid}"
    >
      <h2 id="err-title-{uid}">{title}</h2>
      <p id="err-msg-{uid}">{message}</p>
      <div class="actions">
        <button type="button" class="confirm" bind:this={okBtn} onclick={onOk}>
          {okLabel}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  /* Mirrors ConfirmDialog/InfoDialog, with a red title to signal an error. */
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
    color: #c0392b;
  }
  .dialog p {
    margin: 0 0 18px;
    font-size: 14px;
    line-height: 1.5;
    color: #45505d;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 10px;
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
    .actions button {
      transition: none;
    }
  }
</style>