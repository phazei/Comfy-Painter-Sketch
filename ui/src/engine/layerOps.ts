/**
 * Layer commands of the editor core (layers panel, SPEC "Layers"):
 * add / duplicate / delete / reorder / rename / opacity / mask colour and
 * invert (undoable {@link LayersEntry} history entries), plus visibility,
 * lock and the active layer (not undoable, like Photoshop and the mask eye).
 *
 * The document's `activeLayerId` always names a paint-like layer (the layer
 * strokes go to outside Quick Mask); the mask is selected through the paint
 * target instead (`Editor.setPaintTarget`).
 *
 * Internal helpers (record, insert, setProps, …) live in
 * {@link ./layerOpsHelpers | layerOpsHelpers.ts}.
 */

import { soloGroup } from "./solo";
import { createId, createMaskLayer, createPaintLayer } from "../document/create";
import { nextMaskStyle } from "../defaults/maskDefaults";
import {
  activeAfterRemoval,
  canAddMask,
  canDeleteLayer,
  canDuplicateLayer,
  isPaintLike,
  maskInsertIndex,
  nextLayerName,
  nextMaskName,
  paintInsertIndex,
  resolveMove,
} from "../document/layerList";
import { copyLayerName } from "../document/layerList";
import { IMAGE_MASK_ID } from "../document/imageMask";
import { findMaskLayer } from "../document/masks";
import type { Layer } from "../document/types";
import type { LayerPixels } from "./editorTypes";
import type { EditorState } from "./editorState";
import { captureLayerPixels, releaseRemovedLayers } from "./layerHistory";
import {
  afterMetaChange,
  findLayer,
  insertLayer,
  readyCheck,
  recordLayerChange,
  setLayerProps,
} from "./layerOpsHelpers";
import { pickLayer, pickMask } from "./layerPick";

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
   * Whether the layer can be deleted (not the last paint layer / last mask).
   * @param layerId - Layer id.
   * @returns `true` if deletable.
   */
  canDelete(layerId: string): boolean {
    return canDeleteLayer(this.s.doc.layers, layerId);
  }

  /**
   * Whether another mask can be added (at most `MAX_MASKS`).
   * @returns `true` if below the limit.
   */
  canAddMask(): boolean {
    return canAddMask(this.s.doc.layers);
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

  /**
   * Quick Mask auto-select: the topmost visible, unlocked mask with raw
   * painted coverage at a document point ({@link pickMask}; `invert` ignored).
   * @param x - Document x.
   * @param y - Document y.
   * @returns Mask layer id, or `null` if nothing is hit.
   */
  pickMaskAt(x: number, y: number): string | null {
    const s = this.s;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    const rect = { x: Math.floor(x), y: Math.floor(y), width: 1, height: 1 };
    return pickMask(s.doc.layers, (id) => (s.store.get(id) ? (s.store.read(id, rect)?.data.data[3] ?? 0) : 0));
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
    const layer = findLayer(s, layerId);
    if (!layer || !isPaintLike(layer) || s.doc.activeLayerId === layerId) return false;
    s.settleFloat();
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
    const layer = findLayer(s, layerId);
    if (!layer || layer.visible === visible) return;
    s.settleFloat();
    if (s.stroke.active && s.strokeLayerId === layerId) s.cancelStroke();
    layer.visible = visible;
    afterMetaChange(s);
  }

  /**
   * Show or hide the background (Background row eye). Like layer eyes it is
   * not undoable; hidden = checkerboard in the editor and the `background`
   * widget colour instead of the input image in the outputs.
   * @param visible - Visibility.
   */
  setBackgroundVisible(visible: boolean): void {
    const s = this.s;
    if ((s.doc.backgroundVisible !== false) === visible) return;
    s.settleFloat();
    if (visible) delete s.doc.backgroundVisible;
    else s.doc.backgroundVisible = false;
    afterMetaChange(s);
  }

  /**
   * Lock or unlock a layer (painting on a locked layer is refused).
   * @param layerId - Layer id.
   * @param locked - Lock state.
   */
  setLocked(layerId: string, locked: boolean): void {
    const s = this.s;
    const layer = findLayer(s, layerId);
    // The Image Mask row is never edited, so it has no lock.
    if (!layer || layer.locked === locked || layerId === IMAGE_MASK_ID) return;
    s.settleFloat();
    if (s.stroke.active && s.strokeLayerId === layerId) s.cancelStroke();
    layer.locked = locked;
    afterMetaChange(s);
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
    if (!readyCheck(this.s)) return null;
    insertLayer(this.s, layer, paintInsertIndex(this.s.doc), null);
    this.soloNew(layer);
    return layer.id;
  }

  /**
   * Insert a prepared paint layer WITH pixels (a paste) at `index` and make
   * it active, as one undoable add (the pixels live in the entry).
   * @param layer - New layer (fresh id, not yet in the document).
   * @param index - Position in `doc.layers`.
   * @param pixels - Its pixels (document coords, inside the bounds cap).
   * @returns Its id, or `null` while loading.
   */
  addWithPixels(layer: Layer, index: number, pixels: LayerPixels): string | null {
    if (!readyCheck(this.s)) return null;
    insertLayer(this.s, layer, index, pixels);
    this.soloNew(layer);
    return layer.id;
  }

  /**
   * Add an empty mask ("Mask N", next palette colour) above the current mask
   * and make it the current mask. The active paint layer is unchanged.
   * @returns New mask id, or `null` while loading or at the limit.
   */
  addMask(): string | null {
    const s = this.s;
    if (!readyCheck(s) || !canAddMask(s.doc.layers)) return null;
    const colors = s.doc.layers.filter((l) => l.kind === "mask").map((l) => l.color);
    const layer = createMaskLayer(nextMaskName(s.doc.layers), nextMaskStyle(colors, s.maskStyle()));
    const index = maskInsertIndex(s.doc.layers, findMaskLayer(s.doc, s.currentMaskId)?.id);
    s.currentMaskId = layer.id;
    insertLayer(s, layer, index, null, false);
    this.soloNew(layer);
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
    if (!readyCheck(s) || !this.canDuplicate(layerId)) return null;
    const index = s.doc.layers.findIndex((l) => l.id === layerId);
    const source = s.doc.layers[index];
    if (!source) return null;
    const layer: Layer = { ...source, id: createId(8), name: copyLayerName(source.name, s.doc.layers) };
    insertLayer(s, layer, index + 1, captureLayerPixels(s, source.id));
    this.soloNew(layer);
    return layer.id;
  }

  /**
   * Delete a paint layer or mask (not the last of its kind). The pixels stay
   * in the undo entry. Deleting the current mask makes the top mask current.
   * @param layerId - Layer (default: the active layer).
   * @returns `true` if deleted.
   */
  remove(layerId: string = this.s.doc.activeLayerId): boolean {
    const s = this.s;
    if (!readyCheck(s) || !this.canDelete(layerId)) return false;
    const index = s.doc.layers.findIndex((l) => l.id === layerId);
    const layer = s.doc.layers[index];
    if (!layer) return false;
    const activeBefore = s.doc.activeLayerId;
    const pixels = captureLayerPixels(s, layerId);
    s.doc.layers.splice(index, 1);
    s.runtime.remove(layerId);
    releaseRemovedLayers(s);
    if (activeBefore === layerId) s.doc.activeLayerId = activeAfterRemoval(s.doc.layers, index) ?? activeBefore;
    if (s.currentMaskId === layerId) s.currentMaskId = null;
    recordLayerChange(s, [{ op: "remove", index, layer: { ...layer }, pixels }], activeBefore);
    return true;
  }

  /**
   * Reorder a layer next to another of the same group (paint among paint,
   * mask among masks).
   * @param layerId - Dragged layer.
   * @param targetId - Layer it is dropped next to.
   * @param above - Above (true) or below the target in the stack.
   * @returns `true` if the order changed.
   */
  move(layerId: string, targetId: string, above: boolean): boolean {
    const s = this.s;
    if (!readyCheck(s)) return false;
    const move = resolveMove(s.doc.layers, layerId, targetId, above);
    if (!move) return false;
    const [layer] = s.doc.layers.splice(move.from, 1);
    if (!layer) return false;
    s.doc.layers.splice(move.to, 0, layer);
    recordLayerChange(s, [{ op: "move", id: layerId, ...move }], s.doc.activeLayerId);
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
    if (!trimmed || layerId === IMAGE_MASK_ID) return false;
    return setLayerProps(this.s, layerId, { name: trimmed });
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
    return setLayerProps(this.s, layerId, { opacity: Math.min(1, Math.max(0, opacity)) }, gesture);
  }

  /**
   * Mask display colour.
   * @param layerId - Mask layer id.
   * @param color - `#rrggbb`.
   * @param gesture - Edits with the same key merge into one undo entry (picker drag).
   * @returns `true` if changed.
   */
  setMaskColor(layerId: string, color: string, gesture?: string): boolean {
    if (findLayer(this.s, layerId)?.kind !== "mask" || !/^#[0-9a-f]{6}$/i.test(color)) return false;
    return setLayerProps(this.s, layerId, { color: color.toLowerCase() }, gesture);
  }

  /**
   * Per-mask invert (applied before the union).
   * @param layerId - Mask layer id.
   * @param invert - Invert state.
   * @returns `true` if changed.
   */
  setMaskInvert(layerId: string, invert: boolean): boolean {
    if (findLayer(this.s, layerId)?.kind !== "mask") return false;
    return setLayerProps(this.s, layerId, { invert });
  }

  // ── Internals ───────────────────────────────────────────────────────────

  /**
   * While any solo is on, a new layer takes over its group's solo so what
   * you just made is visible and editable (a new text layer would otherwise
   * be hidden while typing).
   * @param layer - Newly inserted layer.
   */
  private soloNew(layer: Layer): void {
    const solo = this.s.solo.current;
    if (solo.paint === null && solo.mask === null) return;
    this.s.solo.set({ ...solo, [soloGroup(layer)]: layer.id });
  }
}
