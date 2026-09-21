<script lang="ts">
  // Session route: thin orchestrator. Switches between the setup view and the
  // live session view, mirroring how the home route switches between
  // its calibration views. Mounting/unmounting SessionLive via the {#if} drives
  // the engine + webcam/mic lifecycle through its onMount/onDestroy.
  import SessionSetup from "$lib/components/SessionSetup.svelte";
  import SessionLive from "$lib/components/SessionLive.svelte";

  type View = "setup" | "live";
  let view = $state<View>("setup");
</script>
{#if view === "setup"}
  <SessionSetup onStart={() => (view = "live")} />
{:else}
  <SessionLive onEnd={() => (view = "setup")} />
{/if}