/**
 * Pure geometry of Free Transform (SPEC "Free Transform and flips"): affine
 * matrices, the session parameters (centre / scale / angle), the handle
 * box and handle drags (hit zones / cursor choice: `transformHit.ts`). No DOM, no
 * canvas -- unit-testable.
 *
 * Conventions: a transform maps FLOAT-LOCAL px (0..w, 0..h: the lifted area,
 * origin at its top-left) to DOCUMENT px. Parameters describe it as
 * `T(cx, cy) . R(angle) . S(sx, sy) . T(-w/2, -h/2)`: the box centre, a
 * rotation (radians, clockwise on screen since y points down) and signed
 * scales (negative = flipped). No skew, so every matrix we build decomposes
 * back into parameters ({@link decomposeAffine}).
 */

import type { Point, Rect } from "../geometry/rect";

// ── Types ─────────────────────────────────────────────────────────────────────

/** 2D affine matrix: `x' = a x + c y + e`, `y' = b x + d y + f` (canvas `setTransform` order). */
export interface Affine {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

/** Session parameters of a transform (see module doc). */
export interface TransformParams {
  /** Box centre, document px. */
  cx: number;
  cy: number;
  /** Signed scale factors (negative = flipped along that local axis). */
  sx: number;
  sy: number;
  /** Rotation, radians. */
  angle: number;
}

/** A handle of the box: local direction, -1 / 0 / 1 per axis. */
export interface HandleDir {
  hx: -1 | 0 | 1;
  hy: -1 | 0 | 1;
}

/** Eight handles, clockwise from the top-left corner (corners are even indices). */
export const HANDLES: readonly HandleDir[] = [
  { hx: -1, hy: -1 },
  { hx: 0, hy: -1 },
  { hx: 1, hy: -1 },
  { hx: 1, hy: 0 },
  { hx: 1, hy: 1 },
  { hx: 0, hy: 1 },
  { hx: -1, hy: 1 },
  { hx: -1, hy: 0 },
];

/** Rotation snap step with Shift (15 deg). */
export const ROTATE_SNAP = Math.PI / 12;

/** Smallest box side a scale drag may produce, document px. */
const MIN_SIDE = 1;

// ── Matrices ──────────────────────────────────────────────────────────────────

/** The identity matrix. */
export const IDENTITY: Readonly<Affine> = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

/**
 * Pure translation.
 * @param x - X shift.
 * @param y - Y shift.
 * @returns Matrix.
 */
export function translation(x: number, y: number): Affine {
  return { a: 1, b: 0, c: 0, d: 1, e: x, f: y };
}

/**
 * Matrix product `m . n` (apply `n` first, then `m`).
 * @param m - Outer matrix.
 * @param n - Inner matrix.
 * @returns Product.
 */
export function multiply(m: Affine, n: Affine): Affine {
  return {
    a: m.a * n.a + m.c * n.b,
    b: m.b * n.a + m.d * n.b,
    c: m.a * n.c + m.c * n.d,
    d: m.b * n.c + m.d * n.d,
    e: m.a * n.e + m.c * n.f + m.e,
    f: m.b * n.e + m.d * n.f + m.f,
  };
}

/**
 * Inverse matrix.
 * @param m - Matrix.
 * @returns Inverse, or `null` when singular.
 */
export function invert(m: Affine): Affine | null {
  const det = m.a * m.d - m.b * m.c;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  return {
    a: m.d / det,
    b: -m.b / det,
    c: -m.c / det,
    d: m.a / det,
    e: (m.c * m.f - m.d * m.e) / det,
    f: (m.b * m.e - m.a * m.f) / det,
  };
}

/**
 * Apply a matrix to a point.
 * @param m - Matrix.
 * @param p - Point.
 * @returns Transformed point.
 */
export function apply(m: Affine, p: Point): Point {
  return { x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f };
}

/**
 * Whether two matrices are equal within a tolerance.
 * @param m - Matrix.
 * @param n - Matrix.
 * @param eps - Tolerance (default 1e-6).
 * @returns `true` if equal.
 */
export function affineEquals(m: Affine, n: Affine, eps = 1e-6): boolean {
  return (
    Math.abs(m.a - n.a) < eps &&
    Math.abs(m.b - n.b) < eps &&
    Math.abs(m.c - n.c) < eps &&
    Math.abs(m.d - n.d) < eps &&
    Math.abs(m.e - n.e) < eps &&
    Math.abs(m.f - n.f) < eps
  );
}

/**
 * Mirror about a vertical (`"h"`) or horizontal (`"v"`) line through a point (document space).
 * @param axis - `"h"` = flip horizontally, `"v"` = vertically.
 * @param centre - Point on the mirror line.
 * @returns Matrix.
 */
export function mirrorAbout(axis: "h" | "v", centre: Point): Affine {
  return axis === "h" ? { a: -1, b: 0, c: 0, d: 1, e: 2 * centre.x, f: 0 } : { a: 1, b: 0, c: 0, d: -1, e: 0, f: 2 * centre.y };
}

// ── Parameters ────────────────────────────────────────────────────────────────

/**
 * Matrix of session parameters for a `w` x `h` float.
 * @param p - Parameters.
 * @param w - Float width, px.
 * @param h - Float height, px.
 * @returns Float-local -> document matrix.
 */
export function paramsMatrix(p: TransformParams, w: number, h: number): Affine {
  const cos = Math.cos(p.angle);
  const sin = Math.sin(p.angle);
  const a = cos * p.sx;
  const b = sin * p.sx;
  const c = -sin * p.sy;
  const d = cos * p.sy;
  return { a, b, c, d, e: p.cx - (a * w + c * h) / 2, f: p.cy - (b * w + d * h) / 2 };
}

/**
 * Parameters of a skew-free matrix (inverse of {@link paramsMatrix}).
 * @param m - Matrix (rotation + scale + translation only).
 * @param w - Float width, px.
 * @param h - Float height, px.
 * @returns Parameters (a flip is carried by `sy < 0`).
 */
export function decomposeAffine(m: Affine, w: number, h: number): TransformParams {
  const sx = Math.hypot(m.a, m.b);
  const angle = sx > 0 ? Math.atan2(m.b, m.a) : 0;
  const sy = sx > 0 ? (m.a * m.d - m.b * m.c) / sx : Math.hypot(m.c, m.d);
  const centre = apply(m, { x: w / 2, y: h / 2 });
  return { cx: centre.x, cy: centre.y, sx, sy, angle };
}

/**
 * Angle normalized to (-PI, PI].
 * @param angle - Radians.
 * @returns Normalized radians.
 */
export function normalizeAngle(angle: number): number {
  let a = angle % (2 * Math.PI);
  if (a <= -Math.PI) a += 2 * Math.PI;
  if (a > Math.PI) a -= 2 * Math.PI;
  return a;
}

/**
 * Parameters flipped in DOCUMENT space about the box centre (Flip H / Flip V
 * during a session: a canvas-horizontal mirror whatever the rotation).
 * @param p - Parameters.
 * @param axis - `"h"` or `"v"`.
 * @returns Flipped parameters.
 */
export function flipParams(p: TransformParams, axis: "h" | "v"): TransformParams {
  // mirror . R(t) = R(-t) . mirror, and the mirror lands on the local scale.
  return axis === "h" ? { ...p, sx: -p.sx, angle: normalizeAngle(-p.angle) } : { ...p, sy: -p.sy, angle: normalizeAngle(-p.angle) };
}

// ── Box ───────────────────────────────────────────────────────────────────────

/**
 * Transformed corners (top-left, top-right, bottom-right, bottom-left of the float).
 * @param m - Matrix.
 * @param w - Float width.
 * @param h - Float height.
 * @returns Four document points.
 */
export function transformedCorners(m: Affine, w: number, h: number): Point[] {
  return [apply(m, { x: 0, y: 0 }), apply(m, { x: w, y: 0 }), apply(m, { x: w, y: h }), apply(m, { x: 0, y: h })];
}

/**
 * Integer axis-aligned bounds of the transformed float (rounded outwards;
 * edges within 1e-6 of a whole px are not grown).
 * @param m - Matrix.
 * @param w - Float width.
 * @param h - Float height.
 * @returns Document rect.
 */
export function transformedAabb(m: Affine, w: number, h: number): Rect {
  const pts = transformedCorners(m, w, h);
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const x0 = Math.floor(Math.min(...xs) + 1e-6);
  const y0 = Math.floor(Math.min(...ys) + 1e-6);
  const x1 = Math.ceil(Math.max(...xs) - 1e-6);
  const y1 = Math.ceil(Math.max(...ys) - 1e-6);
  return { x: x0, y: y0, width: Math.max(0, x1 - x0), height: Math.max(0, y1 - y0) };
}


// ── Drags ─────────────────────────────────────────────────────────────────────

/**
 * Scale by dragging a handle from `start` to the pointer `at`.
 * Proportional: corners project the pointer onto the anchor->handle
 * diagonal; edges scale both axes by the edge's factor (modern Photoshop).
 * Free: each axis the handle touches follows the pointer. `fromCentre`
 * (Alt) scales about the centre instead of the opposite handle.
 * @param start - Parameters at drag start.
 * @param w - Float width.
 * @param h - Float height.
 * @param handle - Handle index.
 * @param at - Pointer, document px.
 * @param opts - Proportional (lock XOR Shift) and around-centre (Alt).
 * @returns New parameters.
 */
export function scaleDrag(
  start: TransformParams,
  w: number,
  h: number,
  handle: number,
  at: Point,
  opts: { proportional: boolean; fromCentre: boolean },
): TransformParams {
  const dir = HANDLES[handle];
  if (!dir) return start;
  const cos = Math.cos(start.angle);
  const sin = Math.sin(start.angle);
  // Pointer in the box's unrotated frame, origin at the start centre.
  const dx = at.x - start.cx;
  const dy = at.y - start.cy;
  const P = { x: cos * dx + sin * dy, y: -sin * dx + cos * dy };
  const H = { x: (dir.hx * start.sx * w) / 2, y: (dir.hy * start.sy * h) / 2 };
  const A = opts.fromCentre ? { x: 0, y: 0 } : { x: -H.x, y: -H.y };
  const D = { x: H.x - A.x, y: H.y - A.y };
  let kx = dir.hx !== 0 && D.x !== 0 ? (P.x - A.x) / D.x : 1;
  let ky = dir.hy !== 0 && D.y !== 0 ? (P.y - A.y) / D.y : 1;
  if (opts.proportional) {
    let k: number;
    if (dir.hx !== 0 && dir.hy !== 0) {
      const dd = D.x * D.x + D.y * D.y;
      k = dd > 0 ? ((P.x - A.x) * D.x + (P.y - A.y) * D.y) / dd : 1;
    } else {
      k = dir.hx !== 0 ? kx : ky;
    }
    kx = k;
    ky = k;
  }
  const sx = clampScale(start.sx * kx, w);
  const sy = clampScale(start.sy * ky, h);
  kx = start.sx !== 0 ? sx / start.sx : 1;
  ky = start.sy !== 0 ? sy / start.sy : 1;
  // New local centre: the anchor stays put (Alt: the centre does).
  const C = opts.fromCentre ? { x: 0, y: 0 } : { x: A.x + (D.x * kx) / 2, y: A.y + (D.y * ky) / 2 };
  return { ...start, sx, sy, cx: start.cx + cos * C.x - sin * C.y, cy: start.cy + sin * C.x + cos * C.y };
}

/**
 * Rotate about the centre by the pointer's angle change.
 * @param start - Parameters at drag start.
 * @param from - Pointer at drag start, document px.
 * @param at - Pointer now.
 * @param snap - Shift: total angle in 15 deg steps.
 * @returns New parameters.
 */
export function rotateDrag(start: TransformParams, from: Point, at: Point, snap: boolean): TransformParams {
  const a0 = Math.atan2(from.y - start.cy, from.x - start.cx);
  const a1 = Math.atan2(at.y - start.cy, at.x - start.cx);
  let angle = start.angle + (a1 - a0);
  if (snap) angle = Math.round(angle / ROTATE_SNAP) * ROTATE_SNAP;
  return { ...start, angle: normalizeAngle(angle) };
}

/** Keep a signed scale's box side at least {@link MIN_SIDE} px. */
function clampScale(s: number, side: number): number {
  if (side <= 0 || !Number.isFinite(s)) return 1;
  const min = MIN_SIDE / side;
  if (Math.abs(s) >= min) return s;
  return s < 0 ? -min : min;
}
