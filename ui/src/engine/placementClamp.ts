/**
 * Move-drawing placement limits (SPEC M5 Move drawing). Rule: the MAXIMUM
 * paint area ({@link boundsCap} of the frame), mapped to image px through the
 * placement-aware document map, must contain the current image area expanded
 * by {@link PLACEMENT_MARGIN} image px on every side -- so the whole image
 * (plus a margin) is always paintable wherever the drawing is moved.
 *
 * Per axis, with the cap mapped at scale `k` and no offset spanning
 * `[a, b]` image px, the offset shift `t` (image px, `= s * placement.x`)
 * must satisfy `a + t <= -m` and `b + t >= W + m`. That needs
 * `b - a >= W + 2m`, which bounds the scale from below.
 *
 * Fallback when no scale in range satisfies the rule (e.g. the 16384 cap
 * is smaller than image + 2m even at the max scale): use the max scale
 * (the most coverage possible) and centre the paint area on the image on
 * every axis that can't be satisfied. Pure, no DOM.
 */

import { PLACEMENT_MAX_SCALE, PLACEMENT_MIN_SCALE, isIdentityPlacement, normalizePlacement } from "../document/placement";
import type { Placement } from "../document/types";
import type { Point, Size } from "../geometry/rect";
import { boundsCap } from "./bounds";
import { docRectToImage, frameMap } from "./frameMap";
import { scalePlacementAt } from "./placementMath";

// ── Types ─────────────────────────────────────────────────────────────────────

/** Margin (image px) the paint area must extend past the image on every side. */
export const PLACEMENT_MARGIN = 50;

/** Allowed placement scale range for a frame / image pair. */
export interface ScaleRange {
  /** Smallest scale that satisfies the rule (at least {@link PLACEMENT_MIN_SCALE}). */
  min: number;
  /** Largest scale ({@link PLACEMENT_MAX_SCALE}). */
  max: number;
  /** `false` when `min > max`: the rule can't hold (fallback applies). */
  feasible: boolean;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Whether sizes are usable (positive, finite).
 * @param frame - Document frame.
 * @param image - Image size.
 * @returns `true` when both are valid.
 */
function validSizes(frame: Size, image: Size): boolean {
  return [frame.width, frame.height, image.width, image.height].every((v) => Number.isFinite(v) && v > 0);
}

/**
 * Clamp a shift into `[lo, hi]`, or centre (`mid`) when the range is empty.
 * @param t - Candidate shift.
 * @param lo - Lower limit.
 * @param hi - Upper limit.
 * @param mid - Fallback shift.
 * @returns Shift.
 */
function clampShift(t: number, lo: number, hi: number, mid: number): number {
  if (lo > hi) return mid;
  return Math.min(hi, Math.max(lo, t));
}

// ── Limits ────────────────────────────────────────────────────────────────────

/**
 * Scale range that keeps the rule satisfiable.
 * @param frame - Document frame.
 * @param image - Current image size.
 * @returns Range (and feasibility).
 */
export function placementScaleRange(frame: Size, image: Size): ScaleRange {
  const max = PLACEMENT_MAX_SCALE;
  if (!validSizes(frame, image)) return { min: PLACEMENT_MIN_SCALE, max, feasible: true };
  const cap = docRectToImage(frameMap(frame, image), boundsCap(frame));
  const m2 = 2 * PLACEMENT_MARGIN;
  const min = Math.max(PLACEMENT_MIN_SCALE, (image.width + m2) / cap.width, (image.height + m2) / cap.height);
  return { min, max, feasible: min <= max };
}

/**
 * Clamp a placement so the rule holds: scale into {@link placementScaleRange},
 * then the offset into the allowed window (fallback: see module doc).
 * @param p - Candidate placement.
 * @param frame - Document frame.
 * @param image - Current image size.
 * @returns Valid placement.
 */
export function clampPlacement(p: Readonly<Placement>, frame: Size, image: Size): Placement {
  const n = normalizePlacement(p);
  if (!validSizes(frame, image)) return n;
  const range = placementScaleRange(frame, image);
  const scale = range.feasible ? Math.min(range.max, Math.max(range.min, n.scale)) : range.max;
  const s = frameMap(frame, image).scale;
  // Cap in image px at this scale with no offset; shift t = s * x moves it.
  const cap = docRectToImage(frameMap(frame, image, { x: 0, y: 0, scale }), boundsCap(frame));
  const m = PLACEMENT_MARGIN;
  const tx = clampShift(n.x * s, image.width + m - (cap.x + cap.width), -m - cap.x, (image.width - cap.width) / 2 - cap.x);
  const ty = clampShift(n.y * s, image.height + m - (cap.y + cap.height), -m - cap.y, (image.height - cap.height) / 2 - cap.y);
  // Untouched axes keep their exact value (no round-trip ulp drift).
  return { x: tx === n.x * s ? n.x : tx / s, y: ty === n.y * s ? n.y : ty / s, scale };
}

/**
 * Wheel-scale around an image point within the allowed scale range, then
 * clamp the offset.
 * @param p - Current placement.
 * @param frame - Document frame.
 * @param image - Current image size.
 * @param factor - Scale multiplier (> 0).
 * @param anchor - Image point kept fixed (unless the offset clamp moves it).
 * @returns New placement.
 */
export function clampedScaleAt(p: Readonly<Placement>, frame: Size, image: Size, factor: number, anchor: Point): Placement {
  const range = placementScaleRange(frame, image);
  const current = p.scale > 0 && Number.isFinite(p.scale) ? p.scale : 1;
  const wanted = current * (Number.isFinite(factor) && factor > 0 ? factor : 1);
  const k = range.feasible ? Math.min(range.max, Math.max(range.min, wanted)) : range.max;
  return clampPlacement(scalePlacementAt({ ...p, scale: current }, frame, image, k / current, anchor), frame, image);
}

/**
 * Load-time / image-change clamp of a stored placement.
 * @param placement - Stored placement (`undefined` = identity).
 * @param frame - Document frame.
 * @param image - Current image size.
 * @returns The clamped placement (`undefined` = identity) and whether it changed (write it back).
 */
export function clampStoredPlacement(
  placement: Readonly<Placement> | undefined,
  frame: Size,
  image: Size,
): { placement: Placement | undefined; changed: boolean } {
  const before = placement ?? { x: 0, y: 0, scale: 1 };
  const next = clampPlacement(before, frame, image);
  const changed = next.x !== before.x || next.y !== before.y || next.scale !== before.scale;
  return { placement: isIdentityPlacement(next) ? undefined : next, changed };
}
