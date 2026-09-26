/**
 * Pure helpers for mask layers and the Quick Mask paint target (decisions 5
 * and 6). The target itself is editor UI state (not saved); these functions
 * only resolve which document layer a target refers to.
 */

import { createMaskLayer, DEFAULT_MASK_COLOR, DEFAULT_MASK_STYLE } from "./create";
import type { MaskStyle } from "./create";
import type { Layer, PainterDocument } from "./types";

/** What brush/eraser strokes paint into. */
export type PaintTarget = "paint" | "mask";

/**
 * The mask layer Quick Mask edits: the active layer if it is a mask, else the
 * first (bottom-most) mask layer.
 *
 * @param doc - Document.
 * @returns The mask layer, or `undefined` if the document has none.
 */
export function findMaskLayer(doc: Readonly<PainterDocument>): Layer | undefined {
  const active = doc.layers.find((l) => l.id === doc.activeLayerId);
  if (active?.kind === "mask") return active;
  return doc.layers.find((l) => l.kind === "mask");
}

/**
 * The layer strokes go to when not in Quick Mask: the active layer if it is
 * paint-like (paint, or text -- editing text pixels asks to rasterize it,
 * `engine/rasterize.ts`), else the top-most paint layer.
 *
 * @param doc - Document.
 * @returns The paint layer, or `undefined` if the document has none.
 */
export function findPaintLayer(doc: Readonly<PainterDocument>): Layer | undefined {
  const active = doc.layers.find((l) => l.id === doc.activeLayerId);
  if (active && active.kind !== "mask") return active;
  for (let i = doc.layers.length - 1; i >= 0; i--) {
    const layer = doc.layers[i];
    if (layer?.kind === "paint") return layer;
  }
  return undefined;
}

/**
 * Layer a paint target resolves to.
 *
 * @param doc - Document.
 * @param target - Paint target.
 * @returns The layer, or `undefined` if none of that kind exists.
 */
export function targetLayer(doc: Readonly<PainterDocument>, target: PaintTarget): Layer | undefined {
  return target === "mask" ? findMaskLayer(doc) : findPaintLayer(doc);
}

/**
 * Layer whole-layer edits (the Move tool) act on: the mask under Quick Mask,
 * else the active layer if it is paint-like (paint or text), else the
 * top-most paint layer.
 *
 * @param doc - Document.
 * @param target - Paint target.
 * @returns The layer, or `undefined` if none exists.
 */
export function activeEditLayer(doc: Readonly<PainterDocument>, target: PaintTarget): Layer | undefined {
  if (target === "mask") return findMaskLayer(doc);
  const active = doc.layers.find((l) => l.id === doc.activeLayerId);
  return active && active.kind !== "mask" ? active : findPaintLayer(doc);
}

/**
 * Make sure the document has a mask layer, appending a default one on top of
 * the stack if it has none (documents saved before M2). Mutates `doc`.
 *
 * @param doc - Document to update in place.
 * @param style - Style of a newly created mask (only read when one is created).
 * @returns The mask layer and whether it was just created.
 */
export function ensureMaskLayer(
  doc: PainterDocument,
  style: () => Readonly<MaskStyle> = () => DEFAULT_MASK_STYLE,
): { layer: Layer; created: boolean } {
  const existing = findMaskLayer(doc);
  if (existing) return { layer: existing, created: false };
  const layer = createMaskLayer("Mask", style());
  doc.layers.push(layer);
  return { layer, created: true };
}

/**
 * Display colour of a mask layer, falling back to the default for missing or
 * malformed values (the colour is display-only, so this never needs repair).
 *
 * @param layer - Mask layer.
 * @returns A `#rgb` / `#rrggbb` colour.
 */
export function maskDisplayColor(layer: Pick<Layer, "color">): string {
  const color = layer.color;
  return typeof color === "string" && /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(color) ? color : DEFAULT_MASK_COLOR;
}
