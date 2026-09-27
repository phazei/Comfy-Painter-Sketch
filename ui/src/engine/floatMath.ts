/**
 * Pure pixel + selection math behind floating selections and Merge Down
 * (SPEC "Floating selections + clipboard (M10)"). No DOM, no canvas: every
 * function works on straight-alpha RGBA arrays (what `getImageData` returns)
 * or on {@link Selection} objects, so it is unit-testable.
 *
 * - {@link liftPixels}: split a layer region by selection coverage into the
 *   floating part (alpha * c) and what stays behind (alpha * (1 - c), or
 *   untouched for a copy).
 * - {@link compositeOver}: straight-alpha source-over of one buffer onto
 *   another at an integer offset (float commit, paint Merge Down).
 * - {@link mergeMaskCoverage}: union (max) of two masks' effective coverage,
 *   stored under the lower mask's invert.
 * - {@link offsetSelection} / {@link selectionHit}: whole-pixel selection moves.
 */

import type { Rect } from "../geometry/rect";
import { coverageAt } from "./selection";
import type { Selection } from "./selection";

/** Coverage (0-255) at the pointer from which a press counts as "inside" the selection. */
export const INSIDE_COVERAGE = 128;

/**
 * Split RGBA pixels by coverage (floating selection lift).
 * @param src - Straight-alpha RGBA, `n * 4` bytes.
 * @param coverage - Coverage per pixel, `n` bytes.
 * @param cut - `true` = leave a hole (move); `false` = copy (source untouched).
 * @returns `float` (lifted pixels) and `rest` (what stays on the layer), both new arrays.
 */
export function liftPixels(
  src: Uint8ClampedArray,
  coverage: Uint8Array,
  cut: boolean,
): { float: Uint8ClampedArray<ArrayBuffer>; rest: Uint8ClampedArray<ArrayBuffer> } {
  const float = new Uint8ClampedArray(src);
  const rest = new Uint8ClampedArray(src);
  const n = Math.min(coverage.length, src.length >> 2);
  for (let i = 0; i < src.length >> 2; i++) {
    const c = i < n ? (coverage[i] as number) : 0;
    const p = i * 4 + 3;
    const a = src[p] as number;
    float[p] = Math.round((a * c) / 255);
    if (float[p] === 0) {
      float[p - 3] = 0;
      float[p - 2] = 0;
      float[p - 1] = 0;
    }
    if (cut) rest[p] = Math.round((a * (255 - c)) / 255);
  }
  return { float, rest };
}

/**
 * Straight-alpha source-over of `src` onto `dst`, in place (Porter-Duff
 * over, Normal blend). Parts of `src` outside `dst` are ignored.
 * @param dst - Destination RGBA (row stride `dstWidth * 4`), modified.
 * @param dstWidth - Destination width, px.
 * @param dstHeight - Destination height, px.
 * @param src - Source RGBA (row stride `srcWidth * 4`).
 * @param srcWidth - Source width, px.
 * @param srcHeight - Source height, px.
 * @param ox - Source top-left in destination px (integer).
 * @param oy - Source top-left in destination px (integer).
 * @param opacity - Extra source alpha factor 0..1 (layer opacity baked in).
 */
export function compositeOver(
  dst: Uint8ClampedArray,
  dstWidth: number,
  dstHeight: number,
  src: Uint8ClampedArray,
  srcWidth: number,
  srcHeight: number,
  ox: number,
  oy: number,
  opacity = 1,
): void {
  const x0 = Math.max(0, ox);
  const y0 = Math.max(0, oy);
  const x1 = Math.min(dstWidth, ox + srcWidth);
  const y1 = Math.min(dstHeight, oy + srcHeight);
  const k = Math.min(1, Math.max(0, opacity));
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const s = ((y - oy) * srcWidth + (x - ox)) * 4;
      const sa = ((src[s + 3] as number) / 255) * k;
      if (sa <= 0) continue;
      const d = (y * dstWidth + x) * 4;
      const da = (dst[d + 3] as number) / 255;
      const oa = sa + da * (1 - sa);
      for (let c = 0; c < 3; c++) {
        dst[d + c] = Math.round(((src[s + c] as number) * sa + (dst[d + c] as number) * da * (1 - sa)) / oa);
      }
      dst[d + 3] = Math.round(oa * 255);
    }
  }
}

/**
 * Copy a sub-rectangle between RGBA buffers in document coordinates (no blending).
 * @param dst - Destination RGBA covering `dstRect`, modified.
 * @param dstRect - Document rect of `dst`.
 * @param src - Source RGBA covering `srcRect`.
 * @param srcRect - Document rect of `src`.
 */
export function copyPixels(dst: Uint8ClampedArray, dstRect: Rect, src: Uint8ClampedArray, srcRect: Rect): void {
  const x0 = Math.max(dstRect.x, srcRect.x);
  const y0 = Math.max(dstRect.y, srcRect.y);
  const x1 = Math.min(dstRect.x + dstRect.width, srcRect.x + srcRect.width);
  const y1 = Math.min(dstRect.y + dstRect.height, srcRect.y + srcRect.height);
  if (x1 <= x0) return;
  for (let y = y0; y < y1; y++) {
    const s = ((y - srcRect.y) * srcRect.width + (x0 - srcRect.x)) * 4;
    const d = ((y - dstRect.y) * dstRect.width + (x0 - dstRect.x)) * 4;
    dst.set(src.subarray(s, s + (x1 - x0) * 4), d);
  }
}

/**
 * Merge Down for masks: result coverage = max(effective upper, effective
 * lower), each mask's invert applied first; stored under the lower mask's
 * invert (inverted lower: 255 - union). RGB is set to white (mask convention).
 * @param upper - Upper mask RGBA (coverage in alpha).
 * @param upperInvert - Upper mask invert.
 * @param lower - Lower mask RGBA, same size; modified in place.
 * @param lowerInvert - Lower mask invert.
 */
export function mergeMaskCoverage(
  upper: Uint8ClampedArray,
  upperInvert: boolean,
  lower: Uint8ClampedArray,
  lowerInvert: boolean,
): void {
  for (let p = 0; p < lower.length; p += 4) {
    const u = upper[p + 3] as number;
    const l = lower[p + 3] as number;
    const eu = upperInvert ? 255 - u : u;
    const el = lowerInvert ? 255 - l : l;
    const union = eu > el ? eu : el;
    lower[p] = 255;
    lower[p + 1] = 255;
    lower[p + 2] = 255;
    lower[p + 3] = lowerInvert ? 255 - union : union;
  }
}

/**
 * The same selection shifted by whole document px (the data is shared: selections are immutable).
 * @param sel - Selection.
 * @param dx - X shift (integer).
 * @param dy - Y shift (integer).
 * @returns Shifted selection (the same object for a zero shift).
 */
export function offsetSelection(sel: Selection, dx: number, dy: number): Selection {
  if (dx === 0 && dy === 0) return sel;
  return { rect: { ...sel.rect, x: sel.rect.x + dx, y: sel.rect.y + dy }, data: sel.data, outside: sel.outside };
}

/**
 * Whether a document point is "inside" a selection: coverage of the pixel
 * under it is at least {@link INSIDE_COVERAGE}.
 * @param sel - Selection (`null` = never inside).
 * @param x - Document x.
 * @param y - Document y.
 * @returns `true` if inside.
 */
export function selectionHit(sel: Selection | null, x: number, y: number): boolean {
  if (!sel || !Number.isFinite(x) || !Number.isFinite(y)) return false;
  return coverageAt(sel, Math.floor(x), Math.floor(y)) >= INSIDE_COVERAGE;
}
