/**
 * The frame used when no image is connected: the last known frame size (or,
 * if there never was one, `width` x `height`) filled with `background`.
 *
 * Pure: takes raw widget values (unknown) and returns sanitized values.
 */

import type { Size } from "../engine/viewport";

/** Defaults matching the Python node schema. */
export const FALLBACK_DEFAULTS = {
  width: 1024,
  height: 1024,
  color: "#ffffff",
} as const;

/** Frame side limits accepted from widgets (match the Python INT min/max). */
export const MIN_FRAME_SIDE = 64;
export const MAX_FRAME_SIDE = 8192;

/** A sanitized fallback frame. */
export interface FallbackFrame {
  size: Size;
  color: string;
}

/**
 * Normalize a CSS hex colour (`#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, with or
 * without the leading `#`) to lowercase `#rrggbb[aa]`.
 *
 * @param value - Raw widget value.
 * @param fallback - Returned when `value` is not a valid hex colour.
 * @returns Normalized colour string.
 */
export function normalizeHexColor(value: unknown, fallback: string = FALLBACK_DEFAULTS.color): string {
  if (typeof value !== "string") return fallback;
  const hex = value.trim().replace(/^#/, "").toLowerCase();
  if (!/^[0-9a-f]+$/.test(hex)) return fallback;
  if (hex.length === 3 || hex.length === 4) {
    return `#${[...hex].map((c) => c + c).join("")}`;
  }
  if (hex.length === 6 || hex.length === 8) return `#${hex}`;
  return fallback;
}

/**
 * Sanitize a frame dimension widget value to an integer in
 * `[MIN_FRAME_SIDE, MAX_FRAME_SIDE]`.
 *
 * @param value - Raw widget value.
 * @param fallback - Returned for non-numeric values.
 * @returns Integer dimension.
 */
export function sanitizeDimension(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(MAX_FRAME_SIDE, Math.max(MIN_FRAME_SIDE, Math.round(n)));
}

/**
 * Build the frame shown when no image is connected (SPEC Behavior Notes):
 * the last known frame size filled with `background`; the `width`/`height`
 * widgets only apply when there has never been a frame. Mirrors the Python
 * side, which prefers the document's `frame` over the widgets.
 *
 * @param knownFrame - Last known frame size (last background image now;
 *   the document manifest's `frame` from M1), or `null` if never had one.
 * @param width - `width` widget value.
 * @param height - `height` widget value.
 * @param color - `background` widget value.
 * @returns Sanitized frame size and fill colour.
 */
export function resolveFallbackFrame(
  knownFrame: Size | null,
  width: unknown,
  height: unknown,
  color: unknown,
): FallbackFrame {
  const known =
    knownFrame && knownFrame.width > 0 && knownFrame.height > 0
      ? { width: Math.round(knownFrame.width), height: Math.round(knownFrame.height) }
      : null;
  return {
    size: known ?? {
      width: sanitizeDimension(width, FALLBACK_DEFAULTS.width),
      height: sanitizeDimension(height, FALLBACK_DEFAULTS.height),
    },
    color: normalizeHexColor(color),
  };
}
