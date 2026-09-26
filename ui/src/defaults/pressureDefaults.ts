/**
 * The "Defaults" settings for the pen pressure curve of the brush and eraser
 * (SPEC "Pressure", "Settings"): pressure -> size, pressure -> opacity, min
 * size and gamma.
 *
 * They are the INITIAL option values of a new editor session (read once when
 * the session's tools are created). In-session changes in the options bar
 * win; changing a setting never touches live tools -- new sessions pick it up.
 *
 * Pure (no ComfyUI imports) so the sanitizers are unit-testable; reading the
 * values is `readDefaults.ts`.
 */

import type { SettingParams } from "../types/comfy";

/** The pressure part of the brush/eraser options (stored units: fractions). */
export interface PressureDefaults {
  pressureSize: boolean;
  pressureOpacity: boolean;
  /** Size at zero pressure, fraction of the size (0..1). */
  minSize: number;
  /** Curve exponent (1 = linear). */
  gamma: number;
}

/** Built-in pressure defaults (also the brush/eraser code defaults). */
export const PRESSURE_DEFAULTS: Readonly<PressureDefaults> = {
  pressureSize: true,
  pressureOpacity: false,
  minSize: 0.1,
  gamma: 1,
};

/** Setting id: pressure -> size toggle. */
export const PRESSURE_SIZE_ID = "PainterSketch.PressureSize";
/** Setting id: pressure -> opacity toggle. */
export const PRESSURE_OPACITY_ID = "PainterSketch.PressureOpacity";
/** Setting id: min size, percent. */
export const PRESSURE_MIN_SIZE_ID = "PainterSketch.PressureMinSize";
/** Setting id: curve gamma. */
export const PRESSURE_GAMMA_ID = "PainterSketch.PressureGamma";

// Same ranges as the options-bar descriptors (`tools/paintTool.ts`).
const MIN_SIZE_MAX = 100;
const GAMMA_MIN = 0.2;
const GAMMA_MAX = 5;
const GAMMA_STEP = 0.05;

const NOTE = " Applies to the brush and eraser of editors opened afterwards; changes in the options bar win.";

/** Settings-panel entries, in panel order. */
export const PRESSURE_SETTINGS: SettingParams[] = [
  {
    id: PRESSURE_SIZE_ID,
    category: ["PainterSketch", "Defaults", "Pressure size"],
    name: "Pen pressure controls size",
    tooltip: "Default of the brush/eraser 'Size' pressure toggle." + NOTE,
    type: "boolean",
    defaultValue: PRESSURE_DEFAULTS.pressureSize,
  },
  {
    id: PRESSURE_OPACITY_ID,
    category: ["PainterSketch", "Defaults", "Pressure opacity"],
    name: "Pen pressure controls opacity",
    tooltip: "Default of the brush/eraser 'Opacity' pressure toggle." + NOTE,
    type: "boolean",
    defaultValue: PRESSURE_DEFAULTS.pressureOpacity,
  },
  {
    id: PRESSURE_MIN_SIZE_ID,
    category: ["PainterSketch", "Defaults", "Pressure min size"],
    name: "Pressure min size (%)",
    tooltip: "Brush size at zero pressure, as a percentage of the size." + NOTE,
    type: "slider",
    attrs: { min: 0, max: MIN_SIZE_MAX, step: 1 },
    defaultValue: Math.round(PRESSURE_DEFAULTS.minSize * 100),
  },
  {
    id: PRESSURE_GAMMA_ID,
    category: ["PainterSketch", "Defaults", "Pressure curve"],
    name: "Pressure curve (gamma)",
    tooltip: "1 = linear; above 1 = softer start (needs more pressure)." + NOTE,
    type: "slider",
    attrs: { min: GAMMA_MIN, max: GAMMA_MAX, step: GAMMA_STEP },
    defaultValue: PRESSURE_DEFAULTS.gamma,
  },
];

// ── Sanitizers ────────────────────────────────────────────────────────────────

/**
 * A boolean setting, or the fallback for anything else.
 * @param raw - Stored value.
 * @param fallback - Default.
 * @returns Boolean.
 */
function toBool(raw: unknown, fallback: boolean): boolean {
  return typeof raw === "boolean" ? raw : fallback;
}

/**
 * Min size percent (0..100, whole percent) -> fraction.
 * @param raw - Stored setting value.
 * @returns 0..1 (default for junk).
 */
export function normalizeMinSize(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return PRESSURE_DEFAULTS.minSize;
  return Math.min(MIN_SIZE_MAX, Math.max(0, Math.round(raw))) / 100;
}

/**
 * Gamma clamped to 0.2..5 and snapped to 0.05 (the slider can hand back
 * float noise such as 1.1500000000000001).
 * @param raw - Stored setting value.
 * @returns Gamma (default for junk).
 */
export function normalizeGamma(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return PRESSURE_DEFAULTS.gamma;
  const snapped = Math.round(raw / GAMMA_STEP) * GAMMA_STEP;
  return Number(Math.min(GAMMA_MAX, Math.max(GAMMA_MIN, snapped)).toFixed(2));
}

/**
 * Pressure defaults from raw setting values.
 * @param read - Setting reader (`undefined` values -> defaults).
 * @returns Sanitized defaults.
 */
export function pressureDefaultsFrom(read: (id: string) => unknown): PressureDefaults {
  return {
    pressureSize: toBool(read(PRESSURE_SIZE_ID), PRESSURE_DEFAULTS.pressureSize),
    pressureOpacity: toBool(read(PRESSURE_OPACITY_ID), PRESSURE_DEFAULTS.pressureOpacity),
    minSize: normalizeMinSize(read(PRESSURE_MIN_SIZE_ID)),
    gamma: normalizeGamma(read(PRESSURE_GAMMA_ID)),
  };
}
