/**
 * Colours of the picker's two circle groups (`colorWheel.ts`, SPEC "Colour"),
 * pure:
 * - **Harmonies** (top-right gap): hue partners at the base's saturation and
 *   value -- Analogous (±30°), Triadic (±120°), Split-complementary
 *   (180° ±30°).
 * - **Variations** (bottom-right gap): neighbours of the base for shading --
 *   Lighter / darker (mixed 30 % with white / black), Warmer / cooler (mixed
 *   20 % with an orange / a blue), More / less saturated (±25 %).
 *
 * Each group cycles its modes with a button; {@link SchemeSet} describes one
 * group so the wheel can build both the same way.
 */

import { clamp01, hsvToRgb, rgbToHsv, type Hsv, type Rgb } from "./colorMath";

/** One circle group's modes and colours. */
export interface SchemeSet {
  /** Cycle order of the modes (the first is the default). */
  readonly modes: readonly string[];
  /** `localStorage` key of the chosen mode. */
  readonly storageKey: string;
  /** Button title prefix ("Harmony", "Variations"). */
  readonly title: string;
  /** Icon name of the cycle button. */
  readonly icon: string;
  /**
   * @param mode - A mode.
   * @returns Its display name.
   */
  label(mode: string): string;
  /**
   * @param mode - A mode.
   * @returns Tooltip names of the two partners (first, second).
   */
  partnerLabels(mode: string): readonly [string, string];
  /**
   * @param base - Current colour.
   * @param mode - A mode.
   * @returns Partner, base, partner.
   */
  colors(base: Hsv, mode: string): [Hsv, Hsv, Hsv];
}

/**
 * The mode after `mode` in a cycle.
 * @param modes - Cycle order.
 * @param mode - Current mode.
 * @returns The next mode (the first for unknown modes).
 */
export function nextMode(modes: readonly string[], mode: string): string {
  return modes[(modes.indexOf(mode) + 1) % modes.length] ?? modes[0] ?? mode;
}

/**
 * Narrow a stored value to one of `modes`.
 * @param modes - Valid modes (the first is the fallback).
 * @param raw - Stored string.
 * @returns The mode.
 */
export function parseMode(modes: readonly string[], raw: string | null): string {
  return modes.find((m) => m === raw) ?? modes[0] ?? "";
}

// ═══════════════════════════════════════════════════════════════════════════
// Harmonies
// ═══════════════════════════════════════════════════════════════════════════

const HARMONY: Readonly<Record<string, { label: string; offsets: readonly [number, number] }>> = {
  analogous: { label: "Analogous", offsets: [-30, 30] },
  triadic: { label: "Triadic", offsets: [-120, 120] },
  split: { label: "Split-complementary", offsets: [150, 210] },
};

/**
 * Hue partners of `base` at its saturation and value.
 * @param base - Current colour.
 * @param mode - `analogous` | `triadic` | `split` (others: analogous).
 * @returns Partner, base, partner.
 */
export function harmonyColors(base: Hsv, mode: string): [Hsv, Hsv, Hsv] {
  const [a, b] = (HARMONY[mode] ?? HARMONY["analogous"])?.offsets ?? [-30, 30];
  const turn = (offset: number): Hsv => ({ h: wrapHue(base.h + offset), s: base.s, v: base.v });
  return [turn(a), { ...base }, turn(b)];
}

/** The harmony circles (top-right gap). */
export const HARMONY_SET: SchemeSet = {
  modes: ["analogous", "triadic", "split"],
  storageKey: "PainterSketch.colorHarmony",
  title: "Harmony",
  icon: "colorWheel",
  label: (mode) => HARMONY[mode]?.label ?? mode,
  partnerLabels: (mode) => {
    const label = HARMONY[mode]?.label ?? mode;
    return [label, label];
  },
  colors: harmonyColors,
};

// ═══════════════════════════════════════════════════════════════════════════
// Variations
// ═══════════════════════════════════════════════════════════════════════════

/** Share of white / black mixed in for Lighter / Darker. */
const TONE_MIX = 0.3;
/** Share of the warm / cool colour mixed in for Warmer / Cooler. */
const TEMPERATURE_MIX = 0.2;
/** Warm and cool mixing colours (an orange, about 25°; a blue, about 219°). */
const WARM: Rgb = { r: 255, g: 122, b: 26 };
const COOL: Rgb = { r: 26, g: 108, b: 255 };
/** Saturation step of More / Less saturated. */
const SATURATION_STEP = 0.25;

const VARIATION: Readonly<Record<string, { label: string; partners: readonly [string, string] }>> = {
  tone: { label: "Lighter / darker", partners: ["Lighter", "Darker"] },
  temperature: { label: "Warmer / cooler", partners: ["Warmer", "Cooler"] },
  saturation: { label: "More / less saturated", partners: ["More saturated", "Less saturated"] },
};

/**
 * Shading neighbours of `base`. Lighter / Darker mix in RGB with white /
 * black (a tint keeps its hue but loses saturation, like paint); Warmer /
 * Cooler mix in an orange / a blue the same way (no hue direction to pick, so
 * no seam anywhere on the wheel; greys warm and cool too; a strong colour
 * mixed with its opposite gets duller, as paint does).
 * @param base - Current colour.
 * @param mode - `tone` | `temperature` | `saturation` (others: tone).
 * @returns First partner, base, second partner.
 */
export function variationColors(base: Hsv, mode: string): [Hsv, Hsv, Hsv] {
  const { h, s, v } = base;
  if (mode === "temperature") {
    return [mixToward(base, WARM, TEMPERATURE_MIX), { ...base }, mixToward(base, COOL, TEMPERATURE_MIX)];
  }
  if (mode === "saturation") {
    return [{ h, s: clamp01(s + SATURATION_STEP), v }, { ...base }, { h, s: clamp01(s - SATURATION_STEP), v }];
  }
  const lightV = v + (1 - v) * TONE_MIX;
  const lighter = { h, s: lightV > 0 ? (s * v * (1 - TONE_MIX)) / lightV : 0, v: lightV };
  return [lighter, { ...base }, { h, s, v: v * (1 - TONE_MIX) }];
}

/** The variation circles (bottom-right gap). */
export const VARIATION_SET: SchemeSet = {
  modes: ["tone", "temperature", "saturation"],
  storageKey: "PainterSketch.colorVariation",
  title: "Variations",
  icon: "colorVariations",
  label: (mode) => VARIATION[mode]?.label ?? mode,
  partnerLabels: (mode) => VARIATION[mode]?.partners ?? ["", ""],
  colors: variationColors,
};

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Mix a colour towards `target` in RGB (like adding a little paint).
 * @param base - Colour.
 * @param target - Colour mixed in.
 * @param amount - Share of `target`, [0, 1].
 * @returns The mix; a grey result keeps `base`'s hue.
 */
export function mixToward(base: Hsv, target: Rgb, amount: number): Hsv {
  const rgb = hsvToRgb(base);
  const mix = (a: number, b: number): number => a + (b - a) * amount;
  const out = rgbToHsv({ r: mix(rgb.r, target.r), g: mix(rgb.g, target.g), b: mix(rgb.b, target.b) });
  return out.s === 0 ? { ...out, h: base.h } : out;
}

function wrapHue(hue: number): number {
  return ((hue % 360) + 360) % 360;
}