/**
 * Pure math behind copy / cut / paste (SPEC "Clipboard and drop").
 * No DOM, no canvas: straight-alpha RGBA arrays
 * (what `getImageData` returns) and plain rects, so it is unit-testable.
 *
 * - {@link applyCoverage}: selection coverage -> alpha (copy of selected pixels).
 * - {@link maskToGray}: mask coverage -> opaque grayscale (what other apps expect).
 * - {@link unionMaskCoverage} / {@link unionCoverage} / {@link subtractCoverage}:
 *   the cmask combine rule (normal union minus subtract union).
 * - {@link imageToMaskGray}: a pasted image -> lmask float values (luminance x alpha).
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
 * Fold one mask's raw coverage into a union (max), as the MASK output does
 * (normal cmasks into `U`, subtract cmasks into `S`). The mask's pixels cover
 * `read` (a part of `area`, e.g. clipped to the paint bounds); elsewhere its
 * coverage is 0.
 * @param union - Union coverage over `area`, `area.width * area.height` bytes (modified).
 * @param area - Union rect (document px).
 * @param read - Rect the pixels cover (inside `area`), or `null` for none.
 * @param rgba - Mask pixels over `read` (coverage in alpha).
 */
export function unionMaskCoverage(union: Uint8Array, area: Rect, read: Rect | null, rgba: Uint8ClampedArray): void {
  for (let y = 0; y < area.height; y++) {
    const ry = area.y + y - (read?.y ?? 0);
    for (let x = 0; x < area.width; x++) {
      const rx = area.x + x - (read?.x ?? 0);
      const inside = read !== null && rx >= 0 && ry >= 0 && rx < read.width && ry < read.height;
      const v = inside ? (rgba[(ry * read.width + rx) * 4 + 3] as number) : 0;
      const i = y * area.width + x;
      if (v > (union[i] as number)) union[i] = v;
    }
  }
}

/**
 * Fold a coverage plane of the same size into a union (max), in place.
 * @param union - Union coverage (modified).
 * @param coverage - Coverage to add, same length.
 */
export function unionCoverage(union: Uint8Array, coverage: Uint8Array): void {
  for (let i = 0; i < union.length; i++) if ((coverage[i] as number) > (union[i] as number)) union[i] = coverage[i] as number;
}

/**
 * The cmask combine rule (Python `combine_mask_layers`, without the node's
 * `invert_mask`): `result = U * (1 - S)`, `U` = union of the normal cmasks,
 * `S` = union of the subtract cmasks; per pixel `round(u * (255 - s) / 255)`.
 * @param union - `U` (modified: becomes the result).
 * @param subtracted - `S`, same length.
 */
export function subtractCoverage(union: Uint8Array, subtracted: Uint8Array): void {
  for (let i = 0; i < union.length; i++) {
    const s = subtracted[i] as number;
    if (s > 0) union[i] = Math.round(((union[i] as number) * (255 - s)) / 255);
  }
}

/**
 * A pasted image -> lmask float pixels (paste into the lmask-only view), in
 * place: value = Rec.709 luminance x alpha (transparent = black = shown) in
 * RGB, coverage 255 (the paste replaces what it lands on). Our own lmask copy
 * (opaque grayscale) keeps its values exactly.
 * @param rgba - Straight-alpha RGBA (modified).
 */
export function imageToMaskGray(rgba: Uint8ClampedArray): void {
  for (let p = 0; p < rgba.length; p += 4) {
    const lum = 0.2126 * (rgba[p] as number) + 0.7152 * (rgba[p + 1] as number) + 0.0722 * (rgba[p + 2] as number);
    const v = Math.round((lum * (rgba[p + 3] as number)) / 255);
    rgba[p] = v;
    rgba[p + 1] = v;
    rgba[p + 2] = v;
    rgba[p + 3] = 255;
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
 * Start rect of an oversized paste's Free Transform: `rect` scaled about its
 * centre to the largest size that fits `area` (aspect kept; never enlarged),
 * like an inserted layer source. Only the start: the session keeps the full
 * source pixels until the commit.
 * @param rect - Native paste rect, document coords.
 * @param area - Image area, document coords.
 * @returns Rect (fractional).
 */
export function fitRect(rect: Rect, area: Rect): Rect {
  const k = rect.width > 0 && rect.height > 0 ? Math.min(1, area.width / rect.width, area.height / rect.height) : 1;
  const width = rect.width * k;
  const height = rect.height * k;
  return { x: rect.x + (rect.width - width) / 2, y: rect.y + (rect.height - height) / 2, width, height };
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
