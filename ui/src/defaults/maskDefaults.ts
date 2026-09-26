/**
 * The "Defaults" settings for new mask layers (SPEC "Settings"):
 * `PainterSketch.DefaultMaskColor` and `PainterSketch.DefaultMaskOpacity`.
 *
 * They style the FIRST mask of a document -- the one a new document is
 * created with, or the one added lazily to a document saved without a mask.
 * Existing masks are never changed. M8 (multiple masks) keeps this as the
 * first colour and adds a palette for further masks.
 *
 * Pure (no ComfyUI imports) so the sanitizers are unit-testable; reading the
 * values is `readDefaults.ts`.
 */

import { DEFAULT_MASK_STYLE } from "../document/create";
import type { MaskStyle } from "../document/create";
import type { SettingParams } from "../types/comfy";

/** Setting id: first mask colour. */
export const MASK_COLOR_ID = "PainterSketch.DefaultMaskColor";
/** Setting id: first mask overlay opacity (percent). */
export const MASK_OPACITY_ID = "PainterSketch.DefaultMaskOpacity";

const OPACITY_MIN = 10;
const OPACITY_MAX = 100;

/** Settings-panel entry: colour picker (stored as hex without `#`, like core color settings). */
export const MASK_COLOR_SETTING: SettingParams = {
  id: MASK_COLOR_ID,
  category: ["PainterSketch", "Defaults", "Mask colour"],
  name: "Mask colour",
  tooltip: "Overlay colour of the mask in new documents. Existing masks keep their colour.",
  type: "color",
  defaultValue: DEFAULT_MASK_STYLE.color.slice(1),
};

/** Settings-panel entry: overlay opacity slider, percent. */
export const MASK_OPACITY_SETTING: SettingParams = {
  id: MASK_OPACITY_ID,
  category: ["PainterSketch", "Defaults", "Mask overlay opacity"],
  name: "Mask overlay opacity (%)",
  tooltip:
    "How strongly the mask overlay is drawn in new documents (display only; the MASK output is unaffected). " +
    "Existing masks keep theirs.",
  type: "slider",
  attrs: { min: OPACITY_MIN, max: OPACITY_MAX, step: 1 },
  defaultValue: Math.round(DEFAULT_MASK_STYLE.opacity * 100),
};

// ── Sanitizers ────────────────────────────────────────────────────────────────

/**
 * Normalize a stored colour setting to `#rrggbb` (lowercase). Accepts
 * `rgb` / `rrggbb` / `rrggbbaa` with or without `#` (alpha is dropped: the
 * overlay opacity is its own setting); anything else gives the default.
 * @param raw - Stored setting value.
 * @returns `#rrggbb`.
 */
export function normalizeMaskColor(raw: unknown): string {
  if (typeof raw !== "string") return DEFAULT_MASK_STYLE.color;
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(raw.trim());
  const hex = match?.[1]?.toLowerCase();
  if (!hex) return DEFAULT_MASK_STYLE.color;
  if (hex.length === 3) return `#${[...hex].map((c) => c + c).join("")}`;
  return `#${hex.slice(0, 6)}`;
}

/**
 * Normalize a stored opacity percent (10..100, whole percent) to 0..1.
 * @param raw - Stored setting value.
 * @returns Opacity fraction (default 0.5 for junk).
 */
export function normalizeMaskOpacity(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return DEFAULT_MASK_STYLE.opacity;
  return Math.min(OPACITY_MAX, Math.max(OPACITY_MIN, Math.round(raw))) / 100;
}

/**
 * Style of the first mask layer from raw setting values.
 * @param read - Setting reader (`undefined` = unavailable -> defaults).
 * @returns Colour + opacity.
 */
export function firstMaskStyleFrom(read: (id: string) => unknown): MaskStyle {
  return { color: normalizeMaskColor(read(MASK_COLOR_ID)), opacity: normalizeMaskOpacity(read(MASK_OPACITY_ID)) };
}
