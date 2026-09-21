<script lang="ts">
  // Generic, reusable confirmation modal. The parent controls visibility via
  // `open` and supplies all texts (already translated) and the two callbacks,
  // so the component stays independent from any i18n or domain logic. Set
  // `destructive` to style the confirm button as a dangerous action (e.g.
  // delete). Dismissing (Esc / backdrop click / cancel) calls `onCancel`.

  interface Props {
    /** Whether the dialog is visible. */
    open: boolean;
    /** Dialog heading. */
    title: string;
    /** Dialog body text. */
    message: string;
    /** Label of the confirm button. */
    confirmLabel: string;
    /** Label of the cancel button. */
    cancelLabel: string;
    /** Style the confirm button as a destructive action when true. */
    destructive?: boolean;
    /** Called when the user confirms. */
    onConfirm: () => void;
    /** Called when the user cancels (button, Esc, or backdrop click). */
    onCancel: () => void;
  }

  let {
    open,
    title,
    message,
    confirmLabel,
    cancelLabel,
    destructive = false,
    onConfirm,
    onCancel,
  }: Props = $props();

  // Unique ids so multiple dialog instances never collide on aria targets.
  const uid = Math.random().toString(36).slice(2);

  // Focused on open; cancel is the safe default for destructive actions.
  let cancelBtn = $state<HTMLButtonElement | null>(null);

  // While open, focus the cancel button and let Escape dismiss the dialog.
  // The cleanup runs when the dialog closes or the component is destroyed.
  $effect(() => {
    if (!open) return;
    cancelBtn?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
</script>

{#if open}
  <div class="overlay">
    <!-- Native button as backdrop: clickable and keyboard-accessible without
         the a11y caveats of a click-handler on a plain div. -->
    <button
      type="button"
      class="backdrop"
      aria-label={cancelLabel}
      onclick={onCancel}
    ></button>

    <div
      class="dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="cd-title-{uid}"
      aria-describedby="cd-msg-{uid}"
    >
      <h2 id="cd-title-{uid}">{title}</h2>
      <p id="cd-msg-{uid}">{message}</p>
      <div class="actions">
        <button type="button" class="cancel" bind:this={cancelBtn} onclick={onCancel}>
          {cancelLabel}
        </button>
        <button type="button" class="confirm" class:destructive onclick={onConfirm}>
          {confirmLabel}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  /* Self-contained styling (no external CSS variables) so the dialog renders
     consistently on any page, light or dark. */
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
    transition:
      background 0.15s,
      border-color 0.15s;
  }
  .cancel {
    background: #eef0f3;
    color: #1c2128;
    border-color: #d8dce2;
  }
  .cancel:hover {
    background: #e3e6ea;
  }
  .confirm {
    background: #c9a24b;
    color: #1c2128;
  }
  .confirm:hover {
    background: #bb9440;
  }
  .confirm.destructive {
    background: #d24b3e;
    color: #ffffff;
  }
  .confirm.destructive:hover {
    background: #bf4135;
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