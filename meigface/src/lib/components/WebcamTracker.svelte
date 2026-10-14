<script lang="ts">
    //! Svelte 5 component that captures the webcam, runs MediaPipe face
    //! tracking on every animation frame, and exposes the latest result
    //! via bindable props. The video feed is rendered mirrored, matching
    //! the convention used by every videoconference tool.

    import { onMount } from "svelte";
    import { FaceTracker } from "#lib/tracking/mediapipe.js";
    import { TrackerState, type TrackingFrame } from "#lib/tracking/types.js";
    import { t } from "#lib/i18n/index.js";
    import { getPreferredCameraId } from "#lib/mediaDevices.js";

    interface Props {
        frame?: TrackingFrame | null;
        trackerState?: TrackerState;
        // Bindable handle to the underlying <video> element. Used by the
        // calibration flow to grab an eye-region snapshot once the
        // procedure completes. Remains null until the video element
        // mounts, so consumers must null-check before use.
        videoElement?: HTMLVideoElement | null;
    }

    let {
        frame = $bindable(null),
        trackerState = $bindable(TrackerState.Idle),
        videoElement = $bindable(null),
    }: Props = $props();

    let videoEl = $state<HTMLVideoElement | null>(null);

    // Keep the bindable prop in sync with the local ref whenever the
    // element mounts or unmounts, so the parent can capture snapshots.
    $effect(() => {
        videoElement = videoEl;
    });
    let errorMsg = $state<string>("");

    let stream: MediaStream | null = null;
    let tracker: FaceTracker | null = null;
    let rafId: number | null = null;

    onMount(() => {
        let disposed = false;

        (async () => {
            try {
                trackerState = TrackerState.Initializing;

                // Prefer the camera chosen in Settings; fall back to the
                // system default device when none has been picked yet.
                const preferredCameraId = await getPreferredCameraId();
                const baseVideo = {
                    width: { ideal: 1280 },
                    height: { ideal: 720 },
                    facingMode: "user",
                };
                try {
                    stream = await navigator.mediaDevices.getUserMedia({
                        video: preferredCameraId
                            ? { ...baseVideo, deviceId: { exact: preferredCameraId } }
                            : baseVideo,
                        audio: false,
                    });
                } catch (err) {
                    // A saved device ID can go stale (device unplugged, or the
                    // engine rotated its per-origin IDs): retry with the system
                    // default instead of failing the tracker outright.
                    if (!preferredCameraId) throw err;
                    console.warn(
                        "[WebcamTracker] preferred camera unavailable, using system default:",
                        err,
                    );
                    stream = await navigator.mediaDevices.getUserMedia({
                        video: baseVideo,
                        audio: false,
                    });
                }

                if (disposed) {
                    stopStream();
                    return;
                }

                if (videoEl) {
                    videoEl.srcObject = stream;
                    await videoEl.play();
                }

                tracker = new FaceTracker();
                await tracker.initialize();

                if (disposed) {
                    tracker.dispose();
                    stopStream();
                    return;
                }

                trackerState = TrackerState.Ready;
                startDetectionLoop();
            } catch (err) {
                trackerState = TrackerState.Error;
                errorMsg = err instanceof Error ? err.message : String(err);
            }
        })();

        return () => {
            disposed = true;
            stopDetectionLoop();
            if (tracker) {
                tracker.dispose();
                tracker = null;
            }
            stopStream();
        };
    });

    function startDetectionLoop(): void {
        const tick = () => {
            if (!tracker || !videoEl || videoEl.readyState < 2) {
                rafId = requestAnimationFrame(tick);
                return;
            }
            frame = tracker.detect(videoEl, performance.now());
            rafId = requestAnimationFrame(tick);
        };
        rafId = requestAnimationFrame(tick);
    }

    function stopDetectionLoop(): void {
        if (rafId !== null) {
            cancelAnimationFrame(rafId);
            rafId = null;
        }
    }

    function stopStream(): void {
        if (stream) {
            stream.getTracks().forEach((t) => t.stop());
            stream = null;
        }
    }
</script>

<div class="webcam-tracker">
    <!-- Mirrored video so the user sees themselves as in a mirror -->
    <video bind:this={videoEl} autoplay playsinline muted class="video-preview"
    ></video>

    {#if trackerState === TrackerState.Initializing}
        <div class="status">{$t("tracker.initializing")}</div>
    {:else if trackerState === TrackerState.Error}
        <div class="status error">Error: {errorMsg}</div>
    {/if}
</div>

<style>
    .webcam-tracker {
        position: relative;
        display: inline-block;
    }

    .video-preview {
        /* Horizontal mirror matches the user's mental model */
        transform: scaleX(-1);
        width: 100%;
        max-width: 640px;
        background: #000;
        border-radius: 8px;
        display: block;
    }

    .status {
        position: absolute;
        bottom: 8px;
        left: 8px;
        padding: 4px 8px;
        background: rgba(0, 0, 0, 0.7);
        color: white;
        border-radius: 4px;
        font-size: 14px;
    }

    .status.error {
        background: rgba(200, 0, 0, 0.9);
    }
</style>
