/**
 * Layer Move tool operations of the editor core (SPEC M6a), exposed as
 * {@link Editor.layerMove}: move the active layer's content (the active
 * paint-like layer, or the mask under Quick Mask) by whole document px.
 *
 * - Drag: {@link LayerMoveOps.begin} / `preview` / `commit` / `cancel`. The
 *   preview only offsets how the layer canvas is drawn (`layerDisplay.ts`);
 *   pixels move once, on commit, as one undo entry.
 * - Nudge: {@link LayerMoveOps.nudge}; consecutive nudges of one layer merge
 *   into one undo entry.
 * - How a kind moves is the per-kind handler in `layerMovers.ts` (text
 *   layers: M6b).
 * - The selection is not involved (yet): the whole layer moves, the
 *   selection stays where it is.
 *
 * Undo/redo cancels a drag preview (`paintOps.ts`).
 */

import { activeEditLayer } from "../document/masks";
import type { Layer } from "../document/types";
import { HIDDEN_LAYER_NOTE, HIDDEN_MASK_NOTE, LOCKED_LAYER_NOTE } from "./editorTypes";
import type { EditorState } from "./editorState";
import { moverFor, UNMOVABLE_LAYER_NOTE } from "./layerMovers";

/** Gesture key that merges consecutive arrow nudges. */
export const NUDGE_GESTURE = "move-nudge";

/**
 * Layer move commands over a shared {@link EditorState}.
 */
export class LayerMoveOps {
  /**
   * @param s - Shared editor state.
   */
  constructor(private readonly s: EditorState) {}

  /** A drag preview is in progress. */
  get dragging(): boolean {
    return this.s.movePreview !== null;
  }

  /**
   * Start a drag of the active layer (notes when locked / hidden / unmovable).
   * @returns `false` if the layer can't be moved now.
   */
  begin(): boolean {
    const s = this.s;
    if (s.movePreview) return true;
    const layer = this.editable();
    if (!layer) return false;
    s.movePreview = { layerId: layer.id, dx: 0, dy: 0 };
    return true;
  }

  /**
   * Update the drag offset (cheap: redraw only).
   * @param dx - Offset from the drag start, whole document px.
   * @param dy - Offset from the drag start, whole document px.
   */
  preview(dx: number, dy: number): void {
    const p = this.s.movePreview;
    if (!p || (p.dx === dx && p.dy === dy)) return;
    p.dx = dx;
    p.dy = dy;
    this.s.events.emit("render", undefined);
  }

  /**
   * End the drag: move the layer by the preview offset as one undo entry.
   * @returns `true` if the layer moved.
   */
  commit(): boolean {
    const s = this.s;
    const p = s.movePreview;
    if (!p) return false;
    s.movePreview = null;
    const moved = this.apply(p.layerId, p.dx, p.dy, undefined);
    if (!moved) s.events.emit("render", undefined);
    return moved;
  }

  /** Abort the drag (Esc, pointer cancel, tool switch); nothing changes. */
  cancel(): void {
    if (!this.s.movePreview) return;
    this.s.movePreview = null;
    this.s.events.emit("render", undefined);
  }

  /**
   * Arrow nudge of the active layer (merges with the previous nudge).
   * @param dx - X shift, whole document px.
   * @param dy - Y shift, whole document px.
   * @returns `true` if the layer moved.
   */
  nudge(dx: number, dy: number): boolean {
    if (this.s.movePreview) return false;
    const layer = this.editable();
    return layer ? this.apply(layer.id, dx, dy, NUDGE_GESTURE) : false;
  }

  // ── Internals ───────────────────────────────────────────────────────────

  /** The layer to move, if it can be moved now (emits the reason otherwise). */
  private editable(): Layer | null {
    const s = this.s;
    if (s.loading || s.stroke.active) return null;
    const layer = activeEditLayer(s.doc, s.target);
    if (!layer) return null;
    const note = blockedNote(layer);
    if (note) {
      s.events.emit("note", note);
      return null;
    }
    return layer;
  }

  private apply(layerId: string, dx: number, dy: number, gesture: string | undefined): boolean {
    const s = this.s;
    if (s.loading || s.stroke.active || (dx === 0 && dy === 0)) return false;
    // The layer may have changed during the drag (lock, hide, delete).
    const layer = s.doc.layers.find((l) => l.id === layerId);
    if (!layer || blockedNote(layer)) return false;
    const mover = moverFor(layer);
    if (!mover?.move(s, layer, dx, dy, gesture)) return false;
    s.afterEdit();
    return true;
  }
}

/** Why a layer can't be moved, or `null`. */
function blockedNote(layer: Layer): string | null {
  if (layer.locked) return LOCKED_LAYER_NOTE;
  if (!layer.visible) return layer.kind === "mask" ? HIDDEN_MASK_NOTE : HIDDEN_LAYER_NOTE;
  if (!moverFor(layer)) return UNMOVABLE_LAYER_NOTE;
  return null;
}
