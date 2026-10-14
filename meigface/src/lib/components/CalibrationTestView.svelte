<script lang="ts">
  //! Live gaze-prediction overlay used to verify calibration quality.
  //!
  //! Mounts the webcam tracker, applies the fitted GazeModel to every
  //! incoming frame, and renders a small black dot at the predicted
  //! screen coordinates. A lightweight exponential moving average
  //! trims high-frequency tremor without hiding systematic drift, so
  //! the user can judge how accurate the calibration actually is.

  import WebcamTracker from "#lib/components/WebcamTracker.svelte";
  import PuppetSilhouette from "#lib/avatar/PuppetSilhouette.svelte";
  import {
    extractFeatures,
    extractFeaturesDebug,
    headAngles,
    predictGaze,
  } from "#lib/tracking/regression.js";
  import {
    TrackerState,
    type EyeReference,
    type GazeModel,
    type TrackingFrame,
  } from "#lib/tracking/types.js";
  import { t } from "#lib/i18n/index.js";

  // Split the raw hint translation on its {enterKey} placeholder so the key
  // name can be rendered as a real <strong> element instead of injected HTML.
  // In this way we don't use {@html}: the risk is that custom locale files are
  // user-supplied and would become an XSS vector into the Tauri IPC.
  const hintParts = $derived($t("test.hint").split("{enterKey}"));

  interface Props {
    model: GazeModel;
    reference?: EyeReference | null;
    onBack?: () => void;
    onSetupSession?: () => void;
  }

  let { model, reference = null, onBack, onSetupSession }: Props = $props();

  // Tight tolerance (3% of the frame) on how far the user's eyes can
  // drift from the calibration position before the warning overlay
  // kicks in. Kept strict by design — even small head motion degrades
  // the linear regression enough to be visible in the gaze dot.
  const DRIFT_TOLERANCE = 0.03;

  let eyesOutOfPosition = $state(false);

  let frame = $state<TrackingFrame | null>(null);
  let trackerState = $state<TrackerState>(TrackerState.Idle);
  let gazeX = $state<number | null>(null);
  let gazeY = $state<number | null>(null);
  let debug = $state<{
    rawFx: number;
    rawFy: number;
    compensatedFx: number;
    compensatedFy: number;
    yawDeg: number;
    pitchDeg: number;
    predictedX: number;
    predictedY: number;
  } | null>(null);

  // Captured snapshots saved by pressing Enter, rendered as plain text
  // so the user can copy them later for offline analysis.
  let snapshots = $state<string[]>([]);

  /**
   * Build a single-line text record of the current debug values,
   * matching the order the user is asked to check by the assistant.
   */
  function formatSnapshot(): string | null {
    if (!debug) return null;
    const idx = snapshots.length + 1;
    return (
      `#${idx}  ` +
      `raw=(${debug.rawFx.toFixed(3)}, ${debug.rawFy.toFixed(3)})  ` +
      `comp=(${debug.compensatedFx.toFixed(3)}, ${debug.compensatedFy.toFixed(3)})  ` +
      `yaw=${debug.yawDeg.toFixed(1)}°  pitch=${debug.pitchDeg.toFixed(1)}°  ` +
      `pred=(${debug.predictedX.toFixed(0)}, ${debug.predictedY.toFixed(0)})`
    );
  }

  function captureSnapshot(): void {
    const snap = formatSnapshot();
    if (snap) snapshots = [...snapshots, snap];
  }

  function clearSnapshots(): void {
    snapshots = [];
  }

  async function copySnapshots(): Promise<void> {
    if (snapshots.length === 0) return;
    try {
      await navigator.clipboard.writeText(snapshots.join("\n"));
    } catch {
      // Clipboard access can fail in some webview contexts; fallback to
      // selecting the text manually is handled by the UI's readable layout.
    }
  }

  // EMA smoothing factor: 0 = no update (frozen), 1 = no smoothing.
  // 0.4 keeps the dot responsive enough to show error, damp enough
  // to be readable in the presence of normal iris landmark jitter.
  const SMOOTHING = 0.4;
  let smoothedX: number | null = null;
  let smoothedY: number | null = null;
  // Separate, stronger EMA on the head-pose angles (yaw/pitch). The
  // estimated pitch is noisy frame-to-frame (~±2°) and that jitter,
  // once multiplied by the compensation gain, was the main cause of
  // the predicted dot jumping ~150px vertically at a fixed gaze.
  // Smoothing the angles before they reach extractFeatures removes
  // the jitter; the lower factor (0.25) means slower, steadier
  // tracking of genuine head movement.
  const POSE_SMOOTHING = 0.25;
  let smoothedYaw: number | null = null;
  let smoothedPitch: number | null = null;

  $effect(() => {
    if (!frame || !frame.faceDetected || !frame.landmarks) {
      eyesOutOfPosition = reference !== null;
      return;
    }

    // Smooth the head-pose angles before they reach the feature
    // extractor, so frame-to-frame pitch/yaw jitter does not get
    // amplified into a jumpy gaze dot.
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
    const predicted = predictGaze(model, features);

    smoothedX =
      smoothedX === null
        ? predicted.x
        : smoothedX + SMOOTHING * (predicted.x - smoothedX);
    smoothedY =
      smoothedY === null
        ? predicted.y
        : smoothedY + SMOOTHING * (predicted.y - smoothedY);
    gazeX = smoothedX;
    gazeY = smoothedY;

    const dbg = extractFeaturesDebug(frame.landmarks, frame.headPose);
    debug = {
      rawFx: dbg.rawFx,
      rawFy: dbg.rawFy,
      compensatedFx: dbg.compensatedFx,
      compensatedFy: dbg.compensatedFy,
      yawDeg: (dbg.yaw * 180) / Math.PI,
      pitchDeg: (dbg.pitch * 180) / Math.PI,
      predictedX: predicted.x,
      predictedY: predicted.y,
    };

    // Compare current eye region center to the calibration reference.
    // Eye center ≈ midpoint between outer corners of left and right eye,
    // matching the landmarks used to build the reference in the first
    // place. If the drift exceeds tolerance on either axis, warn.
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

  // Global Enter-key listener: lets the user capture a snapshot while
  // their eyes stay on the gaze dot, without having to read on-screen
  // values at the same time.
  $effect(() => {
    const handler = (ev: KeyboardEvent) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        captureSnapshot();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  });
</script>

<div class="test-view">
  <!-- Where the real avatar will be during normal use: lets the user
       verify the gaze dot lands on the eye band when they look there. -->
  <PuppetSilhouette variant="onLight" />
  <!-- Webcam stays mounted and visible in the corner so the user can
       confirm their face is still being detected while testing. -->
  <div
    class="webcam-corner"
    class:out-of-position={eyesOutOfPosition}
    class:in-position={reference !== null && !eyesOutOfPosition}
  >
    <WebcamTracker bind:frame bind:trackerState />

    {#if reference && eyesOutOfPosition}
      <!-- Overlay showing where the eyes were during calibration.
         The image is horizontally mirrored to match the preview,
         which is already mirrored via CSS. -->
      <img
        class="eye-mask"
        src={reference.maskDataUrl}
        alt="Calibration eye position"
        style="
        left: {reference.centerX * 100}%;
        top: {reference.centerY * 100}%;
        width: {reference.halfWidth * 2 * 100}%;
        height: {reference.halfHeight * 2 * 100}%;
      "
      />
    {/if}
  </div>

  {#if gazeX !== null && gazeY !== null}
    <div class="gaze-dot" style="left: {gazeX}px; top: {gazeY}px;"></div>
  {/if}

  <div class="header">
    <div class="header-actions">
      <button onclick={() => onBack?.()}>{$t("test.back")}</button>
      {#if onSetupSession}
        <button class="cta" onclick={() => onSetupSession?.()}>
          {$t("home.setupSession")}
        </button>
      {/if}
    </div>
    <p class="hint">
      {#each hintParts as part, i}{part}{#if i < hintParts.length - 1}<strong
            >{$t("test.enterKey")}</strong
          >{/if}{/each}
    </p>
  </div>

  {#if trackerState === TrackerState.Error}
    <div class="error">{$t("test.cameraError")}</div>
  {/if}

  {#if debug}
    <div class="debug-panel">
      <div><strong>{$t("test.debugRawFeatures")}</strong></div>
      <div>fx: {debug.rawFx.toFixed(3)} fy: {debug.rawFy.toFixed(3)}</div>
      <div><strong>{$t("test.debugCompensatedFeatures")}</strong></div>
      <div>
        fx: {debug.compensatedFx.toFixed(3)} fy: {debug.compensatedFy.toFixed(
          3,
        )}
      </div>
      <div><strong>{$t("test.debugHeadPose")}</strong></div>
      <div>
        yaw: {debug.yawDeg.toFixed(1)}° pitch: {debug.pitchDeg.toFixed(1)}°
      </div>
      <div><strong>{$t("test.debugPredictedGaze")}</strong></div>
      <div>
        x: {debug.predictedX.toFixed(0)} y: {debug.predictedY.toFixed(0)}
      </div>
    </div>
  {/if}

  {#if snapshots.length > 0}
    <div class="snapshots">
      <div class="snapshots-header">
        <strong>{$t("test.snapshotsTitle", { count: snapshots.length })}</strong
        >
        <div class="snapshots-actions">
          <button onclick={copySnapshots}>{$t("test.copy")}</button>
          <button class="danger" onclick={clearSnapshots}
            >{$t("test.clear")}</button
          >
        </div>
      </div>
      <pre>{snapshots.join("\n")}</pre>
    </div>
  {/if}
</div>

<style>
  .test-view {
    position: fixed;
    inset: 0;
    background: #fafafa;
    color: #222;
    /* auto (not hidden): never trap
       content below the fold with no way to scroll to it. */
    overflow-y: auto;
    font-family: system-ui, sans-serif;
  }

  .webcam-corner {
    position: fixed;
    top: 12px;
    right: 12px;
    width: 200px;
    z-index: 5;
    opacity: 0.9;
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

  /* Eye mask overlay: positioned relative to the webcam box. The image
   is a PNG data-URL captured at calibration time. We mirror it with
   scaleX(-1) so it visually aligns with the preview, which is itself
   horizontally mirrored. */
  .eye-mask {
    position: absolute;
    transform: translate(-50%, -50%) scaleX(-1);
    pointer-events: none;
    opacity: 0.75;
    outline: 2px dashed #fff;
    border-radius: 4px;
  }

  .gaze-dot {
    position: absolute;
    width: 16px;
    height: 16px;
    background: #000;
    border-radius: 50%;
    transform: translate(-50%, -50%);
    pointer-events: none;
    /* Subtle white halo so the dot remains visible on dark backgrounds
       if the user later changes the theme. */
    box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.8);
  }

  .header {
    position: absolute;
    top: 20px;
    left: 20px;
    max-width: 420px;
    z-index: 10;
  }

  .header button {
    padding: 8px 16px;
    font-size: 14px;
    border-radius: 6px;
    border: none;
    background: #3a7bd5;
    color: white;
    cursor: pointer;
  }

  .header-actions {
    display: flex;
    gap: 10px;
  }

  .header button.cta {
    background: #2e7d32;
  }

  .hint {
    margin-top: 10px;
    padding: 8px 12px;
    background: rgba(255, 255, 255, 0.85);
    border-radius: 4px;
    font-size: 13px;
    line-height: 1.4;
    color: #333;
  }

  .error {
    position: absolute;
    bottom: 24px;
    left: 50%;
    transform: translateX(-50%);
    padding: 10px 16px;
    background: #e74c3c;
    color: white;
    border-radius: 6px;
    font-size: 14px;
  }

  .debug-panel {
    position: absolute;
    bottom: 12px;
    left: 12px;
    padding: 10px 14px;
    background: rgba(0, 0, 0, 0.75);
    color: #eee;
    border-radius: 6px;
    font-family: monospace;
    font-size: 12px;
    line-height: 1.5;
    z-index: 10;
    min-width: 220px;
  }

  .debug-panel strong {
    color: #7ac2ff;
    display: block;
    margin-top: 4px;
  }

  .snapshots {
    position: absolute;
    top: 90px;
    left: 12px;
    max-width: 460px;
    max-height: 60vh;
    overflow-y: auto;
    padding: 10px 14px;
    background: rgba(0, 0, 0, 0.75);
    color: #eee;
    border-radius: 6px;
    font-family: monospace;
    font-size: 11px;
    z-index: 10;
  }

  .snapshots-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 6px;
    color: #7ac2ff;
    font-family: system-ui, sans-serif;
    font-size: 12px;
  }

  .snapshots-actions {
    display: flex;
    gap: 6px;
  }

  .snapshots-actions button {
    padding: 3px 8px;
    font-size: 11px;
    background: #3a7bd5;
    color: white;
    border: none;
    border-radius: 4px;
    cursor: pointer;
  }

  .snapshots-actions button.danger {
    background: #b03a3a;
  }

  .snapshots pre {
    margin: 0;
    white-space: pre-wrap;
    word-break: break-word;
  }
</style>
