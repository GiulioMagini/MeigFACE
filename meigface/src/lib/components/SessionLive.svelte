<script lang="ts">
  //! Live session view
  //!
  //! Flow on entry:
  //!   1. load settings, the fitted gaze model and the calibration reference;
  //!   2. ask for the conversation length (1-4 min dropdown);
  //!   3. if a calibration exists, ask whether to run the optional bias
  //!      correction (BiasCorrection) before any engine starts;
  //!   4. start the LLM + STT engines and the conversation loop.
  //!
  //! During the session: the avatar sits at the calibration silhouette's rect;
  //! the webcam tracker runs top-right with the head-position feedback; the
  //! conversational loop runs; a transcript panel is on the right; live
  //! eye-contact scoring is on the left; a countdown sits below the gaze
  //! indicator. Every frame the fitted model predicts the gaze and tests
  //! whether it lands on the avatar's face, driving the halo, the indicator
  //! and the scoring.
  //!
  //! When the countdown reaches zero the conversation ends gracefully
  //! (Conversation.requestEnd): the current turn finishes, the avatar speaks a
  //! closing line, then onEnded switches to the results screen.
  import { onMount, onDestroy } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import { load } from "@tauri-apps/plugin-store";
  import { locale, t } from "$lib/i18n";
  import AvatarStage from "$lib/avatar/AvatarStage.svelte";
  import WebcamTracker from "$lib/components/WebcamTracker.svelte";
  import ErrorDialog from "$lib/components/ErrorDialog.svelte";
  import ConfirmDialog from "$lib/components/ConfirmDialog.svelte";
  import BiasCorrection from "$lib/components/BiasCorrection.svelte";
  import SessionHistory from "$lib/components/SessionHistory.svelte";
  import {
    PUPPET_HEIGHT_FRACTION,
    PUPPET_VIEWBOX,
    puppetFaceTarget,
  } from "$lib/avatar/layout";
  import {
    extractFeatures,
    headAngles,
    predictGaze,
  } from "$lib/tracking/regression";
  import { Conversation, type ConversationState } from "$lib/conversation";
  import {
    TrackerState,
    type EyeReference,
    type GazeModel,
    type TrackingFrame,
  } from "$lib/tracking/types";

  type Gender = "male" | "female";
  type Trend = "up" | "down" | "flat";

  // One recorded exchange shown in the transcript panel.
  interface Turn {
    role: "user" | "assistant";
    text: string;
  }

  // Settings captured at mount, consumed by startSession() after the dialogs.
  interface SessionConfig {
    serverPath: string;
    modelPath: string;
    gpuLayers: number;
    whisperPath: string;
    whisperModelPath: string;
    sttGpuDevice?: number;
    piperPath: string;
    voice: string | undefined;
    systemPrompt: string;
    sensitivity: number;
    voiceSpeed: number;
    silenceSec: number;
    maxListenSec: number;
  }

  // Subset of the backend SessionRow used to build the startup context block.
  interface SessionRow {
    endedAt: string;
    contactPct: number;
    streakSec: number;
    pauses: number;
    summary: string;
  }

  // Aggregate stats over a profile's sessions, shown on the results screen.
  interface ProfileStats {
    count: number;
    avgContactPct: number;
    avgStreakSec: number;
    avgPauses: number;
  }

  interface Props {
    /** Called when the session ends, so the route switches back to setup. */
    onEnd: () => void;
  }
  let { onEnd }: Props = $props();

  // View lifecycle:
  //   "loading"   - reading settings
  //   "ask-time"  - choosing the conversation length
  //   "ask-bias"  - ConfirmDialog asking to refine the calibration
  //   "bias"      - running the bias-correction capture
  //   "starting"  - engines coming up
  //   "active"    - conversation running (countdown + scoring live)
  //   "results"   - session ended: final eye-contact metrics
  //   "error"     - fatal startup error (a dialog offers a way back)
  type Phase =
    | "loading"
    | "ask-time"
    | "ask-bias"
    | "bias"
    | "starting"
    | "active"
    | "results"
    | "error";

  // Conversation-length choices, in minutes.
  const DURATION_CHOICES = [1, 2, 3, 4] as const;

  // --- Store keys (shared settings.json). ---
  const STORE_FILE = "settings.json";
  const KEY_SERVER = "llm.serverPath";
  const KEY_MODEL = "llm.modelPath";
  const KEY_GPU = "llm.gpuLayers";
  const KEY_WHISPER = "llm.whisperPath";
  const KEY_WHISPER_MODEL = "llm.whisperModelPath";
  const KEY_STT_GPU = "stt.gpuDevice";
  const KEY_PIPER = "llm.piperPath";
  const KEY_GAZE_MODEL = "calibration.model";
  const KEY_REFERENCE = "calibration.reference";
  const KEY_AVATAR = "session.avatar";
  const KEY_HEAD = "session.headMovement";
  const KEY_SENS = "session.mouthSensitivity";
  const KEY_SPEED = "session.voiceSpeed";
  const KEY_VOICE = "session.voice";
  const KEY_SILENCE = "session.silenceSec";
  const KEY_MAX_LISTEN = "session.maxListenSec";
  const KEY_PROMPT = "session.systemPrompt";
  const KEY_SELECTED_PARAMS = "session.selectedParams";

  // Same strict drift tolerance as the calibration test view (3% of frame).
  const DRIFT_TOLERANCE = 0.03;

  // Runtime gaze pipeline tuning, mirroring the calibration test view.
  const GAZE_SMOOTHING = 0.4; // EMA on the predicted point
  const POSE_SMOOTHING = 0.25; // stronger EMA on yaw/pitch (noisier)
  const CONTACT_SMOOTHING = 0.25;
  const CONTACT_ON = 0.6;
  const CONTACT_OFF = 0.4;
  // Asymmetric look-away grace: re-entering the oval counts instantly, but a
  // gaze that leaves it is only treated as "broken" if it stays out for this
  // long continuously. Absorbs tracker jitter and eye blinks (~300-400 ms) so
  // they neither flip the halo nor cost points. Tunable after field testing.
  const LOOKAWAY_GRACE_MS = 400;
  // Trend window: how strongly recent contact weighs vs the whole session,
  // and the margin (8 pp) before recent counts as up/down rather than flat.
  const TREND_WINDOW_MS = 15000;
  const TREND_MARGIN = 0.08;

  // Conversation language follows the global locale, exactly like SessionSetup.
  const language = $derived($locale ?? "it");

  // Avatar/animation state driving AvatarStage.
  let avatar = $state<Gender>("male");
  let headMovement = $state(1);
  let mouth = $state(0);

  // View lifecycle, live conversation phase, and error text.
  let phase = $state<Phase>("loading");
  let convState = $state<ConversationState>("idle");
  let turnError = $state<string | null>(null);
  let errorMessage = $state("");

  // Webcam tracker state plus head-position feedback.
  let frame = $state<TrackingFrame | null>(null);
  let trackerState = $state<TrackerState>(TrackerState.Idle);
  let reference = $state<EyeReference | null>(null);
  let eyesOutOfPosition = $state(false);

  // Eye-contact state: the fitted gaze model and the debounced on-target flag.
  let gazeModel = $state<GazeModel | null>(null);
  let onTarget = $state(false);

  // Plain (non-reactive) EMA accumulators for the gaze pipeline.
  let smoothedYaw: number | null = null;
  let smoothedPitch: number | null = null;
  let smoothedX: number | null = null;
  let smoothedY: number | null = null;
  let contactEma = 0;
  let contactState = false;

  // Timestamp of the first frame the gaze fell outside the oval during the
  // current potential look-away; null while inside. Drives LOOKAWAY_GRACE_MS.
  let outsideSinceMs: number | null = null;
  // Scoring is frozen once the closing phrase begins (see onClosing): the
  // scripted farewell is not part of the exercise and must not change points.
  let scoringFrozen = false;

  // Conversation length (minutes) and the live countdown.
  let durationMin = $state(2);
  let remainingSec = $state(0);
  let deadlineMs: number | null = null;
  let timeUpFired = false;

  // Plain (non-reactive) scoring accumulators, updated each gaze frame; the
  // display state below is snapshotted from them by the countdown tick.
  let totalMs = 0;
  let contactMs = 0;
  let currentStreakMs = 0;
  let longestStreakMs = 0;
  let lookAways = 0;
  let lastTickMs: number | null = null;
  let recentEma = 0; // recent contact fraction (for the trend arrow)

  // Scoring values shown in the panel / results (snapshotted, not per-frame).
  let scoreContactPct = $state(0);
  let scoreStreakSec = $state(0);
  let scorePauses = $state(0);
  let scoreTrend = $state<Trend>("flat");
  // --- Session-history persistence  ---
  // Selected param-profile name = the user key; null means no DB access.
  let profileName = $state<string | null>(null);
  // ISO-8601 timestamp captured when the conversation goes active.
  let sessionStartedAt = "";
  // Aggregate stats for the results screen, loaded after recording a session.
  let stats = $state<ProfileStats | null>(null);
  // Whether the session-history popup is open.
  let showHistory = $state(false);

  // Live transcript of the exchanges.
  let transcript = $state<Turn[]>([]);
  let transcriptEl = $state<HTMLDivElement | null>(null);

  type EngineStatus = { running: boolean; base_url: string | null };

  let store: Awaited<ReturnType<typeof load>> | null = null;
  let cfg: SessionConfig | null = null;
  let conversation: Conversation | null = null;

  onMount(async () => {
    try {
      store = await load(STORE_FILE, { defaults: {}, autoSave: true });

      const serverPath = await store.get<string>(KEY_SERVER);
      const modelPath = await store.get<string>(KEY_MODEL);
      const gpuLayers = (await store.get<number>(KEY_GPU)) ?? 0;
      const whisperPath = await store.get<string>(KEY_WHISPER);
      const whisperModelPath = await store.get<string>(KEY_WHISPER_MODEL);
      const sttGpuDevice = (await store.get<number>(KEY_STT_GPU)) ?? undefined;
      const piperPath = await store.get<string>(KEY_PIPER);

      const savedAvatar = await store.get<Gender>(KEY_AVATAR);
      const savedHead = await store.get<number>(KEY_HEAD);
      const savedSens = await store.get<number>(KEY_SENS);
      const savedSpeed = await store.get<number>(KEY_SPEED);
      const voice = (await store.get<string>(KEY_VOICE)) ?? undefined;
      const silenceSec = (await store.get<number>(KEY_SILENCE)) ?? 2;
      const maxListenSec = (await store.get<number>(KEY_MAX_LISTEN)) ?? 120;
      const systemPrompt = (await store.get<string>(KEY_PROMPT)) ?? "";
      gazeModel = (await store.get<GazeModel>(KEY_GAZE_MODEL)) ?? null;
      reference = (await store.get<EyeReference>(KEY_REFERENCE)) ?? null;
      profileName = (await store.get<string>(KEY_SELECTED_PARAMS)) ?? null;

      if (savedAvatar) avatar = savedAvatar;
      if (typeof savedHead === "number") headMovement = savedHead;
      const sensitivity = typeof savedSens === "number" ? savedSens : 1.7;
      const voiceSpeed = typeof savedSpeed === "number" ? savedSpeed : 1;

      if (
        !serverPath ||
        !modelPath ||
        !whisperPath ||
        !whisperModelPath ||
        !piperPath
      ) {
        throw new Error($t("session.missingEngines"));
      }

      cfg = {
        serverPath,
        modelPath,
        gpuLayers,
        whisperPath,
        whisperModelPath,
        sttGpuDevice,
        piperPath,
        voice,
        systemPrompt,
        sensitivity,
        voiceSpeed,
        silenceSec,
        maxListenSec,
      };

      // Always choose the length first, then offer the bias gate.
      phase = "ask-time";
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : String(err);
      phase = "error";
    }
  });

  onDestroy(() => {
    conversation?.stop();
    conversation = null;
    void releaseEngines();
  });

  /// Stop the LLM and STT sidecars, freeing their RAM/VRAM. Called as soon as
  /// the session has been recorded and summarized: nothing needs them again
  /// until a new session starts (startSession restarts whatever is stopped),
  /// so keeping the models resident while the user reads the results screen
  /// only wastes memory. Idempotent, so onDestroy can call it again safely.
  async function releaseEngines(): Promise<void> {
    await invoke("llm_stop").catch(() => {});
    await invoke("stt_stop").catch(() => {});
  }

  // Bring up the engines and start the conversation loop. Called after the
  // length + bias gates resolve.
  async function startSession(): Promise<void> {
    if (!cfg) {
      errorMessage = $t("session.missingEngines");
      phase = "error";
      return;
    }
    phase = "starting";
    try {
      let llm = await invoke<EngineStatus>("llm_status");
      if (!llm.running) {
        llm = await invoke<EngineStatus>("llm_start", {
          serverPath: cfg.serverPath,
          modelPath: cfg.modelPath,
          nGpuLayers: cfg.gpuLayers,
        });
      }

      let stt = await invoke<EngineStatus>("stt_status");
      if (!stt.running) {
        stt = await invoke<EngineStatus>("stt_start", {
          serverPath: cfg.whisperPath,
          modelPath: cfg.whisperModelPath,
          gpuDevice: cfg.sttGpuDevice,
        });
      }
      if (!stt.base_url) {
        throw new Error($t("session.missingEngines"));
      }

      // Augment the system prompt with topics from previous sessions (only if
      // a profile is selected and it has history) and stamp the start time.
      const systemPrompt = await buildSystemPrompt();
      sessionStartedAt = new Date().toISOString();

      conversation = new Conversation({
        sttBaseUrl: stt.base_url,
        piperPath: cfg.piperPath,
        language,
        gender: avatar,
        voice: cfg.voice,
        systemPrompt,
        mouthGain: cfg.sensitivity * 3,
        voiceSpeed: cfg.voiceSpeed,
        vad: {
          silenceDurationMs: Math.round(cfg.silenceSec * 1000),
          maxDurationMs: Math.round(cfg.maxListenSec * 1000),
        },
        onState: (s) => {
          convState = s;
          if (s === "listening") turnError = null;
        },
        onMouth: (openness) => (mouth = openness),
        onUserText: (text) =>
          (transcript = [...transcript, { role: "user", text }]),
        onReply: (text) =>
          (transcript = [...transcript, { role: "assistant", text }]),
        onError: (e) => (turnError = e.message),
        onClosing: () => {
          // Closing phrase starting: freeze scoring so the farewell (and the
          // relaxed gaze while the user reads it) can't change the result.
          scoringFrozen = true;
        },
        onEnded: () => {
          // The time-up closing line has been spoken: freeze the final
          // metrics, show the results screen, and persist the session (the
          // metrics save immediately; the LLM summary fills in afterwards).
          snapshotScore();
          phase = "results";
          void finalizeSession();
        },
      });

      phase = "active";
      await conversation.start();
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : String(err);
      phase = "error";
    }
  }

  // --- Session-history helpers ---

  // Build the conversation's system prompt. With a selected profile that has
  // prior summaries, ask the LLM to extract the recurring topics from the last
  // two sessions and append them; otherwise return the base prompt unchanged.
  // Two (limit: 2, see below) keeps the context small enough for 3B-class models and below.
  async function buildSystemPrompt(): Promise<string> {
    const base = cfg!.systemPrompt;
    if (!profileName) return base;
    try {
      const recent = await invoke<SessionRow[]>("agent_list_sessions", {
        name: profileName,
        limit: 2,
      });
      const withTopics = recent.filter((s) => s.summary.trim() !== "");
      if (withTopics.length === 0) return base;
      // Oldest-first reads more naturally in the summaries block.
      const summaries = withTopics
        .slice()
        .reverse()
        .map((s) =>
          $t("session.summaryLine", {
            date: formatDate(s.endedAt),
            topics: s.summary,
            contact: Math.round(s.contactPct * 100),
            streak: formatTime(s.streakSec),
            pauses: s.pauses,
          }),
        )
        .join("\n");
      const reply = await invoke<string>("llm_chat", {
        messages: [
          { role: "user", content: $t("session.topicsPrompt", { summaries }) },
        ],
      });
      const topics = reply.trim();
      return topics === ""
        ? base
        : base + $t("session.topicsInjection", { topics });
    } catch (e) {
      // Non-fatal: start the session with the base prompt.
      console.warn("topics injection failed:", e);
      return base;
    }
  }

  // Persist the just-finished session. Metrics are written first (no LLM
  // needed), so they survive even if the summary generation or the LLM stop
  // races the close; the averages are then refreshed.
  async function recordSession(): Promise<void> {
    if (!profileName) return;
    const endedAt = new Date().toISOString();
    try {
      const id = await invoke<number>("agent_record_session", {
        name: profileName,
        session: {
          startedAt: sessionStartedAt || endedAt,
          endedAt,
          language,
          durationSec: durationMin * 60,
          contactPct: scoreContactPct,
          streakSec: scoreStreakSec,
          pauses: scorePauses,
        },
      });
      await loadStats();
      await generateSummary(id);
    } catch (e) {
      console.warn("agent_record_session failed:", e);
    }
  }

  // Ask the LLM for a topics-only summary of the transcript and store it on the
  // recorded session. Best-effort: a failure leaves the metrics intact.
  async function generateSummary(id: number): Promise<void> {
    const convo = transcript
      .map(
        (tn) =>
          `${tn.role === "user" ? $t("session.speakerYou") : $t("session.speakerAvatar")}: ${tn.text}`,
      )
      .join("\n");
    if (convo.trim() === "") return;
    try {
      const reply = await invoke<string>("llm_chat", {
        messages: [
          { role: "system", content: $t("session.summaryPrompt") },
          { role: "user", content: convo },
        ],
      });
      const summary = reply.trim();
      if (summary !== "") {
        await invoke("agent_set_session_summary", { id, summary });
      }
    } catch (e) {
      console.warn("agent_set_session_summary failed:", e);
    }
  }

  /// Persist the session and then release the engines. The release is in a
  /// finally so it also happens when there is no profile, when recording
  /// fails, or when the transcript is empty — cases where no summary is ever
  /// produced but the models would otherwise stay resident.
  async function finalizeSession(): Promise<void> {
    try {
      await recordSession();
    } finally {
      await releaseEngines();
    }
  }

  // Load the profile's aggregate stats for the results screen's average block.
  async function loadStats(): Promise<void> {
    if (!profileName) return;
    try {
      stats = await invoke<ProfileStats>("agent_profile_stats", {
        name: profileName,
      });
    } catch (e) {
      console.warn("agent_profile_stats failed:", e);
    }
  }

  // --- Length + bias gate handlers ---

  function onTimeConfirm(): void {
    if (gazeModel) phase = "ask-bias";
    else void startSession();
  }

  function onBiasAskConfirm(): void {
    phase = "bias";
  }

  function onBiasAskCancel(): void {
    void startSession();
  }

  async function onBiasComplete(corrected: GazeModel): Promise<void> {
    gazeModel = corrected;
    try {
      await store?.set(KEY_GAZE_MODEL, corrected);
    } catch {
      // Bias is a refinement; run this session with the in-memory model.
    }
    await startSession();
  }

  function onBiasSkip(): void {
    void startSession();
  }

  // --- Countdown ---

  // Snapshot the plain scoring accumulators into the display state.
  function snapshotScore(): void {
    scoreContactPct = totalMs > 0 ? contactMs / totalMs : 0;
    scoreStreakSec = longestStreakMs / 1000;
    scorePauses = lookAways;
    const overall = totalMs > 0 ? contactMs / totalMs : 0;
    const diff = recentEma - overall;
    scoreTrend = diff > TREND_MARGIN ? "up" : diff < -TREND_MARGIN ? "down" : "flat";
  }

  // Update the remaining time and live scores; fire the graceful end once.
  function tick(): void {
    if (deadlineMs === null) return;
    const remMs = Math.max(0, deadlineMs - performance.now());
    remainingSec = Math.ceil(remMs / 1000);
    snapshotScore();
    if (remMs <= 0 && !timeUpFired) {
      timeUpFired = true;
      conversation?.requestEnd($t("session.closingPhrase"));
    }
  }

  // While active, run the countdown clock (also snapshots the live scores).
  $effect(() => {
    if (phase !== "active") return;
    if (deadlineMs === null) {
      deadlineMs = performance.now() + durationMin * 60 * 1000;
    }
    const id = setInterval(tick, 250);
    tick();
    return () => clearInterval(id);
  });

  // mm:ss for the countdown, the streak and the results duration.
  function formatTime(totalSec: number): string {
    const s = Math.max(0, Math.floor(totalSec));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  }

  // Format an ISO-8601 timestamp as a date in the current UI language, used in
  // the previous-sessions summaries block.
  function formatDate(iso: string): string {
    const tag = language === "it" ? "it-IT" : "en-US";
    return new Date(iso).toLocaleDateString(tag, {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
  }

  // Head-position drift check (ported from the calibration test view).
  $effect(() => {
    if (!frame || !frame.faceDetected || !frame.landmarks) {
      eyesOutOfPosition = reference !== null;
      return;
    }
    if (reference) {
      const leftOuter = frame.landmarks[33];
      const rightOuter = frame.landmarks[263];
      const currentX = (leftOuter.x + rightOuter.x) / 2;
      const currentY = (leftOuter.y + rightOuter.y) / 2;
      const dx = Math.abs(currentX - reference.centerX);
      const dy = Math.abs(currentY - reference.centerY);
      eyesOutOfPosition = dx > DRIFT_TOLERANCE || dy > DRIFT_TOLERANCE;
    }
  });

  // Runtime gaze -> eye-contact + scoring. Mirrors the calibration test view's
  // pipeline; updates the debounced on-target flag (halo/indicator) and
  // accumulates the time-based scores.
  $effect(() => {
    if (phase !== "active" || !gazeModel) return;

    let inside = false;
    if (frame && frame.faceDetected && frame.landmarks) {
      let angleOverride: { yaw: number; pitch: number } | undefined;
      if (frame.headPose) {
        const a = headAngles(frame.headPose);
        smoothedYaw =
          smoothedYaw === null
            ? a.yaw
            : smoothedYaw + POSE_SMOOTHING * (a.yaw - smoothedYaw);
        smoothedPitch =
          smoothedPitch === null
            ? a.pitch
            : smoothedPitch + POSE_SMOOTHING * (a.pitch - smoothedPitch);
        angleOverride = { yaw: smoothedYaw, pitch: smoothedPitch };
      }

      const features = extractFeatures(
        frame.landmarks,
        frame.headPose,
        angleOverride,
      );
      const predicted = predictGaze(gazeModel, features);
      smoothedX =
        smoothedX === null
          ? predicted.x
          : smoothedX + GAZE_SMOOTHING * (predicted.x - smoothedX);
      smoothedY =
        smoothedY === null
          ? predicted.y
          : smoothedY + GAZE_SMOOTHING * (predicted.y - smoothedY);

      const tgt = puppetFaceTarget(window.innerWidth, window.innerHeight);
      const nx = (smoothedX - tgt.cx) / tgt.rx;
      const ny = (smoothedY - tgt.cy) / tgt.ry;
      inside = nx * nx + ny * ny <= 1;
    }

    // Asymmetric grace: entering is instant, leaving must persist for
    // LOOKAWAY_GRACE_MS before it counts. While within grace, hold the
    // gaze as still-inside so jitter/blinks don't register at all.
    const nowGrace = performance.now();
    let effectiveInside = inside;
    if (inside) {
      outsideSinceMs = null;
    } else {
      if (outsideSinceMs === null) outsideSinceMs = nowGrace;
      if (nowGrace - outsideSinceMs < LOOKAWAY_GRACE_MS) effectiveInside = true;
    }

    // Debounce with hysteresis; count a break on each on->off transition.
    contactEma += CONTACT_SMOOTHING * ((effectiveInside ? 1 : 0) - contactEma);
    let next = contactState;
    if (!contactState && contactEma >= CONTACT_ON) next = true;
    else if (contactState && contactEma <= CONTACT_OFF) next = false;
    if (next !== contactState) {
      // Look-aways stop being counted once scoring is frozen (closing phrase);
      // the halo keeps updating so the user still gets live visual feedback.
      if (contactState && !next && !scoringFrozen) lookAways += 1; // eye contact broken
      contactState = next;
      onTarget = next;
    }

    // Time-based scoring. dt is clamped so a stalled frame source cannot
    // inflate the totals. Frozen once the closing phrase starts, so the
    // scripted farewell neither adds nor removes any contact time.
    const now = performance.now();
    const dt = lastTickMs === null ? 0 : Math.min(now - lastTickMs, 250);
    lastTickMs = now;
    if (scoringFrozen) return;
    totalMs += dt;
    if (contactState) {
      contactMs += dt;
      currentStreakMs += dt;
      if (currentStreakMs > longestStreakMs) longestStreakMs = currentStreakMs;
    } else {
      currentStreakMs = 0;
    }
    const alpha = Math.min(dt / TREND_WINDOW_MS, 1);
    recentEma += alpha * ((contactState ? 1 : 0) - recentEma);
  });

  // Keep the transcript scrolled to the most recent exchange.
  $effect(() => {
    transcript.length;
    if (transcriptEl) transcriptEl.scrollTop = transcriptEl.scrollHeight;
  });

  const stateLabel = $derived(
    convState === "listening"
      ? $t("session.stateListening")
      : convState === "transcribing"
        ? $t("session.stateTranscribing")
        : convState === "thinking"
          ? $t("session.stateThinking")
          : convState === "speaking"
            ? $t("session.stateSpeaking")
            : $t("session.stateIdle"),
  );

  const trendSymbol = $derived(
    scoreTrend === "up" ? "↑" : scoreTrend === "down" ? "↓" : "→",
  );

  function onErrorOk(): void {
    onEnd();
  }
</script>

<div class="live">
  {#if phase === "ask-time" || phase === "ask-bias"}
    <!-- Static avatar behind the pre-session dialogs. -->
    <div
      class="stage"
      style="height: {PUPPET_HEIGHT_FRACTION * 100}vh; aspect-ratio: {PUPPET_VIEWBOX.width} / {PUPPET_VIEWBOX.height};"
    >
      <AvatarStage
        {avatar}
        headMovement={0}
        mouth={0}
        title={$t("session.avatarLiveTitle")}
      />
    </div>

    {#if phase === "ask-time"}
      <div class="modal-backdrop">
        <div class="modal">
          <h2>{$t("session.timeAskTitle")}</h2>
          <p>{$t("session.timeAskMessage")}</p>
          <select class="duration" bind:value={durationMin}>
            {#each DURATION_CHOICES as m}
              <option value={m}>{$t("session.timeOption", { n: m })}</option>
            {/each}
          </select>
          <p class="notice">{$t("session.timeAskNoise")}</p>
          <button class="primary" onclick={onTimeConfirm}>
            {$t("session.timeAskConfirm")}
          </button>
        </div>
      </div>
    {/if}
  {:else if phase === "bias" && gazeModel}
    <BiasCorrection
      model={gazeModel}
      {avatar}
      onComplete={onBiasComplete}
      onSkip={onBiasSkip}
    />
  {:else if phase === "results"}
    <div class="modal-backdrop">
      <div class="modal results">
        <h2>{$t("session.resultsTitle")}</h2>
        <div class="result-row">
          <span>{$t("session.resultsDuration")}</span>
          <strong>{formatTime(durationMin * 60)}</strong>
        </div>
        <div class="result-row">
          <span>{$t("session.scoreContact")}</span>
          <strong>{Math.round(scoreContactPct * 100)}%</strong>
        </div>
        <div class="result-row">
          <span>{$t("session.scoreStreak")}</span>
          <strong>{formatTime(scoreStreakSec)}</strong>
        </div>
        <div class="result-row">
          <span>{$t("session.scorePauses")}</span>
          <strong>{scorePauses}</strong>
        </div>
        {#if profileName}
          <hr class="divider" />
          <h3 class="avg-title">{$t("session.resultsAverageTitle")}</h3>
          <div class="result-row">
            <span>{$t("session.resultsSessionCount", { n: stats?.count ?? 0 })}</span>
          </div>
          <div class="result-row">
            <span>{$t("session.scoreContact")}</span>
            <strong>{Math.round((stats?.avgContactPct ?? 0) * 100)}%</strong>
          </div>
          <div class="result-row">
            <span>{$t("session.scoreStreak")}</span>
            <strong>{formatTime(stats?.avgStreakSec ?? 0)}</strong>
          </div>
          <div class="result-row">
            <span>{$t("session.scorePauses")}</span>
            <strong>{Math.round(stats?.avgPauses ?? 0)}</strong>
          </div>
          <button class="secondary" onclick={() => (showHistory = true)}>
            {$t("session.resultsHistoryButton")}
          </button>
        {/if}
        <button class="primary" onclick={onEnd}>
          {$t("session.resultsClose")}
        </button>
      </div>
    </div>
    {#if showHistory && profileName}
      <SessionHistory
        {profileName}
        onClose={() => (showHistory = false)}
        onChanged={loadStats}
      />
    {/if}
  {:else if phase === "starting" || phase === "active" || phase === "error"}
    <button class="end" onclick={onEnd}>{$t("session.endButton")}</button>

    <div class="status-pill" class:speaking={convState === "speaking"}>
      {stateLabel}
    </div>

    <!-- Eye-contact indicator (gaze text). -->
    <div class="contact-indicator" class:on={onTarget}>
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
        <circle cx="12" cy="12" r="3" />
      </svg>
      <span>{onTarget ? $t("session.contactOn") : $t("session.contactOff")}</span>
    </div>

    {#if phase === "active"}
      <!-- Countdown, centered just below the gaze indicator. -->
      <div class="countdown" class:low={remainingSec <= 10}>
        <span class="label">{$t("session.timeLeft")}</span>
        <span class="clock">{formatTime(remainingSec)}</span>
      </div>

      <!-- Live eye-contact scoring, left of the avatar. -->
      <aside class="score">
        <h2>{$t("session.scoreTitle")}</h2>
        <div class="metric">
          <span>{$t("session.scoreContact")}</span>
          <strong>{Math.round(scoreContactPct * 100)}%</strong>
        </div>
        <div class="metric">
          <span>{$t("session.scoreStreak")}</span>
          <strong>{formatTime(scoreStreakSec)}</strong>
        </div>
        <div class="metric">
          <span>{$t("session.scorePauses")}</span>
          <strong>{scorePauses}</strong>
        </div>
        <div class="metric">
          <span>{$t("session.scoreTrend")}</span>
          <strong class="trend {scoreTrend}">{trendSymbol}</strong>
        </div>
      </aside>
    {/if}

    <!-- Eye-contact halo behind the avatar. -->
    <div
      class="halo"
      class:on={onTarget}
      style="height: {PUPPET_HEIGHT_FRACTION * 100}vh; aspect-ratio: {PUPPET_VIEWBOX.width} / {PUPPET_VIEWBOX.height};"
    ></div>

    <!-- Avatar at the calibration silhouette's rect. -->
    <div
      class="stage"
      style="height: {PUPPET_HEIGHT_FRACTION * 100}vh; aspect-ratio: {PUPPET_VIEWBOX.width} / {PUPPET_VIEWBOX.height};"
    >
      <AvatarStage
        {avatar}
        {headMovement}
        {mouth}
        title={$t("session.avatarLiveTitle")}
      />
    </div>

    <!-- Webcam top-right with head-position feedback. -->
    <div
      class="webcam-corner"
      class:out-of-position={eyesOutOfPosition}
      class:in-position={reference !== null && !eyesOutOfPosition}
    >
      <WebcamTracker bind:frame bind:trackerState />

      {#if reference && eyesOutOfPosition}
        <img
          class="eye-mask"
          src={reference.maskDataUrl}
          alt={$t("session.eyeMaskAlt")}
          style="
            left: {reference.centerX * 100}%;
            top: {reference.centerY * 100}%;
            width: {reference.halfWidth * 2 * 100}%;
            height: {reference.halfHeight * 2 * 100}%;
          "
        />
      {/if}

      {#if trackerState === TrackerState.Error}
        <div class="self-note error">{$t("session.cameraError")}</div>
      {/if}
    </div>

    <!-- Transcript panel, right of the avatar. -->
    <aside class="transcript">
      <h2>{$t("session.transcriptTitle")}</h2>
      <div class="log" bind:this={transcriptEl}>
        {#if transcript.length === 0}
          <p class="empty">{$t("session.transcriptEmpty")}</p>
        {:else}
          {#each transcript as turn, i (i)}
            <div class="turn {turn.role}">
              <span
                class="icon"
                aria-label={turn.role === "user"
                  ? $t("session.speakerYou")
                  : $t("session.speakerAvatar")}
              >
                {#if turn.role === "user"}
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  >
                    <circle cx="12" cy="8" r="3.5" />
                    <path d="M5 20c0-3.6 3-5.5 7-5.5s7 1.9 7 5.5" />
                  </svg>
                {:else}
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  >
                    <rect x="5" y="8" width="14" height="11" rx="2.5" />
                    <path d="M12 8V4.5" />
                    <circle cx="12" cy="3.5" r="1" fill="currentColor" stroke="none" />
                    <circle cx="9.6" cy="13" r="0.9" fill="currentColor" stroke="none" />
                    <circle cx="14.4" cy="13" r="0.9" fill="currentColor" stroke="none" />
                  </svg>
                {/if}
              </span>
              <span class="bubble">{turn.text}</span>
            </div>
          {/each}
        {/if}
      </div>
    </aside>

    {#if turnError}
      <div class="turn-error">
        {$t("session.turnError", { message: turnError })}
      </div>
    {/if}
  {/if}

  {#if phase === "loading" || phase === "starting"}
    <div class="overlay">
      <div class="spinner"></div>
      <p>{$t("session.preparing")}</p>
    </div>
  {/if}
</div>

<ConfirmDialog
  open={phase === "ask-bias"}
  title={$t("session.biasAskTitle")}
  message={$t("session.biasAskMessage")}
  confirmLabel={$t("session.biasAskConfirm")}
  cancelLabel={$t("session.biasAskCancel")}
  onConfirm={onBiasAskConfirm}
  onCancel={onBiasAskCancel}
/>

<ErrorDialog
  open={phase === "error"}
  title={$t("session.liveErrorTitle")}
  message={errorMessage}
  okLabel={$t("session.errorOk")}
  onOk={onErrorOk}
/>

<style>
  .live {
    position: fixed;
    inset: 0;
    background: radial-gradient(circle at 50% 35%, #1b2433, #0d1219);
    /* auto (not hidden): never trap
       content below the fold with no way to scroll to it. */
    overflow-y: auto;
    font-family: "Hanken Grotesk", system-ui, sans-serif;
  }

  .end {
    position: absolute;
    top: 16px;
    left: 16px;
    z-index: 5;
    padding: 9px 16px;
    font-family: inherit;
    font-size: 14px;
    border: 1px solid rgba(255, 255, 255, 0.25);
    border-radius: 10px;
    background: rgba(255, 255, 255, 0.08);
    color: #f2f4f8;
    cursor: pointer;
    transition: background 0.15s;
  }

  .end:hover {
    background: rgba(255, 255, 255, 0.16);
  }

  .status-pill {
    position: absolute;
    top: 14px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 5;
    padding: 9px 20px;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.1);
    color: #cdd5e1;
    font-size: clamp(15px, 2vh, 20px);
    letter-spacing: 0.02em;
    transition: background 0.2s, color 0.2s;
  }

  .status-pill.speaking {
    background: #2e7d32;
    color: #ffffff;
  }

  .contact-indicator {
    position: absolute;
    top: 66px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 5;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 7px 16px;
    border-radius: 999px;
    font-size: clamp(14px, 1.9vh, 19px);
    background: rgba(224, 160, 48, 0.22);
    color: #f0bd6a;
    transition: background 0.3s, color 0.3s;
  }

  .contact-indicator.on {
    background: rgba(46, 204, 113, 0.28);
    color: #7ff0aa;
  }

  .contact-indicator svg {
    width: clamp(16px, 2vh, 20px);
    height: clamp(16px, 2vh, 20px);
  }

  /* Countdown, just below the gaze indicator. */
  .countdown {
    position: absolute;
    top: 112px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 5;
    display: flex;
    align-items: baseline;
    gap: 10px;
    padding: 8px 22px;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.08);
    color: #e8edf4;
    transition: background 0.3s, color 0.3s;
  }

  .countdown.low {
    background: rgba(231, 76, 60, 0.25);
    color: #ff9b8e;
  }

  .countdown .label {
    font-size: clamp(11px, 1.4vh, 14px);
    letter-spacing: 0.04em;
    text-transform: uppercase;
    opacity: 0.8;
  }

  .countdown .clock {
    font-family: "Hanken Grotesk", system-ui, sans-serif;
    font-size: clamp(30px, 5vh, 56px);
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    line-height: 1;
  }

  /* Live scoring panel, left of the avatar. */
  .score {
    position: fixed;
    left: 16px;
    top: 50%;
    transform: translateY(-50%);
    width: clamp(220px, 21vw, 320px);
    z-index: 5;
    padding: clamp(16px, 2.4vh, 26px) clamp(16px, 1.6vw, 22px);
    border-radius: 14px;
    background: rgba(255, 255, 255, 0.06);
    border: 1px solid rgba(255, 255, 255, 0.12);
    color: #e8edf4;
  }

  .score h2 {
    margin: 0 0 clamp(10px, 1.6vh, 18px);
    font-family: "Hanken Grotesk", system-ui, sans-serif;
    font-size: clamp(16px, 2.2vh, 24px);
    font-weight: 600;
  }

  .score .metric {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    padding: clamp(6px, 1vh, 11px) 0;
    font-size: clamp(14px, 1.9vh, 20px);
    color: #b8c1cf;
  }

  .score .metric strong {
    color: #f2f4f8;
    font-size: clamp(19px, 2.9vh, 30px);
    font-variant-numeric: tabular-nums;
  }

  .score .trend.up {
    color: #7ff0aa;
  }

  .score .trend.down {
    color: #ff9b8e;
  }

  .score .trend.flat {
    color: #cdd5e1;
  }

  /* Eye-contact halo behind the avatar (strong, clearly visible). */
  .halo {
    position: fixed;
    bottom: 0;
    left: 50%;
    transform: translateX(-50%);
    z-index: 0;
    pointer-events: none;
    color: rgba(232, 158, 38, 0.82);
    background: radial-gradient(
      ellipse 66% 56% at 50% 43%,
      currentColor 0%,
      currentColor 22%,
      transparent 76%
    );
    filter: blur(8px);
    transition: color 0.3s ease;
  }

  .halo.on {
    color: rgba(52, 224, 128, 0.92);
  }

  .stage {
    position: fixed;
    bottom: 0;
    left: 50%;
    transform: translateX(-50%);
    z-index: 1;
  }

  .webcam-corner {
    position: fixed;
    top: 12px;
    right: 12px;
    width: 200px;
    z-index: 5;
    opacity: 0.95;
    padding: 4px;
    border-radius: 10px;
    transition: background 0.2s;
  }

  .webcam-corner.in-position {
    background: #2ecc71;
  }

  .webcam-corner.out-of-position {
    background: #e74c3c;
  }

  .webcam-corner :global(.video-preview) {
    max-width: 200px;
  }

  .eye-mask {
    position: absolute;
    transform: translate(-50%, -50%) scaleX(-1);
    pointer-events: none;
    opacity: 0.75;
    outline: 2px dashed #fff;
    border-radius: 4px;
  }

  .self-note {
    padding: 4px 8px;
    font-size: 12px;
    color: #ffffff;
    text-align: center;
  }

  .self-note.error {
    background: rgba(200, 0, 0, 0.9);
    border-radius: 6px;
  }

  .transcript {
    position: fixed;
    top: 184px;
    right: 12px;
    bottom: clamp(32px, 7vh, 80px);
    width: 320px;
    z-index: 5;
    display: flex;
    flex-direction: column;
    background: rgba(255, 255, 255, 0.06);
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 12px;
    overflow: hidden;
  }

  .transcript h2 {
    margin: 0;
    padding: clamp(12px, 1.6vh, 16px) 16px;
    font-family: "Hanken Grotesk", system-ui, sans-serif;
    font-size: clamp(15px, 2vh, 20px);
    font-weight: 600;
    color: #e8edf4;
    border-bottom: 1px solid rgba(255, 255, 255, 0.1);
  }

  .log {
    flex: 1;
    overflow-y: auto;
    padding: 14px;
    display: flex;
    flex-direction: column;
    gap: clamp(10px, 1.4vh, 16px);
  }

  .empty {
    margin: auto 0;
    text-align: center;
    font-size: clamp(14px, 1.8vh, 18px);
    color: #8a93a3;
  }

  .turn {
    display: flex;
    align-items: flex-start;
    gap: 10px;
  }

  .turn .icon {
    flex: 0 0 auto;
    width: clamp(30px, 4vh, 40px);
    height: clamp(30px, 4vh, 40px);
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .turn .icon svg {
    width: clamp(18px, 2.4vh, 24px);
    height: clamp(18px, 2.4vh, 24px);
  }

  .turn.user .icon {
    background: rgba(58, 123, 213, 0.25);
    color: #9cc2ff;
  }

  .turn.assistant .icon {
    background: rgba(46, 125, 50, 0.3);
    color: #8fe0a0;
  }

  .bubble {
    flex: 1;
    min-width: 0;
    padding: 9px 12px;
    border-radius: 10px;
    background: rgba(255, 255, 255, 0.06);
    color: #e8edf4;
    font-size: clamp(14px, 1.9vh, 19px);
    line-height: 1.45;
    overflow-wrap: anywhere;
  }

  .turn-error {
    position: absolute;
    bottom: 16px;
    left: 16px;
    z-index: 5;
    max-width: 360px;
    padding: 8px 12px;
    border-radius: 8px;
    background: rgba(192, 57, 43, 0.92);
    color: #ffffff;
    font-size: 12px;
    line-height: 1.4;
  }

  /* Shared modal look for the length dialog and the results screen. */
  .modal-backdrop {
    position: fixed;
    inset: 0;
    z-index: 8;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(8, 12, 18, 0.6);
  }

  .modal {
    width: min(420px, 90vw);
    padding: 24px;
    border-radius: 14px;
    background: rgba(20, 26, 36, 0.97);
    border: 1px solid rgba(255, 255, 255, 0.12);
    color: #e8edf4;
    text-align: center;
    font-family: "Hanken Grotesk", system-ui, sans-serif;
  }

  .modal h2 {
    margin: 0 0 10px;
    font-family: "Hanken Grotesk", system-ui, sans-serif;
    font-size: 20px;
    font-weight: 600;
  }

  .modal p {
    margin: 0 0 18px;
    font-size: 14px;
    line-height: 1.5;
    color: #cdd5e1;
  }

  .modal .duration {
    -webkit-appearance: none;  /* Forces WebKitGTK to drop native GTK rendering */ 
    appearance: none;
    width: 100%;
    margin-bottom: 18px;
    padding: 10px 12px;
    font-family: inherit;
    font-size: 15px;
    color: #f2f4f8;
    background: rgba(255, 255, 255, 0.08);
    border: 1px solid rgba(255, 255, 255, 0.2);
    border-radius: 10px;
  }

  .modal .duration, ::picker(select) {
    appearance: base-select;
  }

  .modal .duration::picker-icon {
    color: #f2f4f8;
  }
  
  .modal .duration option {
    color: #111;
  }

  /* Advisory shown under the duration picker: dimmer and smaller than the
     modal's main text, so it reads as a precondition to check rather than as
     part of the question being asked. */
  .modal p.notice {
    margin: -6px 0 18px;
    font-size: 13px;
    color: #9aa4b2;
  }

  .modal .primary {
    width: 100%;
    padding: 11px 18px;
    font-family: inherit;
    font-size: 15px;
    border: none;
    border-radius: 10px;
    background: #3a7bd5;
    color: #ffffff;
    cursor: pointer;
    transition: background 0.15s;
  }

  .modal .primary:hover {
    background: #4a8be5;
  }

  .modal.results .result-row {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    padding: 8px 0;
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    font-size: 14px;
    color: #b8c1cf;
  }

  .modal.results .result-row strong {
    color: #f2f4f8;
    font-size: 17px;
    font-variant-numeric: tabular-nums;
  }

  .modal.results .primary {
    margin-top: 20px;
  }

  .modal.results {
    max-height: 85vh;
    overflow-y: auto;
  }

  .modal.results .divider {
    border: none;
    border-top: 1px solid rgba(255, 255, 255, 0.12);
    margin: 18px 0 8px;
  }

  .modal.results .avg-title {
    margin: 0 0 6px;
    font-size: 15px;
    font-weight: 600;
    color: #cdd5e1;
  }

  .modal.results .secondary {
    width: 100%;
    margin-top: 14px;
    padding: 10px 18px;
    font-family: inherit;
    font-size: 14px;
    border-radius: 10px;
    background: rgba(255, 255, 255, 0.1);
    border: 1px solid rgba(255, 255, 255, 0.2);
    color: #e8edf4;
    cursor: pointer;
    transition: background 0.15s;
  }

  .modal.results .secondary:hover {
    background: rgba(255, 255, 255, 0.16);
  }

  .overlay {
    position: absolute;
    inset: 0;
    z-index: 10;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 16px;
    background: rgba(10, 14, 20, 0.78);
    color: #e8edf4;
    font-size: 15px;
  }

  .spinner {
    width: 42px;
    height: 42px;
    border: 4px solid rgba(255, 255, 255, 0.2);
    border-top-color: #3a7bd5;
    border-radius: 50%;
    animation: spin 0.9s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .spinner {
      animation: none;
    }
  }
</style>
