<script lang="ts">
  //! Bias-correction capture (optional refinement step).
  //!
  //! Shown by the session view before the engines start, only after the user
  //! opts in. It re-runs the four eye-anchor points (twice) directly on the
  //! avatar's face and feeds them to a BiasCorrector, which fits a single
  //! translational offset onto the current gaze model — improving eye-contact
  //! accuracy exactly where it matters. The avatar is rendered static (no head
  //! sway) so its eyes stay under the on-screen target dots.
  //!
  //! The parent owns the opt-in dialog and what happens next: this component
  //! only reports the corrected model (onComplete) or a request to proceed
  //! without it (onSkip). Mirrors CalibrationView's capture loop and timing.
  import { onMount, onDestroy } from "svelte";
  import { t } from "$lib/i18n";
  import AvatarStage from "$lib/avatar/AvatarStage.svelte";
  import WebcamTracker from "$lib/components/WebcamTracker.svelte";
  import { PUPPET_HEIGHT_FRACTION, PUPPET_VIEWBOX } from "$lib/avatar/layout";
  import {
    BiasCorrector,
    type CalibrationProgress,
  } from "$lib/tracking/calibration";
  import {
    CalibrationState,
    TrackerState,
    type GazeModel,
    type ScreenPoint,
    type TrackingFrame,
  } from "$lib/tracking/types";

  type Gender = "male" | "female";

  interface Props {
    /** The gaze model to refine; its bias is updated, not reset. */
    model: GazeModel;
    /** Avatar to display, so the user looks at the real target face. */
    avatar: Gender;
    /** Called with the corrected model once the capture succeeds. */
    onComplete: (corrected: GazeModel) => void;
    /** Called when the user skips, or after an unrecoverable failure. */
    onSkip: () => void;
  }
  let { model, avatar, onComplete, onSkip }: Props = $props();

  // Countdown before capture, in seconds, started once the camera is ready.
  const COUNTDOWN_FROM = 3;
  const COUNTDOWN_STEP_MS = 800;

  let currentFrame = $state<TrackingFrame | null>(null);
  let trackerState = $state<TrackerState>(TrackerState.Idle);

  let corrector: BiasCorrector | null = null;
  let points = $state<ReadonlyArray<ScreenPoint>>([]);
  let progress = $state<CalibrationProgress | null>(null);
  // The anchor points repeat each cycle at the same screen positions, so render
  // one dot per position (otherwise the next cycle's dot would cover the active
  // one and hide its highlight/ring). Dedupe by coordinate: `points` is a
  // reactive ($state) proxy, so reference identity is unreliable here.
  const uniquePoints = $derived.by(() => {
    const seen = new Set<string>();
    const out: ScreenPoint[] = [];
    for (const p of points) {
      const key = `${p.x},${p.y}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push(p);
      }
    }
    return out;
  });

  let countdown = $state<number | null>(null);
  let started = $state(false); // capture loop running
  let finished = $state(false); // completed or failed (loop stopped)
  let failed = $state(false);

  let countdownTimer: ReturnType<typeof setTimeout> | null = null;

  onMount(() => {
    armCorrector();
  });

  onDestroy(() => {
    clearCountdown();
  });

  // (Re)create the corrector for the current viewport size and reset the UI.
  function armCorrector(): void {
    corrector = new BiasCorrector(
      window.innerWidth,
      window.innerHeight,
      model,
    );
    points = corrector.getPoints();
    progress = null;
    started = false;
    finished = false;
    failed = false;
    countdown = null;
  }

  function clearCountdown(): void {
    if (countdownTimer !== null) {
      clearTimeout(countdownTimer);
      countdownTimer = null;
    }
  }

  // Tick the countdown down to zero, then start the capture loop.
  function runCountdown(value: number): void {
    countdown = value;
    countdownTimer = setTimeout(() => {
      if (value <= 1) {
        countdown = null;
        corrector?.start(performance.now());
        started = true;
      } else {
        runCountdown(value - 1);
      }
    }, COUNTDOWN_STEP_MS);
  }

  function retry(): void {
    clearCountdown();
    armCorrector();
  }

  // Start the countdown as soon as the camera is ready (once per arming).
  $effect(() => {
    if (
      trackerState === TrackerState.Ready &&
      !started &&
      !finished &&
      countdown === null &&
      countdownTimer === null
    ) {
      runCountdown(COUNTDOWN_FROM);
    }
  });

  // Feed each new frame to the corrector while collecting. Fires onComplete
  // exactly once on success; flags failure (too few samples) for a retry.
  $effect(() => {
    if (!started || finished || countdown !== null) return;
    if (!corrector || !currentFrame) return;

    const snapshot = corrector.update(currentFrame, performance.now());
    progress = snapshot;

    if (snapshot.state === CalibrationState.Completed) {
      finished = true;
      const corrected = corrector.getCorrectedModel();
      if (corrected) onComplete(corrected);
      else failed = true; // defensive: completed without a model
    } else if (snapshot.state === CalibrationState.Failed) {
      finished = true;
      failed = true;
    }
  });
</script>

<div class="bias">
  <button class="skip" onclick={onSkip}>{$t("session.biasSkip")}</button>

  <!-- Static avatar at the puppet rect: the target dots sit on its face. -->
  <div
    class="stage"
    style="height: {PUPPET_HEIGHT_FRACTION * 100}vh; aspect-ratio: {PUPPET_VIEWBOX.width} / {PUPPET_VIEWBOX.height};"
  >
    <AvatarStage {avatar} headMovement={0} mouth={0} title="" />
  </div>

  <!-- Self-view; also the source of tracking frames for the corrector. -->
  <div class="webcam-corner">
    <WebcamTracker bind:frame={currentFrame} bind:trackerState />
  </div>

  {#if failed}
    <div class="panel">
      <p>{$t("session.biasFailed")}</p>
      <div class="actions">
        <button class="primary" onclick={retry}>{$t("session.biasRetry")}</button>
        <button onclick={onSkip}>{$t("session.biasSkip")}</button>
      </div>
    </div>
  {:else if countdown !== null}
    <div class="countdown">{countdown}</div>
  {:else if !started}
    <div class="hud">{$t("session.biasPreparing")}</div>
  {:else}
    <!-- Anchor target dots on the avatar's face; the active one shows a
         shrinking ring during the gaze-shift window, as in calibration. -->
    {#each uniquePoints as point (`${point.x},${point.y}`)}
      {@const isActive =
        progress?.currentTarget != null &&
        progress.currentTarget.x === point.x &&
        progress.currentTarget.y === point.y}
      <div
        class="dot"
        class:active={isActive}
        style="left: {point.x}px; top: {point.y}px;"
      >
        {#if isActive && progress?.phase === "shift"}
          <span class="ring"></span>
        {/if}
      </div>
    {/each}
    <div class="hud">
      {$t("session.biasLookHint")}
      {#if progress}
        <span class="count">
          {Math.min(progress.pointIndex + 1, progress.totalPoints)} / {progress.totalPoints}
        </span>
      {/if}
    </div>
  {/if}
</div>

<style>
  .bias {
    position: fixed;
    inset: 0;
    background: radial-gradient(circle at 50% 35%, #1b2433, #0d1219);
    /* auto (not hidden): never trap
       content below the fold with no way to scroll to it. */
    overflow-y: auto;
    font-family: "Hanken Grotesk", system-ui, sans-serif;
    color: #e8edf4;
  }

  .skip {
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

  .skip:hover {
    background: rgba(255, 255, 255, 0.16);
  }

  /* Same placement as the live avatar so dots land on the same eyes. */
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
    border-radius: 10px;
    overflow: hidden;
  }

  .webcam-corner :global(.video-preview) {
    max-width: 200px;
  }

  /* Anchor target dot, tinted like the calibration anchors. */
  .dot {
    position: absolute;
    width: 14px;
    height: 14px;
    margin: -7px 0 0 -7px;
    z-index: 3;
    border-radius: 50%;
    background: #ffcf4d;
    box-shadow: 0 0 0 3px rgba(0, 0, 0, 0.35);
  }

  .dot.active {
    background: #4aa3ff;
    box-shadow: 0 0 16px 5px rgba(74, 163, 255, 0.9);
  }

  /* Ring that shrinks toward the active dot during the gaze-shift window.
     Centered with translate(-50%, -50%) — as in CalibrationView — so the
     border width is included in the centering math; the translate must be
     repeated in every keyframe, otherwise the animation's transform would
     override it and the ring would shrink around an off-center origin. */
  .ring {
    position: absolute;
    top: 50%;
    left: 50%;
    width: 130px;
    height: 130px;
    border: 4px solid rgba(74, 163, 255, 0.95);
    border-radius: 50%;
    box-shadow: 0 0 14px rgba(74, 163, 255, 0.6);
    transform: translate(-50%, -50%) scale(1);
    animation: ring-shrink 0.7s ease-out infinite;
  }

  @keyframes ring-shrink {
    from {
      transform: translate(-50%, -50%) scale(1);
      opacity: 0.95;
    }
    to {
      transform: translate(-50%, -50%) scale(0.2);
      opacity: 0;
    }
  }

  .countdown {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    z-index: 4;
    font-family: "Hanken Grotesk", system-ui, sans-serif;
    font-size: 96px;
    font-weight: 600;
    color: #ffffff;
    text-shadow: 0 2px 16px rgba(0, 0, 0, 0.6);
  }

  .hud {
    position: absolute;
    bottom: 28px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 5;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 9px 18px;
    border-radius: 999px;
    background: rgba(0, 0, 0, 0.55);
    color: #e8edf4;
    font-size: 14px;
    text-align: center;
  }

  .count {
    font-variant-numeric: tabular-nums;
    color: #ffcf4d;
  }

  .panel {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    z-index: 6;
    max-width: 420px;
    padding: 24px;
    border-radius: 14px;
    background: rgba(20, 26, 36, 0.96);
    border: 1px solid rgba(255, 255, 255, 0.12);
    text-align: center;
  }

  .panel p {
    margin: 0 0 18px;
    font-size: 15px;
    line-height: 1.5;
  }

  .actions {
    display: flex;
    justify-content: center;
    gap: 12px;
  }

  .actions button {
    padding: 9px 18px;
    font-family: inherit;
    font-size: 14px;
    border-radius: 10px;
    border: 1px solid rgba(255, 255, 255, 0.25);
    background: rgba(255, 255, 255, 0.08);
    color: #f2f4f8;
    cursor: pointer;
    transition: background 0.15s;
  }

  .actions button:hover {
    background: rgba(255, 255, 255, 0.16);
  }

  .actions .primary {
    background: #3a7bd5;
    border-color: #3a7bd5;
  }

  .actions .primary:hover {
    background: #4a8be5;
  }
</style>
