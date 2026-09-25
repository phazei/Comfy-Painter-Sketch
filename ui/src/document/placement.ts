/**
 * Move-tool placement values (SPEC "Saved-file contract", Placement): the
 * identity, the scale clamp and lenient validation. Mirrors
 * `nodes/document.py::parse_placement`. The mapping math lives in
 * `engine/frameMap.ts` (composed into the frame map) and the interaction
 * math in `engine/placementOps.ts`. Pure.
 */

import type { Placement } from "./types";

/** Smallest placement scale. */
export const PLACEMENT_MIN_SCALE = 0.05;

/** Largest placement scale. */
export const PLACEMENT_MAX_SCALE = 20;

/** No move, no scale. */
export const IDENTITY_PLACEMENT: Readonly<Placement> = Object.freeze({ x: 0, y: 0, scale: 1 });

/**
 * Clamp a scale into [{@link PLACEMENT_MIN_SCALE}, {@link PLACEMENT_MAX_SCALE}].
 * @param scale - Candidate scale (non-finite -> 1).
 * @returns Valid scale.
 */
export function clampPlacementScale(scale: number): number {
  if (!Number.isFinite(scale)) return 1;
  return Math.min(PLACEMENT_MAX_SCALE, Math.max(PLACEMENT_MIN_SCALE, scale));
}

/**
 * Whether a placement is the identity (missing counts as identity).
 * @param p - Placement or `undefined`.
 * @returns `true` for no move / no scale.
 */
export function isIdentityPlacement(p: Readonly<Placement> | undefined): boolean {
  return !p || (p.x === 0 && p.y === 0 && p.scale === 1);
}

/**
 * Valid copy of a placement: non-finite x/y -> 0, scale clamped.
 * @param p - Candidate.
 * @returns Normalized placement.
 */
export function normalizePlacement(p: Readonly<Placement>): Placement {
  return {
    x: Number.isFinite(p.x) ? p.x : 0,
    y: Number.isFinite(p.y) ? p.y : 0,
    scale: clampPlacementScale(p.scale),
  };
}

/**
 * Lenient read of a stored `placement` value (never fails).
 * @param value - Raw manifest value.
 * @returns The placement (`undefined` = identity) and whether a present value had to be changed.
 */
export function readPlacement(value: unknown): { placement: Placement | undefined; repaired: boolean } {
  if (value === undefined) return { placement: undefined, repaired: false };
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { placement: undefined, repaired: true };
  const raw = value as Record<string, unknown>;
  const num = (v: unknown, fallback: number): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
  const placement = normalizePlacement({ x: num(raw["x"], 0), y: num(raw["y"], 0), scale: num(raw["scale"], 1) });
  const repaired = placement.x !== raw["x"] || placement.y !== raw["y"] || placement.scale !== raw["scale"];
  return { placement: isIdentityPlacement(placement) ? undefined : placement, repaired };
}
