/**
 * Paint-area (`bounds`) growth math, in document (frame) coordinates. Pure.
 *
 * Growth: when a stroke reaches past `bounds`, the bounds grow outward on the
 * affected side(s) in whole chunks (so a scribble along the edge doesn't
 * reallocate every few pixels), limited to a cap rect centred on the frame:
 * `capFactor` x the frame per axis, never more than `maxSide`.
 *
 * The document -> image mapping (decision 4) lives in `frameMap.ts`; bounds
 * never change when the upstream image size does.
 */

import { containsRect, intersectRect, roundOutRect, unionRect } from "../geometry/rect";
import type { Rect, Size } from "../geometry/rect";

// ── Growth ────────────────────────────────────────────────────────────────────

/** Tunables for {@link growBounds}. */
export interface GrowthLimits {
  /** Growth granularity in px. */
  chunk: number;
  /** Cap per axis as a multiple of the frame size. */
  capFactor: number;
  /** Absolute cap per side in px. */
  maxSide: number;
}

/** Default growth limits. */
export const DEFAULT_GROWTH: GrowthLimits = { chunk: 256, capFactor: 3, maxSide: 16384 };

/**
 * The largest bounds allowed for a frame: centred on it, `capFactor` x the
 * frame per axis, clamped to `maxSide` (but never smaller than the frame).
 *
 * @param frame - Frame size.
 * @param limits - Growth limits.
 * @returns Cap rect in frame coords.
 */
export function boundsCap(frame: Size, limits: GrowthLimits = DEFAULT_GROWTH): Rect {
  const width = Math.max(frame.width, Math.min(Math.round(frame.width * limits.capFactor), limits.maxSide));
  const height = Math.max(frame.height, Math.min(Math.round(frame.height * limits.capFactor), limits.maxSide));
  return {
    x: -Math.floor((width - frame.width) / 2),
    y: -Math.floor((height - frame.height) / 2),
    width,
    height,
  };
}

/**
 * Grow `bounds` so it covers `need` (clipped to the cap), extending each side
 * that must move by a whole number of chunks.
 *
 * @param bounds - Current bounds (integer rect).
 * @param need - Area that should be paintable (any rect, fractional ok).
 * @param frame - Frame size (defines the cap).
 * @param limits - Growth limits.
 * @returns New bounds (equal to `bounds` when no growth is needed/possible).
 */
export function growBounds(bounds: Rect, need: Rect, frame: Size, limits: GrowthLimits = DEFAULT_GROWTH): Rect {
  const cap = boundsCap(frame, limits);
  const target = intersectRect(roundOutRect(need), cap);
  if (target.width <= 0 || target.height <= 0 || containsRect(bounds, target)) return { ...bounds };

  const chunk = Math.max(1, limits.chunk);
  const grow = (distance: number): number => (distance > 0 ? Math.ceil(distance / chunk) * chunk : 0);

  const left = grow(bounds.x - target.x);
  const top = grow(bounds.y - target.y);
  const right = grow(target.x + target.width - (bounds.x + bounds.width));
  const bottom = grow(target.y + target.height - (bounds.y + bounds.height));
  const grown = {
    x: bounds.x - left,
    y: bounds.y - top,
    width: bounds.width + left + right,
    height: bounds.height + top + bottom,
  };
  // Keep existing bounds even if they already exceed the cap (e.g. restored
  // from a manifest written with different limits, or re-applied history).
  return unionRect(intersectRect(grown, cap), bounds);
}
