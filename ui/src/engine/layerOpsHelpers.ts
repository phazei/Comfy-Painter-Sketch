/**
 * Shared helper functions for {@link LayerOps} structural commands
 * (engine-internal; not part of the public Editor API).
 *
 * Extracted from `layerOps.ts` so each module stays well under 350 lines.
 * All functions take an {@link EditorState} as their first argument; none
 * touch the DOM or UI layer.
 */

import {
  propsDiffer,
  propsEqual,
  readProps,
  writeProps,
} from "../document/layerList";
import type { LayerChange, LayerProps } from "../document/layerList";
import { findAnyLayer } from "../document/imageMask";
import type { Layer } from "../document/types";
import type { LayerPixels } from "./editorTypes";
import type { EditorState } from "./editorState";
import {
  changesBytes,
  emitLayerEvents,
  installLayerPixels,
} from "./layerHistory";

// ═══════════════════════════════════════════════════════════════════════════
// Helpers (used by LayerOps; not exported from engine/index or Editor)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Find a layer by id in the document, including the Image Mask row
 * (its eye, colour, invert and opacity edit like a mask's).
 * @param s - Shared editor state.
 * @param layerId - Layer id or `IMAGE_MASK_ID`.
 * @returns The layer, or `undefined` if not found.
 */
export function findLayer(s: EditorState, layerId: string): Layer | undefined {
  return findAnyLayer(s.doc, layerId);
}

/**
 * Check whether structural (undoable) edits may proceed: waits for any
 * in-progress restore to finish and cancels an active stroke.
 * @param s - Shared editor state.
 * @returns `true` if edits are allowed.
 */
export function readyCheck(s: EditorState): boolean {
  if (s.loading) return false;
  s.settleFloat();
  if (s.stroke.active) s.cancelStroke();
  return true;
}

/**
 * Insert `layer` at `index`, optionally install pixels, and record the undo entry.
 * @param s - Shared editor state.
 * @param layer - Layer to insert (not yet in the document).
 * @param index - Target position.
 * @param pixels - Pre-captured pixels, or `null` for an empty layer.
 * @param activate - Whether to make the new layer active (default `true`).
 */
export function insertLayer(
  s: EditorState,
  layer: Layer,
  index: number,
  pixels: LayerPixels | null,
  activate = true,
): void {
  const activeBefore = s.doc.activeLayerId;
  s.doc.layers.splice(index, 0, layer);
  installLayerPixels(s, layer.id, pixels);
  if (activate) s.doc.activeLayerId = layer.id;
  recordLayerChange(s, [{ op: "insert", index, layer: { ...layer }, pixels }], activeBefore);
}

/**
 * Merge-aware property setter for one layer. Records a `props` history entry
 * (or merges into the previous gesture step).
 * @param s - Shared editor state.
 * @param layerId - Layer id.
 * @param props - Props to change.
 * @param gesture - Gesture key for merge (same key = same scrub).
 * @returns `true` if any prop changed.
 */
export function setLayerProps(
  s: EditorState,
  layerId: string,
  props: LayerProps,
  gesture?: string,
): boolean {
  const layer = findLayer(s, layerId);
  if (!layer || s.loading || !propsDiffer(layer, props)) return false;
  s.settleFloat();
  const merge = gesture ? s.history.mergeTarget() : undefined;
  const change = merge?.kind === "layers" && merge.gesture === gesture ? merge.changes[0] : undefined;
  if (change?.op === "props" && change.id === layerId && sameKeys(change.after, props)) {
    Object.assign(change.after, props);
    writeProps(layer, props);
    // The gesture came back to where it started (picker Esc, scrub back):
    // drop the entry so no empty undo step remains.
    if (merge?.kind === "layers" && merge.changes.length === 1 && propsEqual(change.before, change.after)) {
      s.history.discardNewest();
    }
    afterMetaChange(s, true);
    return true;
  }
  const before = readProps(layer, props);
  writeProps(layer, props);
  recordLayerChange(s, [{ op: "props", id: layerId, before, after: { ...props } }], s.doc.activeLayerId, gesture);
  return true;
}

/**
 * Push a `layers` history entry and fire metadata events.
 * @param s - Shared editor state.
 * @param changes - Ordered list of reversible changes.
 * @param activeBefore - Active layer id before the operation.
 * @param gesture - Optional gesture key for merge.
 */
export function recordLayerChange(
  s: EditorState,
  changes: LayerChange<LayerPixels>[],
  activeBefore: string,
  gesture?: string,
): void {
  s.history.push({
    kind: "layers",
    changes,
    activeBefore,
    activeAfter: s.doc.activeLayerId,
    bytes: changesBytes(changes),
    ...(gesture ? { gesture } : {}),
  });
  afterMetaChange(s, true);
}

/**
 * Fire events after a metadata-only change; also fires `history` when a new
 * history entry was recorded.
 * @param s - Shared editor state.
 * @param history - `true` if a history entry was just pushed or merged.
 */
export function afterMetaChange(s: EditorState, history = false): void {
  if (history) s.events.emit("history", undefined);
  emitLayerEvents(s);
  s.events.emit("change", undefined);
  s.events.emit("render", undefined);
}

/**
 * True when `a` and `b` have the same set of keys (order-independent).
 * @param a - First props object.
 * @param b - Second props object.
 * @returns `true` if the key sets match.
 */
export function sameKeys(a: LayerProps, b: LayerProps): boolean {
  const ka = Object.keys(a).sort().join();
  return ka === Object.keys(b).sort().join();
}
