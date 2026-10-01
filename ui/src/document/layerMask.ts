/**
 * Layer masks (SPEC "Layer masks (lmask)"): one optional
 * grayscale mask per PAINT layer that hides part of it non-destructively,
 * in the ComfyUI MASK convention of our mask layers: **white = hidden,
 * black = shown**. Editing masks only: they never reach the MASK outputs.
 *
 * Saved as the additive per-layer manifest field (older documents simply
 * have none, so no version bump):
 *
 *   layerMask?: { file, enabled, invert, outside }
 *
 * - `file`: PNG like mask layers (RGB white, hidden amount in ALPHA),
 *   exactly `bounds` sized like the layer's own file; `null` = every stored
 *   pixel 0 = the whole layer shown (the uploader stores nothing for a
 *   fully transparent canvas).
 * - `enabled`: `false` = ignored (the layer shows unmasked).
 * - `invert`: display / output use `1 - mask` (a setting, not a pixel change).
 * - `outside`: value of the area beyond the stored pixels (the bounds growing
 *   later, or a stale smaller file): `"reveal"` (0, shown) or `"hide"`
 *   (1, hidden).
 *
 * Treat a {@link LayerMask} as immutable: every change replaces the object,
 * so shallow layer copies (duplicate, history records) may share it safely.
 * Reading lives here (lenient, like Python's `nodes/layer_masks.py`).
 */

import type { Layer } from "./types";

/** Value of the mask beyond its stored pixels. */
export type MaskOutside = "reveal" | "hide";

/** The per-layer mask record (`Layer.layerMask`). */
export interface LayerMask {
  /** `"painter-sketch/<name>.png [input]"`, or `null` (all stored pixels 0 = shown). */
  file: string | null;
  enabled: boolean;
  invert: boolean;
  outside: MaskOutside;
}

/** How a new mask starts (row icon: click / with a selection / Alt+click). */
export type MaskFill = "reveal" | "hide" | "selection";

/**
 * Pixel-store key of a layer's mask canvas (never a layer id: layer ids are base36).
 * @param layerId - Owning paint layer id.
 * @returns Store / runtime / patch key of its mask.
 */
export function layerMaskKey(layerId: string): string {
  return `${layerId}\u0000mask`;
}

/**
 * The owning layer id of a mask key.
 * @param key - Store key.
 * @returns Layer id, or `null` when `key` is not a mask key.
 */
export function maskOwner(key: string): string | null {
  return key.endsWith("\u0000mask") ? key.slice(0, -5) : null;
}

/**
 * Whether a layer may get a layer mask (paint layers only; a rasterized text
 * layer is a paint layer).
 * @param layer - Layer.
 * @returns `true` for paint layers.
 */
export function canHaveLayerMask(layer: Pick<Layer, "kind">): boolean {
  return layer.kind === "paint";
}

/**
 * A new mask record (no file yet).
 * @param outside - Value beyond the stored pixels.
 * @returns Record.
 */
export function createLayerMask(outside: MaskOutside): LayerMask {
  return { file: null, enabled: true, invert: false, outside };
}

/**
 * Read a saved `layerMask` value leniently: not an object -> dropped;
 * unusable `file` -> `null`; `enabled` non-boolean -> `true`; `invert`
 * non-boolean -> `false`; `outside` other than `"hide"` -> `"reveal"`.
 * @param value - Saved value (`undefined` = none).
 * @returns The record (absent when missing / dropped) and a repair flag.
 */
export function readLayerMask(value: unknown): { mask?: LayerMask; repaired: boolean } {
  if (value === undefined) return { repaired: false };
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { repaired: true };
  const raw = value as Record<string, unknown>;
  const file = typeof raw["file"] === "string" && raw["file"].trim() ? raw["file"] : null;
  const mask: LayerMask = {
    file,
    enabled: typeof raw["enabled"] === "boolean" ? raw["enabled"] : true,
    invert: raw["invert"] === true,
    outside: raw["outside"] === "hide" ? "hide" : "reveal",
  };
  const repaired =
    (raw["file"] !== null && raw["file"] !== undefined && file === null) ||
    typeof raw["enabled"] !== "boolean" ||
    typeof raw["invert"] !== "boolean" ||
    (raw["outside"] !== "hide" && raw["outside"] !== "reveal");
  return { mask, repaired };
}

/**
 * Manifest form (stable key order).
 * @param mask - Record.
 * @returns Plain object for `layerMask`.
 */
export function serializeLayerMask(mask: Readonly<LayerMask>): Record<string, unknown> {
  return { file: mask.file, enabled: mask.enabled, invert: mask.invert, outside: mask.outside };
}
