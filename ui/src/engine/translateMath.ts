/**
 * Pure math of the layer Move tool (SPEC M6a): drag / nudge deltas, the
 * content bbox of a layer, whether a translation fits after bounds growth
 * (so it can be a lossless `translate` history entry instead of a pixel
 * patch), and the bookkeeping of applying / reverting / merging such entries.
 * No DOM, no canvas.
 */

import { containsRect, isEmptyRect, unionRect } from "../geometry/rect";
import type { Point, Rect, Size } from "../geometry/rect";
import { DEFAULT_GROWTH, growBounds } from "./bounds";
import type { GrowthLimits } from "./bounds";

// ── Deltas ────────────────────────────────────────────────────────────────────

/** `-0` -> `0` (keeps entries / comparisons tidy). */
function clean(n: number): number {
  return n === 0 ? 0 : n;
}

/**
 * Whole-document-px drag delta between two pointer samples (both already in
 * document coords, converted through `Editor.frameMap`).
 * @param start - Sample at pointer-down.
 * @param current - Current sample.
 * @returns Rounded delta.
 */
export function dragDelta(start: Point, current: Point): Point {
  return { x: clean(Math.round(current.x - start.x)), y: clean(Math.round(current.y - start.y)) };
}

/**
 * Arrow-nudge step: `imagePx` image px in document px, at least 1.
 * @param imagePx - Step on the image (1, or 10 with Shift).
 * @param mapScale - `Editor.frameMap.scale` (image px per document px).
 * @returns Step in whole document px (>= 1).
 */
export function nudgeStep(imagePx: number, mapScale: number): number {
  if (!(mapScale > 0) || !Number.isFinite(mapScale)) return Math.max(1, Math.round(imagePx));
  return Math.max(1, Math.round(imagePx / mapScale));
}

// ── Content / bounds ──────────────────────────────────────────────────────────

/**
 * Bounding box of pixels with alpha > 0.
 * @param data - RGBA pixels.
 * @param width - Width in px.
 * @param height - Height in px.
 * @returns Local rect (zero-size when fully transparent).
 */
export function alphaBounds(data: Uint8ClampedArray, width: number, height: number): Rect {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width * 4;
    let first = -1;
    for (let x = 0; x < width; x++) {
      if (data[row + x * 4 + 3]) {
        first = x;
        break;
      }
    }
    if (first < 0) continue;
    let last = first;
    for (let x = width - 1; x > first; x--) {
      if (data[row + x * 4 + 3]) {
        last = x;
        break;
      }
    }
    if (first < minX) minX = first;
    if (last > maxX) maxX = last;
    if (minY === height) minY = y;
    maxY = y;
  }
  if (maxX < 0) return { x: 0, y: 0, width: 0, height: 0 };
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/**
 * Rect moved by a delta.
 * @param r - Rect.
 * @param dx - X shift.
 * @param dy - Y shift.
 * @returns Shifted copy.
 */
export function offsetRect(r: Rect, dx: number, dy: number): Rect {
  return { x: r.x + dx, y: r.y + dy, width: r.width, height: r.height };
}

/** How a translation will be committed. */
export type TranslatePlan =
  | { kind: "none" }
  | {
      /** `translate`: nothing is clipped -> lossless entry; `patch`: the cap clips -> before/after patch. */
      kind: "translate" | "patch";
      /** Bounds after (capped, chunked) growth. */
      bounds: Rect;
      /** Where the content lands, document coords. */
      target: Rect;
      /** Area a fallback patch must cover (before + after content, within `bounds`). */
      region: Rect;
    };

/**
 * Plan a whole-layer translation: grow bounds to cover the moved content
 * (same chunked, capped growth as painting); if the cap still clips it the
 * move must be recorded as a pixel patch.
 * @param bounds - Current bounds.
 * @param content - Content bbox, document coords.
 * @param dx - X shift, document px.
 * @param dy - Y shift, document px.
 * @param frame - Document frame (defines the cap).
 * @param limits - Growth limits.
 * @returns The plan.
 */
export function planTranslate(
  bounds: Rect,
  content: Rect,
  dx: number,
  dy: number,
  frame: Size,
  limits: GrowthLimits = DEFAULT_GROWTH,
): TranslatePlan {
  if ((dx === 0 && dy === 0) || isEmptyRect(content)) return { kind: "none" };
  const target = offsetRect(content, dx, dy);
  const grown = growBounds(bounds, target, frame, limits);
  const kind = containsRect(grown, target) ? "translate" : "patch";
  return { kind, bounds: grown, target, region: unionRect(content, target) };
}

// ── Entry bookkeeping ─────────────────────────────────────────────────────────

/** The translation fields of a history entry. */
export interface TranslateRecord {
  dx: number;
  dy: number;
  /** Content bbox before the move. */
  content: Rect;
}

/** One application of a translate record. */
export interface TranslateStep {
  /** Where the content is now (what to move). */
  from: Rect;
  /** Where it goes (bounds must cover it first). */
  to: Rect;
  dx: number;
  dy: number;
}

/**
 * What redo (`forward`) or undo of a translate record moves.
 * @param entry - Record.
 * @param forward - Redo direction.
 * @returns Source rect, destination rect and delta.
 */
export function translateStep(entry: TranslateRecord, forward: boolean): TranslateStep {
  const moved = offsetRect(entry.content, entry.dx, entry.dy);
  return forward
    ? { from: { ...entry.content }, to: moved, dx: entry.dx, dy: entry.dy }
    : { from: moved, to: { ...entry.content }, dx: clean(-entry.dx), dy: clean(-entry.dy) };
}

/**
 * Fold a further lossless nudge into a record (the content bbox stays the
 * pre-move one; only the total delta grows).
 * @param entry - Record to update in place.
 * @param dx - Extra X shift.
 * @param dy - Extra Y shift.
 */
export function mergeTranslate(entry: TranslateRecord, dx: number, dy: number): void {
  entry.dx = clean(entry.dx + dx);
  entry.dy = clean(entry.dy + dy);
}
