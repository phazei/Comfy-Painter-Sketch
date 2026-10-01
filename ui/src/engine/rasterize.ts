/**
 * The one gate every pixel-editing operation passes before it modifies a
 * layer (brush / eraser / shapes via `paintOps.ts`, bucket via
 * `pixelOps.ts`, selection fill / clear via `selectionOps.ts`): lock and
 * visibility notes, the Image Mask refusal (it is never edited), and
 * -- for text layers -- the rasterize prompt (SPEC "Layers" > "The edit gate").
 *
 * Rasterizing turns the layer into a paint layer (drops `textData`; the
 * pixels already hold the rendered text) as a text history entry, and asks
 * the history to join the next edit of that layer into the same undo step,
 * so ONE Ctrl+Z restores the editable text. Pointer-driven strokes abort
 * the press that raised the prompt (the button state is unknown after a
 * modal dialog); the user's next stroke on the layer joins the rasterize
 * step. Moving a text layer never rasterizes (`textLayer.ts` moves it).
 */

import { IMAGE_MASK_ID } from "../document/imageMask";
import type { Layer } from "../document/types";
import { HIDDEN_LAYER_NOTE, HIDDEN_MASK_NOTE, imageMaskNote, LOCKED_LAYER_NOTE, SOLO_HIDDEN_NOTE } from "./editorTypes";
import { editsViewedMask, layerMaskBlockNote } from "./layerMask";
import type { EditKind } from "./layerMask";
import { shownOnStage } from "./solo";
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
 * Why `layer` can't be edited right now, or `null`. The Image Mask / Input Mask row
 * never is. Order otherwise: hidden (eye) > hidden by another layer's
 * solo > locked -- showing it is the first fix. A soloed layer with its eye
 * off stays blocked (eye state wins). Exception: in the lmask-only
 * view, the viewed layer's targeted mask is editable while the layer is
 * hidden (`editsViewedMask`); lock still refuses.
 * Layer masks (`layerMask.ts`) come last: other pixel tools refuse on
 * a targeted mask (`kind: "other"`); whole-layer operations (`kind:
 * "whole"`) carry the mask and never get the lmask-only view exception.
 * @param s - Editor state (solos).
 * @param layer - Layer to edit.
 * @param kind - What the edit is (default: a mask-aware pixel edit).
 * @returns Note text, or `null` if editing is allowed.
 */
export function editBlockNote(s: EditorState, layer: Layer, kind: EditKind = "paint"): string | null {
  if (layer.id === IMAGE_MASK_ID) return imageMaskNote(layer.name);
  // The lmask-only view edits its mask even with the layer hidden; lock still refuses.
  const viewedMask = kind !== "whole" && editsViewedMask(s, layer);
  const hidden = viewedMask ? null : hiddenNote(s, layer);
  if (hidden) return hidden;
  const maskNote = layerMaskBlockNote(s, layer, kind);
  if (maskNote) return maskNote;
  if (layer.locked) return LOCKED_LAYER_NOTE;
  return null;
}

/**
 * The hidden part of {@link editBlockNote}: eye off (masks, incl. the Image
 * Mask row, get the mask note), else hidden by another layer's solo. Also
 * used on its own by sampling "Current layer" (magic wand), which edits
 * nothing but must not read a layer the user can't see.
 * @param s - Editor state (solos).
 * @param layer - Layer (paint, text, mask or the Image Mask row).
 * @returns Note text, or `null` when the layer is shown.
 */
export function hiddenNote(s: EditorState, layer: Layer): string | null {
  if (!layer.visible) return layer.kind === "mask" ? HIDDEN_MASK_NOTE : HIDDEN_LAYER_NOTE;
  if (!shownOnStage(layer, s.solo.current)) return SOLO_HIDDEN_NOTE;
  return null;
}

/**
 * Gate a pixel edit on `layer`: notes for locked / hidden layers, the
 * rasterize prompt for text layers.
 * @param s - Editor state.
 * @param layer - Layer about to be modified.
 * @param kind - What the edit is ({@link editBlockNote}).
 * @returns `"proceed"` (edit now), `"blocked"` (abort; note or Cancel shown),
 *   or `"rasterized"` (the layer is paint now; the next edit on it joins
 *   the rasterize undo step -- synchronous callers may proceed right away).
 */
export function preparePixelEdit(s: EditorState, layer: Layer, kind: EditKind = "paint"): PixelEditPlan {
  // A floating selection lands before any other pixel edit.
  s.settleFloat();
  const note = editBlockNote(s, layer, kind);
  if (note) {
    s.events.emit("note", note);
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
