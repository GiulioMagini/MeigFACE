<script lang="ts">
  //! LLM engine setup panel.
  //!
  //! Lets the user pick the llama-server executable and the default GGUF
  //! model through native file dialogs, persists both choices across
  //! launches, and offers a start/stop control to verify the local LLM.
  //! Reports whether both paths are set so the host can gate calibration.

  import { onMount } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import { open } from "@tauri-apps/plugin-dialog";
  import { load, type Store } from "@tauri-apps/plugin-store";
  import { t } from "#lib/i18n/index.js";

  // Persisted settings: file name and the keys inside it.
  const STORE_FILE = "settings.json";
  const KEY_SERVER = "llm.serverPath";
  const KEY_MODEL = "llm.modelPath";
  const KEY_GPU = "llm.gpuLayers";
  const KEY_STT_GPU = "stt.gpuDevice";
  const KEY_WHISPER = "llm.whisperPath";
  const KEY_WHISPER_MODEL = "llm.whisperModelPath";
  const KEY_PIPER = "llm.piperPath";
  const KEY_SYSTEM_TESTED = "system.tested";

  type Props = {
    /** Called whenever the "both paths selected" state changes. */
    onConfiguredChange?: (configured: boolean) => void;
  };
  let { onConfiguredChange }: Props = $props();

  // Shape of the status object returned by the llm_* commands.
  type LlmStatus = { running: boolean; base_url: string | null };
  type RunState = "stopped" | "starting" | "running";

  let serverPath = $state<string | null>(null);
  let modelPath = $state<string | null>(null);
  let gpuLayers = $state(0);
  // null means "let whisper-server pick its own default device" (see -dev
  // in its --help). No auto-detect exists for this — unlike gpuLayers, the
  // right index depends on which GPU happened to enumerate first, which we
  // cannot infer without parsing the server's own startup log.
  let sttGpuDevice = $state<number | null>(null);
  // True once the GPU-layers value is explicit (restored or user-edited),
  // so auto-detection never overrides a deliberate choice.
  let gpuLayersSet = $state(false);
  let whisperPath = $state<string | null>(null);
  let whisperModelPath = $state<string | null>(null);
  let piperPath = $state<string | null>(null);
  let runState = $state<RunState>("stopped");
  let baseUrl = $state<string | null>(null);
  let sttRunState = $state<RunState>("stopped");
  let sttBaseUrl = $state<string | null>(null);
  let errorMessage = $state<string | null>(null);

  // Loaded asynchronously on mount; guards every persistence call.
  let store: Store | null = null;

  // Required all paths — this is the gate for calibration.
  let configured = $derived(
    serverPath !== null &&
      modelPath !== null &&
      whisperPath !== null &&
      whisperModelPath !== null &&
      piperPath !== null,
  );

  // The LLM engine can be started once its executable and model are set.
  let isllmready = $derived(
    serverPath !== null &&
      modelPath !== null 
  );

  // The STT engine can be started once its executable and model are set.
  let sttReady = $derived(whisperPath !== null && whisperModelPath !== null);

  // Notify the host whenever the configured state changes.
  $effect(() => {
    onConfiguredChange?.(configured);
  });

  // Restore persisted settings once, and reflect any already-running server.
  onMount(async () => {
    try {
      store = await load(STORE_FILE, { defaults: {}, autoSave: true });
      const savedServer = await store.get<string>(KEY_SERVER);
      const savedModel = await store.get<string>(KEY_MODEL);
      const savedWhisper = await store.get<string>(KEY_WHISPER);
      const savedWhisperModel = await store.get<string>(KEY_WHISPER_MODEL);
      const savedPiper = await store.get<string>(KEY_PIPER);
      const savedGpu = await store.get<number>(KEY_GPU);
      const savedSttGpu = await store.get<number>(KEY_STT_GPU);
      if (savedServer) serverPath = savedServer;
      if (savedModel) modelPath = savedModel;
      if (savedWhisper) whisperPath = savedWhisper;
      if (savedWhisperModel) whisperModelPath = savedWhisperModel;
      if (savedPiper) piperPath = savedPiper;
      if (typeof savedGpu === "number") {
        gpuLayers = savedGpu;
        gpuLayersSet = true;
      }
      if (typeof savedSttGpu === "number") sttGpuDevice = savedSttGpu;

      const status = await invoke<LlmStatus>("llm_status");
      if (status.running) {
        runState = "running";
        baseUrl = status.base_url;
      }
      const sttStatus = await invoke<LlmStatus>("stt_status");
      if (sttStatus.running) {
        sttRunState = "running";
        sttBaseUrl = sttStatus.base_url;
      }
    } catch (err) {
      errorMessage = String(err);
    }
    await autoDetectGpuLayers();
  });

  // A new executable/model invalidates the system check: the user must verify
  // the new selection works before calibrating again.
  async function invalidateSystemTest(): Promise<void> {
    await store?.set(KEY_SYSTEM_TESTED, false);
  }

  async function pickServer(): Promise<void> {
    // No extension filter: the executable is "llama-server.exe" on Windows
    // but has no extension on Linux/macOS.
    const selected = await open({ multiple: false, directory: false });
    if (typeof selected === "string") {
      serverPath = selected;
      await store?.set(KEY_SERVER, selected);
      await invalidateSystemTest();
      await autoDetectGpuLayers();
    }
  }

  async function pickModel(): Promise<void> {
    const selected = await open({
      multiple: false,
      directory: false,
      filters: [{ name: "GGUF", extensions: ["gguf"] }],
    });
    if (typeof selected === "string") {
      modelPath = selected;
      await store?.set(KEY_MODEL, selected);
      await invalidateSystemTest();
    }
  }

  async function persistGpuLayers(): Promise<void> {
    gpuLayersSet = true;
    await store?.set(KEY_GPU, gpuLayers);
  }

  async function persistSttGpuDevice(): Promise<void> {
    await store?.set(KEY_STT_GPU, sttGpuDevice);
  }

  async function pickWhisper(): Promise<void> {
    // No extension filter: the executable name/extension varies per OS.
    const selected = await open({ multiple: false, directory: false });
    if (typeof selected === "string") {
      whisperPath = selected;
      await store?.set(KEY_WHISPER, selected);
      await invalidateSystemTest();
    }
  }

  async function pickWhisperModel(): Promise<void> {
    const selected = await open({
      multiple: false,
      directory: false,
      filters: [{ name: "Whisper model", extensions: ["bin"] }],
    });
    if (typeof selected === "string") {
      whisperModelPath = selected;
      await store?.set(KEY_WHISPER_MODEL, selected);
      await invalidateSystemTest();
    }
  }

  async function pickPiper(): Promise<void> {
    const selected = await open({ multiple: false, directory: false });
    if (typeof selected === "string") {
      piperPath = selected;
      await store?.set(KEY_PIPER, selected);
      await invalidateSystemTest();
    }
  }

  async function autoDetectGpuLayers(): Promise<void> {
    // Only pre-fill when the user has never set a value and a server is
    // selected; this respects an explicit choice and never overrides it.
    if (gpuLayersSet || !serverPath) return;
    try {
      const suggested = await invoke<number>("llm_suggest_gpu_layers", {
        serverPath,
      });
      gpuLayers = suggested;
      gpuLayersSet = true;
      await store?.set(KEY_GPU, suggested);
    } catch (err) {
      // Probe failed: keep the default (CPU) and let the user adjust.
      errorMessage = String(err);
    }
  }

  async function startLlm(): Promise<void> {
    if (!serverPath || !modelPath) return;
    runState = "starting";
    errorMessage = null;
    try {
      const status = await invoke<LlmStatus>("llm_start", {
        serverPath,
        modelPath,
        nGpuLayers: gpuLayers,
      });
      baseUrl = status.base_url;
      runState = status.running ? "running" : "stopped";
    } catch (err) {
      errorMessage = String(err);
      runState = "stopped";
    }
  }

  async function stopLlm(): Promise<void> {
    try {
      await invoke("llm_stop");
    } catch (err) {
      errorMessage = String(err);
    }
    runState = "stopped";
    baseUrl = null;
  }

  async function startStt(): Promise<void> {
    if (!whisperPath || !whisperModelPath) return;
    sttRunState = "starting";
    errorMessage = null;
    try {
      const status = await invoke<LlmStatus>("stt_start", {
        serverPath: whisperPath,
        modelPath: whisperModelPath,
        gpuDevice: sttGpuDevice ?? undefined,
      });
      sttBaseUrl = status.base_url;
      sttRunState = status.running ? "running" : "stopped";
    } catch (err) {
      errorMessage = String(err);
      sttRunState = "stopped";
    }
  }

  async function stopStt(): Promise<void> {
    try {
      await invoke("stt_stop");
    } catch (err) {
      errorMessage = String(err);
    }
    sttRunState = "stopped";
    sttBaseUrl = null;
  }

</script>

<section class="llm-setup">
  <h2>{$t("llm.title")}</h2>
  <p class="intro">{$t("llm.intro")}</p>

  <div class="field">
    <span class="label">{$t("llm.serverLabel")}</span>
    <div class="picker">
      <button class="secondary" onclick={pickServer}>
        {serverPath ? $t("llm.change") : $t("llm.choose")}
      </button>
      <span class="path" class:unset={!serverPath} title={serverPath ?? ""}>
        {serverPath ?? $t("llm.notSelected")}
      </span>
    </div>
  </div>

  <div class="field">
    <span class="label">{$t("llm.modelLabel")}</span>
    <div class="picker">
      <button class="secondary" onclick={pickModel}>
        {modelPath ? $t("llm.change") : $t("llm.choose")}
      </button>
      <span class="path" class:unset={!modelPath} title={modelPath ?? ""}>
        {modelPath ?? $t("llm.notSelected")}
      </span>
    </div>
  </div>

  <div class="field">
    <label class="label" for="gpu-layers">{$t("llm.gpuLayersLabel")}</label>
    <input
      id="gpu-layers"
      class="gpu-input"
      type="number"
      min="0"
      bind:value={gpuLayers}
      onchange={persistGpuLayers}
    />
  </div>

  <div class="run-row">
    {#if runState === "running"}
      <button class="secondary" onclick={stopLlm}>{$t("llm.stop")}</button>
    {:else}
      <button onclick={startLlm} disabled={!isllmready || runState === "starting"}>
        {runState === "starting" ? $t("llm.starting") : $t("llm.start")}
      </button>
    {/if}
    <span class="status" class:running={runState === "running"}>
      {runState === "running"
        ? $t("llm.statusRunning", { url: baseUrl ?? "" })
        : $t("llm.statusStopped")}
    </span>
  </div>

  <div class="field">
    <span class="label">{$t("llm.whisperLabel")}</span>
    <div class="picker">
      <button class="secondary" onclick={pickWhisper}>
        {whisperPath ? $t("llm.change") : $t("llm.choose")}
      </button>
      <span class="path" class:unset={!whisperPath} title={whisperPath ?? ""}>
        {whisperPath ?? $t("llm.notSelected")}
      </span>
    </div>
  </div>

  <div class="field">
    <span class="label">{$t("llm.whisperModelLabel")}</span>
    <div class="picker">
      <button class="secondary" onclick={pickWhisperModel}>
        {whisperModelPath ? $t("llm.change") : $t("llm.choose")}
      </button>
      <span class="path" class:unset={!whisperModelPath} title={whisperModelPath ?? ""}>
        {whisperModelPath ?? $t("llm.notSelected")}
      </span>
    </div>
  </div>

  <div class="field">
    <label class="label" for="stt-gpu-device">{$t("llm.gpuDeviceLabel")}</label>
    <input
      id="stt-gpu-device"
      class="gpu-input"
      type="number"
      min="0"
      placeholder={$t("llm.gpuDeviceDefault")}
      value={sttGpuDevice ?? ""}
      oninput={(e) => {
        const raw = e.currentTarget.value;
        sttGpuDevice = raw === "" ? null : Number(raw);
      }}
      onchange={persistSttGpuDevice}
    />
  </div>

  <div class="run-row">
    {#if sttRunState === "running"}
      <button class="secondary" onclick={stopStt}>{$t("llm.sttStop")}</button>
    {:else}
      <button onclick={startStt} disabled={!sttReady || sttRunState === "starting"}>
        {sttRunState === "starting" ? $t("llm.starting") : $t("llm.sttStart")}
      </button>
    {/if}
    <span class="status" class:running={sttRunState === "running"}>
      {sttRunState === "running"
        ? $t("llm.statusRunning", { url: sttBaseUrl ?? "" })
        : $t("llm.statusStopped")}
    </span>
  </div>

  <div class="field">
    <span class="label">{$t("llm.piperLabel")}</span>
    <div class="picker">
      <button class="secondary" onclick={pickPiper}>
        {piperPath ? $t("llm.change") : $t("llm.choose")}
      </button>
      <span class="path" class:unset={!piperPath} title={piperPath ?? ""}>
        {piperPath ?? $t("llm.notSelected")}
      </span>
    </div>
  </div>

  {#if errorMessage}
    <p class="error">{$t("llm.error", { message: errorMessage })}</p>
  {/if}
</section>

<style>
  .llm-setup {
    margin: 16px 0;
    padding: 16px;
    background: #f7f7f9;
    border: 1px solid #e2e2e8;
    border-radius: 8px;
    max-width: 640px;
  }

  .llm-setup h2 {
    margin: 0 0 4px;
    font-size: 16px;
  }

  .intro {
    margin: 0 0 14px;
    font-size: 12px;
    color: #666;
    line-height: 1.4;
  }

  .field {
    margin-bottom: 12px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .label {
    font-size: 13px;
    font-weight: 500;
    color: #333;
  }

  .picker {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .path {
    font-family: monospace;
    font-size: 12px;
    color: #333;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
    min-width: 0;
  }

  .path.unset {
    color: #999;
    font-style: italic;
    font-family: system-ui, sans-serif;
  }

  .gpu-input {
    width: 90px;
    padding: 6px 8px;
    font-size: 14px;
    border-radius: 6px;
    border: 1px solid #bbb;
  }

  .run-row {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-top: 6px;
    margin-bottom: 12px;
  }

  button {
    padding: 8px 16px;
    font-size: 14px;
    border-radius: 6px;
    border: none;
    background: #3a7bd5;
    color: white;
    cursor: pointer;
  }

  button.secondary {
    background: #444;
  }

  button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .status {
    font-size: 13px;
    color: #888;
  }

  .status.running {
    color: #2e7d32;
    font-weight: 500;
  }

  .error {
    margin: 10px 0 0;
    font-size: 13px;
    color: #c0392b;
  }
</style>
