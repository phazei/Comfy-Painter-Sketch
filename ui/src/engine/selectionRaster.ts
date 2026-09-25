/**
 * Anti-aliased coverage for the ellipse marquee and the lasso (SPEC Tools
 * table: both anti-aliased, the Photoshop default). Pure scanline
 * rasterizer in DOCUMENT coords, so it runs in unit tests without a canvas
 * (the alternative -- fill a `Path2D`, read back -- needs a DOM).
 *
 * Each pixel row is sampled at {@link SUBROWS} sub-rows; on every sub-row
 * the shape's spans (ellipse: analytic chord, polygon: non-zero winding --
 * the canvas default, so the preview outline and the result agree) are
 * accumulated with EXACT horizontal coverage (partial end pixels get their
 * fractional overlap, full runs go through a difference array). Coverage =
 * mean over sub-rows, 0-255. Cost is O(sub-rows x crossings + pixels).
 */

import type { Point, Rect } from "../geometry/rect";
import { selectionFromCoverage } from "./selection";
import type { Selection } from "./selection";

/** Vertical samples per pixel row (horizontal coverage is exact). */
const SUBROWS = 16;

/** Spans `[x0, x1, x0, x1, ...]` (document x, sorted, non-overlapping) of a shape on one horizontal line. */
type SpanFn = (y: number) => readonly number[];

// ═══════════════════════════════════════════════════════════════════════════

/**
 * Anti-aliased ellipse inscribed in a box (ellipse marquee).
 * @param box - Box in document coords (usually pixel-snapped).
 * @returns Selection, or `null` when it covers no pixel.
 */
export function ellipseSelection(box: Rect): Selection | null {
  const rx = Math.abs(box.width) / 2;
  const ry = Math.abs(box.height) / 2;
  if (rx <= 0 || ry <= 0) return null;
  const cx = Math.min(box.x, box.x + box.width) + rx;
  const cy = Math.min(box.y, box.y + box.height) + ry;
  const spans: SpanFn = (y) => {
    const dy = (y - cy) / ry;
    if (dy <= -1 || dy >= 1) return [];
    const half = rx * Math.sqrt(1 - dy * dy);
    return [cx - half, cx + half];
  };
  return rasterize(outerRect(cx - rx, cy - ry, cx + rx, cy + ry), spans);
}

/**
 * Anti-aliased closed polygon (lasso), non-zero winding. The last point
 * joins back to the first.
 * @param points - Vertices in document coords (at least 3 for a non-empty result).
 * @returns Selection, or `null` when it covers no pixel.
 */
export function polygonSelection(points: readonly Point[]): Selection | null {
  if (points.length < 3) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  if (maxX <= minX || maxY <= minY) return null;
  const crossings: Array<{ x: number; dir: number }> = [];
  const spans: SpanFn = (y) => {
    crossings.length = 0;
    for (let i = 0; i < points.length; i++) {
      const a = points[i] as Point;
      const b = points[(i + 1) % points.length] as Point;
      if (a.y === b.y) continue;
      // Half-open in y so a vertex shared by two edges counts once.
      const lo = a.y < b.y ? a : b;
      const hi = a.y < b.y ? b : a;
      if (y < lo.y || y >= hi.y) continue;
      crossings.push({ x: lo.x + ((y - lo.y) * (hi.x - lo.x)) / (hi.y - lo.y), dir: b.y > a.y ? 1 : -1 });
    }
    crossings.sort((p, q) => p.x - q.x);
    const out: number[] = [];
    let winding = 0;
    for (const c of crossings) {
      const was = winding;
      winding += c.dir;
      if (was === 0 && winding !== 0) out.push(c.x);
      else if (was !== 0 && winding === 0) out.push(c.x);
    }
    return out;
  };
  return rasterize(outerRect(minX, minY, maxX, maxY), spans);
}

// ── Internals ─────────────────────────────────────────────────────────────────

/** Integer rect enclosing `[x0, x1] x [y0, y1]`. */
function outerRect(x0: number, y0: number, x1: number, y1: number): Rect {
  const x = Math.floor(x0);
  const y = Math.floor(y0);
  return { x, y, width: Math.ceil(x1) - x, height: Math.ceil(y1) - y };
}

/** Sample `spans` over `area` into a coverage buffer and wrap it as a selection. */
function rasterize(area: Rect, spans: SpanFn): Selection | null {
  const { width, height } = area;
  if (width <= 0 || height <= 0) return null;
  const coverage = new Uint8Array(width * height);
  const partial = new Float32Array(width);
  const runs = new Int32Array(width + 1);
  for (let row = 0; row < height; row++) {
    partial.fill(0);
    runs.fill(0);
    for (let j = 0; j < SUBROWS; j++) {
      const list = spans(area.y + row + (j + 0.5) / SUBROWS);
      for (let k = 0; k + 1 < list.length; k += 2) {
        addSpan(partial, runs, width, (list[k] as number) - area.x, (list[k + 1] as number) - area.x);
      }
    }
    let run = 0;
    const base = row * width;
    for (let x = 0; x < width; x++) {
      run += runs[x] as number;
      const c = ((run + (partial[x] as number)) * 255) / SUBROWS;
      coverage[base + x] = c >= 255 ? 255 : Math.round(c);
    }
  }
  return selectionFromCoverage(coverage, area);
}

/** Accumulate one sub-row span `[a, b)` (area-local x) with exact horizontal coverage. */
function addSpan(partial: Float32Array, runs: Int32Array, width: number, a: number, b: number): void {
  const x0 = Math.max(0, a);
  const x1 = Math.min(width, b);
  if (x1 <= x0) return;
  const i0 = Math.floor(x0);
  const i1 = Math.floor(x1);
  if (i0 === i1) {
    partial[i0] = (partial[i0] as number) + (x1 - x0);
    return;
  }
  partial[i0] = (partial[i0] as number) + (i0 + 1 - x0);
  // Fully covered pixels i0+1 .. i1-1.
  runs[i0 + 1] = (runs[i0 + 1] as number) + 1;
  runs[i1] = (runs[i1] as number) - 1;
  if (i1 < width) partial[i1] = (partial[i1] as number) + (x1 - i1);
}
