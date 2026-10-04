/**
 * Editor mode (SPEC "Simple mode"): `simple` hides the advanced chrome (Layers /
 * Outputs panel, clipboard buttons, the bucket / shape / text tools, most of
 * the bottom bar's right side); `advanced` shows everything. Shortcuts work in
 * both.
 *
 * Each node remembers its own mode in `node.properties` (UI state, not
 * document state: it never reaches the backend, so switching modes never
 * re-runs the node). A node without one (new, or saved before modes existed)
 * takes the "Default editor mode" setting once and keeps it.
 *
 * Pure (no ComfyUI imports) so the sanitizer is unit-testable; reading the
 * setting is `readDefaults.ts`.
 */

import type { SettingParams } from "../types/comfy";

/** Which chrome the editor shows. */
export type EditorMode = "simple" | "advanced";

/** Built-in default mode. */
export const DEFAULT_MODE: EditorMode = "simple";

/** Setting id: mode of new nodes. */
export const MODE_SETTING_ID = "PainterSketch.DefaultMode";

/** `node.properties` key holding a node's mode. */
export const MODE_PROPERTY = "PainterSketch mode";

/** Settings-panel entry. */
export const MODE_SETTING: SettingParams = {
  id: MODE_SETTING_ID,
  category: ["PainterSketch", "Defaults", "Editor mode"],
  name: "Default editor mode",
  tooltip:
    "Simple hides the Layers / Outputs panel, the clipboard buttons and the bucket, shape and text tools (their shortcuts still work). " +
    "Each node remembers its own mode (the toggle under its title, or Tab); this applies to nodes created afterwards.",
  type: "combo",
  options: [
    { text: "Simple", value: "simple" },
    { text: "Advanced", value: "advanced" },
  ],
  defaultValue: DEFAULT_MODE,
  // First in the panel (its group sorts first, and it sorts first in the group).
  sortOrder: 100,
};

/**
 * A stored mode value, or `null` for anything else.
 * @param raw - Stored value (setting or node property).
 * @returns The mode, or `null`.
 */
export function parseMode(raw: unknown): EditorMode | null {
  return raw === "simple" || raw === "advanced" ? raw : null;
}
