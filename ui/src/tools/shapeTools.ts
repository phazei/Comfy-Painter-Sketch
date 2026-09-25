/**
 * The shape tool group (U / Shift+U): Line, Arrow, Rectangle, Ellipse in
 * cycle order, sharing one rail slot.
 */

import { createEllipseTool, createRectangleTool } from "./boxShapeTool";
import { createArrowTool, createLineTool } from "./lineTool";
import type { ToolGroupSpec } from "./toolGroups";
import type { Tool } from "./types";

/** Rail group of the shape tools. */
export const SHAPE_GROUP: ToolGroupSpec = { id: "shape", label: "Shape", toolIds: ["line", "arrow", "rectangle", "ellipse"] };

/**
 * Create the shape tools in {@link SHAPE_GROUP} order.
 * @returns New tools.
 */
export function createShapeTools(): Tool[] {
  return [createLineTool(), createArrowTool(), createRectangleTool(), createEllipseTool()];
}
