/**
 * Outline drag (SPEC M10a): with a selection tool (marquee / lasso / wand,
 * `Tool.combinesSelection`) a plain press (no Shift / Alt / Ctrl) inside the
 * selection drags only the selection outline -- one `selection` history
 * entry (`Editor.selectionMove`). A press that never moves past the click
 * slop is replayed to the selection tool as an ordinary click (marquee /
 * lasso: deselect, wand: select at the point).
 *
 * Not a rail tool: `ToolRegistry.resolve` substitutes it for the press
 * (like the Ctrl Move / Alt eyedropper substitutes).
 */

import type { Editor } from "../engine/editor";
import { imageLengthToDoc } from "../engine/frameMap";
import { dragDelta } from "../engine/translateMath";
import type { Tool, ToolCursor, ToolPointer } from "./types";

/** Stage CSS px below which a press counts as a click. */
const CLICK_SLOP_PX = 3;

/**
 * Temporary tool for one outline drag.
 */
export class OutlineDragTool implements Tool {
  readonly id = "selection-outline";
  readonly label = "Move selection outline";
  readonly shortcut = "";
  readonly icon = "move";
  readonly options = null;
  readonly rail = false;
  private inner: Tool | null = null;
  private first: ToolPointer | null = null;
  private slop = 0;
  private started = false;

  /**
   * Bind the selection tool a click is replayed to.
   * @param inner - Active selection tool.
   * @returns This tool.
   */
  wrap(inner: Tool): this {
    this.inner = inner;
    return this;
  }

  /** @inheritdoc */
  onPointerDown(editor: Editor, samples: readonly ToolPointer[]): void {
    const first = samples[0];
    if (!first) return;
    const scale = editor.view.current.scale;
    this.first = first;
    this.slop = imageLengthToDoc(editor.frameMap, CLICK_SLOP_PX / (scale > 0 ? scale : 1));
    this.started = false;
  }

  /** @inheritdoc */
  onPointerMove(editor: Editor, samples: readonly ToolPointer[]): void {
    const last = samples[samples.length - 1];
    if (last) this.track(editor, last);
  }

  /** @inheritdoc */
  onPointerUp(editor: Editor, sample: ToolPointer): void {
    const first = this.first;
    if (!first) return;
    this.track(editor, sample);
    this.first = null;
    if (this.started) {
      this.started = false;
      editor.selectionMove.commit();
      return;
    }
    // A click: the selection tool's own click behaviour.
    this.inner?.onPointerDown(editor, [first]);
    this.inner?.onPointerUp(editor, first);
  }

  /** @inheritdoc */
  onCancel(editor: Editor): void {
    if (this.started) editor.selectionMove.cancel();
    this.started = false;
    this.first = null;
  }

  /** @inheritdoc */
  cursor(): ToolCursor {
    return { kind: "icon", icon: "move" };
  }

  private track(editor: Editor, p: ToolPointer): void {
    const first = this.first;
    if (!first) return;
    if (!this.started) {
      if (Math.hypot(p.x - first.x, p.y - first.y) <= this.slop) return;
      this.started = editor.selectionMove.begin();
      if (!this.started) return;
    }
    const d = dragDelta(first, p);
    editor.selectionMove.preview(d.x, d.y);
  }
}
