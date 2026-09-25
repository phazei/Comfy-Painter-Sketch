/**
 * Eraser tool (E): same stroke-buffer path as the brush, composited with
 * `destination-out`.
 */

import { PaintTool } from "./paintTool";

/**
 * Create an eraser tool with default options.
 * @returns The tool.
 */
export function createEraserTool(): PaintTool {
  return new PaintTool("eraser", "Eraser", "e", "erase", {
    size: 48,
    hardness: 0.8,
    opacity: 1,
    flow: 1,
    spacing: 0.1,
    pressureSize: true,
    pressureOpacity: false,
  });
}
