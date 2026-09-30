/**
 * Flip H / V of a whole layer without a selection or a transform session
 * (SPEC M11 "Transform button and flips"): the current edit layer's content
 * is mirrored about its content centre -- an exact pixel mirror inside the
 * content bbox, so the bounds never change -- as ONE patch undo step. The
 * pixel-edit gate runs first (lock / hidden notes, text rasterize prompt).
 * With a float (or a selection, lifted first) the float gets an exact
 * mirror matrix and stays floating ({@link flipOutsideSession}). A layer's
 * lmask mirrors with it (M14b, `layerMaskCarry.flipMaskPatch`); a selection
 * flip follows the target like any float (pixels or the lmask's pixels).
 */

import { activeEditLayer } from "../document/masks";
import { isEmptyRect } from "../geometry/rect";
import type { EditorState } from "./editorState";
import { flipMaskPatch } from "./layerMaskCarry";
import { layerContentRect } from "./layerTranslate";
import { preparePixelEdit } from "./rasterize";
import type { FloatOps } from "./floatOps";
import { mirrorAbout, multiply, transformedAabb } from "./transformMath";
import { flipRgba } from "./transformResample";

/** Note when there is nothing to flip or transform. */
export const EMPTY_LAYER_NOTE = "The layer is empty.";

/**
 * Mirror the current edit layer's content (one undo step).
 * @param s - Editor state.
 * @param axis - `"h"` mirrors left/right, `"v"` top/bottom.
 * @returns `true` if pixels changed.
 */
export function flipLayer(s: EditorState, axis: "h" | "v"): boolean {
  const layer = activeEditLayer(s.doc, s.target, s.currentMaskId);
  if (!layer || preparePixelEdit(s, layer, "whole") === "blocked") return false;
  const rect = layerContentRect(s, layer.id);
  const before = isEmptyRect(rect) ? null : s.store.read(layer.id, rect);
  if (!before) {
    s.events.emit("note", EMPTY_LAYER_NOTE);
    return false;
  }
  const { width, height } = before.rect;
  const flipped = flipRgba(before.data.data, width, height, axis);
  s.store.write(layer.id, before.rect.x, before.rect.y, new ImageData(flipped, width, height));
  // Re-read so the patch holds exactly what the canvas stores.
  const after = s.store.read(layer.id, before.rect);
  if (after) {
    const bytes = before.data.data.byteLength + after.data.data.byteLength;
    s.history.push({ kind: "patch", layerId: layer.id, x: before.rect.x, y: before.rect.y, before: before.data, after: after.data, bytes });
  }
  s.runtime.touch(layer.id);
  // The lmask mirrors with its layer, same centre, same step (M14b).
  const maskPatch = flipMaskPatch(s, layer, before.rect, axis);
  if (maskPatch) {
    if (after) s.history.joinNext();
    s.history.push(maskPatch);
  }
  s.afterEdit();
  return true;
}

/**
 * Flip H / V outside a transform session: mirror a float (lifting the
 * selection first) as a still-floating exact mirror; else the whole current
 * layer ({@link flipLayer}).
 * @param s - Editor state.
 * @param float - The editor's float commands.
 * @param axis - `"h"` or `"v"`.
 * @returns `true` if something flipped.
 */
export function flipOutsideSession(s: EditorState, float: FloatOps, axis: "h" | "v"): boolean {
  if (s.loading || s.stroke.active) return false;
  if (!float.active && !s.selection.current) return flipLayer(s, axis);
  if (!float.active && !float.lift(false)) return false;
  const f = float.state;
  const m = float.matrix();
  if (!f || !m) return false;
  const r = transformedAabb(m, f.area.width, f.area.height);
  const next = multiply(mirrorAbout(axis, { x: r.x + r.width / 2, y: r.y + r.height / 2 }), m);
  float.setTransform(next, float.selectionAt(next));
  float.bake();
  s.events.emit("transform", undefined);
  return true;
}
