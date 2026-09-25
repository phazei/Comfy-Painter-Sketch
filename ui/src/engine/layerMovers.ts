/**
 * Per-layer-kind "move this layer by (dx, dy)" handlers: the seam between the
 * Move tool (`moveOps.ts`) and how a kind stores its content (SPEC M6a).
 *
 * - `paint` / `mask`: translate pixels (`layerTranslate.ts`).
 * - `text` (M6b): shift `textData`'s anchor and re-render the layer,
 *   recording a text undo entry (`textLayer.ts`); never rasterizes.
 *   Kinds without a handler can't be moved (the tool shows
 *   {@link UNMOVABLE_LAYER_NOTE}).
 *
 * The live drag preview is kind-agnostic: the layer canvas is drawn offset
 * (`EditorState.movePreview`), so handlers only run on commit / nudge.
 */

import type { Layer, LayerKind } from "../document/types";
import type { EditorState } from "./editorState";
import { translateLayerPixels } from "./layerTranslate";
import { moveTextLayer } from "./textLayer";

/** Moves one kind of layer. */
export interface LayerMover {
  /**
   * Move a layer's content and record ONE undo entry (or merge into the
   * newest one when `gesture` matches, e.g. consecutive arrow nudges).
   * Lock / visibility are already checked; the caller emits edit events.
   * @param s - Editor state.
   * @param layer - Layer to move (in `s.doc.layers`).
   * @param dx - X shift, whole document px.
   * @param dy - Y shift, whole document px.
   * @param gesture - Merge key, or `undefined` for a separate entry.
   * @returns `true` if anything changed (and was recorded).
   */
  move(s: EditorState, layer: Layer, dx: number, dy: number, gesture?: string): boolean;
}

/** Pixel translation for raster kinds. */
const pixelMover: LayerMover = {
  move: (s, layer, dx, dy, gesture) => translateLayerPixels(s, layer.id, dx, dy, gesture),
};

/** Anchor move + re-render for text layers. */
const textMover: LayerMover = {
  move: (s, layer, dx, dy, gesture) => moveTextLayer(s, layer, dx, dy, gesture),
};

/** Handlers by kind. */
const MOVERS: Readonly<Partial<Record<LayerKind, LayerMover>>> = {
  paint: pixelMover,
  mask: pixelMover,
  text: textMover,
};

/** Note for layer kinds without a move handler. */
export const UNMOVABLE_LAYER_NOTE = "This layer can't be moved.";

/**
 * The move handler for a layer.
 * @param layer - Layer.
 * @returns Handler, or `undefined` when the kind can't be moved.
 */
export function moverFor(layer: Pick<Layer, "kind">): LayerMover | undefined {
  return MOVERS[layer.kind];
}
