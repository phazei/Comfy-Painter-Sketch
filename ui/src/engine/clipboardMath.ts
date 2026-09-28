/**
 * Pure math behind copy / cut / paste (SPEC "Floating selections + clipboard
 * (M10)", Clipboard block). No DOM, no canvas: straight-alpha RGBA arrays
 * (what `getImageData` returns) and plain rects, so it is unit-testable.
 *
 * - {@link applyCoverage}: selection coverage -> alpha (copy of selected pixels).
 * - {@link maskToGray}: mask coverage -> opaque grayscale (what other apps expect).
 * - {@link pasteRect} / {@link cropToCap}: where a pasted image lands (document px)
 *   and how much of it fits in the paint-area cap.
 * - {@link pastedLayerName}: "Pasted", "Pasted 2", ...
 */

import { intersectRect, isEmptyRect } from "../geometry/rect";
import type { Point, Rect, Size } from "../geometry/rect";

/** Base name of pasted layers. */
export const PASTED_LAYER_NAME = "Pasted";

// ── Pixels ────────────────────────────────────────────────────────────────────

/**
 * Multiply alpha by coverage in place (pixels with no alpha left get RGB 0).
 * @param rgba - Straight-alpha RGBA, `n * 4` bytes (modified).
 * @param coverage - Coverage per pixel, `n` bytes (`null` = fully covered).
 * @returns `true` if any pixel keeps alpha > 0.
 */
export function applyCoverage(rgba: Uint8ClampedArray, coverage: Uint8Array | null): boolean {
  let any = false;
  const n = rgba.length >> 2;
  for (let i = 0; i < n; i++) {
    const p = i * 4 + 3;
    const c = coverage ? (coverage[i] ?? 0) : 255;
    const a = c === 255 ? (rgba[p] as number) : Math.round(((rgba[p] as number) * c) / 255);
    rgba[p] = a;
    if (a === 0) {
      rgba[p - 3] = 0;
      rgba[p - 2] = 0;
      rgba[p - 1] = 0;
    } else {
      any = true;
    }
  }
  return any;
}

/**
 * Mask layer copy: coverage (alpha, times the selection coverage) becomes an
 * opaque grayscale image (white = masked), in place.
 * @param rgba - Mask pixels (coverage in alpha), `n * 4` bytes (modified).
 * @param coverage - Selection coverage per pixel (`null` = no selection).
 * @returns `true` if any pixel is non-black.
 */
export function maskToGray(rgba: Uint8ClampedArray, coverage: Uint8Array | null): boolean {
  let any = false;
  const n = rgba.length >> 2;
  for (let i = 0; i < n; i++) {
    const p = i * 4;
    const c = coverage ? (coverage[i] ?? 0) : 255;
    const v = Math.round(((rgba[p + 3] as number) * c) / 255);
    rgba[p] = v;
    rgba[p + 1] = v;
    rgba[p + 2] = v;
    rgba[p + 3] = 255;
    if (v > 0) any = true;
  }
  return any;
}

/**
 * Fold one mask's EFFECTIVE coverage (its invert applied) into a union (max),
 * as the MASK output does. The mask's pixels cover `read` (a part of `area`,
 * e.g. clipped to the paint bounds); elsewhere its raw coverage is 0, i.e.
 * 255 effective when inverted.
 * @param union - Union coverage over `area`, `area.width * area.height` bytes (modified).
 * @param area - Union rect (document px).
 * @param read - Rect the pixels cover (inside `area`), or `null` for none.
 * @param rgba - Mask pixels over `read` (coverage in alpha).
 * @param invert - The mask's invert flag.
 */
export function unionMaskCoverage(union: Uint8Array, area: Rect, read: Rect | null, rgba: Uint8ClampedArray, invert: boolean): void {
  for (let y = 0; y < area.height; y++) {
    const ry = area.y + y - (read?.y ?? 0);
    for (let x = 0; x < area.width; x++) {
      const rx = area.x + x - (read?.x ?? 0);
      const inside = read !== null && rx >= 0 && ry >= 0 && rx < read.width && ry < read.height;
      const a = inside ? (rgba[(ry * read.width + rx) * 4 + 3] as number) : 0;
      const v = invert ? 255 - a : a;
      const i = y * area.width + x;
      if (v > (union[i] as number)) union[i] = v;
    }
  }
}

// ── Placement ─────────────────────────────────────────────────────────────────

/**
 * Integer document rect a pasted image covers.
 * @param source - Source size, px.
 * @param docPerSource - Document px per source px (1 / frame-map scale for image px).
 * @param at - `{ centre }` (centre of the image at a document point) or
 *   `{ topLeft }` (paste in place).
 * @returns Rect (at least 1 x 1).
 */
export function pasteRect(source: Size, docPerSource: number, at: { centre: Point } | { topLeft: Point }): Rect {
  const k = Number.isFinite(docPerSource) && docPerSource > 0 ? docPerSource : 1;
  const width = Math.max(1, Math.round(source.width * k));
  const height = Math.max(1, Math.round(source.height * k));
  if ("topLeft" in at) return { x: Math.round(at.topLeft.x), y: Math.round(at.topLeft.y), width, height };
  return { x: Math.round(at.centre.x - width / 2), y: Math.round(at.centre.y - height / 2), width, height };
}

/**
 * Part of a paste rect inside the paint-area cap.
 * @param rect - Paste rect.
 * @param cap - Largest allowed bounds (`boundsCap`).
 * @returns The kept rect (`null` if nothing fits) and whether it was cropped.
 */
export function cropToCap(rect: Rect, cap: Rect): { rect: Rect | null; cropped: boolean } {
  const kept = intersectRect(rect, cap);
  if (isEmptyRect(kept)) return { rect: null, cropped: true };
  return { rect: kept, cropped: kept.width !== rect.width || kept.height !== rect.height };
}

// ── Naming ────────────────────────────────────────────────────────────────────

/**
 * Next free pasted-layer name: "Pasted", then "Pasted 2", "Pasted 3", ...
 * @param layers - Existing layers.
 * @returns Name.
 */
export function pastedLayerName(layers: readonly { name: string }[]): string {
  const taken = new Set(layers.map((l) => l.name.trim()));
  if (!taken.has(PASTED_LAYER_NAME)) return PASTED_LAYER_NAME;
  let n = 2;
  while (taken.has(`${PASTED_LAYER_NAME} ${n}`)) n++;
  return `${PASTED_LAYER_NAME} ${n}`;
}

/**
 * Next free inserted-image name: "Image 1", "Image 2", ... (lowest unused N).
 * @param layers - Existing layers.
 * @returns Name.
 */
export function imageLayerName(layers: readonly { name: string }[]): string {
  const taken = new Set(layers.map((l) => l.name.trim()));
  let n = 1;
  while (taken.has(`Image ${n}`)) n++;
  return `Image ${n}`;
}
