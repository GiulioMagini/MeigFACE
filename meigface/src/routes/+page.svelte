<script lang="ts">
  //! Home / calibration host.
  //! Hosts three views — home, calibration, calibration test — and
  //! transitions between them based on user actions and the presence
  //! of a fitted gaze model.

  import CalibrationView from "$lib/components/CalibrationView.svelte";
  import CalibrationTestView from "$lib/components/CalibrationTestView.svelte";
  import LlmSetup from "$lib/components/LlmSetup.svelte";
  import { CALIBRATION_POINT_OPTIONS } from "$lib/tracking/calibration";
  import type { CalibrationMode } from "$lib/tracking/calibration";
  import type { EyeReference, GazeModel } from "$lib/tracking/types";
  import {
    t,
    locale,
    availableLocales,
    loadCustomLocales,
    setLocale,
    type Locale,
  } from "$lib/i18n";
  import { goto } from "$app/navigation";
  import { onMount } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import { load, type Store } from "@tauri-apps/plugin-store";
  import { get } from "svelte/store";
  import InfoDialog from "$lib/components/InfoDialog.svelte";
  import ErrorDialog from "$lib/components/ErrorDialog.svelte";
  import { runSystemCheck, type SystemCheckResult } from "$lib/systemCheck";
  import {
    ensureMediaPermissions,
    type MediaPermissionState,
    detectOs,
  } from "$lib/permissions";
  import {
    listInputDevices,
    getPreferredMicrophoneId,
    setPreferredMicrophoneId,
    getPreferredCameraId,
    setPreferredCameraId,
    type InputDevice,
  } from "$lib/mediaDevices";

  type View = "home" | "calibration" | "test";

  let view = $state<View>("home");
  let model = $state<GazeModel | null>(null);
  let eyeReference = $state<EyeReference | null>(null);
  // Default to the light (recommended) reinforcement: 3 cycles of
  // corners + 3 cycles of eye anchors. The heavy mode (4 cycles) is
  // for low-quality webcams that need more samples.
  let mode = $state<CalibrationMode>("light");
  let llmConfigured = $state(false);

  // Persist the fitted calibration so it survives navigation (to /session and
  // back) and app restarts; the home view restores it on mount and shows the
  // test / session actions again.
  const STORE_FILE = "settings.json";
  const KEY_MODEL = "calibration.model";
  const KEY_REFERENCE = "calibration.reference";
  let store: Store | null = null;
  // LLM/STT/TTS paths live in the shared settings.json (written by LlmSetup);
  // the system check reads them and the system_tested flag from there.
  const KEY_SERVER_PATH = "llm.serverPath";
  const KEY_MODEL_PATH = "llm.modelPath";
  const KEY_GPU = "llm.gpuLayers";
  const KEY_WHISPER_PATH = "llm.whisperPath";
  const KEY_WHISPER_MODEL_PATH = "llm.whisperModelPath";
  const KEY_STT_GPU = "stt.gpuDevice";
  const KEY_PIPER_PATH = "llm.piperPath";
  const KEY_SYSTEM_TESTED = "system.tested";
  // The system check's TTS step is language-specific, so remember which locale
  // it passed for; a different active locale must trigger a fresh check.
  const KEY_SYSTEM_TESTED_LANG = "system.testedLanguage";

  // System-check dialog state.
  let checkOpen = $state(false);
  let checkBusy = $state(false);
  let checkSuccess = $state(false);
  let checkMessage = $state("");
  let errorOpen = $state(false);
  let errorMessage = $state("");
  // Camera/microphone permission state, populated by the startup preflight.
  let mediaPerms = $state<MediaPermissionState | null>(null);
  // Device pickers shown right here, before any executable/model selection:
  // this is the earliest point where picking the wrong camera is visible
  // (the tracking preview) — the wrong microphone would otherwise only
  // surface much later, when the "say hi" step in the test chain times out.
  let microphones = $state<InputDevice[]>([]);
  let cameras = $state<InputDevice[]>([]);
  // "" represents "system default" (native <select> values must be strings).
  let selectedMicrophoneId = $state<string>("");
  let selectedCameraId = $state<string>("");
  // OS-specific hint key for re-enabling permissions (computed once at load).
  const osHintKey = (() => {
    switch (detectOs()) {
      case "macos":
        return "home.permissionsHintMac";
      case "linux":
        return "home.permissionsHintLinux";
      default:
        return "home.permissionsHintWindows";
    }
  })();

  onMount(async () => {
    try {
      store = await load(STORE_FILE, { defaults: {}, autoSave: true });
      const savedModel = await store.get<GazeModel>(KEY_MODEL);
      const savedReference = await store.get<EyeReference>(KEY_REFERENCE);
      if (savedModel) model = savedModel;
      if (savedReference) eyeReference = savedReference;
    } catch {
      // No persisted calibration yet, or store unavailable: start fresh.
    }
    // Load any user-provided custom locales from the on-disk i18n folder (and
    // drop reference dictionaries), so extra languages appear in the switcher.
    await loadCustomLocales();
    // Ask for camera and microphone up front so the OS prompts appear now,
    // not during a timed check where granting too slowly would fail it.
    mediaPerms = await ensureMediaPermissions();
    // Populate the device pickers right after the permission preflight:
    // labels are only revealed once permission has been granted, which the
    // call above just secured.
    microphones = await listInputDevices("audioinput");
    cameras = await listInputDevices("videoinput");
    selectedMicrophoneId = (await getPreferredMicrophoneId()) ?? "";
    selectedCameraId = (await getPreferredCameraId()) ?? "";
  });

  async function handleComplete(
    fitted: GazeModel,
    reference: EyeReference | null,
  ): Promise<void> {
    model = fitted;
    eyeReference = reference;
    await store?.set(KEY_MODEL, fitted);
    await store?.set(KEY_REFERENCE, reference);
    setTimeout(() => {
      view = "home";
    }, 1500);
  }

  function handleCancel(): void {
    view = "home";
  }

  // Re-request camera/microphone (e.g. if the user dismissed the first prompt).
  // Note: if access was hard-denied at the OS level the browser will not prompt
  // again and the user must enable it in Windows privacy settings.
  async function requestPermissions(): Promise<void> {
    mediaPerms = await ensureMediaPermissions();
  }

  /** Persist the chosen microphone. Empty string means "system default". */
  async function setMicrophone(deviceId: string): Promise<void> {
    await setPreferredMicrophoneId(deviceId || null);
  }

  /** Persist the chosen camera. Empty string means "system default". */
  async function setCamera(deviceId: string): Promise<void> {
    await setPreferredCameraId(deviceId || null);
  }

  // The destination of the current pre-flight check: either the calibration
  // flow or the session setup. Both gate on the same system check, so changing
  // an executable/model forces a re-test even when the calibration is unchanged.
  type PendingAction = "calibrate" | "session";
  let pendingAction = $state<PendingAction>("calibrate");

  /** Stop any LLM/STT engine left running from a manual test in the setup
   * panel. Called before all three bottom actions so calibration never
   * shares GPU/VRAM with an idle test instance, and a session always
   * starts from a fresh engine that reflects the current settings instead
   * of silently reusing a possibly stale one. Errors are ignored, same as
   * the system check's own cleanup. */
  async function stopTestEngines(): Promise<void> {
    await invoke("llm_stop").catch(() => {});
    await invoke("stt_stop").catch(() => {});
  }

  // Entry point for the calibrate button.
  async function startCalibrationFlow(): Promise<void> {
    await stopTestEngines();
    pendingAction = "calibrate";
    await ensureTestedThenProceed();
  }

  // Entry point for the setup-session button (home and calibration test view).
  async function startSessionFlow(): Promise<void> {
    await stopTestEngines();
    pendingAction = "session";
    await ensureTestedThenProceed();
  }

  // Entry point for the "test calibration" button; bypasses the system
  // check (an existing model is already known-good) but must still release
  // any engine left running from a manual test.
  async function startCalibrationTest(): Promise<void> {
    await stopTestEngines();
    view = "test";
  }

  // Proceed straight to the pending action if the current paths are already
  // verified (system_tested === true), otherwise run the system check first.
  async function ensureTestedThenProceed(): Promise<void> {
    if (!store) {
      proceedPending();
      return;
    }
    const tested = await store.get<boolean>(KEY_SYSTEM_TESTED);
    const testedLang = await store.get<string>(KEY_SYSTEM_TESTED_LANG);
    // Only skip the check if it previously passed for the *current* language:
    // switching language (or adding a new one with no voice yet) forces a
    // re-check, so a stale pass never lets a voiceless language through.
    if (tested && testedLang === get(locale)) {
      proceedPending();
      return;
    }
    await runChecks();
  }

  // Perform the navigation the user asked for before the check ran.
  function proceedPending(): void {
    if (pendingAction === "session") {
      goto("/session");
    } else {
      view = "calibration";
    }
  }
  // Read the selected paths from the shared store and exercise every engine,
  // showing live progress; on success mark the system verified, on failure
  // surface a step-specific error so the user can fix the right file.
  async function runChecks(): Promise<void> {
    if (!store) return;
    const serverPath = await store.get<string>(KEY_SERVER_PATH);
    const modelPath = await store.get<string>(KEY_MODEL_PATH);
    const whisperPath = await store.get<string>(KEY_WHISPER_PATH);
    const whisperModelPath = await store.get<string>(KEY_WHISPER_MODEL_PATH);
    const piperPath = await store.get<string>(KEY_PIPER_PATH);
    const gpuLayers = (await store.get<number>(KEY_GPU)) ?? 0;
    const sttGpuDevice = (await store.get<number>(KEY_STT_GPU)) ?? undefined;
    if (
      !serverPath ||
      !modelPath ||
      !whisperPath ||
      !whisperModelPath ||
      !piperPath
    ) {
      // The buttons are gated on all paths being set, but guard regardless.
      proceedPending();
      return;
    }

    const tt = get(t);
    const language = get(locale);
    checkSuccess = false;
    checkBusy = true;
    checkMessage = tt("check.llmStep");
    checkOpen = true;

    const result = await runSystemCheck(
      {
        serverPath,
        modelPath,
        gpuLayers,
        whisperPath,
        whisperModelPath,
        sttGpuDevice,
        piperPath,
        language,
        word: tt("check.word"),
        llmPrompt: tt("check.llmPrompt"),
      },
      {
        onLlm: () => (checkMessage = get(t)("check.llmStep")),
        onSttStarting: () => (checkMessage = get(t)("check.sttStarting")),
        onSttListening: () =>
          (checkMessage = get(t)("check.sttPrompt", {
            word: get(t)("check.word"),
          })),
        onTts: () => (checkMessage = get(t)("check.ttsStep")),
      },
    );

    if (result.ok) {
      await store.set(KEY_SYSTEM_TESTED, true);
      await store.set(KEY_SYSTEM_TESTED_LANG, language);
      checkBusy = false;
      checkSuccess = true;
      checkMessage = get(t)("check.success");
    } else {
      checkOpen = false;
      errorMessage = checkErrorMessage(result);
      errorOpen = true;
    }
  }

  // Build the localized error text for a failed step.
  function checkErrorMessage(
    result: Extract<SystemCheckResult, { ok: false }>,
  ): string {
    const tt = get(t);
    switch (result.step) {
      case "llm":
        return tt("check.llmError", { detail: result.detail });
      case "stt":
        return result.reason === "noSpeech"
          ? tt("check.sttNoSpeech")
          : tt("check.sttError", { detail: result.detail });
      case "tts":
        return tt("check.ttsError", { detail: result.detail });
    }
  }

  // OK on the info dialog: close it, and on success proceed to whatever the
  // user originally asked for (calibration or session setup).
  function onCheckOk(): void {
    checkOpen = false;
    if (checkSuccess) proceedPending();
  }

  function onErrorOk(): void {
    errorOpen = false;
  }
</script>

{#if view === "calibration"}
  <CalibrationView {mode} onComplete={handleComplete} onCancel={handleCancel} />
{:else if view === "test" && model}
  <CalibrationTestView
    {model}
    reference={eyeReference}
    onBack={() => (view = "home")}
    onSetupSession={startSessionFlow}
  />
{:else}
  <main class="container">
    <div class="lang-switch">
      <label for="locale-select">🌐</label>
      <select
        id="locale-select"
        value={$locale}
        onchange={(e) =>
          setLocale((e.currentTarget as HTMLSelectElement).value as Locale)}
      >
        {#each $availableLocales as loc}
          <option value={loc}>{loc.toUpperCase()}</option>
        {/each}
      </select>
    </div>

    <h1>{$t("home.title")}</h1>

    {#if mediaPerms && (!mediaPerms.camera || !mediaPerms.microphone)}
      <div class="perm-banner">
        <p>{$t("home.permissionsWarning")}</p>
        <p class="perm-hint">{$t(osHintKey)}</p>
        <button onclick={requestPermissions}>
          {$t("home.permissionsRetry")}
        </button>
      </div>
    {/if}

    <!-- Camera/microphone pickers: placed right here, before any executable
         is chosen below, so a wrong device is caught immediately rather than
         discovered later (a wrong mic in particular has no other visible
         symptom until the "say hi" step of the test chain times out). -->
    <div class="device-picker">
      <div class="device-field">
        <label for="mic-select">{$t("session.microphone")}</label>
        {#if microphones.length > 0}
          <select
            id="mic-select"
            bind:value={selectedMicrophoneId}
            onchange={() => setMicrophone(selectedMicrophoneId)}
          >
            <option value="">{$t("session.systemDefault")}</option>
            {#each microphones as mic}
              <option value={mic.deviceId}>{mic.label || mic.deviceId}</option>
            {/each}
          </select>
        {:else}
          <span class="empty">{$t("session.noInputDevices")}</span>
        {/if}
      </div>
      <div class="device-field">
        <label for="camera-select">{$t("session.camera")}</label>
        {#if cameras.length > 0}
          <select
            id="camera-select"
            bind:value={selectedCameraId}
            onchange={() => setCamera(selectedCameraId)}
          >
            <option value="">{$t("session.systemDefault")}</option>
            {#each cameras as cam}
              <option value={cam.deviceId}>{cam.label || cam.deviceId}</option>
            {/each}
          </select>
        {:else}
          <span class="empty">{$t("session.noInputDevices")}</span>
        {/if}
      </div>
    </div>

    <LlmSetup onConfiguredChange={(v) => (llmConfigured = v)} />

    <!-- How the whole flow works; placed right under the engine setup, whose
         last control is the Piper executable picker. -->
    <section class="guide">
      <h2>{$t("home.guideTitle")}</h2>
      <ol>
        <li>{$t("home.guideStep1")}</li>
        <li>{$t("home.guideStep2")}</li>
        <li>{$t("home.guideStep3")}</li>
      </ol>
    </section>

    <div class="point-select">
      <label for="point-count">{$t("home.pointCountLabel")}</label>
      <select id="point-count" bind:value={mode}>
        {#each CALIBRATION_POINT_OPTIONS as opt}
          <option value={opt}>
            {opt === "light" ? $t("home.modeLight") : $t("home.modeHeavy")}
            {#if opt === "light"}{$t("home.modeTagRecommended")}{/if}
          </option>
        {/each}
      </select>
      <p class="hint-text">{$t("home.pointCountHint")}</p>
    </div>

    <div class="actions">
      <button disabled={!llmConfigured} onclick={startCalibrationFlow}>
        {model ? $t("home.recalibrate") : $t("home.startCalibration")}
      </button>
      {#if model}
        <button class="secondary" onclick={startCalibrationTest}>
          {$t("home.testCalibration")}
        </button>
        <button class="cta" onclick={startSessionFlow}>
          {$t("home.setupSession")}
        </button>
      {/if}
    </div>
    {#if !llmConfigured}
      <p class="hint-text">{$t("llm.calibrationLocked")}</p>
    {/if}

    {#if model}
      <div class="result">
        <h3>{$t("home.fittedModelTitle")}</h3>
        <p>
          <strong>{$t("home.coeffsXLabel")}:</strong> [{model.coeffsX
            .map((c) => c.toFixed(2))
            .join(", ")}]
        </p>
        <p>
          <strong>{$t("home.coeffsYLabel")}:</strong> [{model.coeffsY
            .map((c) => c.toFixed(2))
            .join(", ")}]
        </p>
        <p class="hint">{$t("home.modelHint")}</p>
      </div>
    {/if}

    <InfoDialog
      open={checkOpen}
      title={$t("check.title")}
      message={checkMessage}
      okLabel={$t("check.ok")}
      busy={checkBusy}
      onOk={onCheckOk}
    />
    <ErrorDialog
      open={errorOpen}
      title={$t("check.errorTitle")}
      message={errorMessage}
      okLabel={$t("check.ok")}
      onOk={onErrorOk}
    />
  </main>
{/if}

<style>
  .container {
    padding: 20px;
    font-family: system-ui, sans-serif;
    max-width: 800px;
    margin: 0 auto;
  }

  .actions {
    display: flex;
    gap: 12px;
    margin-top: 12px;
  }

  button {
    padding: 10px 20px;
    font-size: 15px;
    border-radius: 6px;
    border: none;
    background: #3a7bd5;
    color: white;
    cursor: pointer;
  }

  button.secondary {
    background: #444;
  }

  button.cta {
    background: #2e7d32;
  }

  button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .result {
    margin-top: 24px;
    padding: 16px;
    background: #f0f0f0;
    border-radius: 6px;
    font-family: monospace;
    font-size: 13px;
  }

  .result p {
    margin: 6px 0;
  }

  .result .hint {
    font-family: system-ui, sans-serif;
    color: #555;
    font-size: 12px;
    margin-top: 12px;
  }

  .guide {
    margin: 16px 0;
    padding: 16px 18px;
    background: #eef4ff;
    border: 1px solid #c8dbff;
    border-left: 4px solid #3a7bd5;
    border-radius: 8px;
    max-width: 633px;
  }

  .guide h2 {
    margin: 0 0 8px;
    font-size: 15px;
    color: #1c3d6e;
  }

  .guide ol {
    margin: 0;
    padding-left: 20px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .guide li {
    font-size: 13px;
    line-height: 1.5;
    color: #33455c;
  }

  .perm-banner {
    margin: 12px 0 4px;
    padding: 12px 14px;
    background: #fdf3e3;
    border: 1px solid #f0d9a8;
    border-left: 4px solid #c98a2b;
    border-radius: 8px;
    max-width: 638px;
  }

  .perm-banner p {
    margin: 0 0 10px;
    font-size: 14px;
    line-height: 1.45;
    color: #6b4e16;
  }

  .perm-banner button {
    padding: 8px 14px;
    border-radius: 6px;
    border: none;
    background: #c98a2b;
    color: white;
    cursor: pointer;
    font-size: 14px;
  }

  .perm-banner button:hover {
    background: #b3781f;
  }

  .perm-hint {
    margin: 0 0 10px;
    font-size: 13px;
    line-height: 1.45;
    color: #8a6d2f;
  }

  .device-picker {
    display: flex;
    gap: 24px;
    flex-wrap: wrap;
    margin: 12px 0 4px;
    max-width: 638px;
  }

  .device-field {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 14px;
  }

  .device-field select {
    padding: 4px 8px;
    font-size: 13px;
    border-radius: 4px;
    border: 1px solid #bbb;
    background: white;
    cursor: pointer;
    width: 672px;
    max-width: 672px;
  }

  .point-select {
    margin: 20px 0 8px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    max-width: 420px;
  }

  .point-select label {
    font-size: 14px;
    font-weight: 500;
    color: #333;
  }

  .point-select select {
    padding: 8px 10px;
    font-size: 14px;
    border-radius: 6px;
    border: 1px solid #bbb;
    background: white;
    cursor: pointer;
  }

  .hint-text {
    font-size: 12px;
    color: #666;
    margin: 4px 0 0;
    line-height: 1.4;
  }

  .lang-switch {
    position: absolute;
    top: 14px;
    right: 18px;
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 14px;
  }

  .lang-switch select {
    padding: 4px 8px;
    font-size: 13px;
    border-radius: 4px;
    border: 1px solid #bbb;
    background: white;
    cursor: pointer;
  }
</style>
