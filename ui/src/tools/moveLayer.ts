/**
 * Move tool (V, SPEC M6a): moves the ACTIVE LAYER's content -- the active
 * paint-like layer, or the mask under Quick Mask -- by whole document px.
 * (Moving the whole drawing is the separate "Move drawing" mode, `move.ts`.)
 *
 * - Drag: live preview draws the layer offset; release commits one undo
 *   entry (`Editor.layerMove`). Esc / pointer cancel aborts.
 * - Arrows nudge 1 image px (in document px, at least 1), Shift+arrows 10;
 *   consecutive nudges merge into one undo entry.
 * - Locked / hidden layers show a note.
 * - With a selection (M10a): a press inside it (coverage >= 50 %) lifts the
 *   selected pixels into a floating selection (`Editor.float`; Alt = copy,
 *   no hole) and drags it; a press outside moves the whole layer and the
 *   selection moves with it. While a float exists every drag and arrow
 *   nudge moves the float; Enter / other edits commit it, Esc cancels it.
 *   Auto-select (Ctrl or the option) is off while a selection exists.
 * - Auto-select (Photoshop): with Ctrl held at pointer-down -- also when
 *   this tool is the temporary Ctrl tool of another rail tool
 *   (`Tool.ctrlMove`, `ToolRegistry.resolve`) -- or with the "Auto-select"
 *   option on, the drag first picks the topmost visible, unlocked paint/text
 *   layer with a pixel under the pointer (`Editor.layerOps.pickAt`) and makes
 *   it active (not an undo step). With Quick Mask on it picks only visible,
 *   unlocked masks by raw painted coverage (`pickMaskAt`) and makes the hit
 *   the current mask (`Editor.selectMask`, Quick Mask stays on). Nothing hit
 *   = nothing moves, no note.
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
  /** The current drag moves a floating selection. */
  private floating = false;
  /** Action the stage runs after ending this press (text rasterize confirm). */
  private deferred: (() => void) | null = null;

  /** @inheritdoc */
  takeDeferred(): (() => void) | null {
    const action = this.deferred;
    this.deferred = null;
    return action;
  }

  /** @inheritdoc */
  onPointerDown(editor: Editor, samples: readonly ToolPointer[]): void {
    const first = samples[0];
    if (!first) return;
    this.deferred = null;
    const float = editor.float;
    if (!float.active && editor.selectionMove.hit(first.x, first.y)) {
      // Decide before anything moves: a refused lift never falls into a layer move,
      // and the text rasterize confirm runs only after the gesture has ended.
      const check = float.check();
      if (check === "confirm") this.deferred = () => float.prepareLift();
      if (check !== "ok" || !float.lift(first.altKey)) return;
    }
    if (float.active) {
      if (!float.beginDrag()) return;
      this.floating = true;
      this.start = { x: first.x, y: first.y };
      return;
    }
    const pick = (first.ctrlKey || this.values.autoSelect === true) && !editor.selection.active;
    if (pick && !this.autoSelect(editor, first)) return;
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
    if (this.floating) {
      this.floating = false;
      editor.float.endDrag();
      return;
    }
    editor.layerMove.commit();
  }

  /** @inheritdoc */
  onCancel(editor: Editor): void {
    if (!this.start) return;
    this.start = null;
    if (this.floating) {
      this.floating = false;
      editor.float.cancelDrag();
      return;
    }
    editor.layerMove.cancel();
  }

  /** @inheritdoc */
  onKey(editor: Editor, event: KeyboardEvent): boolean {
    const dir = ARROWS[event.key];
    if (!dir) return false;
    // A nudge mid-drag would fight the drag: swallow it.
    if (this.start) return true;
    const step = nudgeStep(event.shiftKey ? 10 : 1, editor.frameMap.scale);
    if (editor.float.nudge(dir[0] * step, dir[1] * step)) return true;
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
    if (editor.paintTarget === "mask") {
      // Quick Mask on: masks only; the pick becomes the current mask (Quick Mask stays on).
      const maskId = editor.layerOps.pickMaskAt(at.x, at.y);
      return maskId !== null && editor.selectMask(maskId);
    }
    const id = editor.layerOps.pickAt(at.x, at.y);
    if (!id) return false;
    editor.layerOps.setActiveLayer(id);
    return true;
  }

  /** Samples are document coords (through `Editor.frameMap`); the delta is rounded to whole px. */
  private previewTo(editor: Editor, sample: ToolPointer): void {
    if (!this.start) return;
    const d = dragDelta(this.start, sample);
    if (this.floating) editor.float.dragTo(d.x, d.y);
    else editor.layerMove.preview(d.x, d.y);
  }
}

/**
 * Create the layer Move tool.
 * @returns The tool.
 */
export function createMoveLayerTool(): MoveLayerTool {
  return new MoveLayerTool();
}
