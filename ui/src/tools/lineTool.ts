/**
 * Line and Arrow tools (U / Shift+U, SPEC Tools table): one implementation,
 * two tools -- Arrow is a line whose arrowhead option defaults to "end".
 * Round caps, foreground colour, Shift snaps the angle to 15 degrees.
 */

import { snapAngle } from "../engine/shapes";
import type { ArrowHeads, ShapeSpec } from "../engine/shapes";
import { OPACITY_OPTION, ShapeTool, WIDTH_OPTION } from "./shapeTool";
import type { ShapeDrag } from "./shapeTool";
import type { OptionDescriptor } from "./options";

/** Stored options of the line/arrow tools. */
export type LineOptions = {
  /** Line width in image px. */
  width: number;
  /** 0..1 */
  opacity: number;
  heads: ArrowHeads;
  /** Arrowhead length as a multiple of the width. */
  headSize: number;
};

/** Options bar layout of the line/arrow tools. */
export const LINE_OPTION_DESCRIPTORS: readonly OptionDescriptor[] = [
  WIDTH_OPTION,
  OPACITY_OPTION,
  {
    kind: "select",
    key: "heads",
    label: "Arrow",
    title: "Arrowheads",
    choices: [
      { value: "none", label: "None" },
      { value: "end", label: "End" },
      { value: "both", label: "Both" },
    ],
    group: "arrow",
  },
  {
    kind: "number",
    key: "headSize",
    label: "Head",
    title: "Arrowhead length (% of width)",
    min: 150,
    max: 1500,
    step: 10,
    unit: "%",
    scale: 100,
    group: "arrow",
  },
];

/**
 * A line with optional arrowheads.
 */
export class LineTool extends ShapeTool<LineOptions> {
  /** @inheritdoc */
  protected buildShape(drag: ShapeDrag): ShapeSpec {
    const { start, pointer } = drag;
    const end = pointer.shiftKey ? snapAngle(start, pointer) : { x: pointer.x, y: pointer.y };
    return {
      kind: "line",
      from: start,
      to: end,
      width: drag.width,
      heads: this.values.heads,
      headRatio: this.values.headSize,
      color: drag.fg,
    };
  }
}

/**
 * Line tool (no arrowheads by default).
 * @returns The tool.
 */
export function createLineTool(): LineTool {
  return new LineTool({
    id: "line",
    label: "Line",
    shortcut: "u",
    icon: "line",
    descriptors: LINE_OPTION_DESCRIPTORS,
    defaults: { width: 4, opacity: 1, heads: "none", headSize: 4 },
  });
}

/**
 * Arrow tool (arrowhead at the end by default).
 * @returns The tool.
 */
export function createArrowTool(): LineTool {
  return new LineTool({
    id: "arrow",
    label: "Arrow",
    shortcut: "u",
    icon: "arrow",
    descriptors: LINE_OPTION_DESCRIPTORS,
    defaults: { width: 4, opacity: 1, heads: "end", headSize: 4 },
  });
}
