/**
 * Pure pixel/colour helpers for the paint bucket and eyedropper: hex <->
 * RGB, the alpha-weighted average colour of a sample window, and blending a
 * solid colour through a coverage mask into straight-alpha RGBA ("source
 * over", like a brush stroke committed at an opacity). No DOM.
 */

import type { Rect } from "../geometry/rect";

/** An 8-bit RGB colour. */
export interface Rgb {
  r: number;
  g: number;
  b: number;
}

// ── Hex ───────────────────────────────────────────────────────────────────────

/**
 * Parse `#rrggbb` / `#rgb`.
 * @param hex - Colour string.
 * @returns RGB, or black for malformed input.
 */
export function hexToRgb(hex: string): Rgb {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  const body = m?.[1];
  if (!body) return { r: 0, g: 0, b: 0 };
  const full = body.length === 3 ? [...body].map((c) => c + c).join("") : body;
  const n = parseInt(full, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

/**
 * Format as lowercase `#rrggbb` (channels rounded and clamped).
 * @param rgb - Colour.
 * @returns Hex string.
 */
export function rgbToHex(rgb: Rgb): string {
  const part = (v: number): string =>
    Math.min(255, Math.max(0, Math.round(v)))
      .toString(16)
      .padStart(2, "0");
  return `#${part(rgb.r)}${part(rgb.g)}${part(rgb.b)}`;
}

// ── Sampling ──────────────────────────────────────────────────────────────────

/**
 * Alpha-weighted average colour of RGBA pixels (a sample window). Fully
 * transparent pixels do not contribute; semi-transparent ones count by alpha.
 * @param data - RGBA pixels.
 * @returns The average colour, or `null` when every pixel is transparent.
 */
export function averageColor(data: Uint8ClampedArray): Rgb | null {
  let r = 0;
  let g = 0;
  let b = 0;
  let a = 0;
  for (let p = 0; p + 3 < data.length; p += 4) {
    const w = data[p + 3] as number;
    if (w === 0) continue;
    r += (data[p] as number) * w;
    g += (data[p + 1] as number) * w;
    b += (data[p + 2] as number) * w;
    a += w;
  }
  if (a === 0) return null;
  return { r: Math.round(r / a), g: Math.round(g / a), b: Math.round(b / a) };
}

// ── Coverage blend ────────────────────────────────────────────────────────────

/**
 * Blend a solid colour into straight-alpha RGBA through a coverage mask
 * ("source over"; source alpha = coverage/255 x opacity), in place.
 *
 * @param dst - RGBA pixels of `rect` (row stride `rect.width * 4`).
 * @param rect - Where `dst` sits in coverage coordinates.
 * @param coverage - Coverage mask, 0-255.
 * @param coverageWidth - Row stride of `coverage` in px.
 * @param color - Colour to paint.
 * @param opacity - 0..1 overall opacity.
 */
export function blendCoverage(
  dst: Uint8ClampedArray,
  rect: Rect,
  coverage: Uint8Array,
  coverageWidth: number,
  color: Rgb,
  opacity: number,
): void {
  const k = Math.min(1, Math.max(0, opacity)) / 255;
  if (k <= 0) return;
  for (let y = 0; y < rect.height; y++) {
    const row = (rect.y + y) * coverageWidth + rect.x;
    for (let x = 0; x < rect.width; x++) {
      const c = coverage[row + x] as number;
      if (c === 0) continue;
      const p = (y * rect.width + x) * 4;
      const sa = c * k;
      const da = (dst[p + 3] as number) / 255;
      const keep = da * (1 - sa);
      const oa = sa + keep;
      if (oa <= 0) continue;
      dst[p] = (color.r * sa + (dst[p] as number) * keep) / oa;
      dst[p + 1] = (color.g * sa + (dst[p + 1] as number) * keep) / oa;
      dst[p + 2] = (color.b * sa + (dst[p + 2] as number) * keep) / oa;
      dst[p + 3] = oa * 255;
    }
  }
}

/**
 * Blend a colour *behind* straight-alpha RGBA pixels through a coverage mask
 * (Photoshop "Behind": existing paint stays on top, transparency is filled).
 * Used for the bucket's fill under a stroke's soft edge (`fillUnder.ts`).
 * @param dst - Pixels of `rect` (`rect.width * rect.height * 4`), modified in place.
 * @param rect - Area of `dst` inside the coverage buffer.
 * @param coverage - Coverage buffer, `coverageWidth` wide.
 * @param coverageWidth - Coverage row length.
 * @param color - Fill colour.
 * @param opacity - 0..1.
 */
export function blendCoverageBehind(
  dst: Uint8ClampedArray,
  rect: Rect,
  coverage: Uint8Array,
  coverageWidth: number,
  color: Rgb,
  opacity: number,
): void {
  const k = Math.min(1, Math.max(0, opacity)) / 255;
  if (k <= 0) return;
  for (let y = 0; y < rect.height; y++) {
    const row = (rect.y + y) * coverageWidth + rect.x;
    for (let x = 0; x < rect.width; x++) {
      const c = coverage[row + x] as number;
      if (c === 0) continue;
      const p = (y * rect.width + x) * 4;
      const da = (dst[p + 3] as number) / 255;
      const add = c * k * (1 - da);
      const oa = da + add;
      if (oa <= 0) continue;
      dst[p] = ((dst[p] as number) * da + color.r * add) / oa;
      dst[p + 1] = ((dst[p + 1] as number) * da + color.g * add) / oa;
      dst[p + 2] = ((dst[p + 2] as number) * da + color.b * add) / oa;
      dst[p + 3] = oa * 255;
    }
  }
}