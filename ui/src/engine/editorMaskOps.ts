/**
 * Quick Mask / paint target delegation for {@link Editor}. Extracted from
 * `editor.ts` to keep that file under the ~400-line guideline.
 *
 * Encapsulates the `paintTarget`, `maskLayer`, `setPaintTarget`,
 * `togglePaintTarget`, `setMaskVisible` and Background row selection
 * operations over the shared editor state and paint operations.
 */

import { findAnyLayer } from "../document/imageMask";
import { findMaskLayer, targetLayer } from "../document/masks";
import type { PaintTarget } from "../document/masks";
import type { Layer } from "../document/types";
import type { EditorState } from "./editorState";
import { targetedMaskLayer } from "./layerMask";
import { editBlockNote } from "./rasterize";
import type { PaintOps } from "./paintOps";

/**
 * Quick Mask and paint target operations delegated from {@link Editor}.
 */
export class EditorMaskOps {
  /**
   * @param s - Shared editor state.
   * @param paint - Paint operations (owns `setPaintTarget` / `setMaskVisible`).
   */
  constructor(
    private readonly s: EditorState,
    private readonly paint: PaintOps,
  ) {}

  /** What brush/eraser strokes paint into (UI state, not saved). */
  get paintTarget(): PaintTarget {
    return this.s.target;
  }

  /** The mask layer Quick Mask edits, if the document has one. */
  get maskLayer(): Readonly<Layer> | undefined {
    return findMaskLayer(this.s.doc, this.s.currentMaskId);
  }

  /**
   * Whether any mask layer is hidden AND has ever held paint (queue-time
   * warning: it will not be in the MASK output).
   * @returns `true` if a hidden-but-painted mask exists.
   */
  hiddenMaskHasContent(): boolean {
    return this.s.doc.layers.some((l) => l.kind === "mask" && !l.visible && this.s.runtime.get(l.id)?.hasContent === true);
  }

  /**
   * Switch the paint target (Quick Mask, `Q`); adds a mask layer if missing.
   * @param target - New target.
   */
  setPaintTarget(target: PaintTarget): void {
    this.paint.setPaintTarget(target);
  }

  /** Toggle between the paint layer and the current mask. */
  togglePaintTarget(): void {
    this.paint.setPaintTarget(this.s.target === "mask" ? "paint" : "mask");
  }

  /**
   * Make a mask the current mask and turn Quick Mask on.
   * @param layerId - Mask layer id.
   * @returns `false` if it is not a mask layer.
   */
  selectMask(layerId: string): boolean {
    const s = this.s;
    // Mask layers and the Image Mask row (pixel edits on it are refused).
    if (findAnyLayer(s.doc, layerId)?.kind !== "mask") return false;
    const changed = findMaskLayer(s.doc, s.currentMaskId)?.id !== layerId || s.sourceSelected !== null;
    if (changed && s.stroke.active) s.cancelStroke();
    s.currentMaskId = layerId;
    if (s.target !== "mask") this.paint.setPaintTarget("mask");
    else if (changed) {
      s.sourceSelected = null;
      s.events.emit("mask", undefined);
    }
    return true;
  }

  /** The Background row is selected (read-only; {@link selectBackground}). */
  get backgroundSelected(): boolean {
    return this.s.sourceSelected === "background";
  }

  /**
   * Select the read-only Background row (session state: not saved, not
   * undoable). Quick Mask turns off; the active layer and current mask stay
   * as they are, and every pixel edit is refused with a note until another
   * row is selected (`editBlockNote`).
   */
  selectBackground(): void {
    const s = this.s;
    if (s.sourceSelected === "background") return;
    if (s.stroke.active) s.cancelStroke();
    s.target = "paint";
    s.sourceSelected = "background";
    s.events.emit("mask", undefined);
  }

  /**
   * Show or hide the mask layer (adds one if missing). Hidden mask layers are
   * also excluded from the `MASK` output (saved-file contract).
   * @param visible - Visibility.
   */
  setMaskVisible(visible: boolean): void {
    this.paint.setMaskVisible(visible);
  }

  /**
   * What a pixel tool would edit now (cursor badges; nothing is changed):
   * whether it paints a cmask (Quick Mask) or a targeted lmask, and whether
   * the edit gate (`editBlockNote`) would refuse it. A missing mask counts
   * as editable (the first stroke adds one).
   * @param kind - The tool's edit kind (`Tool.editsPixels`).
   * @returns Target facts.
   */
  editTarget(kind: "paint" | "other"): { mask: boolean; blocked: boolean } {
    const s = this.s;
    if (s.sourceSelected) return { mask: false, blocked: !s.loading };
    const layer = targetLayer(s.doc, s.target, s.currentMaskId);
    const mask = s.target === "mask" || targetedMaskLayer(s) !== null;
    return { mask, blocked: !s.loading && layer !== undefined && editBlockNote(s, layer, kind) !== null };
  }
}