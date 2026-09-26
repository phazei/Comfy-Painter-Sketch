/**
 * Brush math: pressure curve, dab size/alpha, distance-based dab spacing and
 * the stamp profile. Pure (no canvas) so it is unit-testable; `dabMask.ts`
 * accumulates dabs into stroke coverage.
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
  /** Flow: the dab's alpha (times the stamp profile), composited over, 0..1. */
  alpha: number;
  /** Coverage cap (pen pressure -> opacity), 0..1; 1 without pressure opacity. */
  cap: number;
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
 * Per-dab alpha (Photoshop "flow": each dab is composited over at this
 * strength, `dabMask.ts`).
 * @param dyn - Brush dynamics.
 * @returns Flow 0..1.
 */
export function dabAlpha(dyn: BrushDynamics): number {
  return Math.min(1, Math.max(0, dyn.flow));
}

/**
 * Per-dab coverage cap for a pressure (pressure -> opacity): the most the
 * stroke can reach around that dab.
 * @param pressure - 0..1 (normalized).
 * @param dyn - Brush dynamics.
 * @returns Cap 0..1.
 */
export function dabCap(pressure: number, dyn: BrushDynamics): number {
  return dyn.pressureOpacity ? curvePressure(pressure, dyn.gamma) : 1;
}

// ── Spacing ───────────────────────────────────────────────────────────────────

/**
 * Spacing state for a new stroke.
 * @param from - Start the stroke here without a dab (a Shift-click line
 *   continues from where the last stroke ended; its dabs begin one step
 *   in, like Photoshop's), or `null`: the first sample gets a dab.
 * @param residual - Distance already travelled since the last dab (carried
 *   over from the previous stroke so the spacing runs on through the joint).
 * @returns State.
 */
export function createSpacer(from: StrokeSample | null = null, residual = 0): SpacerState {
  return { last: from, residual: from ? Math.max(0, residual) : 0 };
}

/**
 * Place dabs from the previous sample to `next`, evenly spaced by distance
 * (spacing x current diameter), interpolating position and pressure. The
 * first sample of a stroke always produces a dab (unless the spacer was
 * started `from` a point). Mutates `state`.
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
  return { x, y, size: dabSize(pressure, dyn), alpha: dabAlpha(dyn), cap: dabCap(pressure, dyn) };
}

/**
 * Pixel-covering bounds of a dab (2 px margin: antialiasing plus the 1 px
 * minimum fade of {@link stampProfile}).
 * @param dab - The dab.
 * @param reach - Stamp extent as a multiple of the radius ({@link StampProfile.reach}).
 * @returns Rect in document px.
 */
export function dabBounds(dab: Dab, reach = 1): Rect {
  const r = (dab.size / 2) * reach + 2;
  return { x: dab.x - r, y: dab.y - r, width: r * 2, height: r * 2 };
}

// ── Stamp profile ─────────────────────────────────────────────────────────────

/**
 * Where the fade is cut off, in fade widths: `10^(-1.5^2)` = 0.6%. Measured
 * from Photoshop, whose soft dot ends at 1.5 radii.
 */
export const FADE_CUTOFF = 1.5;

/** Stamp shape of one stroke, in units of the dab radius. */
export interface StampProfile {
  /** Solid core radius. */
  core: number;
  /** Width of the fade after the core (at least 1 px). */
  fade: number;
  /** Where the stamp ends: `core + fade x FADE_CUTOFF`. */
  reach: number;
}

/**
 * Stamp profile for a hardness, measured from Photoshop (300 px soft round,
 * 2026-09-25): at 0% hardness the alpha is `10^-(d/R)^2`, a Gaussian that
 * is 10% at the cursor ring (`R`), 50% at 0.55 R and cut off at 1.5 R (fit
 * error under 1/255). Hardness `h` keeps a solid core out to `h R` and
 * squeezes the same fade into the remaining `(1 - h) R` (our interpolation
 * for 0 < h < 1; 100% is a 1 px antialiased edge centred on the ring).
 * The fade is never thinner than 1 px.
 * @param hardness - 0..1.
 * @param radius - Largest dab radius of the stroke, px (for the 1 px floor).
 * @returns Profile in radius units.
 */
export function stampProfile(hardness: number, radius: number): StampProfile {
  const h = Math.min(1, Math.max(0, Number.isFinite(hardness) ? hardness : 0));
  const fade = Math.max(1 - h, 1 / Math.max(1, radius));
  const core = Math.min(h, 1 - fade / 2);
  return { core, fade, reach: core + fade * FADE_CUTOFF };
}

/**
 * How far into the fade the cursor ring sits, in fade widths. Measured in
 * Photoshop at hardness 0: an 80 px brush has a 60 px ring, a 300 px brush
 * a 230 px ring (0.75 / 0.767; the larger one is the more precise). The
 * tip is ~25% opaque there, not 50%.
 */
export const RING_FADE_POSITION = 0.77;

/**
 * Diameter of the brush cursor ring, like Photoshop's default "Normal Brush
 * Tip" cursor: it shrinks as the brush gets softer (the full-size ring is
 * only right for a hard brush). Sits {@link RING_FADE_POSITION} into the
 * fade, never outside the nominal size.
 * @param size - Brush diameter, px.
 * @param hardness - 0..1.
 * @returns Ring diameter, px.
 */
export function ringDiameter(size: number, hardness: number): number {
  const p = stampProfile(hardness, size / 2);
  return size * Math.min(1, p.core + p.fade * RING_FADE_POSITION);
}

/**
 * Stamp alpha at a distance from the dab centre.
 * @param u - Distance in radii (`d / R`).
 * @param profile - Stamp profile ({@link stampProfile}).
 * @returns Alpha 0..1.
 */
export function stampAlpha(u: number, profile: StampProfile): number {
  if (u <= profile.core) return 1;
  const t = (u - profile.core) / profile.fade;
  return t >= FADE_CUTOFF ? 0 : Math.pow(10, -t * t);
}

