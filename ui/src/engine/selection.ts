/**
 * Selection algebra (decision 7, SPEC "Selection"). A selection is a pixel
 * coverage mask (0-255) in DOCUMENT coordinates, so it follows the drawing
 * (not the image) and survives frame-map / placement changes for free.
 *
 * Storage is cropped: `data` covers only `rect` (the selection's bbox), and
 * every document pixel outside `rect` has the coverage `outside` -- 0 for a
 * normal selection, 255 after an invert (so an inverted selection keeps
 * covering paint area the bounds grow into later). `null` means "no
 * selection" (everything editable). Results are always trimmed; a result
 * that selects nothing becomes `null` (Photoshop deselects).
 *
 * Combining (Photoshop modifiers): replace, add (max), subtract
 * (min(a, 255 - b)), intersect (min). Min/max are exact and idempotent for
 * hard (AA off) coverage and behave sensibly for soft edges.
 *
 * Also the pure pixel helper used by "clear selection" ({@link eraseCoverage}).
 * No DOM.
 */

import { intersectRect, isEmptyRect, unionRect } from "../geometry/rect";
import type { Rect } from "../geometry/rect";

// ── Types ─────────────────────────────────────────────────────────────────────

/** Coverage mask in document coords (treat as immutable: every change makes a new object). */
export interface Selection {
  /** Integer document rect covered by `data` (may be empty when `outside` is 255). */
  readonly rect: Rect;
  /** Coverage per pixel of `rect`, row-major, `rect.width * rect.height` bytes. */
  readonly data: Uint8Array;
  /** Coverage of every document pixel outside `rect`. */
  readonly outside: 0 | 255;
}

/** How a new coverage combines with the current selection. */
export type SelectionMode = "replace" | "add" | "subtract" | "intersect";

const EMPTY: Rect = { x: 0, y: 0, width: 0, height: 0 };

// ── Construction ──────────────────────────────────────────────────────────────

/**
 * Photoshop modifier -> mode (read at drag start): Shift add, Alt subtract,
 * Shift+Alt intersect, none replace.
 * @param shift - Shift held.
 * @param alt - Alt held.
 * @returns Mode.
 */
export function selectionMode(shift: boolean, alt: boolean): SelectionMode {
  if (shift && alt) return "intersect";
  if (shift) return "add";
  if (alt) return "subtract";
  return "replace";
}

/**
 * Snap a fractional box to whole pixels (edges rounded), the hard-edged
 * marquee grid: a pixel is selected when its centre lies inside `box`.
 * @param box - Box in document coords.
 * @returns Integer rect (width/height >= 0).
 */
export function snapRect(box: Rect): Rect {
  const x0 = Math.round(box.x);
  const y0 = Math.round(box.y);
  const x1 = Math.round(box.x + box.width);
  const y1 = Math.round(box.y + box.height);
  return { x: Math.min(x0, x1), y: Math.min(y0, y1), width: Math.abs(x1 - x0), height: Math.abs(y1 - y0) };
}

/**
 * Hard-edged (AA off) rectangle selection.
 * @param box - Box in document coords (snapped with {@link snapRect}).
 * @returns Selection, or `null` when the box covers no pixel.
 */
export function rectSelection(box: Rect): Selection | null {
  const rect = snapRect(box);
  if (isEmptyRect(rect)) return null;
  return { rect, data: new Uint8Array(rect.width * rect.height).fill(255), outside: 0 };
}

/**
 * Selection from a coverage buffer (magic wand: `floodFill` output; lasso /
 * ellipse: alpha of a rasterized path), trimmed to its non-zero pixels.
 * @param coverage - Coverage over `area`, `area.width * area.height` bytes.
 * @param area - Document rect the buffer covers (integer).
 * @param bbox - Optional known bbox of non-zero coverage, buffer coords (speeds up trimming).
 * @returns Selection, or `null` when nothing is covered.
 */
export function selectionFromCoverage(coverage: Uint8Array, area: Rect, bbox?: Rect): Selection | null {
  if (coverage.length < area.width * area.height) return null;
  const inner = bbox ? intersectRect(bbox, { x: 0, y: 0, width: area.width, height: area.height }) : null;
  if (inner && isEmptyRect(inner)) return null;
  const crop = inner ?? { x: 0, y: 0, width: area.width, height: area.height };
  const data = copyRegion(coverage, area.width, crop);
  return trimSelection({ rect: { x: area.x + crop.x, y: area.y + crop.y, width: crop.width, height: crop.height }, data, outside: 0 });
}

/**
 * Selection from the alpha channel of RGBA pixels (e.g. a path filled on a
 * canvas with `getImageData`).
 * @param rgba - RGBA pixels of `area`.
 * @param area - Document rect of the pixels (integer).
 * @returns Selection, or `null` when fully transparent.
 */
export function selectionFromAlpha(rgba: Uint8ClampedArray, area: Rect): Selection | null {
  const n = area.width * area.height;
  if (rgba.length < n * 4) return null;
  const coverage = new Uint8Array(n);
  for (let i = 0; i < n; i++) coverage[i] = rgba[i * 4 + 3] as number;
  return selectionFromCoverage(coverage, area);
}

// ── Queries ───────────────────────────────────────────────────────────────────

/**
 * Coverage of one document pixel.
 * @param sel - Selection (`null` = none: 0).
 * @param x - Document x (integer).
 * @param y - Document y (integer).
 * @returns 0-255.
 */
export function coverageAt(sel: Selection | null, x: number, y: number): number {
  if (!sel) return 0;
  const { rect } = sel;
  const px = x - rect.x;
  const py = y - rect.y;
  if (px < 0 || py < 0 || px >= rect.width || py >= rect.height) return sel.outside;
  return sel.data[py * rect.width + px] as number;
}

/**
 * Coverage over an arbitrary document rect (fill clip, pixel commands).
 * @param sel - Selection.
 * @param area - Integer document rect.
 * @returns `area.width * area.height` bytes.
 */
export function coverageFor(sel: Selection, area: Rect): Uint8Array {
  const out = new Uint8Array(Math.max(0, area.width * area.height));
  if (sel.outside) out.fill(sel.outside);
  const overlap = intersectRect(sel.rect, area);
  if (isEmptyRect(overlap)) return out;
  const sw = sel.rect.width;
  for (let y = overlap.y; y < overlap.y + overlap.height; y++) {
    const src = (y - sel.rect.y) * sw + (overlap.x - sel.rect.x);
    out.set(sel.data.subarray(src, src + overlap.width), (y - area.y) * area.width + (overlap.x - area.x));
  }
  return out;
}

/**
 * Document area a command must touch: the bbox for a normal selection, or
 * all of `area` (e.g. the bounds) when everything outside the bbox is selected.
 * @param sel - Selection.
 * @param area - Available area (integer).
 * @returns Rect inside `area` (possibly empty).
 */
export function selectionExtent(sel: Selection, area: Rect): Rect {
  return intersectRect(sel.outside ? area : sel.rect, area);
}

/**
 * Structural equality.
 * @param a - Selection or `null`.
 * @param b - Selection or `null`.
 * @returns `true` when both select exactly the same coverage.
 */
export function selectionsEqual(a: Selection | null, b: Selection | null): boolean {
  if (a === b) return true;
  if (!a || !b || a.outside !== b.outside) return false;
  const r = a.rect;
  const q = b.rect;
  if (r.x !== q.x || r.y !== q.y || r.width !== q.width || r.height !== q.height) return false;
  for (let i = 0; i < a.data.length; i++) if (a.data[i] !== b.data[i]) return false;
  return true;
}

/**
 * Estimated memory of a selection (history accounting).
 * @param sel - Selection or `null`.
 * @returns Bytes.
 */
export function selectionBytes(sel: Selection | null): number {
  return (sel?.data.byteLength ?? 0) + 64;
}

// ── Operations ────────────────────────────────────────────────────────────────

const OPS: Record<Exclude<SelectionMode, "replace">, (a: number, b: number) => number> = {
  add: (a, b) => (a > b ? a : b),
  subtract: (a, b) => Math.min(a, 255 - b),
  intersect: (a, b) => (a < b ? a : b),
};

/**
 * Combine the current selection with a new coverage.
 * @param current - Current selection (`null` = none).
 * @param next - New coverage (`null` = selects nothing).
 * @param mode - Combination mode.
 * @returns Resulting selection, `null` when nothing is selected.
 */
export function combineSelection(current: Selection | null, next: Selection | null, mode: SelectionMode): Selection | null {
  if (mode === "replace") return next ? trimSelection(next) : null;
  if (!current) return mode === "add" && next ? trimSelection(next) : null;
  if (!next) return mode === "intersect" ? null : current;
  const op = OPS[mode];
  const outside = op(current.outside, next.outside) >= 128 ? 255 : 0;
  const rect = unionRect(current.rect, next.rect);
  const a = coverageFor(current, rect);
  const b = coverageFor(next, rect);
  const data = new Uint8Array(a.length);
  for (let i = 0; i < data.length; i++) data[i] = op(a[i] as number, b[i] as number);
  return trimSelection({ rect, data, outside });
}

/**
 * Invert (Shift+F7). No selection stays no selection (Photoshop).
 * @param sel - Selection.
 * @returns Inverted selection, or `null`.
 */
export function invertSelection(sel: Selection | null): Selection | null {
  if (!sel) return null;
  const data = new Uint8Array(sel.data.length);
  for (let i = 0; i < data.length; i++) data[i] = 255 - (sel.data[i] as number);
  return trimSelection({ rect: { ...sel.rect }, data, outside: sel.outside ? 0 : 255 });
}

/**
 * Restrict a selection to a document rect (outside it: nothing selected).
 * @param sel - Selection.
 * @param limit - Integer document rect.
 * @returns Clipped selection, or `null`.
 */
export function clipSelection(sel: Selection | null, limit: Rect): Selection | null {
  if (!sel) return null;
  const rect = sel.outside ? { ...limit } : intersectRect(sel.rect, limit);
  if (isEmptyRect(rect)) return null;
  return trimSelection({ rect, data: coverageFor(sel, rect), outside: 0 });
}

/**
 * Crop to the pixels that differ from `outside`.
 * @param sel - Selection.
 * @returns Trimmed selection; `null` when nothing is selected.
 */
export function trimSelection(sel: Selection): Selection | null {
  const { rect, data, outside } = sel;
  let minX = rect.width;
  let minY = rect.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < rect.height; y++) {
    const row = y * rect.width;
    for (let x = 0; x < rect.width; x++) {
      if (data[row + x] === outside) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return outside ? { rect: { ...EMPTY, x: rect.x, y: rect.y }, data: new Uint8Array(0), outside } : null;
  if (minX === 0 && minY === 0 && maxX === rect.width - 1 && maxY === rect.height - 1) return sel;
  const crop = { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
  return {
    rect: { x: rect.x + crop.x, y: rect.y + crop.y, width: crop.width, height: crop.height },
    data: copyRegion(data, rect.width, crop),
    outside,
  };
}

// ── Pixel application ─────────────────────────────────────────────────────────

/**
 * "Clear selection" on straight-alpha RGBA, in place: alpha *= 1 - coverage
 * (the canvas `destination-out` of a coverage mask).
 * @param dst - RGBA pixels of `rect` (row stride `rect.width * 4`).
 * @param rect - Where `dst` sits in coverage coordinates.
 * @param coverage - Coverage mask, 0-255.
 * @param coverageWidth - Row stride of `coverage` in px.
 */
export function eraseCoverage(dst: Uint8ClampedArray, rect: Rect, coverage: Uint8Array, coverageWidth: number): void {
  for (let y = 0; y < rect.height; y++) {
    const row = (rect.y + y) * coverageWidth + rect.x;
    for (let x = 0; x < rect.width; x++) {
      const c = coverage[row + x] as number;
      if (c === 0) continue;
      const p = (y * rect.width + x) * 4 + 3;
      dst[p] = ((dst[p] as number) * (255 - c)) / 255;
    }
  }
}

// ── Internals ─────────────────────────────────────────────────────────────────

function copyRegion(src: Uint8Array, stride: number, crop: Rect): Uint8Array {
  const out = new Uint8Array(crop.width * crop.height);
  for (let y = 0; y < crop.height; y++) {
    const from = (crop.y + y) * stride + crop.x;
    out.set(src.subarray(from, from + crop.width), y * crop.width);
  }
  return out;
}
