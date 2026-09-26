/**
 * Pure helpers for mask layers and the Quick Mask paint target (decisions 5
 * and 6). The target itself is editor UI state (not saved); these functions
 * only resolve which document layer a target refers to.
 */

import { createMaskLayer, DEFAULT_MASK_COLOR, DEFAULT_MASK_STYLE, FIRST_MASK_NAME } from "./create";
import type { MaskStyle } from "./create";
import type { Layer, PainterDocument } from "./types";

/** What brush/eraser strokes paint into. */
export type PaintTarget = "paint" | "mask";

/**
 * The current mask (M8): the mask Quick Mask edits. It is the last selected
 * mask row (`currentMaskId`, editor UI state); if that mask no longer exists
 * (deleted, undone) the top-most mask is used instead.
 *
 * @param doc - Document.
 * @param currentMaskId - Last selected mask id (`null`/`undefined` = none yet).
 * @returns The mask layer, or `undefined` if the document has none.
 */
export function findMaskLayer(doc: Readonly<PainterDocument>, currentMaskId?: string | null): Layer | undefined {
  if (currentMaskId) {
    const current = doc.layers.find((l) => l.id === currentMaskId);
    if (current?.kind === "mask") return current;
  }
  for (let i = doc.layers.length - 1; i >= 0; i--) {
    const layer = doc.layers[i];
    if (layer?.kind === "mask") return layer;
  }
  return undefined;
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
 * @param currentMaskId - Current mask id ({@link findMaskLayer}).
 * @returns The layer, or `undefined` if none of that kind exists.
 */
export function targetLayer(
  doc: Readonly<PainterDocument>,
  target: PaintTarget,
  currentMaskId?: string | null,
): Layer | undefined {
  return target === "mask" ? findMaskLayer(doc, currentMaskId) : findPaintLayer(doc);
}

/**
 * Layer whole-layer edits (the Move tool) act on: the mask under Quick Mask,
 * else the active layer if it is paint-like (paint or text), else the
 * top-most paint layer.
 *
 * @param doc - Document.
 * @param target - Paint target.
 * @param currentMaskId - Current mask id ({@link findMaskLayer}).
 * @returns The layer, or `undefined` if none exists.
 */
export function activeEditLayer(
  doc: Readonly<PainterDocument>,
  target: PaintTarget,
  currentMaskId?: string | null,
): Layer | undefined {
  if (target === "mask") return findMaskLayer(doc, currentMaskId);
  const active = doc.layers.find((l) => l.id === doc.activeLayerId);
  return active && active.kind !== "mask" ? active : findPaintLayer(doc);
}

/**
 * Make sure the document has a mask layer, appending a default one on top of
 * the stack if it has none (documents saved before M2). Mutates `doc`.
 *
 * @param doc - Document to update in place.
 * @param style - Style of a newly created mask (only read when one is created).
 * @param currentMaskId - Current mask id ({@link findMaskLayer}).
 * @returns The current mask layer and whether it was just created.
 */
export function ensureMaskLayer(
  doc: PainterDocument,
  style: () => Readonly<MaskStyle> = () => DEFAULT_MASK_STYLE,
  currentMaskId?: string | null,
): { layer: Layer; created: boolean } {
  const existing = findMaskLayer(doc, currentMaskId);
  if (existing) return { layer: existing, created: false };
  const layer = createMaskLayer(FIRST_MASK_NAME, style());
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
