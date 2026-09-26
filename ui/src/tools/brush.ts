/**
 * Brush tool (B): paints the foreground colour.
 */

import { PRESSURE_DEFAULTS } from "../defaults/pressureDefaults";
import type { PressureDefaults } from "../defaults/pressureDefaults";
import { PaintTool } from "./paintTool";

/**
 * Create a brush tool with default options.
 * @param pressure - Initial pressure options (the user's settings; built-in by default).
 * @returns The tool.
 */
export function createBrushTool(pressure: Readonly<PressureDefaults> = PRESSURE_DEFAULTS): PaintTool {
  return new PaintTool({
    id: "brush",
    label: "Brush",
    shortcut: "b",
    icon: "brush",
    mode: "paint",
    altEyedropper: true,
    defaults: {
      size: 24,
      hardness: 0.8,
      opacity: 1,
      flow: 1,
      spacing: 0.1,
      ...pressure,
    },
  });
}
