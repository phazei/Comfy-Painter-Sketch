/**
 * Pure layer-list operations on a document's `layers` array (bottom -> top,
 * SPEC "Document Model"): where new layers go, "Layer N" naming, reorder
 * constraints, and the reversible {@link LayerChange} records the editor's
 * structural undo entries are made of.
 *
 * Constraints (v1 UI, decision 5): mask layers stay above every paint layer,
 * paint layers only reorder among paint layers, the last paint layer cannot
 * be deleted, and mask layers are not added/deleted/duplicated from the
 * panel. Pixels are opaque here (`P`), so everything is unit-testable.
 */

import type { Layer, PainterDocument } from "./types";

// ── Types ─────────────────────────────────────────────────────────────────────

/** Layer fields changed by undoable property edits. */
export type LayerProps = Partial<Pick<Layer, "name" | "opacity" | "color" | "invert">>;

/** Keys of {@link LayerProps}. */
const PROP_KEYS = ["name", "opacity", "color", "invert"] as const;

/**
 * One reversible change to the layer list. `insert`/`remove` carry the layer
 * (metadata copy) and its pixels (`null` = empty) so either direction can
 * recreate it.
 */
export type LayerChange<P> =
  | { op: "insert"; index: number; layer: Layer; pixels: P | null }
  | { op: "remove"; index: number; layer: Layer; pixels: P | null }
  | { op: "move"; id: string; from: number; to: number }
  | { op: "props"; id: string; before: LayerProps; after: LayerProps };

// ── Queries ───────────────────────────────────────────────────────────────────

/**
 * Whether a layer is part of the paint stack (paint or text, not mask).
 * @param layer - Layer.
 * @returns `true` for paint-like layers.
 */
export function isPaintLike(layer: Pick<Layer, "kind">): boolean {
  return layer.kind !== "mask";
}

/**
 * Number of paint-like layers.
 * @param layers - Layer list.
 * @returns Count.
 */
export function paintLayerCount(layers: readonly Layer[]): number {
  let n = 0;
  for (const layer of layers) if (isPaintLike(layer)) n++;
  return n;
}

/**
 * Next free "Layer N" name: one above the highest existing N (Photoshop).
 * @param layers - Layer list.
 * @returns E.g. `"Layer 3"`.
 */
export function nextLayerName(layers: readonly Pick<Layer, "name">[]): string {
  let max = 0;
  for (const layer of layers) {
    const match = /^Layer (\d+)$/.exec(layer.name.trim());
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `Layer ${max + 1}`;
}

/**
 * Index a new paint layer is inserted at: directly above the active paint
 * layer, else above the top-most paint layer, else below the first mask.
 * @param doc - Document.
 * @returns Index in `doc.layers`.
 */
export function paintInsertIndex(doc: Readonly<Pick<PainterDocument, "layers" | "activeLayerId">>): number {
  const layers = doc.layers;
  const active = layers.findIndex((l) => l.id === doc.activeLayerId);
  if (active >= 0 && isPaintLike(layers[active] as Layer)) return active + 1;
  for (let i = layers.length - 1; i >= 0; i--) if (isPaintLike(layers[i] as Layer)) return i + 1;
  const firstMask = layers.findIndex((l) => l.kind === "mask");
  return firstMask >= 0 ? firstMask : layers.length;
}

/**
 * Whether a layer may be deleted (paint-like and not the last one).
 * @param layers - Layer list.
 * @param id - Layer id.
 * @returns `true` if deletable.
 */
export function canDeleteLayer(layers: readonly Layer[], id: string): boolean {
  const layer = layers.find((l) => l.id === id);
  return !!layer && isPaintLike(layer) && paintLayerCount(layers) > 1;
}

/**
 * Whether a layer may be duplicated (paint-like only in v1).
 * @param layers - Layer list.
 * @param id - Layer id.
 * @returns `true` if duplicable.
 */
export function canDuplicateLayer(layers: readonly Layer[], id: string): boolean {
  const layer = layers.find((l) => l.id === id);
  return !!layer && isPaintLike(layer);
}

/**
 * Paint layer that becomes active after removing index `removed`: the one
 * below it, else the nearest one above.
 * @param layers - Layer list AFTER the removal.
 * @param removed - Index the removed layer had.
 * @returns Layer id, or `undefined` if no paint layer is left.
 */
export function activeAfterRemoval(layers: readonly Layer[], removed: number): string | undefined {
  for (let i = Math.min(removed - 1, layers.length - 1); i >= 0; i--) {
    const layer = layers[i];
    if (layer && isPaintLike(layer)) return layer.id;
  }
  for (let i = Math.max(0, removed); i < layers.length; i++) {
    const layer = layers[i];
    if (layer && isPaintLike(layer)) return layer.id;
  }
  return undefined;
}

/**
 * Final index for dragging `id` next to `targetId` (display: `above` = higher
 * in the stack = larger index). Only paint-like layers move among paint-like
 * layers, so masks always stay on top.
 * @param layers - Layer list.
 * @param id - Dragged layer.
 * @param targetId - Layer it is dropped next to.
 * @param above - Drop above (true) or below the target.
 * @returns `{ from, to }` (final index after the move), or `null` if invalid or a no-op.
 */
export function resolveMove(
  layers: readonly Layer[],
  id: string,
  targetId: string,
  above: boolean,
): { from: number; to: number } | null {
  const from = layers.findIndex((l) => l.id === id);
  const target = layers.findIndex((l) => l.id === targetId);
  const src = layers[from];
  const dst = layers[target];
  if (!src || !dst || !isPaintLike(src) || !isPaintLike(dst)) return null;
  if (from === target) return null;
  const targetAfterRemoval = target > from ? target - 1 : target;
  const to = above ? targetAfterRemoval + 1 : targetAfterRemoval;
  return to === from ? null : { from, to };
}

// ── Changes ───────────────────────────────────────────────────────────────────

/**
 * Current values of the changed keys of a layer (the "before" of a props change).
 * @param layer - Layer.
 * @param props - Keys to read (values ignored).
 * @returns Snapshot of those keys.
 */
export function readProps(layer: Readonly<Layer>, props: LayerProps): LayerProps {
  const out: LayerProps = {};
  for (const key of PROP_KEYS) if (key in props) Object.assign(out, { [key]: layer[key] });
  return out;
}

/**
 * Whether applying `props` would change the layer.
 * @param layer - Layer.
 * @param props - New values.
 * @returns `true` if any value differs.
 */
export function propsDiffer(layer: Readonly<Layer>, props: LayerProps): boolean {
  return PROP_KEYS.some((key) => key in props && props[key] !== layer[key]);
}

/**
 * Write props into a layer (an `undefined` value removes the optional field).
 * @param layer - Layer to mutate.
 * @param props - Values to write.
 */
export function writeProps(layer: Layer, props: LayerProps): void {
  for (const key of PROP_KEYS) {
    if (!(key in props)) continue;
    const value = props[key];
    if (value === undefined) {
      if (key === "color" || key === "invert") delete layer[key];
    } else {
      Object.assign(layer, { [key]: value });
    }
  }
}

/**
 * Apply one change to a layer list (metadata only; pixels are the caller's).
 * `forward = false` applies the inverse (undo). Re-inserted layers are
 * copies, so the stored record is never aliased by the live document; a
 * removal refreshes the record's layer copy from the live layer so
 * non-undoable state (visibility, lock, file) survives an undo/redo cycle.
 * @param layers - Layer list to mutate.
 * @param change - Change record.
 * @param forward - Redo direction (`true`) or undo (`false`).
 * @returns `false` if the list does not match the record (nothing changed).
 */
export function applyLayerChange<P>(layers: Layer[], change: LayerChange<P>, forward: boolean): boolean {
  switch (change.op) {
    case "insert":
    case "remove": {
      const inserting = (change.op === "insert") === forward;
      if (inserting) {
        if (layers.some((l) => l.id === change.layer.id)) return false;
        layers.splice(Math.min(change.index, layers.length), 0, { ...change.layer });
        return true;
      }
      const index = layers.findIndex((l) => l.id === change.layer.id);
      const live = layers[index];
      if (!live) return false;
      // Keep non-undoable state (visibility, lock, file) for re-insertion.
      change.layer = { ...live };
      layers.splice(index, 1);
      return true;
    }
    case "move": {
      const from = forward ? change.from : change.to;
      const to = forward ? change.to : change.from;
      if (layers[from]?.id !== change.id) return false;
      const [moved] = layers.splice(from, 1);
      if (!moved) return false;
      layers.splice(Math.min(to, layers.length), 0, moved);
      return true;
    }
    case "props": {
      const layer = layers.find((l) => l.id === change.id);
      if (!layer) return false;
      writeProps(layer, forward ? change.after : change.before);
      return true;
    }
  }
}
