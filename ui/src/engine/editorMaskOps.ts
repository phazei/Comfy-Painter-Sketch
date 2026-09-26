/**
 * Quick Mask / paint target delegation for {@link Editor}. Extracted from
 * `editor.ts` to keep that file under the ~400-line guideline.
 *
 * Encapsulates the `paintTarget`, `maskLayer`, `setPaintTarget`,
 * `togglePaintTarget`, and `setMaskVisible` operations over the shared
 * editor state and paint operations.
 */

import { findMaskLayer } from "../document/masks";
import type { PaintTarget } from "../document/masks";
import type { Layer } from "../document/types";
import type { EditorState } from "./editorState";
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
   * Make a mask the current mask (M8) and turn Quick Mask on.
   * @param layerId - Mask layer id.
   * @returns `false` if it is not a mask layer.
   */
  selectMask(layerId: string): boolean {
    const s = this.s;
    if (s.doc.layers.find((l) => l.id === layerId)?.kind !== "mask") return false;
    const changed = findMaskLayer(s.doc, s.currentMaskId)?.id !== layerId;
    if (changed && s.stroke.active) s.cancelStroke();
    s.currentMaskId = layerId;
    if (s.target !== "mask") this.paint.setPaintTarget("mask");
    else if (changed) s.events.emit("mask", undefined);
    return true;
  }

  /**
   * Show or hide the mask layer (adds one if missing). Hidden mask layers are
   * also excluded from the `MASK` output (saved-file contract).
   * @param visible - Visibility.
   */
  setMaskVisible(visible: boolean): void {
    this.paint.setMaskVisible(visible);
  }
}