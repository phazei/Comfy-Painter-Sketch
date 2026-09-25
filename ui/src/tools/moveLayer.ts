/**
 * Move tool (V, SPEC M6a): moves the ACTIVE LAYER's content -- the active
 * paint-like layer, or the mask under Quick Mask -- by whole document px.
 * (Moving the whole drawing is the separate "Move drawing" mode, `move.ts`.)
 *
 * - Drag: live preview draws the layer offset; release commits one undo
 *   entry (`Editor.layerMove`). Esc / pointer cancel aborts.
 * - Arrows nudge 1 image px (in document px, at least 1), Shift+arrows 10;
 *   consecutive nudges merge into one undo entry.
 * - Locked / hidden layers show a note. The selection is not used yet: the
 *   whole layer moves and the selection stays put.
 * - Auto-select (Photoshop): with Ctrl held at pointer-down -- also when
 *   this tool is the temporary Ctrl tool of another rail tool
 *   (`Tool.ctrlMove`, `ToolRegistry.resolve`) -- or with the "Auto-select"
 *   option on, the drag first picks the topmost visible, unlocked paint/text
 *   layer with a pixel under the pointer (`Editor.layerOps.pickAt`) and makes
 *   it active (Quick Mask off; not an undo step). Nothing hit = nothing
 *   moves, no note.
 */

import type { Editor } from "../engine/editor";
import { dragDelta, nudgeStep } from "../engine/translateMath";
import type { Point } from "../geometry/rect";
import { OptionSet } from "./options";
import type { OptionDescriptor, OptionValues } from "./options";
import type { Tool, ToolCursor, ToolPointer } from "./types";

const DESCRIPTORS: readonly OptionDescriptor[] = [
  { kind: "toggle", key: "autoSelect", label: "Auto-select", title: "Pick the layer under the pointer (hold Ctrl for a one-off pick)" },
];

/** Arrow key -> unit direction. */
const ARROWS: Readonly<Record<string, readonly [number, number]>> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

/**
 * The layer Move tool.
 */
export class MoveLayerTool implements Tool {
  readonly id = "move-layer";
  readonly label = "Move layer";
  readonly shortcut = "v";
  readonly icon = "move";
  /** Ctrl is this tool's own auto-select modifier; it never substitutes itself. */
  readonly ctrlMove = false;
  private readonly values: OptionValues = { autoSelect: false };
  readonly options = new OptionSet(DESCRIPTORS, this.values);
  /** Pointer-down position (document coords) while dragging. */
  private start: Point | null = null;

  /** @inheritdoc */
  onPointerDown(editor: Editor, samples: readonly ToolPointer[]): void {
    const first = samples[0];
    if (!first) return;
    if ((first.ctrlKey || this.values.autoSelect === true) && !this.autoSelect(editor, first)) return;
    if (!editor.layerMove.begin()) return;
    this.start = { x: first.x, y: first.y };
  }

  /** @inheritdoc */
  onPointerMove(editor: Editor, samples: readonly ToolPointer[]): void {
    const last = samples[samples.length - 1];
    if (last) this.previewTo(editor, last);
  }

  /** @inheritdoc */
  onPointerUp(editor: Editor, sample: ToolPointer): void {
    if (!this.start) return;
    this.previewTo(editor, sample);
    this.start = null;
    editor.layerMove.commit();
  }

  /** @inheritdoc */
  onCancel(editor: Editor): void {
    if (!this.start) return;
    this.start = null;
    editor.layerMove.cancel();
  }

  /** @inheritdoc */
  onKey(editor: Editor, event: KeyboardEvent): boolean {
    const dir = ARROWS[event.key];
    if (!dir) return false;
    // A nudge mid-drag would fight the drag: swallow it.
    if (this.start) return true;
    const step = nudgeStep(event.shiftKey ? 10 : 1, editor.frameMap.scale);
    editor.layerMove.nudge(dir[0] * step, dir[1] * step);
    return true;
  }

  /** @inheritdoc */
  cursor(): ToolCursor {
    return { kind: "icon", icon: "move" };
  }

  /**
   * Pick the layer under the pointer and make it the move target.
   * @returns alse if nothing was hit (the drag moves nothing).
   */
  private autoSelect(editor: Editor, at: ToolPointer): boolean {
    const id = editor.layerOps.pickAt(at.x, at.y);
    if (!id) return false;
    // The pick targets a paint/text layer: leave Quick Mask so it, not the mask, moves.
    if (editor.paintTarget === "mask") editor.setPaintTarget("paint");
    editor.layerOps.setActiveLayer(id);
    return true;
  }

  /** Samples are document coords (through `Editor.frameMap`); the delta is rounded to whole px. */
  private previewTo(editor: Editor, sample: ToolPointer): void {
    if (!this.start) return;
    const d = dragDelta(this.start, sample);
    editor.layerMove.preview(d.x, d.y);
  }
}

/**
 * Create the layer Move tool.
 * @returns The tool.
 */
export function createMoveLayerTool(): MoveLayerTool {
  return new MoveLayerTool();
}
