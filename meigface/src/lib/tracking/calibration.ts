//! Calibration state machine for gaze tracking.
//!
//! Walks the user through two blocks of points, each repeated per
//! cycle (light = 3 cycles, heavy = 4): first the four screen corners,
//! then four "anchor" targets placed exactly on the puppet's eye band
//! — the only screen region where gaze accuracy actually matters for
//! eye-contact scoring. For each point, the first "gaze-shift" window
//! is ignored (the user needs time to move their eyes), then samples
//! are collected during the "collect" window and finally a regression
//! from iris features to screen coordinates is fitted on the corner +
//! anchor data together.

import { buildAnchorPoints } from "../avatar/layout";
import { extractFeatures, fitGazeModel, predictGaze } from "./regression";
import {
  CalibrationState,
  type GazeModel,
  type ScreenPoint,
  type TrackingFrame,
} from "./types";

/**
 * Calibration modes selectable by the user. Both first reinforce the
 * four screen-corner points (to pin down the top/bottom extremes,
 * where vertical accuracy is weakest), then the four eye-anchor points
 * on the puppet's face (the gaze target during use). They differ only
 * in how many times each block is repeated:
 *   - "light" : 3 cycles of corners + 3 cycles of eye anchors (recommended).
 *   - "heavy" : 4 cycles of each (for low-quality webcams).
 * Earlier grid modes (9/16/25/49) were superseded: the corners reinforce
 * the vertical extremes while the eye anchors reinforce the only region
 * that matters for scoring, without showing the user a tiring grid.
 */
export const CALIBRATION_POINT_OPTIONS = ["light", "heavy"] as const;
export type CalibrationMode = (typeof CALIBRATION_POINT_OPTIONS)[number];

// Number of repetitions of each block (corners, then eye anchors) per
// mode. Repeating the same points across cycles is what made the
// reinforcement effective in field tests.
const MODE_CYCLES: Record<CalibrationMode, number> = { light: 3, heavy: 4 };

// Per-point timing, tuned for a natural pace without rushing the user.
const GAZE_SHIFT_MS = 600;   // Samples during this window are discarded
const COLLECT_MS = 1500;     // Samples during this window are kept
const POINT_TOTAL_MS = GAZE_SHIFT_MS + COLLECT_MS;

// A point is considered valid only if at least this many valid samples
// were gathered — guards against excessive blinking or a face lost mid
// calibration resulting in a silently low-quality model.
const MIN_SAMPLES_PER_POINT = 10;

/**
 * Progress snapshot returned on every update, so the UI can render
 * the active target, the remaining time, and the overall status.
 */
export interface CalibrationProgress {
  pointIndex: number;
  totalPoints: number;
  currentTarget: ScreenPoint | null;
  phase: "shift" | "collect" | "between";
  state: CalibrationState;
  /**
   * True while the active target is one of the eye-anchor points on
   * the puppet's face (the tail of the sequence). The UI shows the
   * puppet silhouette during this phase.
   */
  isAnchorPhase: boolean;
}

/**
 * Orchestrates the calibration procedure (corner reinforcement
 * followed by eye-anchor reinforcement; see CALIBRATION_POINT_OPTIONS).
 *
 * Usage pattern from the UI layer:
 *   const c = new Calibrator(width, height);
 *   c.start(performance.now());
 *   // every animation frame while a tracking frame is available:
 *   const progress = c.update(frame, performance.now());
 *   // when progress.state === CalibrationState.Completed:
 *   const model = c.getModel();
 */
export class Calibrator {
  private readonly points: ScreenPoint[];
  /**
   * Per-point flag: true when the point is one of the puppet's eye
   * anchors (drawn as the special on-face target). Decoupling this
   * from any index threshold guarantees every repeated anchor — in
   * every cycle — is recognized as an anchor.
   */
  private readonly anchorMask: boolean[];
  private samplesByPoint: Array<Array<[number, number]>> = [];
  private currentIndex = 0;
  private pointStartTimeMs = 0;
  private state: CalibrationState = CalibrationState.Idle;
  private model: GazeModel | null = null;

  /**
 * @param screenWidth - Viewport width in CSS pixels.
 * @param screenHeight - Viewport height in CSS pixels.
 * @param mode - "light" (3 cycles, recommended) or "heavy" (4 cycles,
 *               for low-quality webcams). Each mode runs the four
 *               screen-corner points for N cycles, then the four
 *               eye-anchor points for N cycles.
 */
  constructor(
    screenWidth: number,
    screenHeight: number,
    mode: CalibrationMode,
  ) {
    const cycles = MODE_CYCLES[mode];
    const corners = buildCorners(screenWidth, screenHeight);
    const anchors = buildAnchorPoints(screenWidth, screenHeight);

    const points: ScreenPoint[] = [];
    const anchorMask: boolean[] = [];
    // First block: the four screen corners, repeated `cycles` times.
    for (let c = 0; c < cycles; c++) {
      for (const p of corners) {
        points.push(p);
        anchorMask.push(false);
      }
    }
    // Second block: the four eye anchors on the puppet's face, repeated
    // `cycles` times — flagged as anchors in every cycle.
    for (let c = 0; c < cycles; c++) {
      for (const p of anchors) {
        points.push(p);
        anchorMask.push(true);
      }
    }
    this.points = points;
    this.anchorMask = anchorMask;
    this.samplesByPoint = this.points.map(() => []);
}

  /**
   * Begin the procedure. The caller must provide a monotonic timestamp
   * (typically performance.now()) that matches what will be passed to
   * subsequent update() calls.
   */
  start(nowMs: number): void {
    this.currentIndex = 0;
    this.samplesByPoint = this.points.map(() => []);
    this.pointStartTimeMs = nowMs;
    this.state = CalibrationState.Collecting;
    this.model = null;
  }

  /**
   * Feed a new tracking frame to the calibrator.
   * Returns the current progress snapshot for the UI to render.
   */
  update(frame: TrackingFrame, nowMs: number): CalibrationProgress {
    if (this.state !== CalibrationState.Collecting) {
      return this.snapshot("between");
    }
    const elapsed = nowMs - this.pointStartTimeMs;
    const phase: "shift" | "collect" =
      elapsed < GAZE_SHIFT_MS ? "shift" : "collect";

    // Sample only during the collect window, and only when a valid
    // face with landmarks is available. Blinks and lost-face frames
    // are silently skipped; MIN_SAMPLES_PER_POINT guards the quality.
    if (phase === "collect" && frame.faceDetected && frame.landmarks) {
      const features = extractFeatures(frame.landmarks, frame.headPose);
      this.samplesByPoint[this.currentIndex].push(features);
    }

    if (elapsed >= POINT_TOTAL_MS) {
      this.advance(nowMs);
    }
    return this.snapshot(phase);
  }

  /** Fitted model once calibration has completed, null otherwise. */
  getModel(): GazeModel | null {
    return this.model;
  }

  /** The ordered list of screen points the UI should highlight. */
  getPoints(): ReadonlyArray<ScreenPoint> {
    return this.points;
  }

  /**
   * Per-point anchor flags, aligned with getPoints(). True entries are
   * the eye anchors on the puppet's face; the UI styles them as the
   * special on-face target and shows the silhouette while they are
   * active. Robust across repeated cycles (unlike an index threshold).
   */
  getAnchorMask(): ReadonlyArray<boolean> {
    return this.anchorMask;
  }

  // ---- internal helpers ----

  private advance(nowMs: number): void {
    this.currentIndex += 1;
    if (this.currentIndex >= this.points.length) {
      this.finalize();
      return;
    }
    this.pointStartTimeMs = nowMs;
  }

  private finalize(): void {
    // Require every point to have enough samples; otherwise ask the
    // user to redo calibration rather than produce a low-quality model.
    const aggregated: Array<[number, number]> = [];
    const targets: ScreenPoint[] = [];
    for (let i = 0; i < this.points.length; i++) {
      const samples = this.samplesByPoint[i];
      if (samples.length < MIN_SAMPLES_PER_POINT) {
        this.state = CalibrationState.Failed;
        return;
      }
      aggregated.push(medianFeature(samples));
      targets.push(this.points[i]);
    }
    const fitted = fitGazeModel(aggregated, targets);
    if (fitted === null) {
      this.state = CalibrationState.Failed;
      return;
    }
    this.model = fitted;
    this.state = CalibrationState.Completed;
  }

  private snapshot(phase: CalibrationProgress["phase"]): CalibrationProgress {
    return {
      pointIndex: this.currentIndex,
      totalPoints: this.points.length,
      currentTarget: this.points[this.currentIndex] ?? null,
      phase,
      state: this.state,
      isAnchorPhase:
        this.state === CalibrationState.Collecting &&
        (this.anchorMask[this.currentIndex] ?? false),
    };
  }
}

/**
 * The four screen-corner points, with asymmetric margins: horizontal
 * 10% (X already behaves well), vertical 6% so
 * the top corners sit close to where vertical accuracy is weakest
 * (upper-eyelid occlusion). Order: top-left, top-right, bottom-left,
 * bottom-right.
 */
function buildCorners(w: number, h: number): ScreenPoint[] {
  const marginX = w * 0.1;
  const marginY = h * 0.06;
  return [
    { x: marginX, y: marginY },
    { x: w - marginX, y: marginY },
    { x: marginX, y: h - marginY },
    { x: w - marginX, y: h - marginY },
  ];
}

/**
 * Coordinate-wise median of a set of 2D feature vectors.
 * More robust than the mean against blinks or transient head movement
 * that might have slipped past the face-detected check.
 */
function medianFeature(samples: Array<[number, number]>): [number, number] {
  const xs = samples.map((s) => s[0]).sort((a, b) => a - b);
  const ys = samples.map((s) => s[1]).sort((a, b) => a - b);
  const mid = Math.floor(samples.length / 2);
  const medianX =
    samples.length % 2 === 0 ? (xs[mid - 1] + xs[mid]) / 2 : xs[mid];
  const medianY =
    samples.length % 2 === 0 ? (ys[mid - 1] + ys[mid]) / 2 : ys[mid];
  return [medianX, medianY];
}

/**
 * Repetitions of the four eye-anchor points during the optional
 * bias-correction step (so 4 points × this = total captures). Two passes
 * balance robustness against keeping the step short.
 */
const BIAS_CYCLES = 2;

/**
 * Optional post-calibration refinement focused on the puppet's eye band.
 * It re-shows only the four eye-anchor points (twice) and, from the gaze the
 * current model predicts at those known targets, fits a single translational
 * offset — the systematic bias in the only region that matters for eye
 * contact. Wider-screen accuracy is intentionally left untouched: for this
 * app there is no value in looking away from the face.
 *
 * Same update() contract as Calibrator, so the UI can drive it identically.
 */
export class BiasCorrector {
  private readonly points: ScreenPoint[];
  private samplesByPoint: Array<Array<[number, number]>> = [];
  private currentIndex = 0;
  private pointStartTimeMs = 0;
  private state: CalibrationState = CalibrationState.Idle;
  private readonly model: GazeModel;
  private corrected: GazeModel | null = null;

  /**
   * @param screenWidth - Viewport width in CSS pixels.
   * @param screenHeight - Viewport height in CSS pixels.
   * @param model - The currently fitted gaze model to refine. Its existing
   *                bias (if any) is preserved and the new offset is added on
   *                top, so re-running refines rather than resets.
   */
  constructor(screenWidth: number, screenHeight: number, model: GazeModel) {
    const anchors = buildAnchorPoints(screenWidth, screenHeight);
    const points: ScreenPoint[] = [];
    for (let c = 0; c < BIAS_CYCLES; c++) {
      for (const p of anchors) points.push(p);
    }
    this.points = points;
    this.model = model;
    this.samplesByPoint = this.points.map(() => []);
  }

  /** Begin the procedure with a monotonic timestamp (performance.now()). */
  start(nowMs: number): void {
    this.currentIndex = 0;
    this.samplesByPoint = this.points.map(() => []);
    this.pointStartTimeMs = nowMs;
    this.state = CalibrationState.Collecting;
    this.corrected = null;
  }

  /** Feed a tracking frame; returns the progress snapshot for the UI. */
  update(frame: TrackingFrame, nowMs: number): CalibrationProgress {
    if (this.state !== CalibrationState.Collecting) {
      return this.snapshot("between");
    }
    const elapsed = nowMs - this.pointStartTimeMs;
    const phase: "shift" | "collect" =
      elapsed < GAZE_SHIFT_MS ? "shift" : "collect";

    // Same windowing as Calibrator: discard the gaze-shift window, sample the
    // collect window when a valid face is present.
    if (phase === "collect" && frame.faceDetected && frame.landmarks) {
      const features = extractFeatures(frame.landmarks, frame.headPose);
      this.samplesByPoint[this.currentIndex].push(features);
    }

    if (elapsed >= POINT_TOTAL_MS) {
      this.advance(nowMs);
    }
    return this.snapshot(phase);
  }

  /** Corrected model (input model + fitted bias) once completed, else null. */
  getCorrectedModel(): GazeModel | null {
    return this.corrected;
  }

  /** The ordered list of screen points the UI should highlight. */
  getPoints(): ReadonlyArray<ScreenPoint> {
    return this.points;
  }

  // ---- internal helpers ----

  private advance(nowMs: number): void {
    this.currentIndex += 1;
    if (this.currentIndex >= this.points.length) {
      this.finalize();
      return;
    }
    this.pointStartTimeMs = nowMs;
  }

  private finalize(): void {
    // Average residual (target - current prediction) over the anchor points,
    // added on top of any existing bias so re-running refines the correction.
    let sumX = 0;
    let sumY = 0;
    for (let i = 0; i < this.points.length; i++) {
      const samples = this.samplesByPoint[i];
      if (samples.length < MIN_SAMPLES_PER_POINT) {
        this.state = CalibrationState.Failed;
        return;
      }
      const predicted = predictGaze(this.model, medianFeature(samples));
      sumX += this.points[i].x - predicted.x;
      sumY += this.points[i].y - predicted.y;
    }
    const n = this.points.length;
    const base = this.model.bias ?? { x: 0, y: 0 };
    this.corrected = {
      ...this.model,
      bias: { x: base.x + sumX / n, y: base.y + sumY / n },
    };
    this.state = CalibrationState.Completed;
  }

  private snapshot(phase: CalibrationProgress["phase"]): CalibrationProgress {
    return {
      pointIndex: this.currentIndex,
      totalPoints: this.points.length,
      currentTarget: this.points[this.currentIndex] ?? null,
      phase,
      state: this.state,
      isAnchorPhase: this.state === CalibrationState.Collecting,
    };
  }
}