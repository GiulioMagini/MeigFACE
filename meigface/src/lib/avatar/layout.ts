//! Shared on-screen layout of the 2D puppet avatar.
//!
//! Single source of truth for where the puppet sits on screen and
//! where its eyes are. Consumed by:
//!   - the calibration state machine (eye-anchor calibration points),
//!   - the calibration/test views (stylized silhouette overlay),
//!   - the future avatar component and gaze-scoring module.
//! Keeping all of them on the same numbers guarantees that "the user
//! is looking at the puppet's eyes" means exactly the same thing in
//! calibration, testing and actual use.

import type { ScreenPoint } from "../tracking/types";

/**
 * Native coordinate system of the puppet SVG artwork (both the male
 * and female avatars share the same viewBox and the same eye layout).
 */
export const PUPPET_VIEWBOX = { width: 360, height: 378 } as const;

/** Eye centers in puppet viewBox coordinates (camera-facing). */
export const PUPPET_LEFT_EYE = { x: 143, y: 176 } as const;
export const PUPPET_RIGHT_EYE = { x: 217, y: 176 } as const;

/**
 * Puppet height as a fraction of the viewport height. The puppet is
 * bottom-anchored and horizontally centered; with 0.65 the eye line
 * lands at ~65% of the viewport height, matching the project spec
 * (avatar face in the lower-central area of the screen).
 */
export const PUPPET_HEIGHT_FRACTION = 0.65;

/** Rectangle the puppet occupies on screen, in CSS pixels. */
export interface PuppetRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Compute the on-screen rectangle of the puppet for a given viewport:
 * bottom-anchored, horizontally centered, aspect ratio preserved.
 */
export function puppetRect(
  viewportWidth: number,
  viewportHeight: number,
): PuppetRect {
  const height = viewportHeight * PUPPET_HEIGHT_FRACTION;
  const width = height * (PUPPET_VIEWBOX.width / PUPPET_VIEWBOX.height);
  return {
    x: (viewportWidth - width) / 2,
    y: viewportHeight - height,
    width,
    height,
  };
}

/** Map a point from puppet viewBox coordinates to screen pixels. */
function toScreen(rect: PuppetRect, px: number, py: number): ScreenPoint {
  return {
    x: rect.x + (px / PUPPET_VIEWBOX.width) * rect.width,
    y: rect.y + (py / PUPPET_VIEWBOX.height) * rect.height,
  };
}

/** Screen positions of the puppet's eyes and of the point between them. */
export function puppetEyePoints(
  viewportWidth: number,
  viewportHeight: number,
): { left: ScreenPoint; right: ScreenPoint; center: ScreenPoint } {
  const rect = puppetRect(viewportWidth, viewportHeight);
  const left = toScreen(rect, PUPPET_LEFT_EYE.x, PUPPET_LEFT_EYE.y);
  const right = toScreen(rect, PUPPET_RIGHT_EYE.x, PUPPET_RIGHT_EYE.y);
  return {
    left,
    right,
    center: { x: (left.x + right.x) / 2, y: (left.y + right.y) / 2 },
  };
}

/**
 * Extra calibration targets placed exactly where the user will look
 * during normal use: the puppet's eye band. Appended at the end of
 * the calibration sequence, they densify the regression data in the
 * only region where accuracy actually matters for eye-contact
 * scoring — the four screen corners alone cannot provide that density without
 * becoming exhausting for the user.
 *
 * Four targets: left eye, between the eyes, right eye, nose bridge
 * (slightly below the eye line). Close together on purpose.
 */
export function buildAnchorPoints(
  viewportWidth: number,
  viewportHeight: number,
): ScreenPoint[] {
  const rect = puppetRect(viewportWidth, viewportHeight);
  const midX = (PUPPET_LEFT_EYE.x + PUPPET_RIGHT_EYE.x) / 2;
  return [
    toScreen(rect, PUPPET_LEFT_EYE.x, PUPPET_LEFT_EYE.y),
    toScreen(rect, midX, PUPPET_LEFT_EYE.y),
    toScreen(rect, PUPPET_RIGHT_EYE.x, PUPPET_RIGHT_EYE.y),
    toScreen(rect, midX, PUPPET_LEFT_EYE.y + 20),
  ];
}

/**
 * Elliptical screen region (in CSS pixels) treated as "looking at the
 * avatar's face" for eye-contact detection. Centered on the eye band and
 * sized generously around the head: the gaze estimate is only accurate to
 * ~2-5°, and the goal is to tell "looking at the face" from "looking away",
 * not to resolve which eye. Shared by the runtime gaze check and
 * the eye-contact scoring so both use the same definition.
 */
export function puppetFaceTarget(
  viewportWidth: number,
  viewportHeight: number,
): { cx: number; cy: number; rx: number; ry: number } {
  const rect = puppetRect(viewportWidth, viewportHeight);
  const center = puppetEyePoints(viewportWidth, viewportHeight).center;
  return {
    cx: center.x,
    cy: center.y,
    rx: rect.width * 0.5,
    ry: rect.height * 0.3,
  };
}