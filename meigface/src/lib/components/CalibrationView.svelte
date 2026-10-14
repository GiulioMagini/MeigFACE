<script lang="ts">
    import { onDestroy } from "svelte";
    import WebcamTracker from "#lib/components/WebcamTracker.svelte";
    import PuppetSilhouette from "#lib/avatar/PuppetSilhouette.svelte";
    import { Calibrator } from "#lib/tracking/calibration.js";
    import type {
        CalibrationProgress,
        CalibrationMode,
    } from "#lib/tracking/calibration.js";
    import {
        CalibrationState,
        TrackerState,
        type GazeModel,
        type EyeReference,
        type ScreenPoint,
        type TrackingFrame,
    } from "#lib/tracking/types.js";
    import { t } from "#lib/i18n/index.js";

    interface Props {
        mode: CalibrationMode;
        onComplete?: (model: GazeModel, reference: EyeReference | null) => void;
        onCancel?: () => void;
    }

    let { mode, onComplete, onCancel }: Props = $props();

    // Reactive state surfaced to the template.
    let currentFrame = $state<TrackingFrame | null>(null);
    let trackerState = $state<TrackerState>(TrackerState.Idle);
    let calibrationStarted = $state(false);
    let calibrationFinished = $state(false);
    let failed = $state(false);
    let progress = $state<CalibrationProgress | null>(null);
    let calibrationPoints = $state<ReadonlyArray<ScreenPoint>>([]);
    let anchorMask = $state<ReadonlyArray<boolean>>([]);
    let countdown = $state<number | null>(null);
    let containerEl = $state<HTMLDivElement | null>(null);
    let videoElement = $state<HTMLVideoElement | null>(null);

    // Imperative handles — no reactivity needed.
    let calibrator: Calibrator | null = null;
    let countdownInterval: ReturnType<typeof setInterval> | null = null;

    /**
     * Start the 3-2-1 pre-calibration countdown and, when it reaches 0,
     * arm the Calibrator state machine with the current viewport size.
     */
    function start(): void {
        if (!containerEl) return;
        const rect = containerEl.getBoundingClientRect();
        calibrator = new Calibrator(rect.width, rect.height, mode);
        calibrationPoints = calibrator.getPoints();
        anchorMask = calibrator.getAnchorMask();
        calibrationStarted = true;
        calibrationFinished = false;
        failed = false;
        progress = null;

        countdown = 3;
        countdownInterval = setInterval(() => {
            if (countdown === null) {
                clearCountdown();
                return;
            }
            countdown -= 1;
            if (countdown <= 0) {
                clearCountdown();
                countdown = null;
                calibrator?.start(performance.now());
            }
        }, 1000);
    }

    /** Reset the view to the intro screen so the user can retry. */
    function retry(): void {
        clearCountdown();
        calibrator = null;
        calibrationStarted = false;
        calibrationFinished = false;
        failed = false;
        progress = null;
        calibrationPoints = [];
        anchorMask = [];
        countdown = null;
    }

    function clearCountdown(): void {
        if (countdownInterval !== null) {
            clearInterval(countdownInterval);
            countdownInterval = null;
        }
    }

    /**
     * Build an EyeReference from a tracking frame + the live video element.
     *
     * The returned mask is a PNG data-URL of the eye region, cropped using
     * the outermost eye landmarks as a bounding box. Both eyes are included
     * in a single rectangle so the overlay is a natural horizontal band.
     *
     * Returns null if the frame does not contain landmarks or if the video
     * is not yet ready to be read from a 2D canvas.
     */
    function captureEyeReference(frame: TrackingFrame): EyeReference | null {
        if (!frame.landmarks || !videoElement) return null;
        if (videoElement.readyState < 2) return null;

        // Outer corners are the leftmost/rightmost horizontal extents,
        // top/bottom are the uppermost/lowermost vertical extents across
        // both eyes combined. Landmarks are in normalized [0, 1] coords.
        const L_OUTER = frame.landmarks[33];
        const L_TOP = frame.landmarks[159];
        const L_BOTTOM = frame.landmarks[145];
        const R_OUTER = frame.landmarks[263];
        const R_TOP = frame.landmarks[386];
        const R_BOTTOM = frame.landmarks[374];

        const minX = Math.min(L_OUTER.x, R_OUTER.x);
        const maxX = Math.max(L_OUTER.x, R_OUTER.x);
        const minY = Math.min(L_TOP.y, R_TOP.y, L_BOTTOM.y, R_BOTTOM.y);
        const maxY = Math.max(L_TOP.y, R_TOP.y, L_BOTTOM.y, R_BOTTOM.y);

        // Pad the box so eyebrows and some skin are included — gives the
        // user a bigger visual anchor to realign to.
        const padX = (maxX - minX) * 0.2;
        const padY = (maxY - minY) * 0.9;
        const left = Math.max(0, minX - padX);
        const right = Math.min(1, maxX + padX);
        const top = Math.max(0, minY - padY);
        const bottom = Math.min(1, maxY + padY);

        const vw = videoElement.videoWidth;
        const vh = videoElement.videoHeight;
        if (vw === 0 || vh === 0) return null;

        const cropW = Math.round((right - left) * vw);
        const cropH = Math.round((bottom - top) * vh);
        const cropX = Math.round(left * vw);
        const cropY = Math.round(top * vh);

        const canvas = document.createElement("canvas");
        canvas.width = cropW;
        canvas.height = cropH;
        const ctx = canvas.getContext("2d");
        if (!ctx) return null;
        ctx.drawImage(
            videoElement,
            cropX,
            cropY,
            cropW,
            cropH,
            0,
            0,
            cropW,
            cropH,
        );

        return {
            maskDataUrl: canvas.toDataURL("image/png"),
            centerX: (left + right) / 2,
            centerY: (top + bottom) / 2,
            halfWidth: (right - left) / 2,
            halfHeight: (bottom - top) / 2,
        };
    }

    // Every time WebcamTracker updates `currentFrame`, feed it to the
    // calibrator and update `progress`. The `calibrationFinished` guard
    // ensures onComplete fires exactly once per calibration session.
    $effect(() => {
        if (!calibrationStarted || calibrationFinished || countdown !== null) {
            return;
        }
        if (!calibrator || !currentFrame) return;

        const snapshot = calibrator.update(currentFrame, performance.now());
        progress = snapshot;

        if (snapshot.state === CalibrationState.Completed) {
            calibrationFinished = true;
            const model = calibrator.getModel();
            if (model) {
                // Capture the eye region from the current frame while the user is
                // still in calibration pose. The reference is passed alongside
                // the model so the test view can warn on head drift.
                const reference = captureEyeReference(currentFrame);
                onComplete?.(model, reference);
            }
        } else if (snapshot.state === CalibrationState.Failed) {
            calibrationFinished = true;
            failed = true;
        }
    });

    onDestroy(() => {
        clearCountdown();
    });
</script>

<div class="calibration-view" bind:this={containerEl}>
    <!--
    WebcamTracker stays mounted for the whole session.
    The wrapper is repositioned via CSS so MediaPipe never reloads.
  -->
    <div
        class="webcam-slot"
        class:intro={!calibrationStarted || failed}
        class:offscreen={calibrationStarted && !failed}
    >
        <WebcamTracker
            bind:frame={currentFrame}
            bind:trackerState
            bind:videoElement
        />
    </div>

    {#if !calibrationStarted}
        <div class="panel">
            <h2>{$t("calibration.introTitle")}</h2>
            <p>{$t("calibration.introDistance")}</p>
            <p>{$t("calibration.introPosition")}</p>
            <p>{$t("calibration.introHeadStill")}</p>
            {#if mode === "heavy"}
                <p>{$t("calibration.introHeavy")}</p>
            {:else}
                <p>{$t("calibration.introLight")}</p>
            {/if}
            <div class="actions">
                <button
                    onclick={start}
                    disabled={trackerState !== TrackerState.Ready}
                >
                    {#if trackerState === TrackerState.Ready}
                        {$t("calibration.startButton")}
                    {:else if trackerState === TrackerState.Error}
                        {$t("calibration.cameraError")}
                    {:else}
                        {$t("calibration.preparingCamera")}
                    {/if}
                </button>
                {#if onCancel}
                    <button class="secondary" onclick={onCancel}
                        >{$t("calibration.cancel")}</button
                    >
                {/if}
            </div>
        </div>
    {:else if failed}
        <div class="panel">
            <h2>{$t("calibration.failedTitle")}</h2>
            <p>{$t("calibration.failedBody")}</p>
            <div class="actions">
                <button onclick={retry}>{$t("calibration.retry")}</button>
                {#if onCancel}
                    <button class="secondary" onclick={onCancel}
                        >{$t("calibration.cancel")}</button
                    >
                {/if}
            </div>
        </div>
    {:else if countdown !== null}
        <div class="countdown">{countdown}</div>
    {:else if calibrationFinished}
        <div class="panel">
            <h2>{$t("calibration.completeTitle")}</h2>
            <p>{$t("calibration.completeBody")}</p>
        </div>
    {:else}
        {#if progress?.isAnchorPhase}
            <!-- The remaining targets sit on the puppet's eye band: show
                 the character outline so the user understands where the
                 avatar will live during normal use. -->
            <PuppetSilhouette variant="onDark" />
        {/if}
        {#each calibrationPoints as point, i}
            {@const isAnchor = anchorMask[i] ?? false}
            {@const isActive = progress !== null && i === progress.pointIndex}
            {@const phaseMatches =
                (progress?.isAnchorPhase ?? false) === isAnchor}
            {#if phaseMatches}
                <div
                    class="dot"
                    class:active={isActive}
                    class:anchor={isAnchor}
                    style="left: {point.x}px; top: {point.y}px;"
                >
                    {#if isActive && progress?.phase === "shift"}
                        <!-- Concentric ring that shrinks toward the dot, cueing the
           user to move their gaze to this location before sampling. Shown
           only on the active target during the gaze-shift window. -->
                        <span class="ring ring-1"></span>
                    {:else if !isAnchor}
                        <!-- Corner targets always show the classic eye icon, in
           every cycle and regardless of active state. -->
                        <svg
                            class="eye-icon"
                            viewBox="0 0 24 24"
                            aria-hidden="true"
                        >
                            <path
                                fill="currentColor"
                                d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zm0 12.5a5 5 0 1 1 0-10 5 5 0 0 1 0 10zm0-8a3 3 0 1 0 0 6 3 3 0 0 0 0-6z"
                            />
                        </svg>
                    {/if}
                    <!-- Anchor (face) targets carry no eye icon in any cycle: they
                         render as the special small dot via the `.anchor` class. -->
                </div>
            {/if}
        {/each}
        {#if progress}
            <div class="hud">
                {$t("calibration.pointProgress", {
                    current: Math.min(
                        progress.pointIndex + 1,
                        progress.totalPoints,
                    ),
                    total: progress.totalPoints,
                })}
                {#if progress.isAnchorPhase}
                    <div class="hud-anchor">{$t("calibration.anchorHint")}</div>
                {/if}
            </div>
        {/if}
    {/if}
</div>

<style>
    .calibration-view {
        position: fixed;
        inset: 0;
        background: #1a1a1a;
        color: #eee;
        font-family: system-ui, sans-serif;
    }

    /* WebcamTracker is always rendered; these two classes just move it. */
    .webcam-slot.intro {
        position: fixed;
        top: 20px;
        left: 50%;
        transform: translateX(-50%);
        z-index: 5;
    }

    /* Scale the preview against the viewport height (not a fixed pixel
       size) so it stays proportionate on short/scaled screens (e.g. a
       15.6" FHD laptop with Windows display scaling) instead of
       overflowing them. The panel's margin-top below tracks this same
       budget so the two stay in sync on every screen size. */
    .webcam-slot.intro :global(.video-preview) {
        width: auto;
        height: auto;
        max-width: min(640px, 90vw);
        max-height: 26vh;
    }

    /* visibility:hidden keeps the <video> playing and MediaPipe active */
    .webcam-slot.offscreen {
        position: fixed;
        top: -9999px;
        left: -9999px;
        visibility: hidden;
    }

    .panel {
        position: relative;
        max-width: 560px;
        /* Tracks the intro webcam's height budget (26vh) plus its 20px top
           offset and a fixed gap, instead of a pixel value tuned for one
           screen size only. */
        margin: calc(20px + 26vh + 40px) auto 0;
        padding: clamp(16px, 3vh, 24px) clamp(18px, 3vw, 28px);
        background: #252525;
        border-radius: 8px;
        z-index: 10;
    }

    .panel h2 {
        margin-top: 0;
        margin-bottom: 16px;
        font-size: clamp(16px, 2.2vh, 20px);
    }

    .panel p {
        line-height: 1.5;
        margin: 8px 0;
        font-size: clamp(13px, 1.8vh, 15px);
    }

    .actions {
        display: flex;
        gap: 12px;
        justify-content: flex-end;
        margin-top: 20px;
    }

    button {
        padding: clamp(8px, 1.4vh, 10px) clamp(14px, 2vw, 20px);
        font-size: clamp(13px, 1.8vh, 15px);
        border-radius: 6px;
        border: none;
        background: #3a7bd5;
        color: white;
        cursor: pointer;
    }

    button:disabled {
        background: #555;
        cursor: not-allowed;
    }

    button.secondary {
        background: #444;
    }

    .dot {
        position: absolute;
        width: 28px;
        height: 28px;
        background: #555;
        border-radius: 50%;
        transform: translate(-50%, -50%);
        transition:
            width 0.2s,
            height 0.2s,
            background 0.2s;
        color: #fff;
        display: flex;
        align-items: center;
        justify-content: center;
    }

    .dot.active {
        width: 56px;
        height: 56px;
        background: #eee;
        z-index: 2;
    }

    /* Anchor dots sit on the puppet's eyes; tint them so they read as
       a different, on-character target set from the corner dots. */
    .dot.anchor {
        background: #8fd0ff;
        width: 22px;
        height: 22px;
    }

    .dot.anchor.active {
        background: #d6efff;
        width: 44px;
        height: 44px;
    }

    /* Single ring that travels from far away toward the dot center,
   merging with it. */
    .ring {
        position: absolute;
        top: 50%;
        left: 50%;
        width: 56px;
        height: 56px;
        border: 3px solid #fff;
        border-radius: 50%;
        transform: translate(-50%, -50%) scale(3.5);
        opacity: 0;
        animation: ring-shrink 600ms ease-in 3;
        pointer-events: none;
    }

    .ring-1 {
        display: block;
    }

    @keyframes ring-shrink {
        0% {
            transform: translate(-50%, -50%) scale(3.5);
            opacity: 0;
        }
        15% {
            opacity: 1;
        }
        85% {
            opacity: 1;
        }
        100% {
            transform: translate(-50%, -50%) scale(1);
            opacity: 0;
        }
    }

    .eye-icon {
        width: 40px;
        height: 40px;
        color: #1a1a1a;
    }

    .hud {
        position: absolute;
        top: 20px;
        left: 20px;
        padding: 8px 14px;
        background: rgba(0, 0, 0, 0.5);
        border-radius: 4px;
        font-size: 14px;
        z-index: 3;
    }

    .hud-anchor {
        margin-top: 4px;
        font-size: 13px;
        color: #8fd0ff;
    }

    .countdown {
        position: absolute;
        inset: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 128px;
        font-weight: 200;
        color: #eee;
    }
</style>
