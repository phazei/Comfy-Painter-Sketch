/**
 * Pure geometry of the colour wheel (`colorWheel.ts`, SPEC "Colour"): the hue
 * ring, the fixed saturation/value triangle inside it, and the positions of
 * the swatch and the two circle groups in the gaps (their colours:
 * `colorSchemes.ts`).
 *
 * Coordinates are wheel-local CSS px with the origin at the wheel centre and
 * y pointing down. The triangle never rotates: its pure-hue corner points
 * right, white is top-left, black bottom-left (GTK / Krita "HSV triangle"
 * maths, fixed orientation). The ring's hue angle matches the reference the
 * maintainer gave: red upper-left, yellow on top, blue at the bottom.
 */

import { clamp01 } from "./colorMath";

// ── Layout constants ──────────────────────────────────────────────────────────

/** Wheel box side, CSS px. */
export const WHEEL_SIZE = 224;
/** Ring thickness, CSS px. */
export const RING_WIDTH = 16;
/** Outer ring radius. */
export const RING_OUTER = WHEEL_SIZE / 2;
/** Inner ring radius. */
export const RING_INNER = RING_OUTER - RING_WIDTH;
/** Triangle circumradius (gap of 6 px to the ring). */
export const TRIANGLE_RADIUS = RING_INNER - 6;

/** Screen angle (degrees, clockwise from +x) of hue 0. */
const HUE_ZERO_ANGLE = -150;

/** A point in wheel-local CSS px. */
export interface Point {
  x: number;
  y: number;
}

/** Triangle corners: pure hue (right), white (top-left), black (bottom-left). */
export const TRIANGLE = {
  hue: { x: TRIANGLE_RADIUS, y: 0 },
  white: { x: -TRIANGLE_RADIUS / 2, y: (-TRIANGLE_RADIUS * Math.sqrt(3)) / 2 },
  black: { x: -TRIANGLE_RADIUS / 2, y: (TRIANGLE_RADIUS * Math.sqrt(3)) / 2 },
} as const;

/** Distance from a corner to the opposite edge. */
export const TRIANGLE_HEIGHT = 1.5 * TRIANGLE_RADIUS;

// ── Ring ──────────────────────────────────────────────────────────────────────

/**
 * Screen angle of a hue on the ring.
 * @param hue - Hue in degrees.
 * @returns Angle in radians (clockwise from +x, y down).
 */
export function hueToAngle(hue: number): number {
  return ((hue + HUE_ZERO_ANGLE) * Math.PI) / 180;
}

/**
 * Hue under a point (its direction from the centre).
 * @param p - Wheel-local point.
 * @returns Hue in [0, 360).
 */
export function pointToHue(p: Point): number {
  const deg = (Math.atan2(p.y, p.x) * 180) / Math.PI - HUE_ZERO_ANGLE;
  return ((deg % 360) + 360) % 360;
}

/**
 * Whether a press at `p` grabs the ring (else the triangle). Generous: the
 * inner gap counts as ring so the thin ring is easy to hit.
 * @param p - Wheel-local point.
 * @returns `true` for the ring.
 */
export function isRingHit(p: Point): boolean {
  return Math.hypot(p.x, p.y) >= RING_INNER - 4;
}

/**
 * Whether a press at `p` grabs the triangle: inside it or within 3 px of an
 * edge. Presses in the gaps (around the swatch and circles) grab nothing.
 * @param p - Wheel-local point.
 * @returns `true` for the triangle.
 */
export function isTriangleHit(p: Point): boolean {
  const w = triangleWeights(p);
  return Math.min(w.hue, w.white, w.black) * TRIANGLE_HEIGHT >= -3;
}

/**
 * Centre of the ring thumb for a hue.
 * @param hue - Hue in degrees.
 * @returns Wheel-local point.
 */
export function ringThumb(hue: number): Point {
  const angle = hueToAngle(hue);
  const r = RING_OUTER - RING_WIDTH / 2;
  return { x: r * Math.cos(angle), y: r * Math.sin(angle) };
}

// ── Triangle ──────────────────────────────────────────────────────────────────

/** Barycentric weights of the hue, white and black corners (sum 1). */
export interface Weights {
  hue: number;
  white: number;
  black: number;
}

/**
 * Barycentric weights of a point (negative outside the triangle).
 * @param p - Wheel-local point.
 * @returns Weights of the three corners.
 */
export function triangleWeights(p: Point): Weights {
  const { hue: a, white: b, black: c } = TRIANGLE;
  const det = (b.y - c.y) * (a.x - c.x) + (c.x - b.x) * (a.y - c.y);
  const wa = ((b.y - c.y) * (p.x - c.x) + (c.x - b.x) * (p.y - c.y)) / det;
  const wb = ((c.y - a.y) * (p.x - c.x) + (a.x - c.x) * (p.y - c.y)) / det;
  return { hue: wa, white: wb, black: 1 - wa - wb };
}

/**
 * Nearest point of the triangle (the point itself when inside).
 * @param p - Wheel-local point.
 * @returns Point on or inside the triangle.
 */
export function clampToTriangle(p: Point): Point {
  const w = triangleWeights(p);
  if (w.hue >= 0 && w.white >= 0 && w.black >= 0) return p;
  const { hue, white, black } = TRIANGLE;
  let best: Point = hue;
  let bestDist = Infinity;
  for (const [a, b] of [[hue, white], [white, black], [black, hue]] as const) {
    const q = nearestOnSegment(p, a, b);
    const d = Math.hypot(p.x - q.x, p.y - q.y);
    if (d < bestDist) {
      bestDist = d;
      best = q;
    }
  }
  return best;
}

/**
 * Saturation / value at a triangle point (clamped into the triangle first).
 * The hue corner is s = v = 1, white s = 0 v = 1, black v = 0.
 * @param p - Wheel-local point.
 * @returns `{ s, v }` in [0, 1].
 */
export function pointToSv(p: Point): { s: number; v: number } {
  const w = triangleWeights(clampToTriangle(p));
  const hue = Math.max(0, w.hue);
  const v = clamp01(hue + Math.max(0, w.white));
  return { s: v > 0 ? clamp01(hue / v) : 0, v };
}

/**
 * Triangle point of a saturation / value.
 * @param s - Saturation [0, 1].
 * @param v - Value [0, 1].
 * @returns Wheel-local point.
 */
export function svToPoint(s: number, v: number): Point {
  const hue = clamp01(s) * clamp01(v);
  const white = clamp01(v) - hue;
  const black = 1 - hue - white;
  const { hue: a, white: b, black: c } = TRIANGLE;
  return {
    x: hue * a.x + white * b.x + black * c.x,
    y: hue * a.y + white * b.y + black * c.y,
  };
}

function nearestOnSegment(p: Point, a: Point, b: Point): Point {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const t = clamp01(((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy));
  return { x: a.x + t * dx, y: a.y + t * dy };
}

// ── Gaps: swatch and colour circles ─────────────────────────────────────────

/** A circle in wheel-local CSS px. */
export interface Circle extends Point {
  r: number;
}

/** Three circles and a cycle button for one gap. */
export interface CircleGroup {
  /** Partner, base (larger, on top), partner. */
  circles: readonly [Circle, Circle, Circle];
  /** Button just outside the ring on the same line as the base circle. */
  button: Circle;
}

/**
 * The circles of a gap outside a triangle edge: the larger base on the line
 * from the opposite corner through the centre, the two partners either side
 * of it, slightly overlapped by the base; the button just outside the ring on
 * the same line (it may poke a few px out of the wheel box; the picker leaves
 * room for it).
 * @param dir - Direction of the gap, degrees (clockwise from +x).
 * @returns The group.
 */
function circleGroup(dir: number): CircleGroup {
  return {
    circles: [polarCircle(68, dir - 19, 11), polarCircle(71, dir, 15), polarCircle(68, dir + 19, 11)],
    button: polarCircle(RING_OUTER + 2 + 13, dir, 13),
  };
}

/** Top-right gap (outside the hue-white edge): the harmony circles. */
export const HARMONY_GROUP = circleGroup(-60);

/** Bottom-right gap (outside the hue-black edge): the variation circles. */
export const VARIATION_GROUP = circleGroup(60);

/** Left-gap swatch box (a tall oval, flat towards the triangle). */
export const SWATCH_BOX = { left: -88, top: -36, width: 38, height: 72 } as const;

function polarCircle(r: number, deg: number, radius: number): Circle {
  const a = (deg * Math.PI) / 180;
  return { x: r * Math.cos(a), y: r * Math.sin(a), r: radius };
}