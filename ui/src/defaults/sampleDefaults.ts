/**
 * The "Defaults" settings for what the paint bucket and magic wand sample
 * ("Background" / "Current layer" / "All layers"; SPEC "Tools", "Settings").
 *
 * Like the pressure defaults they are the INITIAL option values of a new
 * editor session: changes in the options bar win, and changing a setting never
 * touches live tools -- new sessions pick it up.
 *
 * Pure (no ComfyUI imports) so the sanitizer is unit-testable; reading the
 * values is `readDefaults.ts`.
 */

import type { SampleSource } from "../engine/pixelOps";
import type { SettingParams } from "../types/comfy";

/** Initial sample source of the sampling tools. */
export interface SampleDefaults {
  bucket: SampleSource;
  wand: SampleSource;
}

/** Built-in defaults (also the tools' code defaults). */
export const SAMPLE_DEFAULTS: Readonly<SampleDefaults> = {
  bucket: "background",
  wand: "background",
};

/** Setting id: paint bucket sample source. */
export const BUCKET_SAMPLE_ID = "PainterSketch.BucketSample";
/** Setting id: magic wand sample source. */
export const WAND_SAMPLE_ID = "PainterSketch.WandSample";

/** Settings-panel choices (value = the option-bar value). */
const CHOICES: { text: string; value: SampleSource }[] = [
  { text: "Background (input image only)", value: "background" },
  { text: "Current layer", value: "layer" },
  { text: "All layers (what you see)", value: "all" },
];

const NOTE = " Applies to editors opened afterwards; the options-bar 'Sample' choice wins.";

/** Settings-panel entries, in panel order. */
export const SAMPLE_SETTINGS: SettingParams[] = [
  {
    id: BUCKET_SAMPLE_ID,
    category: ["PainterSketch", "Defaults", "Bucket sample"],
    name: "Paint bucket samples",
    tooltip: "Which pixels the paint bucket looks at to find the area to fill." + NOTE,
    type: "combo",
    options: CHOICES,
    defaultValue: SAMPLE_DEFAULTS.bucket,
  },
  {
    id: WAND_SAMPLE_ID,
    category: ["PainterSketch", "Defaults", "Wand sample"],
    name: "Magic wand samples",
    tooltip: "Which pixels the magic wand looks at to find the area to select." + NOTE,
    type: "combo",
    options: CHOICES,
    defaultValue: SAMPLE_DEFAULTS.wand,
  },
];

/**
 * A stored sample-source value, or the fallback for anything else.
 * @param raw - Stored setting value.
 * @param fallback - Default.
 * @returns Valid sample source.
 */
export function normalizeSample(raw: unknown, fallback: SampleSource): SampleSource {
  return raw === "background" || raw === "layer" || raw === "all" ? raw : fallback;
}

/**
 * Sample defaults from raw setting values.
 * @param read - Setting reader (`undefined` values -> defaults).
 * @returns Sanitized defaults.
 */
export function sampleDefaultsFrom(read: (id: string) => unknown): SampleDefaults {
  return {
    bucket: normalizeSample(read(BUCKET_SAMPLE_ID), SAMPLE_DEFAULTS.bucket),
    wand: normalizeSample(read(WAND_SAMPLE_ID), SAMPLE_DEFAULTS.wand),
  };
}
