/**
 * Eraser tool (E): same stroke-buffer path as the brush, composited with
 * `destination-out`.
 */

import { PRESSURE_DEFAULTS } from "../defaults/pressureDefaults";
import type { PressureDefaults } from "../defaults/pressureDefaults";
import { PaintTool } from "./paintTool";

/**
 * Create an eraser tool with default options.
 * @param pressure - Initial pressure options (the user's settings; built-in by default).
 * @returns The tool.
 */
export function createEraserTool(pressure: Readonly<PressureDefaults> = PRESSURE_DEFAULTS): PaintTool {
  return new PaintTool({
    id: "eraser",
    label: "Eraser",
    shortcut: "e",
    icon: "eraser",
    mode: "erase",
    defaults: {
      size: 48,
      hardness: 0.8,
      opacity: 1,
      flow: 1,
      spacing: 0.25,
      ...pressure,
    },
  });
}
