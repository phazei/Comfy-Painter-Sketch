/**
 * Brush math: pressure curve, dab size/alpha, distance-based dab spacing and
 * stamp falloff. Pure (no canvas) so it is unit-testable; `stampCache.ts`
 * turns the falloff into pixels and `stroke.ts` draws the dabs.
 */

import type { Rect } from "../geometry/rect";

// ── Types ─────────────────────────────────────────────────────────────────────

/** Brush parameters that affect dab placement and strength. */
export interface BrushDynamics {
  /** Diameter at full pressure, document px. */
  size: number;
  /** Per-dab alpha, 0..1 (Photoshop "flow"). */
  flow: number;
  /** Dab spacing as a fraction of the current diameter (0.1 = 10%). */
  spacing: number;
  /** Pressure scales size. */
  pressureSize: boolean;
  /** Pressure scales per-dab alpha. */
  pressureOpacity: boolean;
  /** Diameter at zero pressure as a fraction of `size`. */
  minSizeRatio: number;
  /** Pressure curve exponent (1 = linear, >1 = softer start). */
  gamma: number;
}

/** One input sample in document coords. */
export interface StrokeSample {
  x: number;
  y: number;
  /** 0..1 (already normalized, see {@link normalizePressure}). */
  pressure: number;
}

/** One stamp placement. */
export interface Dab {
  x: number;
  y: number;
  /** Diameter, document px. */
  size: number;
  /** 0..1 */
  alpha: number;
}

/** Mutable spacing state carried across samples of one stroke. */
export interface SpacerState {
  last: StrokeSample | null;
  /** Distance travelled since the last dab. */
  residual: number;
}

/** Smallest dab step, document px (guards tiny brushes). */
const MIN_STEP = 0.5;
/** Smallest dab diameter, document px. */
const MIN_SIZE = 0.5;

// ── Pressure ──────────────────────────────────────────────────────────────────

/**
 * Pointer pressure to use for painting. Only pens report meaningful pressure;
 * mouse (which reports 0.5 while pressed) and touch count as full pressure.
 *
 * @param pointerType - `PointerEvent.pointerType`.
 * @param pressure - `PointerEvent.pressure`.
 * @returns Pressure in 0..1.
 */
export function normalizePressure(pointerType: string, pressure: number): number {
  if (pointerType !== "pen") return 1;
  if (!Number.isFinite(pressure)) return 1;
  return Math.min(1, Math.max(0, pressure));
}

/**
 * Apply the pressure curve.
 * @param pressure - 0..1
 * @param gamma - Exponent (> 0).
 * @returns Curved pressure 0..1.
 */
export function curvePressure(pressure: number, gamma: number): number {
  const g = gamma > 0 && Number.isFinite(gamma) ? gamma : 1;
  return Math.pow(Math.min(1, Math.max(0, pressure)), g);
}

/**
 * Pressure -> size factor (SPEC "Pressure": min size %, gamma):
 * `min + (1 - min) * pressure^gamma`, so zero pressure gives `min` and full
 * pressure gives 1.
 * @param pressure - 0..1 (normalized).
 * @param minSizeRatio - Factor at zero pressure, 0..1 (clamped).
 * @param gamma - Curve exponent (> 0; invalid = linear).
 * @returns Factor in `[min, 1]`.
 */
export function pressureSizeFactor(pressure: number, minSizeRatio: number, gamma: number): number {
  const min = Number.isFinite(minSizeRatio) ? Math.min(1, Math.max(0, minSizeRatio)) : 0;
  return min + (1 - min) * curvePressure(pressure, gamma);
}

/**
 * Dab diameter for a pressure.
 * @param pressure - 0..1 (normalized).
 * @param dyn - Brush dynamics.
 * @returns Diameter in document px.
 */
export function dabSize(pressure: number, dyn: BrushDynamics): number {
  if (!dyn.pressureSize) return Math.max(MIN_SIZE, dyn.size);
  return Math.max(MIN_SIZE, dyn.size * pressureSizeFactor(pressure, dyn.minSizeRatio, dyn.gamma));
}

/**
 * Per-dab alpha for a pressure.
 * @param pressure - 0..1 (normalized).
 * @param dyn - Brush dynamics.
 * @returns Alpha 0..1.
 */
export function dabAlpha(pressure: number, dyn: BrushDynamics): number {
  const flow = Math.min(1, Math.max(0, dyn.flow));
  return dyn.pressureOpacity ? flow * curvePressure(pressure, dyn.gamma) : flow;
}

// ── Spacing ───────────────────────────────────────────────────────────────────

/**
 * Fresh spacing state for a new stroke.
 * @returns Empty state.
 */
export function createSpacer(): SpacerState {
  return { last: null, residual: 0 };
}

/**
 * Place dabs from the previous sample to `next`, evenly spaced by distance
 * (spacing x current diameter), interpolating position and pressure. The
 * first sample of a stroke always produces a dab. Mutates `state`.
 *
 * @param state - Spacing state for this stroke.
 * @param next - New sample.
 * @param dyn - Brush dynamics.
 * @returns Dabs to draw, in order.
 */
export function placeDabs(state: SpacerState, next: StrokeSample, dyn: BrushDynamics): Dab[] {
  const prev = state.last;
  state.last = next;
  if (!prev) {
    state.residual = 0;
    return [makeDab(next.x, next.y, next.pressure, dyn)];
  }

  const dx = next.x - prev.x;
  const dy = next.y - prev.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) return [];

  const dabs: Dab[] = [];
  const spacing = Math.max(0.01, dyn.spacing);
  let travelled = 0;
  for (;;) {
    const t = travelled / length;
    const pressure = prev.pressure + (next.pressure - prev.pressure) * t;
    const step = Math.max(MIN_STEP, spacing * dabSize(pressure, dyn));
    const needed = step - state.residual;
    if (travelled + needed > length) {
      state.residual += length - travelled;
      break;
    }
    travelled += needed;
    state.residual = 0;
    const u = travelled / length;
    dabs.push(
      makeDab(prev.x + dx * u, prev.y + dy * u, prev.pressure + (next.pressure - prev.pressure) * u, dyn),
    );
  }
  return dabs;
}

function makeDab(x: number, y: number, pressure: number, dyn: BrushDynamics): Dab {
  return { x, y, size: dabSize(pressure, dyn), alpha: dabAlpha(pressure, dyn) };
}

/**
 * Pixel-covering bounds of a dab (1px antialias margin).
 * @param dab - The dab.
 * @returns Rect in document px.
 */
export function dabBounds(dab: Dab): Rect {
  const r = dab.size / 2 + 1;
  return { x: dab.x - r, y: dab.y - r, width: r * 2, height: r * 2 };
}

// ── Stamp falloff ─────────────────────────────────────────────────────────────

/**
 * Radial gradient stops (offset 0..1 from centre, alpha) for a stamp.
 * Hardness 1 keeps a one-pixel antialiased edge.
 *
 * @param hardness - 0 (soft) .. 1 (hard).
 * @param radiusPx - Stamp radius in pixels.
 * @returns Stops, increasing offsets.
 */
export function stampStops(hardness: number, radiusPx: number): Array<[number, number]> {
  const h = Math.min(1, Math.max(0, hardness));
  const aaEdge = radiusPx > 1 ? 1 - 1 / radiusPx : 0;
  const inner = Math.min(h, aaEdge);
  if (inner <= 0) return [[0, 1], [1, 0]];
  return [[0, 1], [inner, 1], [1, 0]];
}
