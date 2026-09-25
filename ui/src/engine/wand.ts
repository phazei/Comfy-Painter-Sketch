/**
 * Magic wand glue (SPEC Tools table, W): the paint bucket's flood fill
 * (`floodFill.ts`: tolerance, contiguous, anti-alias) run over sampled
 * pixels of a document area, turned into a document-space
 * {@link Selection}. Pure; the pixel sampling (current layer / all layers)
 * is shared with the bucket in `pixelOps.ts`.
 */

import type { Point, Rect } from "../geometry/rect";
import { floodFill } from "./floodFill";
import { selectionFromCoverage } from "./selection";
import type { Selection } from "./selection";

/** Wand matching options (the bucket's, minus opacity/colour). */
export interface WandOptions {
  /** 0-255 per-channel tolerance. */
  tolerance: number;
  contiguous: boolean;
  antiAlias: boolean;
}

/**
 * Selection of the pixels matching the colour under `point`.
 * @param pixels - Straight-alpha RGBA of `area`.
 * @param area - Integer document rect the pixels cover.
 * @param point - Click position, document coords.
 * @param options - Tolerance / contiguous / anti-alias.
 * @returns Selection (document coords), or `null` when the point is outside `area`.
 */
export function wandSelection(pixels: Uint8ClampedArray, area: Rect, point: Point, options: WandOptions): Selection | null {
  const { coverage, bbox } = floodFill(pixels, area.width, area.height, {
    x: Math.floor(point.x) - area.x,
    y: Math.floor(point.y) - area.y,
    tolerance: options.tolerance,
    contiguous: options.contiguous,
    antiAlias: options.antiAlias,
  });
  return selectionFromCoverage(coverage, area, bbox);
}
