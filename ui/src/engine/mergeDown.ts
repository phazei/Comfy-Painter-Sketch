/**
 * Merge Down (Ctrl+E, SPEC M10a), exposed as `Editor.mergeDown`: merge the
 * current row (the active paint-like layer, or the current mask under Quick
 * Mask) into the next row below it in the same group -- paint/text into
 * paint-like, mask into mask; never into the background (not a layer).
 *
 * - The lower row keeps its name and settings. Paint: the upper layer is
 *   drawn onto the lower one source-over with its opacity baked in. Masks:
 *   coverage = union (max) of both masks' effective coverage (each invert
 *   applied), stored under the lower mask's invert (`floatMath.mergeMaskCoverage`).
 * - Text rows are rasterized first (the usual prompt, `rasterize.ts`).
 * - Refused with a note when either row is hidden (eye or solo) or locked,
 *   or nothing mergeable is below.
 * - ONE undo step: a group entry `[rasterize..., patch on lower, remove upper]`.
 *   A solo on the removed layer ends (the `layers` event prunes it).
 */

import { isPaintLike } from "../document/layerList";
import { activeEditLayer } from "../document/masks";
import type { Layer } from "../document/types";
import { intersectRect, isEmptyRect } from "../geometry/rect";
import type { Rect } from "../geometry/rect";
import type { HistoryEntry, LayersEntry } from "./editorTypes";
import type { EditorState } from "./editorState";
import { compositeOver, mergeMaskCoverage } from "./floatMath";
import { captureLayerPixels, changesBytes, emitLayerEvents, releaseRemovedLayers } from "./layerHistory";
import { readyCheck } from "./layerOpsHelpers";
import { layerContentRect } from "./layerTranslate";
import { editBlockNote, preparePixelEdit } from "./rasterize";

/** Note when there is no row to merge into. */
export const MERGE_NOTHING_NOTE = "Nothing to merge down into.";

/**
 * Merge the current row into the row below it.
 * @param s - Editor state.
 * @returns `true` if the layers were merged.
 */
export function mergeDown(s: EditorState): boolean {
  if (!readyCheck(s)) return false;
  const upper = activeEditLayer(s.doc, s.target, s.currentMaskId);
  if (!upper) return false;
  const index = s.doc.layers.indexOf(upper);
  const lower = s.doc.layers[index - 1];
  if (!lower || isPaintLike(lower) !== isPaintLike(upper)) {
    s.events.emit("note", MERGE_NOTHING_NOTE);
    return false;
  }
  const note = editBlockNote(s, upper) ?? editBlockNote(s, lower);
  if (note) {
    s.events.emit("note", note);
    return false;
  }
  const depth = s.history.undoDepth;
  if (preparePixelEdit(s, upper) === "blocked" || preparePixelEdit(s, lower) === "blocked") {
    return false;
  }
  // Rasterize steps pushed just now become part of the merge step.
  const entries: HistoryEntry[] = [];
  while (s.history.undoDepth > depth) {
    const entry = s.history.discardNewest();
    if (entry) entries.unshift(entry);
  }
  const patch = mergePixels(s, upper, lower);
  if (patch) entries.push(patch);
  entries.push(removeUpper(s, upper, lower, index));
  s.history.push({ kind: "group", entries, bytes: entries.reduce((n, e) => n + e.bytes, 0) });
  s.runtime.touch(lower.id);
  emitLayerEvents(s);
  s.afterEdit();
  return true;
}

/** Draw `upper` into `lower`; returns the patch entry, or `null` if nothing changed. */
function mergePixels(s: EditorState, upper: Layer, lower: Layer): HistoryEntry | null {
  const bounds = s.store.bounds;
  const rect: Rect = upper.kind === "mask" && upper.invert === true ? bounds : intersectRect(layerContentRect(s, upper.id), bounds);
  if (isEmptyRect(rect)) return null;
  const up = s.store.read(upper.id, rect);
  const before = s.store.read(lower.id, rect);
  if (!up || !before) return null;
  const r = before.rect;
  const next = new Uint8ClampedArray(before.data.data);
  if (upper.kind === "mask") {
    mergeMaskCoverage(up.data.data, upper.invert === true, next, lower.invert === true);
  } else {
    compositeOver(next, r.width, r.height, up.data.data, r.width, r.height, 0, 0, upper.opacity);
  }
  s.store.write(lower.id, r.x, r.y, new ImageData(next, r.width, r.height));
  const after = s.store.read(lower.id, r);
  if (!after) return null;
  const bytes = before.data.data.byteLength + after.data.data.byteLength;
  return { kind: "patch", layerId: lower.id, x: r.x, y: r.y, before: before.data, after: after.data, bytes };
}

/** Remove the merged upper row; the lower row becomes active / current. */
function removeUpper(s: EditorState, upper: Layer, lower: Layer, index: number): LayersEntry {
  const activeBefore = s.doc.activeLayerId;
  const pixels = captureLayerPixels(s, upper.id);
  s.doc.layers.splice(index, 1);
  s.runtime.remove(upper.id);
  releaseRemovedLayers(s);
  if (activeBefore === upper.id) s.doc.activeLayerId = lower.id;
  if (upper.kind === "mask") s.currentMaskId = lower.id;
  const changes: LayersEntry["changes"] = [{ op: "remove", index, layer: { ...upper }, pixels }];
  return { kind: "layers", changes, activeBefore, activeAfter: s.doc.activeLayerId, bytes: changesBytes(changes) };
}
