<script lang="ts">
  // Session setup view: choose avatar, tune head movement and mouth
  // sensitivity, pick the voice, set listening pauses and the system prompt,
  // and preview the avatar live. The button is disabled
  // until the conversation-memory step is in place.
  import { onMount, onDestroy } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import { load, type Store } from "@tauri-apps/plugin-store";
  import { toArrayBuffer } from "#lib/audio/player.js";
  import { locale, t } from "#lib/i18n/index.js";
  import { goto } from "$app/navigation";
  import ConfirmDialog from "#lib/components/ConfirmDialog.svelte";
  import SessionHistory from "#lib/components/SessionHistory.svelte";
  import AvatarStage from "#lib/avatar/AvatarStage.svelte";
  import {
    listInputDevices,
    getPreferredMicrophoneId,
    setPreferredMicrophoneId,
    getPreferredCameraId,
    setPreferredCameraId,
    type InputDevice,
  } from "#lib/mediaDevices.js";

  type Gender = "male" | "female";

  interface Props {
    /** Called when the user starts the live session (the route switches view). */
    onStart: () => void;
  }
  let { onStart }: Props = $props();

  // Persistence keys (shared store file with the rest of the app).
  const STORE_FILE = "settings.json";
  const KEY_PIPER = "llm.piperPath";
  const K = {
    language: "session.language",
    avatar: "session.avatar",
    headMovement: "session.headMovement",
    sensitivity: "session.mouthSensitivity",
    voiceSpeed: "session.voiceSpeed",
    voice: "session.voice",
    silence: "session.silenceSec",
    maxListen: "session.maxListenSec",
    prompt: "session.systemPrompt",
    promptEdited: "session.promptEdited",
    selectedPrompt: "session.selectedPrompt",
    selectedParams: "session.selectedParams",
  };

  let store: Store | null = null;
  let piperPath = $state<string | null>(null);

  // Configurable session state (defaults mirror the avatar's own defaults).
  // Conversation language follows the app's global locale (no on-page selector).
  const language = $derived($locale ?? "it");
  let avatar = $state<Gender>("male");
  let headMovement = $state(1); // avatar sway amplitude 0..2
  let sensitivity = $state(1.7); // mouth sensitivity 0.4..4 (RMS multiplier)
  let voiceSpeed = $state(1); // Piper speaking rate 0.7..1.4 (higher = faster)
  let voices = $state<string[]>([]);
  let selectedVoice = $state<string | null>(null);
  let microphones = $state<InputDevice[]>([]);
  let cameras = $state<InputDevice[]>([]);
  // "" represents "system default" (native <select> values must be strings).
  let selectedMicrophoneId = $state<string>("");
  let selectedCameraId = $state<string>("");
  let silenceSec = $state(2); // pause before the avatar replies
  let maxListenSec = $state(120); // max length of a single utterance
  let systemPrompt = $state($t("session.defaultPrompt"));
  let positiveThinkingPrompt = $state($t("session.positiveThinkingPrompt"));
  let promptEdited = $state(false);
  // Saved-prompt management (files in <app config>/prompts via Rust commands).
  let prompts = $state<string[]>([]); // names of saved prompts (no extension)
  let selectedPrompt = $state<string | null>(null); // currently loaded prompt
  let promptName = $state(""); // name field used when saving
  let hint = $state($t("session.systemPromptHint")); // changing when passing from normal prompt to positive thinking
  let confirmDeleteOpen = $state(false); // delete-confirmation dialog visibility
  // Saved parameter profiles (silence + max-listen pairs, files in <app
  // config>/params via Rust commands), switchable per person.
  let paramProfiles = $state<string[]>([]); // names of saved profiles
  let selectedParamProfile = $state<string | null>(null); // currently loaded
  let paramProfileName = $state(""); // name field used when saving
  let showHistory = $state(false); // session-history popup visibility
  let confirmDeleteParamOpen = $state(false); // delete-confirmation visibility

  // Post-save confirmation feedback. Saving over an existing prompt/profile
  // changes nothing else on screen, so the user has no way to tell it worked:
  // the button briefly disables itself and swaps its label for an OK-hand
  // icon. Timer handles are kept so a second save restarts the window cleanly
  // and a pending timeout can be cancelled on unmount.
  const SAVED_FEEDBACK_MS = 3000;
  let promptSaved = $state(false);
  let paramsSaved = $state(false);
  let promptSavedTimer: ReturnType<typeof setTimeout> | null = null;
  let paramsSavedTimer: ReturnType<typeof setTimeout> | null = null;

  let testing = $state(false);
  let errorMessage = $state<string | null>(null);
  let mouthLevel = $state(0); // avatar mouth openness 0..1, driven by the voice test

  let audioCtx: AudioContext | null = null;

  const canTest = $derived(
    piperPath !== null && selectedVoice !== null && !testing,
  );

  // The live session can start once a voice and the Piper executable are set;
  // engines, calibration and prompt are guaranteed by the upstream home flow.
  const canStart = $derived(piperPath !== null && selectedVoice !== null);

  onMount(async () => {
    try {
      store = await load(STORE_FILE, { defaults: {}, autoSave: true });
      piperPath = (await store.get<string>(KEY_PIPER)) ?? null;

      const savedAvatar = await store.get<Gender>(K.avatar);
      const savedHead = await store.get<number>(K.headMovement);
      const savedSens = await store.get<number>(K.sensitivity);
      const savedSpeed = await store.get<number>(K.voiceSpeed);
      const savedVoice = await store.get<string>(K.voice);
      const savedSilence = await store.get<number>(K.silence);
      const savedMax = await store.get<number>(K.maxListen);
      const savedPrompt = await store.get<string>(K.prompt);
      const savedEdited = await store.get<boolean>(K.promptEdited);
      const savedSelected = await store.get<string>(K.selectedPrompt);
      const savedSelectedParams = await store.get<string>(K.selectedParams);

      if (savedAvatar) avatar = savedAvatar;
      if (typeof savedHead === "number") headMovement = savedHead;
      if (typeof savedSens === "number") sensitivity = savedSens;
      if (typeof savedSpeed === "number") voiceSpeed = savedSpeed;
      if (typeof savedSilence === "number") silenceSec = savedSilence;
      if (typeof savedMax === "number") maxListenSec = savedMax;
      if (savedVoice) selectedVoice = savedVoice;
      if (savedSelected) {
        selectedPrompt = savedSelected;
        promptName = savedSelected; // pre-fill the name field for re-saving
      }
      if (savedSelectedParams) {
        selectedParamProfile = savedSelectedParams;
        paramProfileName = savedSelectedParams; // pre-fill for re-saving
      }
      promptEdited = savedEdited === true;
      systemPrompt =
        promptEdited && savedPrompt ? savedPrompt : $t("session.defaultPrompt");

      await loadVoices();
      await loadPrompts();
      await loadParamProfiles();

      microphones = await listInputDevices("audioinput");
      cameras = await listInputDevices("videoinput");
      selectedMicrophoneId = (await getPreferredMicrophoneId()) ?? "";
      selectedCameraId = (await getPreferredCameraId()) ?? "";

      await persistAll();
    } catch (err) {
      errorMessage = String(err);
    }
  });

  async function loadVoices(): Promise<void> {
    try {
      voices = await invoke<string[]>("list_voices", {
        language,
        gender: avatar,
      });
      if (selectedVoice && !voices.includes(selectedVoice))
        selectedVoice = null;
      if (!selectedVoice && voices.length > 0) selectedVoice = voices[0];
      await store?.set(K.voice, selectedVoice);
    } catch {
      voices = [];
      selectedVoice = null;
    }
  }

  async function setAvatar(next: Gender): Promise<void> {
    avatar = next;
    await store?.set(K.avatar, next);
    await loadVoices();
  }

  /** Persist the chosen microphone. Empty string means "system default". */
  async function setMicrophone(deviceId: string): Promise<void> {
    await setPreferredMicrophoneId(deviceId || null);
  }

  /** Persist the chosen camera. Empty string means "system default". */
  async function setCamera(deviceId: string): Promise<void> {
    await setPreferredCameraId(deviceId || null);
  }

  async function onVoiceChange(): Promise<void> {
    await store?.set(K.voice, selectedVoice);
  }

  async function onPromptInput(): Promise<void> {
    promptEdited = true;
    await store?.set(K.promptEdited, true);
    await store?.set(K.prompt, systemPrompt);
  }

  async function resetPrompt(): Promise<void> {
    systemPrompt = $t("session.defaultPrompt");
    hint = $t("session.systemPromptHint");
    promptEdited = false;
    selectedPrompt = null;
    await store?.set(K.promptEdited, false);
    await store?.set(K.prompt, systemPrompt);
    await store?.set(K.selectedPrompt, null);
  }

  async function setPositiveThinkingPrompt(): Promise<void> {
    systemPrompt = $t("session.positiveThinkingPrompt");
    hint = $t("session.positiveThinkingHint");
    promptEdited = false;
    selectedPrompt = null;
    await store?.set(K.promptEdited, false);
    await store?.set(K.prompt, positiveThinkingPrompt);
    await store?.set(K.selectedPrompt, null);
  }

  async function persistNumber(key: string, value: number): Promise<void> {
    await store?.set(key, value);
  }

  // Persist every configurable page variable to the shared settings.json, so
  // the config file always reflects the full page state — including controls
  // the user has not touched yet (otherwise their defaults are written only on
  // first interaction).
  async function persistAll(): Promise<void> {
    if (!store) return;
    await store.set(K.avatar, avatar);
    await store.set(K.headMovement, headMovement);
    await store.set(K.sensitivity, sensitivity);
    await store.set(K.voiceSpeed, voiceSpeed);
    await store.set(K.voice, selectedVoice);
    await store.set(K.silence, silenceSec);
    await store.set(K.maxListen, maxListenSec);
    await store.set(K.prompt, systemPrompt);
    await store.set(K.promptEdited, promptEdited);
    await store.set(K.selectedPrompt, selectedPrompt);
    await store.set(K.selectedParams, selectedParamProfile);
  }

  // Refresh the saved-prompt list from disk, dropping a stale selection that no
  // longer maps to a file.
  async function loadPrompts(): Promise<void> {
    try {
      prompts = await invoke<string[]>("list_prompts");
      if (selectedPrompt && !prompts.includes(selectedPrompt)) {
        selectedPrompt = null;
      }
    } catch {
      prompts = [];
    }
  }

  // Load the selected prompt's text into the editor. A loaded prompt is custom
  // content, so it is marked edited and persisted to survive reloads instead of
  // being replaced by the language default.
  async function onSelectPrompt(): Promise<void> {
    hint = $t("session.systemPromptHint");
    if (!selectedPrompt) return;
    try {
      systemPrompt = await invoke<string>("read_prompt", {
        name: selectedPrompt,
      });
      promptName = selectedPrompt;
      promptEdited = true;
      await store?.set(K.promptEdited, true);
      await store?.set(K.prompt, systemPrompt);
      await store?.set(K.selectedPrompt, selectedPrompt);
    } catch (err) {
      errorMessage = String(err);
    }
  }

  /// Show the "saved" confirmation on one of the two save buttons: disable it
  /// and swap its label for the OK-hand icon for SAVED_FEEDBACK_MS, then
  /// restore it. Called only after the save actually succeeded.
  function flashSaved(which: "prompt" | "params"): void {
    if (which === "prompt") {
      if (promptSavedTimer !== null) clearTimeout(promptSavedTimer);
      promptSaved = true;
      promptSavedTimer = setTimeout(() => {
        promptSaved = false;
        promptSavedTimer = null;
      }, SAVED_FEEDBACK_MS);
    } else {
      if (paramsSavedTimer !== null) clearTimeout(paramsSavedTimer);
      paramsSaved = true;
      paramsSavedTimer = setTimeout(() => {
        paramsSaved = false;
        paramsSavedTimer = null;
      }, SAVED_FEEDBACK_MS);
    }
  }

  // Drop any pending confirmation timer if the view is left mid-countdown.
  onDestroy(() => {
    if (promptSavedTimer !== null) clearTimeout(promptSavedTimer);
    if (paramsSavedTimer !== null) clearTimeout(paramsSavedTimer);
  });

  // Save the current editor text under the typed name (overwriting if it
  // exists), then select it. The saved text becomes the active prompt.
  async function savePrompt(): Promise<void> {
    const name = promptName.trim();
    if (name === "") return;
    errorMessage = null;
    try {
      await invoke("save_prompt", { name, content: systemPrompt });
      await loadPrompts();
      selectedPrompt = name;
      promptEdited = true;
      await store?.set(K.selectedPrompt, name);
      await store?.set(K.promptEdited, true);
      await store?.set(K.prompt, systemPrompt);
      flashSaved("prompt");
    } catch (err) {
      errorMessage = String(err);
    }
  }

  // Open the confirmation dialog for deleting the selected prompt.
  function requestDeletePrompt(): void {
    if (selectedPrompt === null) return;
    confirmDeleteOpen = true;
  }

  // Confirmed deletion: remove the file, clear the selection and refresh.
  async function confirmDeletePrompt(): Promise<void> {
    confirmDeleteOpen = false;
    if (selectedPrompt === null) return;
    errorMessage = null;
    try {
      await invoke("delete_prompt", { name: selectedPrompt });
      selectedPrompt = null;
      await store?.set(K.selectedPrompt, null);
      await loadPrompts();
    } catch (err) {
      errorMessage = String(err);
    }
  }

  // Refresh the saved parameter-profile list from disk, dropping a stale
  // selection that no longer maps to a file.
  async function loadParamProfiles(): Promise<void> {
    try {
      paramProfiles = await invoke<string[]>("list_param_profiles");
      if (
        selectedParamProfile &&
        !paramProfiles.includes(selectedParamProfile)
      ) {
        selectedParamProfile = null;
      }
    } catch {
      paramProfiles = [];
    }
  }

  // Load the selected profile's values into the two sliders and persist them,
  // so the chosen pause/max-listen pair becomes active and survives reloads.
  async function onSelectParamProfile(): Promise<void> {
    // "No profile" selected: clear the name field and stored selection so the
    // session runs without any database access; do not load any values.
    if (!selectedParamProfile) {
      paramProfileName = "";
      await store?.set(K.selectedParams, null);
      return;
    }
    try {
      const profile = await invoke<{
        silenceSec: number;
        maxListenSec: number;
      }>("read_param_profile", { name: selectedParamProfile });
      silenceSec = profile.silenceSec;
      maxListenSec = profile.maxListenSec;
      paramProfileName = selectedParamProfile;
      await store?.set(K.silence, silenceSec);
      await store?.set(K.maxListen, maxListenSec);
      await store?.set(K.selectedParams, selectedParamProfile);
    } catch (err) {
      errorMessage = String(err);
    }
  }

  // Save the current pause/max-listen pair under the typed name (overwriting
  // if it exists), select it, and mirror the profile into the session
  // database so its sessions can be saved/retrieved later.
  async function saveParamProfile(): Promise<void> {
    const name = paramProfileName.trim();
    if (name === "") return;
    errorMessage = null;
    try {
      await invoke("save_param_profile", {
        name,
        profile: { silenceSec, maxListenSec },
      });
      // Mirror the profile into the session database (no-op if it already
      // exists). Best-effort: a DB failure must not block saving the file —
      // the row self-heals on the next session record.
      await invoke("agent_ensure_profile", { name }).catch((e) =>
        console.warn("agent_ensure_profile failed:", e),
      );
      await loadParamProfiles();
      selectedParamProfile = name;
      await store?.set(K.selectedParams, name);
      flashSaved("params");
    } catch (err) {
      errorMessage = String(err);
    }
  }

  // Open the confirmation dialog for deleting the selected profile.
  function requestDeleteParamProfile(): void {
    if (selectedParamProfile === null) return;
    confirmDeleteParamOpen = true;
  }

  // Confirmed deletion: remove the profile's session history (cascade) and its
  // file, clear the selection and refresh.
  async function confirmDeleteParamProfile(): Promise<void> {
    confirmDeleteParamOpen = false;
    if (selectedParamProfile === null) return;
    errorMessage = null;
    try {
      // Remove the history first (ON DELETE CASCADE drops its sessions), then
      // the profile file. The DB call is best-effort, so the file deletion —
      // the source of truth for the profile — always proceeds.
      await invoke("agent_delete_profile", {
        name: selectedParamProfile,
      }).catch((e) => console.warn("agent_delete_profile failed:", e));
      await invoke("delete_param_profile", { name: selectedParamProfile });
      selectedParamProfile = null;
      await store?.set(K.selectedParams, null);
      await loadParamProfiles();
    } catch (err) {
      errorMessage = String(err);
    }
  }

  // Synthesize the sample line and play it, driving the avatar's mouth from the
  // live amplitude (RMS x sensitivity), exactly as the real conversation will.
  async function playTest(): Promise<void> {
    if (!piperPath || !selectedVoice) return;
    testing = true;
    errorMessage = null;
    try {
      const buffer = await invoke<ArrayBuffer>("tts_synthesize", {
        piperPath,
        language,
        gender: avatar,
        text: $t("session.voiceSampleText"),
        voice: selectedVoice,
        speed: voiceSpeed,
      });

      audioCtx ??= new AudioContext();
      if (audioCtx.state === "suspended") await audioCtx.resume();
      const audio = await audioCtx.decodeAudioData(toArrayBuffer(buffer));

      const source = audioCtx.createBufferSource();
      source.buffer = audio;
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 1024;
      const samples = new Float32Array(analyser.fftSize);
      source.connect(analyser);
      analyser.connect(audioCtx.destination);

      let raf = 0;
      const tick = () => {
        analyser.getFloatTimeDomainData(samples);
        let sum = 0;
        for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
        const rms = Math.sqrt(sum / samples.length);
        mouthLevel = Math.min(1, rms * sensitivity * 3);
        raf = requestAnimationFrame(tick);
      };
      source.onended = () => {
        cancelAnimationFrame(raf);
        mouthLevel = 0;
        testing = false;
      };
      source.start();
      raf = requestAnimationFrame(tick);
    } catch (err) {
      errorMessage = String(err);
      testing = false;
    }
  }
</script>

<button class="back" onclick={() => goto("/")}>{$t("test.back")}</button>

<div class="wrap">
  <header>
    <h1>{$t("session.title")}</h1>
    <p class="lead">{$t("session.lead")}</p>
  </header>

  <div class="panel">
    <!-- Avatar -->
    <div class="field">
      <span class="label">{$t("session.avatarLabel")}</span>
      <div class="segmented">
        <button class:on={avatar === "male"} onclick={() => setAvatar("male")}
          >{$t("session.avatarMale")}</button
        >
        <button
          class:on={avatar === "female"}
          onclick={() => setAvatar("female")}
          >{$t("session.avatarFemale")}</button
        >
      </div>
    </div>

    <div class="divider"></div>

    <!-- Head movement (always-on amplitude) -->
    <div class="ctrl">
      <span>{$t("session.headMovement")}</span>
      <input
        type="range"
        min="0"
        max="2"
        step="0.1"
        bind:value={headMovement}
        oninput={() => persistNumber(K.headMovement, headMovement)}
      />
      <output>{headMovement.toFixed(1)}</output>
    </div>

    <!-- Mouth sensitivity -->
    <div class="ctrl">
      <span>{$t("session.mouthSensitivity")}</span>
      <input
        type="range"
        min="0.4"
        max="4"
        step="0.1"
        bind:value={sensitivity}
        oninput={() => persistNumber(K.sensitivity, sensitivity)}
      />
      <output>{sensitivity.toFixed(1)}</output>
    </div>

    <!-- Voice speed: relative multiplier over the voice's own tuned rate. -->
    <div class="ctrl">
      <span>{$t("session.voiceSpeed")}</span>
      <input
        type="range"
        min="0.7"
        max="1.4"
        step="0.05"
        bind:value={voiceSpeed}
        oninput={() => persistNumber(K.voiceSpeed, voiceSpeed)}
      />
      <output>{voiceSpeed.toFixed(2)}</output>
    </div>

    <!-- Voice -->
    <div class="ctrl">
      <span>{$t("session.voice")}</span>
      {#if voices.length > 0}
        <select bind:value={selectedVoice} onchange={onVoiceChange}>
          {#each voices as v}
            <option value={v}>{v}</option>
          {/each}
        </select>
      {:else}
        <span class="empty"
          >{$t("session.noVoices", { language, gender: avatar })}</span
        >
      {/if}
      <span></span>
    </div>

    <!-- Microphone -->
    <div class="ctrl">
      <span>{$t("session.microphone")}</span>
      {#if microphones.length > 0}
        <select
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
      <span></span>
    </div>

    <!-- Camera -->
    <div class="ctrl">
      <span>{$t("session.camera")}</span>
      {#if cameras.length > 0}
        <select
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
      <span></span>
    </div>

    <!-- Live avatar preview, in the spot it will occupy during the session -->
    <div class="stage">
      <AvatarStage
        {avatar}
        {headMovement}
        mouth={mouthLevel}
        title={$t("session.avatarPreviewTitle")}
      />
    </div>

    <!-- Audio test -->
    <div class="row">
      <button onclick={playTest} disabled={!canTest}>
        {testing ? $t("session.testPlaying") : $t("session.testButton")}
      </button>
      {#if !piperPath}
        <span class="note">{$t("session.piperNote")}</span>
      {/if}
    </div>

    <div class="divider"></div>

    <!-- Listening timing -->
    <div class="ctrl">
      <span>{$t("session.pauseLabel")}</span>
      <input
        type="range"
        min="0.5"
        max="5"
        step="0.1"
        bind:value={silenceSec}
        oninput={() => persistNumber(K.silence, silenceSec)}
      />
      <output>{silenceSec.toFixed(1)} s</output>
    </div>
    <p class="hint">{$t("session.pauseHint")}</p>

    <div class="ctrl">
      <span>{$t("session.maxListenLabel")}</span>
      <input
        type="range"
        min="10"
        max="180"
        step="5"
        bind:value={maxListenSec}
        oninput={() => persistNumber(K.maxListen, maxListenSec)}
      />
      <output>{maxListenSec} s</output>
    </div>
    <p class="hint">{$t("session.maxListenHint")}</p>

    <!-- Saved parameter profiles: load, save, delete (files in <app
         config>/params). Lets the pause + max-listen pair be switched per
         person. -->
    <div class="prompt-store">
      <span class="label">{$t("session.savedParamsLabel")}</span>
      <p class="hint">{$t("session.savedParamsHint")}</p>
      <div class="prompt-row">
        <select
          aria-label={$t("session.loadParamsLabel")}
          bind:value={selectedParamProfile}
          onchange={onSelectParamProfile}
        >
          <option value={null}>{$t("session.noProfile")}</option>
          {#each paramProfiles as p}
            <option value={p}>{p}</option>
          {/each}
        </select>
        <button
          type="button"
          class="danger"
          onclick={requestDeleteParamProfile}
          disabled={selectedParamProfile === null}
        >
          {$t("session.deleteParams")}
        </button>
      </div>
      <div class="save-row">
        <span class="label">{$t("session.saveParamsLabel")}</span>
        <div class="save-field">
          <input
            type="text"
            bind:value={paramProfileName}
            placeholder={$t("session.saveParamsName")}
            spellcheck="false"
          />
          <button
            type="button"
            class="save-btn"
            class:saved={paramsSaved}
            onclick={saveParamProfile}
            disabled={paramProfileName.trim() === "" || paramsSaved}
          >
            {paramsSaved ? "👌" : $t("session.saveParams")}
          </button>
        </div>
      </div>
    </div>

    <div class="divider"></div>

    <!-- System prompt -->
    <div class="field">
      <div class="label-row">
        <span class="label">{$t("session.systemPromptLabel")}</span>
        {#if promptEdited || systemPrompt === positiveThinkingPrompt}
          <button class="link" onclick={resetPrompt}
            >{$t("session.resetPrompt")}</button
          >
        {/if}
        {#if systemPrompt != positiveThinkingPrompt}
          <button class="link" onclick={setPositiveThinkingPrompt}
            >{$t("session.positiveThinking")}</button
          >
        {/if}
      </div>
      <textarea
        rows="9"
        bind:value={systemPrompt}
        oninput={onPromptInput}
        spellcheck="false"
      ></textarea>
      <p class="hint">{hint}</p>
      <p class="prompt-disclaimer">{$t("session.promptDisclaimer")}</p>
      <!-- Saved prompts: load, save, delete (files in <app config>/prompts) -->
      <div class="prompt-store">
        <span class="label">{$t("session.savedPromptsLabel")}</span>
        <div class="prompt-row">
          <select
            aria-label={$t("session.loadPromptLabel")}
            bind:value={selectedPrompt}
            onchange={onSelectPrompt}
            disabled={prompts.length === 0}
          >
            <option value={null} disabled>
              {prompts.length === 0
                ? $t("session.noSavedPrompts")
                : $t("session.loadPromptPlaceholder")}
            </option>
            {#each prompts as p}
              <option value={p}>{p}</option>
            {/each}
          </select>
          <button
            type="button"
            class="danger"
            onclick={requestDeletePrompt}
            disabled={selectedPrompt === null}
          >
            {$t("session.deletePrompt")}
          </button>
        </div>
        <div class="save-row">
          <span class="label">{$t("session.savePromptLabel")}</span>
          <div class="save-field">
            <input
              type="text"
              bind:value={promptName}
              placeholder={$t("session.savePromptName")}
              spellcheck="false"
            />
            <button
              type="button"
              class="save-btn"
              class:saved={promptSaved}
              onclick={savePrompt}
              disabled={promptName.trim() === "" || promptSaved}
            >
              {promptSaved ? "👌" : $t("session.savePrompt")}
            </button>
          </div>
        </div>
      </div>
    </div>

    {#if errorMessage}
      <p class="error">{errorMessage}</p>
    {/if}
  </div>

  <!-- Opens the session-history popup for the currently selected profile. -->
  <button
    class="history"
    disabled={!selectedParamProfile}
    onclick={() => (showHistory = true)}
  >
    {$t("session.resultsHistoryButton")}
  </button>
  <!-- Starts the live session view; gated on a voice and the Piper executable. -->
  <button class="start" disabled={!canStart} onclick={onStart}>
    {$t("session.startButton")}
  </button>
  {#if !canStart}
    <p class="hint center">{$t("session.startLocked")}</p>
  {/if}

  <ConfirmDialog
    open={confirmDeleteOpen}
    title={$t("session.deleteConfirmTitle")}
    message={$t("session.deleteConfirmMessage", { name: selectedPrompt ?? "" })}
    confirmLabel={$t("session.deleteConfirmConfirm")}
    cancelLabel={$t("session.deleteConfirmCancel")}
    destructive
    onConfirm={confirmDeletePrompt}
    onCancel={() => (confirmDeleteOpen = false)}
  />

  <ConfirmDialog
    open={confirmDeleteParamOpen}
    title={$t("session.deleteParamsConfirmTitle")}
    message={$t("session.deleteParamsConfirmMessage", {
      name: selectedParamProfile ?? "",
    })}
    confirmLabel={$t("session.deleteConfirmConfirm")}
    cancelLabel={$t("session.deleteConfirmCancel")}
    destructive
    onConfirm={confirmDeleteParamProfile}
    onCancel={() => (confirmDeleteParamOpen = false)}
  />

  {#if showHistory && selectedParamProfile}
    <SessionHistory
      profileName={selectedParamProfile}
      onClose={() => (showHistory = false)}
    />
  {/if}
</div>

<style>
  :global(:root) {
    --bg: #14171c;
    --bg2: #1c2128;
    --panel: #1a1e25;
    --line: #2c333d;
    --txt: #e7e9ee;
    --muted: #9aa3b0;
    --accent: #c9a24b;
    --accent-soft: #3a3320;
    --radius: 16px;
  }
  .wrap {
    max-width: 560px;
    margin: 0 auto;
    padding: 32px 20px 64px;
    display: flex;
    flex-direction: column;
    gap: 22px;
    font-family: "Hanken Grotesk", system-ui, sans-serif;
    color: var(--txt);
  }
  .wrap * {
    box-sizing: border-box;
  }
  header {
    text-align: center;
  }
  header h1 {
    font-family: "Hanken Grotesk", system-ui, sans-serif;
    font-weight: 600;
    font-size: 28px;
    margin: 0 0 6px;
    color: #1c2128;
    letter-spacing: 0.2px;
  }
  .lead {
    margin: 0;
    color: var(--muted);
    font-size: 15px;
  }
  .panel {
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: var(--radius);
    padding: 18px;
  }
  .field {
    margin: 14px 0;
  }
  .field:first-child {
    margin-top: 4px;
  }
  .label {
    display: block;
    font-size: 13px;
    color: var(--muted);
    margin-bottom: 8px;
  }
  .label-row {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
  }
  .segmented {
    display: inline-flex;
    gap: 8px;
  }
  button {
    font-family: inherit;
    font-size: 14px;
    color: var(--txt);
    cursor: pointer;
    background: var(--bg2);
    border: 1px solid var(--line);
    border-radius: 10px;
    padding: 9px 14px;
    transition:
      border-color 0.15s,
      background 0.15s;
  }
  button:hover:not(:disabled) {
    border-color: #46505d;
  }
  button.on {
    background: var(--accent-soft);
    border-color: var(--accent);
    color: var(--accent);
  }
  button:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
  /* Keep the save buttons at a constant width so swapping the label for the
     confirmation icon does not make the row jump. */
  .save-btn {
    min-width: 8rem;
  }
  /* During the confirmation the button is disabled, but it must stay clearly
     readable, so it overrides the dimmed :disabled look with the accent
     styling already used for active buttons. */
  .save-btn.saved:disabled {
    opacity: 1;
    background: var(--accent-soft);
    border-color: var(--accent);
    color: var(--accent);
  }
  .back {
    position: fixed;
    top: 20px;
    left: 20px;
    z-index: 10;
    padding: 8px 16px;
    font-size: 14px;
    border-radius: 6px;
    border: none;
    background: #3a7bd5;
    color: white;
    cursor: pointer;
    font-family: "Hanken Grotesk", system-ui, sans-serif;
  }
  .ctrl {
    display: grid;
    grid-template-columns: 150px 1fr 60px;
    align-items: center;
    gap: 12px;
    margin: 12px 0;
  }
  .ctrl span:first-child {
    font-size: 13px;
    color: var(--muted);
  }
  .ctrl output {
    font-size: 13px;
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  .ctrl .empty {
    font-size: 12.5px;
    color: var(--muted);
    font-style: italic;
  }
  input[type="range"] {
    width: 100%;
    accent-color: var(--accent);
  }
  select {
    -webkit-appearance: none;  /* Forces WebKitGTK to drop native GTK rendering */ 
    appearance: none;
    font-family: inherit;
    font-size: 14px;
    color: var(--txt);
    background: var(--bg2);
    border: 1px solid var(--line);
    border-radius: 10px;
    padding: 8px 10px;
    width: 100%;
  }
  select, ::picker(select) {
  appearance: base-select;
  }
  select::picker-icon {
  color: var(--txt)
  }
  option { color: #1c2128; background: #e7e9ee}
  textarea {
    width: 100%;
    font-family: inherit;
    font-size: 13.5px;
    line-height: 1.5;
    color: var(--txt);
    background: var(--bg2);
    border: 1px solid var(--line);
    border-radius: 10px;
    padding: 11px 12px;
    resize: vertical;
  }
  input:focus-visible,
  select:focus-visible,
  textarea:focus-visible,
  button:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  .row {
    display: flex;
    justify-content: center;
    align-items: center;
    gap: 12px;
    margin: 14px 0 2px;
    flex-wrap: wrap;
  }
  .note,
  .hint {
    font-size: 12.5px;
    color: var(--muted);
    line-height: 1.5;
  }
  .hint {
    margin: 6px 0 0;
  }
  .hint.center {
    text-align: center;
  }
  .link {
    background: none;
    border: none;
    padding: 0;
    color: var(--accent);
    font-size: 12.5px;
    text-decoration: underline;
    border-radius: 0;
  }
  .divider {
    height: 1px;
    background: var(--line);
    margin: 16px 0;
  }
  .error {
    color: #e0796b;
    font-size: 13px;
    margin: 12px 0 0;
  }
  .stage {
    margin: 0 auto;
    width: 300px;
    max-width: 92vw;
    aspect-ratio: 360 / 378;
    border-radius: 22px;
    overflow: hidden;
    border: 1px solid var(--line);
    background: radial-gradient(
      75% 60% at 50% 38%,
      #3a4150 0%,
      #232932 55%,
      #1a1f27 100%
    );
    box-shadow: 0 24px 60px -24px rgba(0, 0, 0, 0.7);
  }
  .start {
    align-self: center;
    min-width: 220px;
    padding: 13px 20px;
    font-size: 15px;
    background: var(--accent-soft);
    border-color: var(--accent);
    color: var(--accent);
  }
  .history {
    align-self: center;
    min-width: 220px;
    padding: 11px 20px;
    font-size: 14px;
  }
  .history:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .prompt-disclaimer {
    margin: 10px 0 0;
    padding: 10px 12px;
    font-size: 12px;
    line-height: 1.45;
    color: var(--muted);
    background: var(--bg2);
    border: 1px solid var(--line);
    border-left: 3px solid #c98a2b;
    border-radius: 8px;
  }
  .prompt-store {
    margin-top: 12px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .prompt-store .label {
    margin-bottom: 0;
    margin-top: 10px;
  }
  .prompt-row {
    display: flex;
    gap: 8px;
  }
  .prompt-row select,
  .save-field input[type="text"] {
    flex: 1;
    min-width: 0;
  }
  .prompt-row button,
  .save-field button {
    white-space: nowrap;
  }

  /* Save rows: label on its own line, input + button on the line below, so the
     input keeps enough width even with longer translated labels. */
  .save-row {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .save-field {
    display: flex;
    gap: 8px;
  }
  .save-field input[type="text"] {
    font-family: inherit;
    font-size: 14px;
    color: var(--txt);
    background: var(--bg2);
    border: 1px solid var(--line);
    border-radius: 10px;
    padding: 8px 10px;
  }
  .prompt-row button.danger {
    border-color: #6b2f2a;
    color: #e0796b;
  }
  .prompt-row button.danger:hover:not(:disabled) {
    border-color: #8a3a33;
    background: #2a1f1d;
  }
  @media (prefers-reduced-motion: reduce) {
    button {
      transition: none;
    }
  }
</style>
