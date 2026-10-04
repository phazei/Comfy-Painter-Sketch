/**
 * PainterSketch entries for the ComfyUI settings panel.
 *
 * `SETTINGS` is registered through the extension's `settings` field in
 * `main.ts`. Each feature owns its own entry (and the id constant used to read
 * it); this file only collects them. IDs are prefixed `PainterSketch.`.
 * Groups: "Storage" (paint quality, cleanup), "Defaults" (editor mode, new masks, pen
 * pressure, bucket/wand sample source).
 */

import type { SettingParams } from "./types/comfy";

import { CLEANUP_SETTING } from "./cleanup/cleanupSetting";
import { MASK_COLOR_SETTING, MASK_OPACITY_SETTING } from "./defaults/maskDefaults";
import { MODE_SETTING } from "./defaults/modeDefaults";
import { PRESSURE_SETTINGS } from "./defaults/pressureDefaults";
import { SAMPLE_SETTINGS } from "./defaults/sampleDefaults";
import { PAINT_QUALITY_SETTING } from "./widget/paintQuality";

/** All PainterSketch settings, in panel order. */
export const SETTINGS: SettingParams[] = [
  PAINT_QUALITY_SETTING,
  CLEANUP_SETTING,
  MODE_SETTING,
  MASK_COLOR_SETTING,
  MASK_OPACITY_SETTING,
  ...PRESSURE_SETTINGS,
  ...SAMPLE_SETTINGS,
];
