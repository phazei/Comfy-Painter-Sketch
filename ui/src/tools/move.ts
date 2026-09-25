/**
 * Move drawing tool (SPEC M5): repositions / scales the WHOLE drawing (all
 * layers and masks together) relative to the current image by editing the
 * document placement (`Editor.placement`); pixels are never resampled.
 *
 * Activated by the "Move drawing" toggle in the layers panel footer -- not a
 * rail tool and has no keyboard shortcut (V is the per-layer Move tool,
 * `moveLayer.ts`).
 *
 * - Drag moves (whole image px, so an unscaled drawing stays pixel-exact).
 * - Wheel while the button is held scales around the cursor
 *   ({@link wheelScaleFactor}: 1.05 per notch, trackpads proportional); the
 *   wheel without a drag still zooms the view (`ui/stageInput.ts`).
 * - Arrows nudge 1 image px, Shift+arrows 10 (while Move is active).
 * - Esc during a drag restores the placement from the drag start.
 * - Options bar: X / Y (image px), Scale %, "Reset position".
 *
 * Not undoable (SPEC M5): placement never enters the paint history.
 */

import type { Editor } from "../engine/editor";
import { docToImage } from "../engine/frameMap";
import { imageOffsetToPlacement, translatePlacement, wheelScaleFactor } from "../engine/placementMath";
import type { Placement } from "../document/types";
import type { Point } from "../geometry/rect";
import type { OptionDescriptor, OptionValue, ToolOptions } from "./options";
import type { Tool, ToolCursor, ToolPointer } from "./types";

/** Largest X / Y shown in the options bar (image px). */
const OFFSET_LIMIT = 16384;

const DESCRIPTORS: readonly OptionDescriptor[] = [
  { kind: "number", key: "x", label: "X", title: "Horizontal offset (image px; arrows nudge)", min: -OFFSET_LIMIT, max: OFFSET_LIMIT, step: 1, unit: "px" },
  { kind: "number", key: "y", label: "Y", title: "Vertical offset (image px; arrows nudge)", min: -OFFSET_LIMIT, max: OFFSET_LIMIT, step: 1, unit: "px" },
  { kind: "number", key: "scale", label: "Scale", title: "Drawing scale (wheel while dragging)", min: 5, max: 2000, step: 0.1, unit: "%", scale: 100, curve: "pow" },
  { kind: "button", key: "reset", label: "Reset position", title: "Put the drawing back where it was painted", group: "reset" },
];

/** Arrow key -> unit direction. */
const ARROWS: Readonly<Record<string, readonly [number, number]>> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

/** A drag in progress. */
interface MoveDrag {
  /** Placement at pointer-down (Esc restores it). */
  start: Placement;
  /** Placement the current translation is relative to (re-anchored after wheel scaling). */
  anchor: Placement;
  /** Image point of the pointer when `anchor` was taken. */
  from: Point;
}

/**
 * Options of the Move drawing tool: live views of the editor's placement.
 */
class MoveOptions implements ToolOptions {
  readonly descriptors = DESCRIPTORS;

  /**
   * @param editor - Editor whose placement is edited.
   */
  constructor(private readonly editor: Editor) {}

  /** @inheritdoc */
  get(key: string): OptionValue | undefined {
    const placement = this.editor.placement;
    switch (key) {
      case "x":
        return placement.imageOffset.x;
      case "y":
        return placement.imageOffset.y;
      case "scale":
        return placement.current.scale;
      case "reset":
        return placement.isMoved;
      default:
        return undefined;
    }
  }

  /** @inheritdoc */
  set(key: string, value: OptionValue): boolean {
    const { editor } = this;
    const current = editor.placement.current;
    const next: Placement = { ...current };
    if (key === "reset") {
      if (value !== true || !editor.placement.isMoved) return false;
      editor.placement.reset();
      return true;
    }
    if (typeof value !== "number" || !Number.isFinite(value)) return false;
    const toDoc = (px: number): number => imageOffsetToPlacement(px, editor.doc.frame, editor.imageSize);
    if (key === "x") next.x = toDoc(value);
    else if (key === "y") next.y = toDoc(value);
    else if (key === "scale") next.scale = value;
    else return false;
    editor.placement.set(next);
    const after = editor.placement.current;
    return after.x !== current.x || after.y !== current.y || after.scale !== current.scale;
  }
}

/**
 * The Move drawing tool: repositions and scales the whole drawing without
 * entering the rail or consuming a keyboard shortcut.
 */
export class MoveTool implements Tool {
  readonly id = "move";
  readonly label = "Move drawing";
  /** No keyboard shortcut; V is the layer Move tool (`moveLayer.ts`). */
  readonly shortcut = "";
  readonly icon = "moveDrawing";
  /** Hidden from the tool rail; activated by the layers panel footer toggle. */
  readonly rail = false;
  /** Ctrl never swaps in the layer Move tool while moving the drawing. */
  readonly ctrlMove = false;
  readonly options: ToolOptions;
  private drag: MoveDrag | null = null;

  /**
   * @param editor - Editor of the session (the options read its placement).
   */
  constructor(editor: Editor) {
    this.options = new MoveOptions(editor);
  }

  /** @inheritdoc */
  onPointerDown(editor: Editor, samples: readonly ToolPointer[]): void {
    const first = samples[0];
    if (!first) return;
    const start = editor.placement.current;
    this.drag = { start, anchor: start, from: docToImage(editor.frameMap, first) };
  }

  /** @inheritdoc */
  onPointerMove(editor: Editor, samples: readonly ToolPointer[]): void {
    const last = samples[samples.length - 1];
    if (last) this.moveTo(editor, last, false);
  }

  /** @inheritdoc */
  onPointerUp(editor: Editor, sample: ToolPointer): void {
    if (!this.drag) return;
    this.moveTo(editor, sample, false);
    this.drag = null;
    editor.placement.commit();
  }

  /** @inheritdoc */
  onCancel(editor: Editor): void {
    const drag = this.drag;
    this.drag = null;
    if (drag) editor.placement.set(drag.start);
  }

  /** @inheritdoc */
  onWheel(editor: Editor, deltaPx: number, at: ToolPointer): void {
    const drag = this.drag;
    if (!drag) return;
    const point = docToImage(editor.frameMap, at);
    editor.placement.scaleAt(wheelScaleFactor(deltaPx), point, false);
    // Later pointer moves translate from the scaled placement.
    drag.anchor = editor.placement.current;
    drag.from = point;
  }

  /** @inheritdoc */
  onKey(editor: Editor, event: KeyboardEvent): boolean {
    const dir = ARROWS[event.key];
    if (!dir) return false;
    // A nudge mid-drag would fight the drag anchor: swallow it.
    if (this.drag) return true;
    const step = event.shiftKey ? 10 : 1;
    editor.placement.translateImage(dir[0] * step, dir[1] * step);
    return true;
  }

  /** @inheritdoc */
  cursor(): ToolCursor {
    return { kind: "icon", icon: "move" };
  }

  /**
   * Translate from the drag anchor by the pointer's (whole) image-px delta.
   * The sample was converted with the current frame map, so mapping it back
   * gives the true image point even though the placement keeps changing.
   */
  private moveTo(editor: Editor, sample: ToolPointer, commit: boolean): void {
    const drag = this.drag;
    if (!drag) return;
    const q = docToImage(editor.frameMap, sample);
    const dx = Math.round(q.x - drag.from.x);
    const dy = Math.round(q.y - drag.from.y);
    editor.placement.set(translatePlacement(drag.anchor, editor.doc.frame, editor.imageSize, dx, dy), commit);
  }
}

/**
 * Create the Move drawing tool for a session's editor.
 * @param editor - Session editor.
 * @returns The tool.
 */
export function createMoveTool(editor: Editor): MoveTool {
  return new MoveTool(editor);
}