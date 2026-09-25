/**
 * Rectangle and Ellipse tools (U / Shift+U, SPEC Tools table). Paint mode
 * stroke / fill / both: stroke and fill-only use the foreground colour;
 * "both" strokes with the foreground and fills with the background
 * (Photoshop's FG/BG pair). Shift = square/circle; Alt pressed during the
 * drag = draw from the centre (Alt at pointer-down is the eyedropper).
 */

import { boxFromDrag } from "../engine/shapes";
import type { BoxPaint, ShapeSpec } from "../engine/shapes";
import { OPACITY_OPTION, ShapeTool, WIDTH_OPTION } from "./shapeTool";
import type { ShapeDrag, ShapeToolSpec } from "./shapeTool";
import type { OptionDescriptor } from "./options";

/** Stored options of the rectangle/ellipse tools. */
export type BoxShapeOptions = {
  paint: BoxPaint;
  /** Stroke width in image px. */
  width: number;
  /** 0..1 */
  opacity: number;
};

/** Options bar layout of the rectangle/ellipse tools. */
export const BOX_OPTION_DESCRIPTORS: readonly OptionDescriptor[] = [
  {
    kind: "select",
    key: "paint",
    label: "Mode",
    title: "Stroke (FG), fill (FG), or both (stroke FG, fill BG)",
    choices: [
      { value: "stroke", label: "Stroke" },
      { value: "fill", label: "Fill" },
      { value: "both", label: "Both" },
    ],
  },
  { ...WIDTH_OPTION, title: "Stroke width" },
  OPACITY_OPTION,
];

/**
 * An axis-aligned rectangle or ellipse.
 */
export class BoxShapeTool extends ShapeTool<BoxShapeOptions> {
  /**
   * @param kind - Rectangle or ellipse.
   * @param spec - Tool spec (see {@link ShapeTool}).
   */
  constructor(
    private readonly kind: "rect" | "ellipse",
    spec: ShapeToolSpec<BoxShapeOptions>,
  ) {
    super(spec);
  }

  /** @inheritdoc */
  protected buildShape(drag: ShapeDrag): ShapeSpec {
    const { start, pointer } = drag;
    const paint = this.values.paint;
    return {
      kind: this.kind,
      rect: boxFromDrag(start, pointer, pointer.shiftKey, pointer.altKey),
      paint,
      strokeWidth: drag.width,
      strokeColor: drag.fg,
      fillColor: paint === "both" ? drag.bg : drag.fg,
    };
  }
}

/**
 * Rectangle tool.
 * @returns The tool.
 */
export function createRectangleTool(): BoxShapeTool {
  return new BoxShapeTool("rect", {
    id: "rectangle",
    label: "Rectangle",
    shortcut: "u",
    icon: "rectangle",
    descriptors: BOX_OPTION_DESCRIPTORS,
    defaults: { paint: "stroke", width: 4, opacity: 1 },
  });
}

/**
 * Ellipse tool.
 * @returns The tool.
 */
export function createEllipseTool(): BoxShapeTool {
  return new BoxShapeTool("ellipse", {
    id: "ellipse",
    label: "Ellipse",
    shortcut: "u",
    icon: "ellipse",
    descriptors: BOX_OPTION_DESCRIPTORS,
    defaults: { paint: "stroke", width: 4, opacity: 1 },
  });
}
