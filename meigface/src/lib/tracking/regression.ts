//! Pure math helpers for the calibration regression.
//!
//! The gaze tracker maps iris features (extracted from the face mesh
//! and optionally compensated for head pose) to screen coordinates
//! through a regression fitted on the calibration points. Three basis
//! families are supported:
//!
//!   - "linear"    : 3 coefficients per axis. Robust on low-quality
//!                   webcams and with few calibration points, but
//!                   cannot model the non-linear iris-to-screen
//!                   mapping near the screen edges (systematic
//!                   under-prediction at the top of the screen).
//!   - "quadratic" : 6 coefficients per axis. Captures the eyelid-
//!                   saturation non-linearity but the global fx^2/fy^2
//!                   terms amplify landmark jitter, making the
//!                   predicted point unstable.
//!   - "hybrid"    : linear backbone + regularized RBF residual
//!                   correction anchored at the calibration points.
//!                   Fixes the top-of-screen bias locally (where the
//!                   calibration data says the linear fit is wrong)
//!                   while keeping noise amplification close to the
//!                   linear mode, because the correction surface is
//!                   smooth and its magnitude is bounded by ridge
//!                   regularization.
//!
//! Switching between modes is done by changing the GAZE_MODE constant
//! below; the rest of the file adapts automatically.

import type { GazeModel, Landmark, ScreenPoint } from "./types";

// Eye-corner and iris-boundary landmark indices from the MediaPipe
// Face Mesh topology. Using the signed offset of the iris relative to
// the eye CENTER (mean of the four eyelid corners) — and scaling by
// the eye's absolute width/height — cancels out most of the variance
// from head distance while remaining consistent in sign across both
// eyes. "Left" and "right" are from the camera's point of view.
const LEFT_EYE_INNER = 133;
const LEFT_EYE_OUTER = 33;
const LEFT_EYE_TOP = 159;
const LEFT_EYE_BOTTOM = 145;
const RIGHT_EYE_INNER = 362;
const RIGHT_EYE_OUTER = 263;
const RIGHT_EYE_TOP = 386;
const RIGHT_EYE_BOTTOM = 374;

const LEFT_IRIS_CENTER = 468;
const RIGHT_IRIS_CENTER = 473;

type GazeMode = "linear" | "quadratic" | "hybrid";

/**
 * Active regression basis. Change this single constant to switch
 * between linear, quadratic and hybrid fitting. Everything else in
 * this file — basis size, feature expansion, design matrix, RBF
 * stage — adapts from here.
 *
 * Must also be kept in sync with the coefficient layout documented
 * for GazeModel in types.ts (3 for linear, 6 for quadratic,
 * 3 + one weight per calibration point for hybrid).
 */
// The `as GazeMode` assertion widens the inferred type back to the
// full union so that downstream `=== "linear"` / `=== "quadratic"`
// comparisons remain valid whichever literal is selected here.
export const GAZE_MODE = "linear" as GazeMode;

/** Number of polynomial basis functions per axis for the current mode.
 *  The hybrid mode uses the linear basis as its backbone (3), the RBF
 *  weights are appended separately by the fitting stage. */
const BASIS_SIZE = GAZE_MODE === "quadratic" ? 6 : 3;

// ---- hybrid (RBF) tuning constants ----
//
// sigma and ridge are NOT used as fixed values: they are scale
// factors from which the actual kernel width and damping are derived
// per-calibration, so the hybrid fit stays well-conditioned across
// both calibration modes — the four screen corners are well spread
// while the four eye anchors are repeated and therefore cluster
// tightly in feature space.

/**
 * Kernel width as a multiple of the calibration points' spacing. The
 * spacing is taken as the mean nearest-neighbor distance but floored
 * at a fraction of the median pairwise distance (see
 * RBF_SIGMA_FLOOR_FRAC), so clustered or repeated points (e.g. the repeated eye anchors)
 * cannot collapse the width to zero. Larger values produce a
 * smoother, wider-reaching correction; smaller values keep each
 * point's correction more local.
 */
const RBF_SIGMA_SCALE = 1.5;

/**
 * Floor for the kernel width, as a fraction of the median pairwise
 * distance between calibration features. Kicks in only when the mean
 * nearest-neighbor spacing is unusually small (clustered/duplicate
 * points), preventing a near-zero, ill-conditioned kernel. For the
 * well-spread corner points the nearest-neighbor spacing dominates
 * and this has no effect.
 */
const RBF_SIGMA_FLOOR_FRAC = 0.5;

/**
 * Base ridge regularization added to the kernel matrix diagonal
 * (kernel values are in [0, 1], so this is relative to a unit
 * diagonal and therefore already count-independent). Higher values
 * keep the correction stiffer and closer to the linear backbone.
 */
const RBF_RIDGE = 0.05;

/**
 * Small-sample boost for the ridge: the effective ridge is
 * RBF_RIDGE * (1 + RBF_RIDGE_SMALL_N / n). With few calibration
 * points there is less averaging, so a bit more damping keeps the
 * solve stable and avoids overfitting the residuals; the boost fades
 * as n grows (e.g. x1.33 at n=24 in light mode, x1.25 at n=32 in heavy).
 */
const RBF_RIDGE_SMALL_N = 8;

// Empirical gains for the head-pose compensation. Subtracting a
// fraction proportional to yaw/pitch from the raw image-space iris
// offset approximates the inverse shift caused by small head
// rotations between calibration and runtime. Lowered from 0.35 to
// 0.22 after field data showed the estimated pitch is noisy
// (~10° ± 2° on cameras pointing up at the face); a smaller gain
// keeps that jitter from being amplified into large vertical jumps
// of the predicted point. Runtime callers further denoise the angles
// with a temporal filter (see the angleOverride parameter below).

type CompensationMode = "on" | "off";

/**
 * Active head-pose compensation configuration. Change this single
 * constant to switch:
 *
 *   - "on"  : counter-rotate the iris offset by the (smoothed) head
 *             yaw/pitch. The default; helps when the head moves
 *             between calibration and use.
 *   - "off" : no pose compensation at all — features are the raw iris
 *             offsets. MediaPipe's landmarks already absorb some head
 *             motion, so this is worth testing: if the raw features
 *             are stable enough, our extra compensation may be adding
 *             more noise/bias than it removes.
 *
 * Independent of GAZE_MODE: any compensation mode works with any
 * regression basis.
 */
export const HEAD_COMPENSATION = "off" as CompensationMode;

// Gains are forced to 0 when compensation is disabled, so the rest of
// the code path stays identical (no branching needed downstream).
const HEAD_COMPENSATION_GAIN_X = HEAD_COMPENSATION === "off" ? 0 : 0.22;
const HEAD_COMPENSATION_GAIN_Y = HEAD_COMPENSATION === "off" ? 0 : 0.22;
/**
 * @param landmarks - Face landmarks in the image frame (from MediaPipe).
 * @param headPose  - Optional 4x4 facial transformation matrix in
 *                    column-major order. When supplied, raw features
 *                    are counter-rotated by the head's yaw and pitch
 *                    so calibration and runtime features stay
 *                    comparable.
 * @param angleOverride - Optional pre-computed (and typically
 *                    temporally smoothed) yaw/pitch in radians. When
 *                    supplied it replaces the angles derived from
 *                    headPose — runtime callers use this to feed an
 *                    EMA-filtered head pose, killing the frame-to-frame
 *                    jitter that the raw matrix exhibits, without
 *                    changing the compensation formula (so calibration,
 *                    which denoises via per-point medians, and runtime
 *                    stay consistent).
 */
export function extractFeatures(
  landmarks: Landmark[],
  headPose?: number[],
  angleOverride?: { yaw: number; pitch: number },
): [number, number] {
  const left = eyeOffset(
    landmarks,
    LEFT_IRIS_CENTER,
    LEFT_EYE_INNER,
    LEFT_EYE_OUTER,
    LEFT_EYE_TOP,
    LEFT_EYE_BOTTOM,
  );
  const right = eyeOffset(
    landmarks,
    RIGHT_IRIS_CENTER,
    RIGHT_EYE_INNER,
    RIGHT_EYE_OUTER,
    RIGHT_EYE_TOP,
    RIGHT_EYE_BOTTOM,
  );
  const rawFx = (left[0] + right[0]) / 2;
  const rawFy = (left[1] + right[1]) / 2;

  const angles = angleOverride ?? (headPose ? headAngles(headPose) : null);
  if (!angles) {
    return [rawFx, rawFy];
  }

  return [
    rawFx - angles.yaw * HEAD_COMPENSATION_GAIN_X,
    rawFy - angles.pitch * HEAD_COMPENSATION_GAIN_Y,
  ];
}

/**
 * Extract yaw (rotation around Y, left/right head turn) and pitch
 * (rotation around X, up/down head nod) in radians from a 4x4
 * facial transformation matrix in column-major order (element
 * (row, col) lives at index col * 4 + row).
 */
export function headAngles(headPose: number[]): { yaw: number; pitch: number } {
  const m02 = headPose[2 * 4 + 0];
  const m12 = headPose[2 * 4 + 1];
  const m22 = headPose[2 * 4 + 2];
  return {
    yaw: Math.atan2(m02, m22),
    pitch: Math.atan2(-m12, Math.hypot(m02, m22)),
  };
}

/**
 * Apply the fitted gaze model to a feature vector. Works with all
 * three bases: linear and quadratic go through the polynomial
 * expansion; hybrid adds the RBF correction on top of the linear
 * backbone. A hybrid-mode model that lacks the rbf field (graceful
 * degradation when the kernel solve failed) behaves as pure linear.
 */
export function predictGaze(
  model: GazeModel,
  features: [number, number],
): ScreenPoint {
  const [fx, fy] = features;

  if (GAZE_MODE === "hybrid" && model.rbf) {
    const { centers, sigma } = model.rbf;
    // Linear backbone: first 3 coefficients.
    let x = model.coeffsX[0] + model.coeffsX[1] * fx + model.coeffsX[2] * fy;
    let y = model.coeffsY[0] + model.coeffsY[1] * fx + model.coeffsY[2] * fy;
    // Bounded local correction: one Gaussian kernel per center,
    // weights stored after the 3 linear coefficients.
    const twoSigmaSq = 2 * sigma * sigma;
    for (let i = 0; i < centers.length; i++) {
      const dx = fx - centers[i][0];
      const dy = fy - centers[i][1];
      const k = Math.exp(-(dx * dx + dy * dy) / twoSigmaSq);
      x += model.coeffsX[3 + i] * k;
      y += model.coeffsY[3 + i] * k;
    }
    return applyBias(model, x, y);
  }

  const poly = polynomialFeatures(fx, fy);
  return applyBias(model, dot(model.coeffsX, poly), dot(model.coeffsY, poly));
}

/**
 * Add the optional post-hoc bias offset (fitted by the session's
 * bias-correction step) to a base prediction. No-op when absent.
 */
function applyBias(model: GazeModel, x: number, y: number): ScreenPoint {
  return model.bias ? { x: x + model.bias.x, y: y + model.bias.y } : { x, y };
}

/**
 * Fit a gaze model on the basis functions selected by GAZE_MODE.
 *
 * Linear and quadratic: ordinary least squares on the polynomial
 * basis. Hybrid: OLS on the linear basis first, then a regularized
 * RBF fit of the residuals at the calibration points (two-stage fit).
 * If the RBF stage fails (degenerate kernel matrix), the linear
 * backbone alone is returned, so the hybrid mode can never be worse
 * than linear.
 *
 * Returns null when the normal equations are rank-deficient — happens
 * only on degenerate input (e.g. all calibration points colinear or
 * the user stared at a single spot throughout).
 */
export function fitGazeModel(
  features: Array<[number, number]>,
  targets: ScreenPoint[],
): GazeModel | null {
  const base = fitLeastSquares(features, targets);
  if (base === null || GAZE_MODE !== "hybrid") {
    return base;
  }
  return fitRbfResiduals(base, features, targets);
}

/**
 * Ordinary least squares on the polynomial basis selected by
 * GAZE_MODE (3 terms for linear/hybrid backbone, 6 for quadratic).
 */
function fitLeastSquares(
  features: Array<[number, number]>,
  targets: ScreenPoint[],
): GazeModel | null {
  const n = features.length;
  if (n !== targets.length || n < BASIS_SIZE) {
    return null;
  }

  const design: number[][] = features.map(([fx, fy]) =>
    polynomialFeatures(fx, fy),
  );

  const xtx = zeros2D(BASIS_SIZE, BASIS_SIZE);
  const xtyX = new Array<number>(BASIS_SIZE).fill(0);
  const xtyY = new Array<number>(BASIS_SIZE).fill(0);
  for (let i = 0; i < n; i++) {
    const row = design[i];
    const { x: tx, y: ty } = targets[i];
    for (let r = 0; r < BASIS_SIZE; r++) {
      xtyX[r] += row[r] * tx;
      xtyY[r] += row[r] * ty;
      for (let c = 0; c < BASIS_SIZE; c++) {
        xtx[r][c] += row[r] * row[c];
      }
    }
  }

  const coeffsX = solveLinearSystem(xtx, xtyX);
  const coeffsY = solveLinearSystem(xtx, xtyY);
  if (coeffsX === null || coeffsY === null) {
    return null;
  }
  return {
    coeffsX: coeffsX as GazeModel["coeffsX"],
    coeffsY: coeffsY as GazeModel["coeffsY"],
  };
}

/**
 * Second stage of the hybrid fit: model the residuals of the linear
 * backbone with a regularized Gaussian RBF whose centers are the
 * calibration features themselves. Solves (K + ridge*I) w = residual
 * per axis; the resulting weights are appended to the linear
 * coefficients and the centers/sigma stored in the model so
 * predictGaze can evaluate the same kernels at runtime.
 *
 * On failure (degenerate geometry) returns the untouched linear
 * backbone, which predictGaze handles transparently.
 */
function fitRbfResiduals(
  base: GazeModel,
  features: Array<[number, number]>,
  targets: ScreenPoint[],
): GazeModel {
  const n = features.length;

  // Kernel width: nearest-neighbor spacing, floored at a fraction of
  // the median pairwise distance so clustered/duplicate points (face
  // mode) cannot collapse it to zero.
  const spacing = meanNearestNeighborDistance(features);
  const floor = RBF_SIGMA_FLOOR_FRAC * medianPairwiseDistance(features);
  const sigma = RBF_SIGMA_SCALE * Math.max(spacing, floor);
  if (!(sigma > 1e-6)) {
    // Degenerate spread (all features almost identical): the linear
    // backbone is the best we can do.
    return base;
  }

  // Ridge with a small-sample boost (relative to the unit diagonal).
  const ridge = RBF_RIDGE * (1 + RBF_RIDGE_SMALL_N / n);

  // Residuals of the linear backbone at the calibration points.
  const resX = new Array<number>(n);
  const resY = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const [fx, fy] = features[i];
    const predX = base.coeffsX[0] + base.coeffsX[1] * fx + base.coeffsX[2] * fy;
    const predY = base.coeffsY[0] + base.coeffsY[1] * fx + base.coeffsY[2] * fy;
    resX[i] = targets[i].x - predX;
    resY[i] = targets[i].y - predY;
  }

  // Symmetric kernel matrix with ridge damping on the diagonal.
  const twoSigmaSq = 2 * sigma * sigma;
  const kernel = zeros2D(n, n);
  for (let r = 0; r < n; r++) {
    for (let c = r; c < n; c++) {
      const dx = features[r][0] - features[c][0];
      const dy = features[r][1] - features[c][1];
      const k = Math.exp(-(dx * dx + dy * dy) / twoSigmaSq);
      kernel[r][c] = k;
      kernel[c][r] = k;
    }
    kernel[r][r] += ridge;
  }

  const weightsX = solveLinearSystem(kernel, resX);
  const weightsY = solveLinearSystem(kernel, resY);
  if (weightsX === null || weightsY === null) {
    return base;
  }

  return {
    coeffsX: [...base.coeffsX, ...weightsX],
    coeffsY: [...base.coeffsY, ...weightsY],
    rbf: {
      centers: features.map(([fx, fy]) => [fx, fy] as [number, number]),
      sigma,
    },
  };
}

/**
 * Median of all pairwise distances between points. A robust measure
 * of the overall point spread that, unlike the mean nearest-neighbor
 * distance, does not collapse toward zero when several points are
 * clustered or duplicated (e.g. the repeated eye anchors).
 * Returns 0 for fewer than 2 points.
 */
function medianPairwiseDistance(points: Array<[number, number]>): number {
  const n = points.length;
  if (n < 2) return 0;
  const dists: number[] = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const dx = points[i][0] - points[j][0];
      const dy = points[i][1] - points[j][1];
      dists.push(Math.sqrt(dx * dx + dy * dy));
    }
  }
  dists.sort((a, b) => a - b);
  const mid = Math.floor(dists.length / 2);
  return dists.length % 2 === 0
    ? (dists[mid - 1] + dists[mid]) / 2
    : dists[mid];
}

/**
 * Debug-only variant of extractFeatures that exposes intermediate
 * values (raw features, head yaw/pitch in radians, compensated
 * features). Not used by the production pipeline.
 */
export function extractFeaturesDebug(
  landmarks: Landmark[],
  headPose?: number[],
): {
  rawFx: number;
  rawFy: number;
  compensatedFx: number;
  compensatedFy: number;
  yaw: number;
  pitch: number;
} {
  const left = eyeOffset(
    landmarks,
    LEFT_IRIS_CENTER,
    LEFT_EYE_INNER,
    LEFT_EYE_OUTER,
    LEFT_EYE_TOP,
    LEFT_EYE_BOTTOM,
  );
  const right = eyeOffset(
    landmarks,
    RIGHT_IRIS_CENTER,
    RIGHT_EYE_INNER,
    RIGHT_EYE_OUTER,
    RIGHT_EYE_TOP,
    RIGHT_EYE_BOTTOM,
  );
  const rawFx = (left[0] + right[0]) / 2;
  const rawFy = (left[1] + right[1]) / 2;

  if (!headPose) {
    return {
      rawFx,
      rawFy,
      compensatedFx: rawFx,
      compensatedFy: rawFy,
      yaw: 0,
      pitch: 0,
    };
  }

  const { yaw, pitch } = headAngles(headPose);

  return {
    rawFx,
    rawFy,
    compensatedFx: rawFx - yaw * HEAD_COMPENSATION_GAIN_X,
    compensatedFy: rawFy - pitch * HEAD_COMPENSATION_GAIN_Y,
    yaw,
    pitch,
  };
}


// ---- internal helpers ----

/**
 * Expand a feature pair into the polynomial basis selected by
 * GAZE_MODE. Order must match the one assumed by predictGaze and
 * fitLeastSquares — both of which also go through this function.
 * The hybrid mode uses the linear basis here (its backbone); the
 * RBF terms are handled separately by fitRbfResiduals/predictGaze.
 */
function polynomialFeatures(fx: number, fy: number): number[] {
  if (GAZE_MODE === "quadratic") {
    return [1, fx, fy, fx * fy, fx * fx, fy * fy];
  }
  return [1, fx, fy];
}

/**
 * Mean distance from each point to its nearest neighbor. Used to set
 * the RBF kernel width relative to how densely the calibration
 * features cover the feature space. Returns 0 for fewer than 2 points
 * or fully coincident points (callers must guard against that).
 */
function meanNearestNeighborDistance(
  points: Array<[number, number]>,
): number {
  const n = points.length;
  if (n < 2) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    let best = Infinity;
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      const dx = points[i][0] - points[j][0];
      const dy = points[i][1] - points[j][1];
      const d2 = dx * dx + dy * dy;
      if (d2 < best) best = d2;
    }
    sum += Math.sqrt(best);
  }
  return sum / n;
}

/** Standard dot product between two equal-length numeric vectors. */
function dot(a: readonly number[], b: readonly number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += a[i] * b[i];
  }
  return sum;
}

/**
 * Compute the iris offset from the eye's geometric center, normalized
 * by the absolute eye dimensions. The denominators are taken in
 * absolute value so the same formula works for both eyes despite
 * inner and outer corners being swapped along the X axis.
 */
function eyeOffset(
  landmarks: Landmark[],
  irisIdx: number,
  innerIdx: number,
  outerIdx: number,
  topIdx: number,
  bottomIdx: number,
): [number, number] {
  const inner = landmarks[innerIdx];
  const outer = landmarks[outerIdx];
  const top = landmarks[topIdx];
  const bottom = landmarks[bottomIdx];
  const iris = landmarks[irisIdx];

  const centerX = (inner.x + outer.x) / 2;
  const centerY = (top.y + bottom.y) / 2;
  const width = Math.abs(outer.x - inner.x);
  const height = Math.abs(bottom.y - top.y);

  // Fallback to 0 offset if the eye is not reliably visible
  // (e.g. blink): avoids division-by-near-zero noise.
  const fx = width < 1e-6 ? 0 : (iris.x - centerX) / width;
  const fy = height < 1e-6 ? 0 : (iris.y - centerY) / height;
  return [fx, fy];
}

// ---- internal linear solver (Gauss elimination, partial pivoting) ----

function zeros2D(rows: number, cols: number): number[][] {
  const m: number[][] = [];
  for (let r = 0; r < rows; r++) {
    m.push(new Array<number>(cols).fill(0));
  }
  return m;
}

/**
 * Solve the square linear system A * x = b via Gaussian elimination
 * with partial pivoting. Returns null if the matrix is singular or
 * nearly so. The input arrays are not modified.
 */
function solveLinearSystem(
  matrix: readonly number[][],
  rhs: readonly number[],
): number[] | null {
  const n = rhs.length;
  if (matrix.length !== n) {
    return null;
  }

  const aug: number[][] = [];
  for (let r = 0; r < n; r++) {
    if (matrix[r].length !== n) return null;
    aug.push([...matrix[r], rhs[r]]);
  }

  for (let col = 0; col < n; col++) {
    let pivotRow = col;
    let pivotMag = Math.abs(aug[col][col]);
    for (let r = col + 1; r < n; r++) {
      const mag = Math.abs(aug[r][col]);
      if (mag > pivotMag) {
        pivotMag = mag;
        pivotRow = r;
      }
    }
    if (pivotMag < 1e-12) {
      return null;
    }
    if (pivotRow !== col) {
      const tmp = aug[col];
      aug[col] = aug[pivotRow];
      aug[pivotRow] = tmp;
    }
    const pivot = aug[col][col];
    for (let r = col + 1; r < n; r++) {
      const factor = aug[r][col] / pivot;
      if (factor === 0) continue;
      for (let c = col; c <= n; c++) {
        aug[r][c] -= factor * aug[col][c];
      }
    }
  }

  const result = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let sum = aug[r][n];
    for (let c = r + 1; c < n; c++) {
      sum -= aug[r][c] * result[c];
    }
    result[r] = sum / aug[r][r];
  }
  return result;
}