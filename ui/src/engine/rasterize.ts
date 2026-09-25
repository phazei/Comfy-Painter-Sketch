/**
 * The one gate every pixel-editing operation passes before it modifies a
 * layer (brush / eraser / shapes via `paintOps.ts`, bucket via
 * `pixelOps.ts`, selection fill / clear via `selectionOps.ts`): lock and
 * visibility notes, and -- for text layers -- the rasterize prompt (SPEC M6b).
 *
 * Rasterizing turns the layer into a paint layer (drops `textData`; the
 * pixels already hold the rendered text) as a text history entry, and asks
 * the history to join the next edit of that layer into the same undo step,
 * so ONE Ctrl+Z restores the editable text. Pointer-driven strokes abort
 * the press that raised the prompt (the button state is unknown after a
 * modal dialog); the user's next stroke on the layer joins the rasterize
 * step. Moving a text layer never rasterizes (`textLayer.ts` moves it).
 */

import type { Layer } from "../document/types";
import { HIDDEN_LAYER_NOTE, HIDDEN_MASK_NOTE, LOCKED_LAYER_NOTE } from "./editorTypes";
import type { HistoryEntry } from "./editorTypes";
import type { EditorState } from "./editorState";
import { recordTextChange, textStateOf } from "./textLayer";

/** Confirm text shown before a text layer is rasterized. */
export const RASTERIZE_PROMPT = "Rasterize text layer? It will no longer be editable as text.";

/** What a pixel edit on a layer should do (pure part of the guard). */
export type RasterizeDecision =
  /** Not a text layer: edit directly. */
  | "edit"
  /** Text layer, user agreed: rasterize, then edit. */
  | "rasterize"
  /** Text layer, user declined: abort the action. */
  | "cancel";

/**
 * Decide how a pixel edit proceeds on a layer. `confirm` is only called for
 * text layers.
 * @param layer - Target layer.
 * @param confirm - Asks the user (returns `true` for OK).
 * @returns Decision.
 */
export function rasterizeDecision(layer: Pick<Layer, "kind">, confirm: () => boolean): RasterizeDecision {
  if (layer.kind !== "text") return "edit";
  return confirm() ? "rasterize" : "cancel";
}

/** How the caller continues after {@link preparePixelEdit}. */
export type PixelEditPlan = "proceed" | "blocked" | "rasterized";

/**
 * Gate a pixel edit on `layer`: notes for locked / hidden layers, the
 * rasterize prompt for text layers.
 * @param s - Editor state.
 * @param layer - Layer about to be modified.
 * @returns `"proceed"` (edit now), `"blocked"` (abort; note or Cancel shown),
 *   or `"rasterized"` (the layer is paint now; the next edit on it joins
 *   the rasterize undo step -- synchronous callers may proceed right away).
 */
export function preparePixelEdit(s: EditorState, layer: Layer): PixelEditPlan {
  if (layer.locked) {
    s.events.emit("note", LOCKED_LAYER_NOTE);
    return "blocked";
  }
  if (!layer.visible) {
    s.events.emit("note", layer.kind === "mask" ? HIDDEN_MASK_NOTE : HIDDEN_LAYER_NOTE);
    return "blocked";
  }
  const decision = rasterizeDecision(layer, () => s.confirmRasterize());
  if (decision === "cancel") return "blocked";
  if (decision === "edit") return "proceed";
  rasterizeLayer(s, layer);
  return "rasterized";
}

/**
 * Convert a text layer to paint as one text entry, and join the next entry
 * that edits this layer into it.
 * @param s - Editor state.
 * @param layer - Text layer.
 */
export function rasterizeLayer(s: EditorState, layer: Layer): void {
  const before = textStateOf(layer);
  layer.kind = "paint";
  delete layer.textData;
  recordTextChange(s, layer.id, before, textStateOf(layer));
  s.history.joinNext((entry) => entryLayerId(entry) === layer.id);
  s.events.emit("layers", undefined);
  s.events.emit("change", undefined);
  s.events.emit("history", undefined);
}

/** Layer a single-layer pixel entry edits, if any. */
function entryLayerId(entry: HistoryEntry): string | null {
  return entry.kind === "patch" || entry.kind === "translate" || entry.kind === "text" ? entry.layerId : null;
}
