/**
 * Shared drag handling of the shape tools (line/arrow, rectangle/ellipse):
 * pointer-down opens a stroke on the paint target (layer or Quick Mask),
 * every move rebuilds the whole shape from the drag start and the current
 * pointer (`editor.drawShape`, a live preview in the stroke buffer), and
 * pointer-up rasterizes it into the layer as one undo patch. Cancel (Esc,
 * tool switch, pointer cancel) drops it.
 *
 * Widths are in image px like brush size and are converted to document px
 * through the frame-map scale at pointer-down. Colours are read from
 * `editor.colors` at pointer-down.
 *
 * Modifiers are read from every sample (the stage re-sends the last sample
 * when Shift/Alt change mid-drag). Alt at pointer-down belongs to the
 * temporary eyedropper (SPEC Tools table), which takes the whole press
 * before the tool sees it, so an Alt seen here was pressed during the drag
 * (Photoshop: Alt = from centre once the drag has started).
 */

import type { Editor } from "../engine/editor";
import { imageLengthToDoc } from "../engine/frameMap";
import type { ShapeSpec } from "../engine/shapes";
import type { Point } from "../geometry/rect";
import { OptionSet } from "./options";
import type { OptionDescriptor, OptionValues } from "./options";
import type { Tool, ToolCursor, ToolPointer } from "./types";

/** Values every shape tool stores. */
export type ShapeBaseOptions = OptionValues & {
  /** Line / stroke width in image px. */
  width: number;
  /** 0..1, applied once when the shape is committed. */
  opacity: number;
};

/** What a shape is built from. */
export interface ShapeDrag {
  /** Pointer-down point, document coords. */
  start: Point;
  /** Current pointer (position + modifiers). */
  pointer: ToolPointer;
  /** Width option converted to document px. */
  width: number;
  /** Foreground / background colours at pointer-down. */
  fg: string;
  bg: string;
}

/** Static description of a shape tool. */
export interface ShapeToolSpec<V extends ShapeBaseOptions> {
  id: string;
  label: string;
  shortcut: string;
  icon: string;
  descriptors: readonly OptionDescriptor[];
  defaults: V;
}

/** Width option shared by the shape tools. */
export const WIDTH_OPTION: OptionDescriptor = {
  kind: "number",
  key: "width",
  label: "Width",
  title: "Line / stroke width",
  min: 1,
  max: 500,
  step: 1,
  unit: "px",
  curve: "pow",
};

/** Opacity option shared by the shape tools (keys 1..9, 0 set it). */
export const OPACITY_OPTION: OptionDescriptor = {
  kind: "number",
  key: "opacity",
  label: "Opac",
  title: "Opacity (1..9, 0)",
  min: 1,
  max: 100,
  step: 1,
  unit: "%",
  scale: 100,
};

/**
 * Base class of the drag-to-draw shape tools.
 */
export abstract class ShapeTool<V extends ShapeBaseOptions> implements Tool {
  readonly id: string;
  readonly label: string;
  readonly shortcut: string;
  readonly icon: string;
  readonly options: OptionSet;
  /** Alt at pointer-down = temporary eyedropper (SPEC Tools table). */
  readonly altEyedropper = true;
  /** Stored option values (edited in place through {@link options}). */
  readonly values: V;
  private drag: Omit<ShapeDrag, "pointer"> | null = null;

  /**
   * @param spec - Id, label, shortcut, icon, option layout and defaults.
   */
  constructor(spec: ShapeToolSpec<V>) {
    this.id = spec.id;
    this.label = spec.label;
    this.shortcut = spec.shortcut;
    this.icon = spec.icon;
    this.values = { ...spec.defaults };
    this.options = new OptionSet(spec.descriptors, this.values);
  }

  /**
   * Build the shape for the current drag state.
   * @param drag - Start, pointer, width and colours.
   * @returns Shape in document coords.
   */
  protected abstract buildShape(drag: ShapeDrag): ShapeSpec;

  /** @inheritdoc */
  onPointerDown(editor: Editor, samples: readonly ToolPointer[]): void {
    const first = samples[0];
    if (!first || this.drag) return;
    const { fg, bg } = editor.colors;
    if (!editor.beginStroke({ mode: "paint", opacity: this.values.opacity, hardness: 1, color: fg }, 1)) return;
    this.drag = { start: { x: first.x, y: first.y }, width: imageLengthToDoc(editor.frameMap, this.values.width), fg, bg };
    this.update(editor, samples.at(-1) ?? first);
  }

  /** @inheritdoc */
  onPointerMove(editor: Editor, samples: readonly ToolPointer[]): void {
    const last = samples.at(-1);
    if (last) this.update(editor, last);
  }

  /** @inheritdoc */
  onPointerUp(editor: Editor, sample: ToolPointer): void {
    if (!this.drag) return;
    this.update(editor, sample);
    this.drag = null;
    editor.endStroke(null);
  }

  /** @inheritdoc */
  onCancel(editor: Editor): void {
    if (!this.drag) return;
    this.drag = null;
    editor.cancelStroke();
  }

  /** @inheritdoc */
  cursor(): ToolCursor {
    return { kind: "icon", icon: "crosshair" };
  }

  private update(editor: Editor, pointer: ToolPointer): void {
    if (this.drag) editor.drawShape(this.buildShape({ ...this.drag, pointer }));
  }
}
