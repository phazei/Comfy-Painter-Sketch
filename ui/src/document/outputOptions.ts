/** Pure normalization and copying of the additive v1 output-processing options. */

import type { OutputOptions } from "./types";

/** Largest `borderSize` accepted (px per side); mirrored in nodes/document_regions.py. */
export const MAX_BORDER_SIZE = 4096;

/** Built-in defaults; callers receive independent mutable copies via `cloneOutputOptions`. */
export const DEFAULT_OUTPUT_OPTIONS: Readonly<OutputOptions> = Object.freeze({
  applyMask: "none",
  fillColor: "#000000",
  cropPadding: 0,
  borderSize: 64,
  borderColor: "#ffffff",
  borderMask: true,
});

// ── Field readers ─────────────────────────────────────────────────────────

/**
 * Validate an opaque `#rrggbb` colour.
 * @param value - Untrusted value.
 * @param fallback - Default colour.
 * @returns Lowercase colour, or the fallback.
 */
function readColor(value: unknown, fallback: string): string {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : fallback;
}

/**
 * Validate the mask mode.
 * @param value - Untrusted value.
 * @returns The mode, `none` when unknown.
 */
function readMode(value: unknown): OutputOptions["applyMask"] {
  return value === "fill" || value === "crop" || value === "border" ? value : "none";
}

/**
 * Validate the border size: finite number, floored, clamped to 1..MAX_BORDER_SIZE.
 * @param value - Untrusted value.
 * @returns Border size, default 64 when not a finite number.
 */
function readBorderSize(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_OUTPUT_OPTIONS.borderSize;
  return Math.min(MAX_BORDER_SIZE, Math.max(1, Math.floor(value)));
}

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Normalize optional saved options field-by-field; missing/malformed fields use defaults.
 * @param value - Untrusted saved record.
 * @returns Fresh options with lowercase colours and integer sizes.
 */
export function readOutputOptions(value: unknown): OutputOptions {
  const record = typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
  const padding = record["cropPadding"];
  const borderMask = record["borderMask"];
  return {
    applyMask: readMode(record["applyMask"]),
    fillColor: readColor(record["fillColor"], DEFAULT_OUTPUT_OPTIONS.fillColor),
    cropPadding: typeof padding === "number" && Number.isFinite(padding)
      ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(padding))) : 0,
    borderSize: readBorderSize(record["borderSize"]),
    borderColor: readColor(record["borderColor"], DEFAULT_OUTPUT_OPTIONS.borderColor),
    borderMask: typeof borderMask === "boolean" ? borderMask : DEFAULT_OUTPUT_OPTIONS.borderMask,
  };
}

/**
 * Copy options, materializing the defaults when absent (or missing border fields).
 * @param options - Validated options, or absent for defaults.
 * @returns Independent options in stable serialization order.
 */
export function cloneOutputOptions(options: Readonly<OutputOptions> = DEFAULT_OUTPUT_OPTIONS): OutputOptions {
  return {
    applyMask: options.applyMask,
    fillColor: options.fillColor,
    cropPadding: options.cropPadding,
    borderSize: options.borderSize ?? DEFAULT_OUTPUT_OPTIONS.borderSize,
    borderColor: options.borderColor ?? DEFAULT_OUTPUT_OPTIONS.borderColor,
    borderMask: options.borderMask ?? DEFAULT_OUTPUT_OPTIONS.borderMask,
  };
}

/**
 * Field-by-field equality of two option sets.
 * @param a - First options.
 * @param b - Second options.
 * @returns True when every field matches.
 */
export function outputOptionsEqual(a: Readonly<OutputOptions>, b: Readonly<OutputOptions>): boolean {
  return a.applyMask === b.applyMask
    && a.fillColor === b.fillColor
    && a.cropPadding === b.cropPadding
    && a.borderSize === b.borderSize
    && a.borderColor === b.borderColor
    && a.borderMask === b.borderMask;
}

/**
 * Whether every option is at its default (including currently inactive fields).
 * @param options - Options, possibly absent in older documents.
 * @returns True for absent or exactly default options.
 */
export function isDefaultOutputOptions(options?: Readonly<OutputOptions>): boolean {
  return !options || outputOptionsEqual(cloneOutputOptions(options), DEFAULT_OUTPUT_OPTIONS);
}
