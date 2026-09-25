/**
 * "Scrubby slider" math (Photoshop): dragging horizontally on a number
 * option's label changes the value by whole steps. Speed adapts to the
 * range so small ranges don't fly by and large ones don't crawl; Shift is
 * 10x faster. Pure, so it is unit-testable.
 */

import { clampDisplay } from "../tools/options";
import type { NumberOption } from "../tools/options";

/** Screen px per step for ranges with few steps (slow, precise). */
const MAX_PX_PER_STEP = 8;
/** Screen px per step for large ranges (fast). */
const MIN_PX_PER_STEP = 1;
/** Pixels to cross the whole range, before clamping the per-step distance. */
const RANGE_PX = 240;
/** Shift multiplier. */
export const SCRUB_FAST_FACTOR = 10;

/**
 * Screen pixels of drag per step for a descriptor.
 * @param desc - Number descriptor.
 * @returns Pixels per step (1..8).
 */
export function scrubPixelsPerStep(desc: NumberOption): number {
  const steps = desc.step > 0 ? Math.round((desc.max - desc.min) / desc.step) : 0;
  if (!(steps > 0)) return MAX_PX_PER_STEP;
  return Math.min(MAX_PX_PER_STEP, Math.max(MIN_PX_PER_STEP, RANGE_PX / steps));
}

/**
 * Display value after dragging `dx` screen px from where the scrub started.
 * @param desc - Number descriptor.
 * @param startDisplay - Display value at pointer-down.
 * @param dx - Horizontal drag since pointer-down, screen px (right = up).
 * @param fast - Shift held (10x steps).
 * @returns New display value (clamped, snapped).
 */
export function scrubValue(desc: NumberOption, startDisplay: number, dx: number, fast: boolean): number {
  const steps = Math.trunc(dx / scrubPixelsPerStep(desc)) * (fast ? SCRUB_FAST_FACTOR : 1);
  return clampDisplay(desc, startDisplay + steps * desc.step);
}
