/**
 * The `PainterSketch.PaintQuality` setting: format for saved paint layers.
 * Below 100: lossy WebP at that quality (much smaller, minimal quality loss).
 * 100: lossless PNG (Chrome lossless WebP measured ~2x PNG; PNG is the better
 * lossless choice). Masks are always PNG regardless.
 * Read at upload time (`persistence.ts`), so changing it only affects future
 * uploads. Pure (no ComfyUI imports) so it is unit-testable.
 */

import type { SettingParams } from "../types/comfy";

/** Setting id. */
export const PAINT_QUALITY_ID = "PainterSketch.PaintQuality";
/** Default (lossy WebP at 99 quality). */
export const PAINT_QUALITY_DEFAULT = 99;
const MIN = 50;
const MAX = 100;

/** Settings-panel entry for the paint quality slider. */
export const PAINT_QUALITY_SETTING: SettingParams = {
  id: PAINT_QUALITY_ID,
  category: ["PainterSketch", "Storage", "Paint layer quality"],
  name: "Paint layer quality",
  tooltip:
    "Paint layer quality. Below 100 saves lossy WebP (much smaller); 100 saves lossless PNG. " +
    "Masks are always PNG.",
  type: "slider",
  attrs: { min: MIN, max: MAX, step: 1 },
  defaultValue: PAINT_QUALITY_DEFAULT,
};

/**
 * Clamps a raw setting value to an integer in 50..100 (default for junk).
 * @param raw - Stored setting value.
 * @returns Quality percent.
 */
export function normalizePaintQuality(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return PAINT_QUALITY_DEFAULT;
  return Math.min(MAX, Math.max(MIN, Math.round(raw)));
}
