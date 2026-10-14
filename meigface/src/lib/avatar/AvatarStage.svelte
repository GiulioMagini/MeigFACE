<script lang="ts">
  // Reusable avatar stage: renders one SVG puppet in an iframe and drives its
  // mouth and head movement. Shared by the session setup preview and the live
  // session view, so the avatar wiring (blob URL + postMessage protocol) lives
  // in one place. The host page owns the surrounding box and its sizing; this
  // component only fills it with the puppet.
  import { onDestroy } from "svelte";
  // Avatar puppets live in $lib/avatar (user-editable assets, not static/).
  // Imported as raw HTML strings (`?raw`, no Vite HTML transform) and turned
  // into blob: object URLs below. A blob URL is used instead of `srcdoc`
  // because under srcdoc (about:srcdoc) the SVG's internal url(#id)
  // gradient/clip references do not resolve in WebView2, leaving a blank
  // avatar; a blob document has a real base URL, so they resolve.
  import avatarMaleHtml from "#lib/avatar/avatar-male.html?raw";
  import avatarFemaleHtml from "#lib/avatar/avatar-female.html?raw";

  type Gender = "male" | "female";

  interface Props {
    /** Which puppet to show. */
    avatar: Gender;
    /** Head-sway amplitude in [0, 2]; pushed to the puppet on change. */
    headMovement?: number;
    /** Mouth openness in [0, 1]; pushed to the puppet on change. */
    mouth?: number;
    /** Accessible title for the iframe. */
    title?: string;
  }

  let { avatar, headMovement = 1, mouth = 0, title = "" }: Props = $props();

  let iframeEl: HTMLIFrameElement | null = null;

  // Build each puppet document once as a blob: object URL (revoked on destroy).
  const avatarMaleSrc = URL.createObjectURL(
    new Blob([avatarMaleHtml], { type: "text/html" }),
  );
  const avatarFemaleSrc = URL.createObjectURL(
    new Blob([avatarFemaleHtml], { type: "text/html" }),
  );
  const avatarUrl = $derived(
    avatar === "male" ? avatarMaleSrc : avatarFemaleSrc,
  );
  onDestroy(() => {
    URL.revokeObjectURL(avatarMaleSrc);
    URL.revokeObjectURL(avatarFemaleSrc);
  });

  function postToAvatar(message: unknown): void {
    iframeEl?.contentWindow?.postMessage(message, "*");
  }

  // Push head movement and mouth openness to the puppet reactively.
  $effect(() => {
    postToAvatar({ type: "headMovement", value: headMovement });
  });
  $effect(() => {
    postToAvatar({ type: "mouth", value: mouth });
  });

  // On (re)load (incl. switching puppet), resend the current state so the
  // freshly loaded puppet matches the host.
  function onAvatarLoad(): void {
    postToAvatar({ type: "headMovement", value: headMovement });
    postToAvatar({ type: "mouth", value: mouth });
  }
</script>

<!-- sandbox (scripts only, no same-origin): the puppet gets an opaque origin,
     so its script can never reach the parent window or the Tauri IPC. -->
<iframe
  bind:this={iframeEl}
  src={avatarUrl}
  onload={onAvatarLoad}
  sandbox="allow-scripts"
  {title}
></iframe>

<style>
  iframe {
    display: block;
    width: 100%;
    height: 100%;
    border: 0;
  }
</style>
