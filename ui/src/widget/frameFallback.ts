/**
 * The "current image" used when no image is connected: `width` x `height`
 * filled with `background` (the document's own frame maps onto it, decision 4).
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
/** Step of the `width`/`height` widgets (Python INT `step`). */
export const FRAME_SIDE_STEP = 8;

/** A sanitized fallback frame. */
export interface FallbackFrame {
  size: Size;
  color: string;
}

/**
 * Normalize a CSS hex colour (`#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, with or
 * without the leading `#`) to lowercase opaque `#rrggbb`. Alpha is dropped on
 * purpose: the node's `IMAGE` output has no alpha and Python ignores it too, so
 * the editor must draw the background opaque to match the output.
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
    return `#${[...hex.slice(0, 3)].map((c) => c + c).join("")}`;
  }
  if (hex.length === 6 || hex.length === 8) return `#${hex.slice(0, 6)}`;
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
 * Build the "current image" used when no image is connected: `width` x
 * `height` filled with `background`. The document maps onto it like onto any
 * upstream image (decision 4); Python builds the same background.
 *
 * @param width - `width` widget value.
 * @param height - `height` widget value.
 * @param color - `background` widget value.
 * @returns Sanitized image size and fill colour.
 */
export function resolveFallbackFrame(width: unknown, height: unknown, color: unknown): FallbackFrame {
  return {
    size: {
      width: sanitizeDimension(width, FALLBACK_DEFAULTS.width),
      height: sanitizeDimension(height, FALLBACK_DEFAULTS.height),
    },
    color: normalizeHexColor(color),
  };
}

/**
 * Widget value for a frame side, so the `width`/`height` widgets can take
 * over an image's size on disconnect: rounded to the nearest multiple of
 * {@link FRAME_SIDE_STEP} and clamped to the widget range. The result may
 * differ from `side` by less than one step; the frame map absorbs that.
 *
 * @param side - Image side in pixels.
 * @returns Value valid for the `width`/`height` INT widgets.
 */
export function widgetDimension(side: number): number {
  const snapped = Math.round(side / FRAME_SIDE_STEP) * FRAME_SIDE_STEP;
  return Math.min(MAX_FRAME_SIDE, Math.max(MIN_FRAME_SIDE, snapped));
}
