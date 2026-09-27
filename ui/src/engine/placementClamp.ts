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
 * every axis that can't be satisfied.
 *
 * Applied to user interactions only (drag, nudge, wheel, fields); never on
 * load or image-size changes (placement is the user's setting), so the
 * current placement may violate the rule. Interactions then clamp relative
 * to it: each edge limit is relaxed to where the current placement's edge
 * already is if that edge violates the rule, so a violated edge may only
 * improve (never jumps, never worsens) and satisfied edges clamp as usual.
 * Pure, no DOM.
 */

import { PLACEMENT_MAX_SCALE, PLACEMENT_MIN_SCALE, normalizePlacement } from "../document/placement";
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

/** Image-px limits for the mapped max paint area's edges. */
interface EdgeLimits {
  /** Left edge must be `<= left`. */
  left: number;
  /** Top edge must be `<= top`. */
  top: number;
  /** Right edge must be `>= right`. */
  right: number;
  /** Bottom edge must be `>= bottom`. */
  bottom: number;
}

/**
 * Edge limits: the image + margin, relaxed per edge to where `from` already
 * is when `from` violates that edge (so an interaction never jumps; it may
 * only improve a violated edge, see module doc).
 * @param frame - Document frame.
 * @param image - Current image size.
 * @param from - Current placement (omit for the strict rule).
 * @returns Limits.
 */
function edgeLimits(frame: Size, image: Size, from?: Readonly<Placement>): EdgeLimits {
  const m = PLACEMENT_MARGIN;
  const strict = { left: -m, top: -m, right: image.width + m, bottom: image.height + m };
  if (!from) return strict;
  const r = docRectToImage(frameMap(frame, image, normalizePlacement(from)), boundsCap(frame));
  return {
    left: Math.max(strict.left, r.x),
    top: Math.max(strict.top, r.y),
    right: Math.min(strict.right, r.x + r.width),
    bottom: Math.min(strict.bottom, r.y + r.height),
  };
}

// ── Limits ────────────────────────────────────────────────────────────────────

/**
 * Scale range that keeps the rule satisfiable.
 * @param frame - Document frame.
 * @param image - Current image size.
 * @param from - Current placement: relaxes violated edges (see {@link edgeLimits}).
 * @returns Range (and feasibility).
 */
export function placementScaleRange(frame: Size, image: Size, from?: Readonly<Placement>): ScaleRange {
  const max = PLACEMENT_MAX_SCALE;
  if (!validSizes(frame, image)) return { min: PLACEMENT_MIN_SCALE, max, feasible: true };
  const cap = docRectToImage(frameMap(frame, image), boundsCap(frame));
  const e = edgeLimits(frame, image, from);
  const min = Math.max(PLACEMENT_MIN_SCALE, (e.right - e.left) / cap.width, (e.bottom - e.top) / cap.height);
  return { min, max, feasible: min <= max };
}

/**
 * Clamp a placement so the rule holds: scale into {@link placementScaleRange},
 * then the offset into the allowed window (fallback: see module doc).
 * @param p - Candidate placement.
 * @param frame - Document frame.
 * @param image - Current image size.
 * @param from - Current placement (interactions): edges it already violates
 *   are only kept from getting worse. Omit for the strict rule.
 * @returns Valid placement.
 */
export function clampPlacement(p: Readonly<Placement>, frame: Size, image: Size, from?: Readonly<Placement>): Placement {
  const n = normalizePlacement(p);
  if (!validSizes(frame, image)) return n;
  const range = placementScaleRange(frame, image, from);
  const scale = range.feasible ? Math.min(range.max, Math.max(range.min, n.scale)) : range.max;
  const s = frameMap(frame, image).scale;
  // Cap in image px at this scale with no offset; shift t = s * x moves it.
  const cap = docRectToImage(frameMap(frame, image, { x: 0, y: 0, scale }), boundsCap(frame));
  const e = edgeLimits(frame, image, from);
  const tx = clampShift(n.x * s, e.right - (cap.x + cap.width), e.left - cap.x, (image.width - cap.width) / 2 - cap.x);
  const ty = clampShift(n.y * s, e.bottom - (cap.y + cap.height), e.top - cap.y, (image.height - cap.height) / 2 - cap.y);
  // Untouched axes keep their exact value (no round-trip ulp drift).
  return { x: tx === n.x * s ? n.x : tx / s, y: ty === n.y * s ? n.y : ty / s, scale };
}

/**
 * Wheel-scale around an image point within the allowed scale range, then
 * clamp the offset (both relative to `p`, see {@link clampPlacement}).
 * @param p - Current placement.
 * @param frame - Document frame.
 * @param image - Current image size.
 * @param factor - Scale multiplier (> 0).
 * @param anchor - Image point kept fixed (unless the offset clamp moves it).
 * @returns New placement.
 */
export function clampedScaleAt(p: Readonly<Placement>, frame: Size, image: Size, factor: number, anchor: Point): Placement {
  const range = placementScaleRange(frame, image, p);
  const current = p.scale > 0 && Number.isFinite(p.scale) ? p.scale : 1;
  const wanted = current * (Number.isFinite(factor) && factor > 0 ? factor : 1);
  const k = range.feasible ? Math.min(range.max, Math.max(range.min, wanted)) : range.max;
  return clampPlacement(scalePlacementAt({ ...p, scale: current }, frame, image, k / current, anchor), frame, image, p);
}
