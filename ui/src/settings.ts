/**
 * PainterSketch entries for the ComfyUI settings panel.
 *
 * `SETTINGS` is registered through the extension's `settings` field in
 * `main.ts`. Each feature owns its own entry (and the id constant used to read
 * it); this file only collects them. IDs are prefixed `PainterSketch.`.
 */

import type { SettingParams } from "./types/comfy";

import { CLEANUP_SETTING } from "./cleanup/cleanupSetting";
import { PAINT_QUALITY_SETTING } from "./widget/paintQuality";

/** All PainterSketch settings, in panel order. */
export const SETTINGS: SettingParams[] = [
  PAINT_QUALITY_SETTING,
  CLEANUP_SETTING,
];
