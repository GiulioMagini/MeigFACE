//! Shared type definitions for the eye tracking module.
//!
//! These types abstract over the MediaPipe output so the rest of
//! the app does not depend on MediaPipe's own types directly.

/**
 * Normalized 3D landmark coordinate in image space.
 * x and y are in [0, 1] relative to image dimensions, z is depth
 * relative to the face center (negative means closer to the camera).
 */
export interface Landmark {
  x: number;
  y: number;
  z: number;
}

/**
 * Iris center positions extracted from the full landmark array.
 *
 * Note: "left" and "right" are from the camera's point of view,
 * which is mirrored compared to the user. This does not matter
 * for gaze estimation as long as the convention stays consistent.
 */
export interface IrisPosition {
  left: Landmark;
  right: Landmark;
}

/**
 * Lifecycle state of the FaceTracker.
 * Used by UI layers to render loading/error indicators.
 */
export enum TrackerState {
  Idle = "idle",
  Initializing = "initializing",
  Ready = "ready",
  Error = "error",
}

/**
 * Result of running inference on a single video frame.
 * When no face is detected, only timestamp and faceDetected=false are set.
 */
export interface TrackingFrame {
  timestamp: number;
  faceDetected: boolean;
  iris?: IrisPosition;
  // Full landmark array is kept for downstream modules that need
  // head pose or eye-corner references (calibration, scoring).
  landmarks?: Landmark[];
  // Facial transformation matrix (16 entries, column-major) describing
  // head rotation and translation relative to the camera. Used by the
  // feature extractor to compensate for head movement between
  // calibration and runtime.
  headPose?: number[];
}

/**
 * Screen coordinates in pixels, origin top-left.
 */
export interface ScreenPoint {
  x: number;
  y: number;
}

/**
 * Fitted gaze-estimation model produced by the calibration procedure
 * and consumed by the gaze scoring module.
 *
 * Coefficients are stored as plain number arrays because the active
 * basis size depends on regression.ts's GAZE_MODE constant:
 *   - GAZE_MODE "linear"    → 3 coefficients per axis
 *                              screen = c[0] + c[1]*fx + c[2]*fy
 *   - GAZE_MODE "quadratic" → 6 coefficients per axis
 *                              screen = c[0] + c[1]*fx + c[2]*fy
 *                                        + c[3]*fx*fy + c[4]*fx^2 + c[5]*fy^2
 *   - GAZE_MODE "hybrid"    → 3 linear coefficients followed by one
 *                              RBF kernel weight per calibration point;
 *                              the kernel centers and width live in the
 *                              rbf field below.
 *
 * The model must always be produced and consumed by the same GAZE_MODE
 * — mixing them yields meaningless predictions. A stored model should
 * therefore be invalidated whenever the mode changes.
 */
export interface GazeModel {
  coeffsX: number[];
  coeffsY: number[];
  /**
   * Present only for hybrid-mode models: Gaussian RBF kernel centers
   * (in iris-feature space, same frame as extractFeatures output) and
   * the kernel width shared by both axes. Absent on linear/quadratic
   * models and on hybrid models that gracefully degraded to the pure
   * linear backbone.
   */
  rbf?: {
    centers: Array<[number, number]>;
    sigma: number;
  };
  /**
   * Optional post-hoc bias correction applied AFTER the base prediction
   * (coeffs + optional RBF). A translational offset in screen pixels fitted
   * on the eye-anchor points during the session's optional bias-correction
   * step. Absent on freshly-calibrated models that skipped that step.
   */
  bias?: { x: number; y: number };
}

/**
 * Lifecycle state of the calibration procedure.
 */
export enum CalibrationState {
  Idle = "idle",
  Collecting = "collecting",
  Completed = "completed",
  Failed = "failed",
}

/**
 * Reference eye region captured at the end of calibration.
 * Used at runtime to warn the user when their head has drifted too far
 * from the position they were in during calibration.
 */
export interface EyeReference {
  /**
   * PNG data-URL of the cropped eye region from the reference frame.
   * Rendered as an overlay mask when the user leaves tolerance.
   */
  maskDataUrl: string;
  /**
   * Center of the eye region in the video frame, normalized to [0, 1]
   * so the overlay can be repositioned regardless of preview size.
   */
  centerX: number;
  centerY: number;
  /**
   * Half-size of the captured eye region in normalized units.
   * The overlay mask scales to this size on every preview.
   */
  halfWidth: number;
  halfHeight: number;
}