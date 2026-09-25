/**
 * Brush tool (B): paints the foreground colour.
 */

import { PaintTool } from "./paintTool";

/**
 * Create a brush tool with default options.
 * @returns The tool.
 */
export function createBrushTool(): PaintTool {
  return new PaintTool("brush", "Brush", "b", "paint", {
    size: 24,
    hardness: 0.8,
    opacity: 1,
    flow: 1,
    spacing: 0.1,
    pressureSize: true,
    pressureOpacity: false,
    color: "#000000",
  });
}
