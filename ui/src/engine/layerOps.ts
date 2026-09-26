/**
 * Layer commands of the editor core (layers panel, SPEC "### Layers"):
 * add / duplicate / delete / reorder / rename / opacity / mask colour and
 * invert (undoable {@link LayersEntry} history entries), plus visibility,
 * lock and the active layer (not undoable, like Photoshop and the mask eye).
 *
 * The document's `activeLayerId` always names a paint-like layer (the layer
 * strokes go to outside Quick Mask); the mask is selected through the paint
 * target instead (`Editor.setPaintTarget`).
 */

import { createId, createPaintLayer } from "../document/create";
import {
  activeAfterRemoval,
  canDeleteLayer,
  canDuplicateLayer,
  isPaintLike,
  nextLayerName,
  paintInsertIndex,
  propsDiffer,
  propsEqual,
  readProps,
  resolveMove,
  writeProps,
} from "../document/layerList";
import type { LayerChange, LayerProps } from "../document/layerList";
import type { Layer } from "../document/types";
import type { LayerPixels } from "./editorTypes";
import type { EditorState } from "./editorState";
import {
  captureLayerPixels,
  changesBytes,
  emitLayerEvents,
  installLayerPixels,
  releaseRemovedLayers,
} from "./layerHistory";
import { pickLayer } from "./layerPick";

/**
 * Layer list commands over a shared {@link EditorState}.
 */
export class LayerOps {
  /**
   * @param s - Shared editor state.
   */
  constructor(private readonly s: EditorState) {}

  // ── Queries ─────────────────────────────────────────────────────────────

  /**
   * Pixel revision of a layer: changes whenever its committed pixels change
   * (thumbnail cache key; not bumped during a stroke preview).
   * @param layerId - Layer id.
   * @returns Revision number.
   */
  revision(layerId: string): number {
    return this.s.runtime.revision(layerId);
  }

  /**
   * Whether the layer can be deleted (paint-like, not the last one).
   * @param layerId - Layer id.
   * @returns `true` if deletable.
   */
  canDelete(layerId: string): boolean {
    return canDeleteLayer(this.s.doc.layers, layerId);
  }

  /**
   * Whether the layer can be duplicated (paint-like).
   * @param layerId - Layer id.
   * @returns `true` if duplicable.
   */
  canDuplicate(layerId: string): boolean {
    return canDuplicateLayer(this.s.doc.layers, layerId);
  }

  /**
   * Move-tool auto-select: the topmost visible, unlocked paint/text layer
   * with a visible pixel at a document point ({@link pickLayer}; reads one
   * pixel per candidate layer).
   * @param x - Document x.
   * @param y - Document y.
   * @returns Layer id, or `null` if nothing is hit.
   */
  pickAt(x: number, y: number): string | null {
    const s = this.s;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    const rect = { x: Math.floor(x), y: Math.floor(y), width: 1, height: 1 };
    // Layers without a surface have no pixels (and must not get one here).
    return pickLayer(s.doc.layers, (id) => (s.store.get(id) ? (s.store.read(id, rect)?.data.data[3] ?? 0) : 0));
  }

  // ── Not undoable ────────────────────────────────────────────────────────

  /**
   * Make a paint layer the active one (the layer strokes go to outside
   * Quick Mask). Mask layers are selected via the paint target instead.
   * @param layerId - Paint layer id.
   * @returns `true` if the active layer changed.
   */
  setActiveLayer(layerId: string): boolean {
    const s = this.s;
    const layer = this.find(layerId);
    if (!layer || !isPaintLike(layer) || s.doc.activeLayerId === layerId) return false;
    if (s.stroke.active) s.cancelStroke();
    s.doc.activeLayerId = layerId;
    s.events.emit("layers", undefined);
    s.events.emit("change", undefined);
    return true;
  }

  /**
   * Show or hide a layer (hidden layers are skipped in `IMAGE`/`MASK`).
   * @param layerId - Layer id.
   * @param visible - Visibility.
   */
  setVisible(layerId: string, visible: boolean): void {
    const s = this.s;
    const layer = this.find(layerId);
    if (!layer || layer.visible === visible) return;
    if (s.stroke.active && s.strokeLayerId === layerId) s.cancelStroke();
    layer.visible = visible;
    this.afterMeta();
  }

  /**
   * Lock or unlock a layer (painting on a locked layer is refused).
   * @param layerId - Layer id.
   * @param locked - Lock state.
   */
  setLocked(layerId: string, locked: boolean): void {
    const s = this.s;
    const layer = this.find(layerId);
    if (!layer || layer.locked === locked) return;
    if (s.stroke.active && s.strokeLayerId === layerId) s.cancelStroke();
    layer.locked = locked;
    this.afterMeta();
  }

  // ── Structural (undoable) ───────────────────────────────────────────────

  /**
   * Add an empty "Layer N" above the active paint layer and make it active.
   * @returns New layer id, or `null` while loading.
   */
  add(): string | null {
    return this.addLayer(createPaintLayer(nextLayerName(this.s.doc.layers)));
  }

  /**
   * Insert a prepared, empty layer (e.g. a new text layer) above the active
   * paint layer and make it active, as one undoable add.
   * @param layer - New layer (fresh id, not yet in the document).
   * @returns Its id, or `null` while loading.
   */
  addLayer(layer: Layer): string | null {
    if (!this.ready()) return null;
    this.insert(layer, paintInsertIndex(this.s.doc), null);
    return layer.id;
  }

  /**
   * Duplicate a paint layer (pixels included) directly above it; the copy
   * becomes active.
   * @param layerId - Source layer (default: the active layer).
   * @returns New layer id, or `null` if not possible.
   */
  duplicate(layerId: string = this.s.doc.activeLayerId): string | null {
    const s = this.s;
    if (!this.ready() || !this.canDuplicate(layerId)) return null;
    const index = s.doc.layers.findIndex((l) => l.id === layerId);
    const source = s.doc.layers[index];
    if (!source) return null;
    const layer: Layer = { ...source, id: createId(8), name: `${source.name} copy` };
    this.insert(layer, index + 1, captureLayerPixels(s, source.id));
    return layer.id;
  }

  /**
   * Delete a paint layer (not the last one; masks are not deletable). The
   * pixels stay in the undo entry.
   * @param layerId - Layer (default: the active layer).
   * @returns `true` if deleted.
   */
  remove(layerId: string = this.s.doc.activeLayerId): boolean {
    const s = this.s;
    if (!this.ready() || !this.canDelete(layerId)) return false;
    const index = s.doc.layers.findIndex((l) => l.id === layerId);
    const layer = s.doc.layers[index];
    if (!layer) return false;
    const activeBefore = s.doc.activeLayerId;
    const pixels = captureLayerPixels(s, layerId);
    s.doc.layers.splice(index, 1);
    s.runtime.remove(layerId);
    releaseRemovedLayers(s);
    if (activeBefore === layerId) s.doc.activeLayerId = activeAfterRemoval(s.doc.layers, index) ?? activeBefore;
    this.record([{ op: "remove", index, layer: { ...layer }, pixels }], activeBefore);
    return true;
  }

  /**
   * Reorder a paint layer next to another paint layer.
   * @param layerId - Dragged layer.
   * @param targetId - Layer it is dropped next to.
   * @param above - Above (true) or below the target in the stack.
   * @returns `true` if the order changed.
   */
  move(layerId: string, targetId: string, above: boolean): boolean {
    const s = this.s;
    if (!this.ready()) return false;
    const move = resolveMove(s.doc.layers, layerId, targetId, above);
    if (!move) return false;
    const [layer] = s.doc.layers.splice(move.from, 1);
    if (!layer) return false;
    s.doc.layers.splice(move.to, 0, layer);
    this.record([{ op: "move", id: layerId, ...move }], s.doc.activeLayerId);
    return true;
  }

  /**
   * Rename a layer (trimmed; empty names are ignored).
   * @param layerId - Layer id.
   * @param name - New name.
   * @returns `true` if renamed.
   */
  rename(layerId: string, name: string): boolean {
    const trimmed = name.trim().slice(0, 100);
    if (!trimmed) return false;
    return this.setProps(layerId, { name: trimmed });
  }

  /**
   * Layer opacity (paint: composite opacity; mask: overlay display only).
   * @param layerId - Layer id.
   * @param opacity - 0..1 (clamped).
   * @param gesture - Edits with the same key merge into one undo entry (a scrub/slider drag).
   * @returns `true` if changed.
   */
  setOpacity(layerId: string, opacity: number, gesture?: string): boolean {
    if (!Number.isFinite(opacity)) return false;
    return this.setProps(layerId, { opacity: Math.min(1, Math.max(0, opacity)) }, gesture);
  }

  /**
   * Mask display colour.
   * @param layerId - Mask layer id.
   * @param color - `#rrggbb`.
   * @param gesture - Edits with the same key merge into one undo entry (picker drag).
   * @returns `true` if changed.
   */
  setMaskColor(layerId: string, color: string, gesture?: string): boolean {
    if (this.find(layerId)?.kind !== "mask" || !/^#[0-9a-f]{6}$/i.test(color)) return false;
    return this.setProps(layerId, { color: color.toLowerCase() }, gesture);
  }

  /**
   * Per-mask invert (applied before the union, decision 5).
   * @param layerId - Mask layer id.
   * @param invert - Invert state.
   * @returns `true` if changed.
   */
  setMaskInvert(layerId: string, invert: boolean): boolean {
    if (this.find(layerId)?.kind !== "mask") return false;
    return this.setProps(layerId, { invert });
  }

  // ── Internals ───────────────────────────────────────────────────────────

  private find(layerId: string): Layer | undefined {
    return this.s.doc.layers.find((l) => l.id === layerId);
  }

  /** Structural edits wait for restores and cancel a running stroke. */
  private ready(): boolean {
    const s = this.s;
    if (s.loading) return false;
    if (s.stroke.active) s.cancelStroke();
    return true;
  }

  private insert(layer: Layer, index: number, pixels: LayerPixels | null): void {
    const s = this.s;
    const activeBefore = s.doc.activeLayerId;
    s.doc.layers.splice(index, 0, layer);
    installLayerPixels(s, layer.id, pixels);
    s.doc.activeLayerId = layer.id;
    this.record([{ op: "insert", index, layer: { ...layer }, pixels }], activeBefore);
  }

  private setProps(layerId: string, props: LayerProps, gesture?: string): boolean {
    const s = this.s;
    const layer = this.find(layerId);
    if (!layer || s.loading || !propsDiffer(layer, props)) return false;
    const merge = gesture ? s.history.mergeTarget() : undefined;
    const change = merge?.kind === "layers" && merge.gesture === gesture ? merge.changes[0] : undefined;
    if (change?.op === "props" && change.id === layerId && sameKeys(change.after, props)) {
      Object.assign(change.after, props);
      writeProps(layer, props);
      // The gesture came back to where it started (picker Esc, scrub back):
      // drop the entry so no empty undo step remains. A later edit in the
      // same gesture simply starts a new entry.
      if (merge?.kind === "layers" && merge.changes.length === 1 && propsEqual(change.before, change.after)) s.history.discardNewest();
      this.afterMeta(true);
      return true;
    }
    const before = readProps(layer, props);
    writeProps(layer, props);
    this.record([{ op: "props", id: layerId, before, after: { ...props } }], s.doc.activeLayerId, gesture);
    return true;
  }

  private record(changes: LayerChange<LayerPixels>[], activeBefore: string, gesture?: string): void {
    const s = this.s;
    s.history.push({
      kind: "layers",
      changes,
      activeBefore,
      activeAfter: s.doc.activeLayerId,
      bytes: changesBytes(changes),
      ...(gesture ? { gesture } : {}),
    });
    this.afterMeta(true);
  }

  /** Events after a metadata change (`history` too when it was recorded). */
  private afterMeta(history = false): void {
    const s = this.s;
    if (history) s.events.emit("history", undefined);
    emitLayerEvents(s);
    s.events.emit("change", undefined);
    s.events.emit("render", undefined);
  }
}

function sameKeys(a: LayerProps, b: LayerProps): boolean {
  const ka = Object.keys(a).sort().join();
  return ka === Object.keys(b).sort().join();
}
