/**
 * Layer picking for the Move tool's auto-select (Photoshop: Ctrl+click with
 * Move, or the "Auto-select" option): which layer's pixel is under the
 * pointer. Pure -- the pixel lookup is injected as an alpha sampler, so the
 * rule is unit-testable without a canvas.
 */

import type { Layer } from "../document/types";

/** Pixels with alpha at or below this (0..255) don't count as a hit. */
export const PICK_ALPHA_THRESHOLD = 10;

/** The layer fields the pick rule looks at. */
export type PickCandidate = Pick<Layer, "id" | "kind" | "visible" | "locked">;

/**
 * Alpha (0..255) of a layer's pixel at the pick point; 0 outside its pixels.
 * @param layerId - Layer id.
 * @returns Alpha 0..255.
 */
export type AlphaSampler = (layerId: string) => number;

/**
 * The topmost pickable layer with a visible pixel at the pick point:
 * visible, not locked, kind `paint` or `text`, alpha > `threshold`.
 * @param layers - Document layers, bottom -> top.
 * @param alphaAt - Alpha sampler for the pick point (only called for pickable layers).
 * @param threshold - Alpha that must be exceeded (default {@link PICK_ALPHA_THRESHOLD}).
 * @returns The picked layer id, or `null` if nothing is hit.
 */
export function pickLayer(
  layers: readonly PickCandidate[],
  alphaAt: AlphaSampler,
  threshold: number = PICK_ALPHA_THRESHOLD,
): string | null {
  for (let i = layers.length - 1; i >= 0; i--) {
    const layer = layers[i];
    if (!layer || !layer.visible || layer.locked) continue;
    if (layer.kind !== "paint" && layer.kind !== "text") continue;
    if (alphaAt(layer.id) > threshold) return layer.id;
  }
  return null;
}
