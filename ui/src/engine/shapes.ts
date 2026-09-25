/**
 * Shape geometry for the shape tools (SPEC Tools table: Line / Arrow,
 * Rectangle / Ellipse). Pure, no DOM: angle snapping, box-from-drag with
 * Shift (square/circle) and Alt (from centre), arrowhead polygons, and the
 * dirty rect of a shape including stroke width and anti-aliasing. All
 * values are in document px. The engine rasterizes a {@link ShapeSpec} with
 * `shapeRender.ts`.
 */

import { unionRect } from "../geometry/rect";
import type { Point, Rect } from "../geometry/rect";

// ── Types ─────────────────────────────────────────────────────────────────────

/** Which ends of a line get an arrowhead. */
export type ArrowHeads = "none" | "end" | "both";

/** How a box shape is painted. */
export type BoxPaint = "stroke" | "fill" | "both";

/** A straight line, optionally with arrowheads (round caps). */
export interface LineShape {
  kind: "line";
  from: Point;
  to: Point;
  /** Stroke width. */
  width: number;
  heads: ArrowHeads;
  /** Arrowhead length as a multiple of `width`. */
  headRatio: number;
  color: string;
}

/** An axis-aligned rectangle or ellipse (inscribed in `rect`). */
export interface BoxShape {
  kind: "rect" | "ellipse";
  /** Box the shape is drawn in; the stroke is centred on its edge. */
  rect: Rect;
  paint: BoxPaint;
  strokeWidth: number;
  strokeColor: string;
  fillColor: string;
}

/** Anything the shape tools draw. */
export type ShapeSpec = LineShape | BoxShape;

/** Resolved line geometry: shaft segment (or none) and filled head polygons. */
export interface LineGeometry {
  /** Shaft from/to (round caps), `null` when the heads cover the whole line. */
  shaft: [Point, Point] | null;
  /** Arrowhead triangles (tip first). */
  heads: Point[][];
}

/** Extra padding for anti-aliased edges, document px. */
export const AA_PAD = 1;

/** Arrowhead half-width as a fraction of its length. */
const HEAD_HALF_WIDTH = 0.4;

/** Longest share of the line one arrowhead may take. */
const HEAD_MAX_SHARE = 0.9;

// ── Drag helpers ──────────────────────────────────────────────────────────────

/**
 * Snap the end of a segment so its angle is a multiple of `stepDeg`,
 * keeping its length (Shift on the line tool).
 * @param from - Fixed start.
 * @param to - Free end.
 * @param stepDeg - Angle step in degrees (default 15).
 * @returns Snapped end point.
 */
export function snapAngle(from: Point, to: Point, stepDeg = 15): Point {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) return { ...to };
  const step = (stepDeg * Math.PI) / 180;
  const angle = Math.round(Math.atan2(dy, dx) / step) * step;
  return { x: from.x + clean(Math.cos(angle)) * length, y: from.y + clean(Math.sin(angle)) * length };
}

/**
 * Box spanned by a drag (Photoshop rectangle/ellipse modifiers).
 * @param start - Pointer-down point.
 * @param current - Current point.
 * @param square - Shift: equal width and height (the larger side wins).
 * @param fromCenter - Alt (pressed during the drag): `start` is the centre.
 * @returns Box with non-negative size.
 */
export function boxFromDrag(start: Point, current: Point, square: boolean, fromCenter: boolean): Rect {
  let dx = current.x - start.x;
  let dy = current.y - start.y;
  if (square) {
    const side = Math.max(Math.abs(dx), Math.abs(dy));
    dx = (dx < 0 ? -1 : 1) * side;
    dy = (dy < 0 ? -1 : 1) * side;
  }
  if (fromCenter) {
    const w = Math.abs(dx);
    const h = Math.abs(dy);
    return { x: start.x - w, y: start.y - h, width: w * 2, height: h * 2 };
  }
  return { x: Math.min(start.x, start.x + dx), y: Math.min(start.y, start.y + dy), width: Math.abs(dx), height: Math.abs(dy) };
}

/**
 * Rectangle path that renders crisp on the pixel grid: corners rounded to
 * whole px; with an odd stroke width the path moves onto pixel centres so
 * the stroke covers whole pixels.
 * @param rect - Box.
 * @param strokeWidth - Stroke width (0 = fill only).
 * @returns Path rect.
 */
export function crispRect(rect: Rect, strokeWidth: number): Rect {
  const x = Math.round(rect.x);
  const y = Math.round(rect.y);
  const r = { x, y, width: Math.round(rect.x + rect.width) - x, height: Math.round(rect.y + rect.height) - y };
  const odd = strokeWidth > 0 && Math.round(strokeWidth) % 2 === 1;
  return odd ? { ...r, x: r.x + 0.5, y: r.y + 0.5 } : r;
}

// ── Arrowheads ────────────────────────────────────────────────────────────────

/**
 * Arrowhead length for a line (shrinks on short lines so heads never
 * overlap or pass the other end).
 * @param width - Line width.
 * @param ratio - Head length / width.
 * @param lineLength - Line length.
 * @param count - Number of heads (1 or 2).
 * @returns Head length (0 without heads).
 */
export function headLength(width: number, ratio: number, lineLength: number, count: number): number {
  if (count <= 0) return 0;
  const wanted = Math.max(0, width * ratio);
  return Math.min(wanted, (lineLength * HEAD_MAX_SHARE) / count);
}

/**
 * Filled arrowhead triangle pointing at `tip`, coming from `from`.
 * @param tip - Arrow tip.
 * @param from - Any point back along the line (direction source).
 * @param length - Head length along the line.
 * @returns `[tip, left, right]`, or `[]` for a zero-length line/head.
 */
export function arrowHeadPolygon(tip: Point, from: Point, length: number): Point[] {
  const dx = tip.x - from.x;
  const dy = tip.y - from.y;
  const d = Math.hypot(dx, dy);
  if (d === 0 || length <= 0) return [];
  const ux = dx / d;
  const uy = dy / d;
  const bx = tip.x - ux * length;
  const by = tip.y - uy * length;
  const half = length * HEAD_HALF_WIDTH;
  return [
    { ...tip },
    { x: bx - uy * half, y: by + ux * half },
    { x: bx + uy * half, y: by - ux * half },
  ];
}

/**
 * Shaft + heads of a line shape. With a head the shaft stops at the head's
 * base (its round cap stays inside the head), so the tip is sharp.
 * @param line - Line shape.
 * @returns Geometry, or `null` for a zero-length line.
 */
export function lineGeometry(line: LineShape): LineGeometry | null {
  const { from, to } = line;
  const length = Math.hypot(to.x - from.x, to.y - from.y);
  if (length === 0 || line.width <= 0) return null;
  const count = line.heads === "both" ? 2 : line.heads === "end" ? 1 : 0;
  const head = headLength(line.width, line.headRatio, length, count);
  const ux = (to.x - from.x) / length;
  const uy = (to.y - from.y) / length;
  const heads: Point[][] = [];
  let a = from;
  let b = to;
  if (count > 0 && head > 0) {
    heads.push(arrowHeadPolygon(to, from, head));
    b = { x: to.x - ux * head, y: to.y - uy * head };
    if (count === 2) {
      heads.push(arrowHeadPolygon(from, to, head));
      a = { x: from.x + ux * head, y: from.y + uy * head };
    }
  }
  const shaftLength = Math.hypot(b.x - a.x, b.y - a.y);
  return { shaft: shaftLength > 0 ? [a, b] : null, heads };
}

// ── Bounds ────────────────────────────────────────────────────────────────────

/**
 * Whether a shape would paint anything (zero-size drags paint nothing).
 * @param shape - Shape.
 * @returns `true` if it has visible area.
 */
export function isDrawableShape(shape: ShapeSpec): boolean {
  if (shape.kind === "line") return lineGeometry(shape) !== null;
  const hasPaint = shape.paint !== "stroke" || shape.strokeWidth > 0;
  return hasPaint && shape.rect.width > 0 && shape.rect.height > 0;
}

/**
 * Document rect a shape can touch: geometry + half the stroke width +
 * anti-aliasing (the undo patch / preview dirty rect).
 * @param shape - Shape.
 * @returns Fractional rect (empty for undrawable shapes).
 */
export function shapeBounds(shape: ShapeSpec): Rect {
  const empty: Rect = { x: 0, y: 0, width: 0, height: 0 };
  if (!isDrawableShape(shape)) return empty;
  if (shape.kind === "line") {
    const geo = lineGeometry(shape);
    if (!geo) return empty;
    let r = empty;
    if (geo.shaft) r = unionRect(r, padRect(pointsRect(geo.shaft), shape.width / 2));
    for (const head of geo.heads) r = unionRect(r, pointsRect(head));
    return padRect(r, AA_PAD);
  }
  const stroke = shape.paint === "fill" ? 0 : shape.strokeWidth;
  const path = shape.kind === "rect" ? crispRect(shape.rect, stroke) : shape.rect;
  return padRect(path, stroke / 2 + AA_PAD);
}

/**
 * Rect enclosing points.
 * @param points - At least one point.
 * @returns Bounding rect (zero size for one point).
 */
export function pointsRect(points: readonly Point[]): Rect {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  if (minX > maxX) return { x: 0, y: 0, width: 0, height: 0 };
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function padRect(r: Rect, pad: number): Rect {
  return { x: r.x - pad, y: r.y - pad, width: r.width + pad * 2, height: r.height + pad * 2 };
}

/** Kill floating-point dust from cos/sin of multiples of 15 degrees. */
function clean(v: number): number {
  return Math.abs(v) < 1e-12 ? 0 : v;
}
