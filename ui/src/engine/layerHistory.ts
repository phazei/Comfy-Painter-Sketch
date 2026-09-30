/**
 * Applying structural layer history entries ({@link LayersEntry}) to the
 * editor state: the metadata part is the pure `applyLayerChange`
 * (`document/layerList.ts`); this module adds the pixel and runtime side.
 *
 * - A layer that (re)appears gets its stored pixels back (or stays empty) and
 *   is marked dirty so it uploads again (the uploader skips the request when
 *   the content hash matches a file it already knows).
 * - A layer that disappears loses its canvas and runtime entry; its pixels
 *   live on in the entry (counted in `bytes`, so the history cap applies).
 * - Layer ids are stable across delete/undo, so pixel patches recorded for a
 *   layer before it was deleted apply again once it is restored.
 */

import { IMAGE_MASK_ID } from "../document/imageMask";
import { applyLayerChange, isPaintLike, writeProps } from "../document/layerList";
import type { LayerChange } from "../document/layerList";
import { layerMaskKey, maskOwner } from "../document/layerMask";
import type { LayerPixels, LayersEntry } from "./editorTypes";
import type { EditorState } from "./editorState";
import { installMaskSurface, surfaceKeys } from "./layerMask";
import { renderTextLayer } from "./textLayer";

/** Fixed history cost of a structural entry (metadata), bytes. */
export const LAYERS_ENTRY_BASE_BYTES = 256;

/**
 * History cost of a set of changes.
 * @param changes - Changes (only insert/remove carry pixels).
 * @returns Estimated bytes.
 */
export function changesBytes(changes: readonly LayerChange<LayerPixels>[]): number {
  let bytes = LAYERS_ENTRY_BASE_BYTES;
  for (const change of changes) {
    if ((change.op === "insert" || change.op === "remove") && change.pixels) {
      bytes += change.pixels.data.data.byteLength + (change.pixels.mask?.data.byteLength ?? 0);
    }
  }
  return bytes;
}

/**
 * Whole-layer pixels for a history record (with its layer mask, M14), or
 * `null` when the layer never held paint and has no mask (keeps empty
 * layers free in the history budget).
 * @param s - Editor state.
 * @param layerId - Layer id.
 * @returns Pixels at the current bounds origin, or `null`.
 */
export function captureLayerPixels(s: EditorState, layerId: string): LayerPixels | null {
  const masked = s.doc.layers.find((l) => l.id === layerId)?.layerMask !== undefined;
  if (!s.runtime.get(layerId)?.hasContent && !masked) return null;
  const bounds = s.store.bounds;
  const pixels: LayerPixels = { x: bounds.x, y: bounds.y, data: s.store.snapshot(layerId) };
  if (masked) pixels.mask = s.store.snapshot(layerMaskKey(layerId));
  return pixels;
}

/**
 * Give a (re)inserted layer its pixels (and its layer mask's) and fresh
 * runtime bookkeeping.
 * @param s - Editor state.
 * @param layerId - Layer id (already in `doc.layers`).
 * @param pixels - Stored pixels, or `null` for an empty layer.
 */
export function installLayerPixels(s: EditorState, layerId: string, pixels: LayerPixels | null): void {
  const surface = s.store.ensure(layerId);
  surface.ctx.clearRect(0, 0, surface.canvas.width, surface.canvas.height);
  if (pixels) {
    s.ensureBounds({ x: pixels.x, y: pixels.y, width: pixels.data.width, height: pixels.data.height }, false);
    s.store.write(layerId, pixels.x, pixels.y, pixels.data);
  }
  s.runtime.reinstate(layerId, pixels !== null);
  const mask = s.doc.layers.find((l) => l.id === layerId)?.layerMask;
  if (mask) installMaskSurface(s, layerId, mask, pixels?.mask ? { x: pixels.x, y: pixels.y, data: pixels.mask } : null);
}

/**
 * Drop canvases and runtime entries of layers (and layer masks) no longer in the document.
 * @param s - Editor state.
 */
export function releaseRemovedLayers(s: EditorState): void {
  const keep = surfaceKeys(s.doc.layers);
  s.store.retain(keep);
  s.runtime.removeWhere((id) => maskOwner(id) !== null && !keep.has(id));
}

/**
 * Undo (`forward = false`) or redo a structural entry.
 * @param s - Editor state.
 * @param entry - Entry to apply.
 * @param forward - Redo direction.
 */
export function applyLayersEntry(s: EditorState, entry: LayersEntry, forward: boolean): void {
  if (s.stroke.active) s.cancelStroke();
  const changes = forward ? entry.changes : [...entry.changes].reverse();
  for (const change of changes) {
    // The Image Mask row is not in `layers`; only its settings are undoable.
    if (change.op === "props" && change.id === IMAGE_MASK_ID) {
      if (s.doc.imageMask) writeProps(s.doc.imageMask, forward ? change.after : change.before);
      continue;
    }
    if (!applyLayerChange(s.doc.layers, change, forward)) continue;
    if (change.op !== "insert" && change.op !== "remove") continue;
    const appeared = (change.op === "insert") === forward;
    if (appeared) {
      installLayerPixels(s, change.layer.id, change.pixels);
      // A text layer recorded without pixels (created by the text tool) renders from its data.
      const layer = s.doc.layers.find((l) => l.id === change.layer.id);
      if (!change.pixels && layer?.kind === "text") {
        renderTextLayer(s, layer);
        s.runtime.touch(layer.id);
      }
    } else {
      s.runtime.remove(change.layer.id);
    }
  }
  const active = forward ? entry.activeAfter : entry.activeBefore;
  if (s.doc.layers.some((l) => l.id === active && isPaintLike(l))) s.doc.activeLayerId = active;
  releaseRemovedLayers(s);
  emitLayerEvents(s);
}

/**
 * Notify listeners of a layer-list/metadata change (panel, mask indicators).
 * @param s - Editor state.
 */
export function emitLayerEvents(s: EditorState): void {
  s.events.emit("layers", undefined);
  s.events.emit("mask", undefined);
}
