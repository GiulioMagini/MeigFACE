//! MediaPipe FaceLandmarker wrapper for real-time iris tracking.
//!
//! Loads the face_landmarker.task model and the Wasm runtime from the
//! app's local static assets (no network access at runtime) and exposes
//! a synchronous detect() call to be invoked once per video frame.

import {
  FaceLandmarker,
  FilesetResolver,
  type FaceLandmarker as FaceLandmarkerType,
} from "@mediapipe/tasks-vision";

import type { IrisPosition, Landmark, TrackingFrame } from "./types";

// The face_landmarker.task model returns 478 landmarks per face:
// indices 0..467 are the standard face mesh, 468..472 are the left iris
// region (468 = center), 473..477 are the right iris region (473 = center).
const EXPECTED_LANDMARK_COUNT = 478;
const LEFT_IRIS_CENTER_INDEX = 468;
const RIGHT_IRIS_CENTER_INDEX = 473;

// Paths are served by SvelteKit from the static/ folder.
// Bundling the model and Wasm runtime guarantees fully offline operation.
const WASM_BASE_PATH = "/mediapipe/wasm";
const MODEL_PATH = "/mediapipe/face_landmarker.task";

/**
 * Single-instance wrapper around MediaPipe's FaceLandmarker.
 *
 * The underlying Wasm model takes ~200 MB of RAM and takes a few hundred
 * milliseconds to load, so the instance should be created once at app
 * startup and shared for the entire session.
 */
export class FaceTracker {
  private landmarker: FaceLandmarkerType | null = null;

  // Canvas handed to MediaPipe for its WebGL work. Without it MediaPipe
  // allocates an OffscreenCanvas, and WebKitGTK cannot open a WebGL context on
  // an OffscreenCanvas (it returns null), which breaks both the GPU delegate
  // and the frame conversion used by the CPU one. A detached <canvas> element
  // works everywhere and never needs to be in the DOM.
  private glCanvas: HTMLCanvasElement | null = null;

  /**
   * Load the Wasm runtime and the Face Landmarker model.
   * Safe to call multiple times — subsequent calls are no-ops.
   */
  async initialize(): Promise<void> {
    if (this.landmarker !== null) {
      return;
    }
    
    const fileset = await FilesetResolver.forVisionTasks(WASM_BASE_PATH);

    this.glCanvas = document.createElement("canvas");

    // Options shared between the GPU attempt and the CPU fallback below.
    const commonOptions = {
      // VIDEO mode returns results synchronously per frame, which
      // simplifies the render loop compared to LIVE_STREAM (callback-based).
      runningMode: "VIDEO" as const,
      numFaces: 1,
      // Blendshapes and transformation matrices are not needed for
      // gaze scoring; disabling them saves ~1-2 ms per frame.
      outputFaceBlendshapes: false,
      outputFacialTransformationMatrixes: true,
      canvas: this.glCanvas,
    };

    try {
      // GPU delegate uses WebGL for inference and is faster, but WebGL
      // context creation is known to fail unpredictably depending on the
      // GPU/driver combination — a documented MediaPipe issue, not specific
      // to this app or to Linux (google-ai-edge/mediapipe#4594). It does not
      // fail gracefully on its own, so the CPU fallback below is a deliberate
      // try/catch, not something MediaPipe applies for us automatically.
      this.landmarker = await FaceLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: MODEL_PATH, delegate: "GPU" },
        ...commonOptions,
      });
    } catch (err) {
      console.warn(
        "[FaceTracker] GPU delegate failed, falling back to CPU:",
        err,
      );
      this.landmarker = await FaceLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: MODEL_PATH, delegate: "CPU" },
        ...commonOptions,
      });
    }
  }

  /**
   * Run face and iris detection on a single video frame.
   *
   * @param video - An <video> element with an active webcam stream.
   * @param timestampMs - A monotonically increasing millisecond timestamp.
   *                      Use performance.now() from the render loop.
   * @returns A TrackingFrame describing the detected iris positions, or
   *          a frame with faceDetected=false if no face is in view.
   */
  detect(video: HTMLVideoElement, timestampMs: number): TrackingFrame {
    if (this.landmarker === null) {
      throw new Error("FaceTracker.detect called before initialize()");
    }
    const result = this.landmarker.detectForVideo(video, timestampMs);
    const faces = result.faceLandmarks;
    if (faces.length === 0 || faces[0].length < EXPECTED_LANDMARK_COUNT) {
      return { timestamp: timestampMs, faceDetected: false };
    }
    const landmarks = faces[0] as Landmark[];
    const iris: IrisPosition = {
      left: landmarks[LEFT_IRIS_CENTER_INDEX],
      right: landmarks[RIGHT_IRIS_CENTER_INDEX],
    };
    // Transformation matrix is returned as a 16-entry array in column-major
    // order. Kept raw for downstream feature extraction.
    const matrixData = result.facialTransformationMatrixes?.[0]?.data;
    const headPose =
      matrixData && matrixData.length === 16
        ? (Array.from(matrixData) as number[])
        : undefined;
    return {
      timestamp: timestampMs,
      faceDetected: true,
      iris,
      landmarks,
      headPose,
    };
  }

  /**
   * Release the Wasm runtime and free GPU memory.
   * Must be called when the tracker is no longer needed (e.g. on app close).
   */
  dispose(): void {
    if (this.landmarker !== null) {
      this.landmarker.close();
      this.landmarker = null;
      this.glCanvas = null;
    }
  }
}