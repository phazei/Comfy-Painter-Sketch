/**
 * Pure colour math: hex <-> RGB <-> HSV conversions, round-trips, clamping.
 * No DOM dependencies; unit-testable in Node.
 *
 * HSV: hue [0,360), saturation [0,1], value [0,1].
 * RGB: each channel [0,255] integer.
 * Hex: normalized ``#rrggbb`` lowercase string.
 */

// ── Types ──────────────────────────────────────────────────────────────────

/** RGB with each channel in [0, 255]. */
export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** HSV with h in [0, 360), s and v in [0, 1]. */
export interface Hsv {
  h: number;
  s: number;
  v: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// Hex helpers
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Parse a hex colour string to an {@link Rgb} object.
 * Accepts `#rrggbb`, `#rgb`, or the bare digits (any case).
 * @param hex - Hex colour string.
 * @returns Parsed RGB, or `null` if the input is invalid.
 */
export function hexToRgb(hex: string): Rgb | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  const digits = m?.[1];
  if (!digits) return null;
  const full = digits.length === 3 ? [...digits].map((c) => c + c).join("") : digits;
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
  };
}

/**
 * Convert an {@link Rgb} object to a normalized `#rrggbb` hex string.
 * Channels are clamped to [0, 255] and rounded.
 * @param rgb - RGB values.
 * @returns Lowercase `#rrggbb` string.
 */
export function rgbToHex(rgb: Rgb): string {
  const r = clampByte(rgb.r);
  const g = clampByte(rgb.g);
  const b = clampByte(rgb.b);
  return `#${byteHex(r)}${byteHex(g)}${byteHex(b)}`;
}

// ═══════════════════════════════════════════════════════════════════════════
// RGB <-> HSV
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Convert RGB (0-255 each) to HSV.
 * Hue is in [0, 360); undefined for achromatic (s === 0) colours is 0.
 * @param rgb - RGB values (channels clamped and rounded internally).
 * @returns HSV representation.
 */
export function rgbToHsv(rgb: Rgb): Hsv {
  const r = clampByte(rgb.r) / 255;
  const g = clampByte(rgb.g) / 255;
  const b = clampByte(rgb.b) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  const v = max;
  const s = max === 0 ? 0 : delta / max;
  let h = 0;
  if (delta !== 0) {
    if (max === r) h = ((g - b) / delta) % 6;
    else if (max === g) h = (b - r) / delta + 2;
    else h = (r - g) / delta + 4;
    h = h * 60;
    if (h < 0) h += 360;
  }
  return { h, s, v };
}

/**
 * Convert HSV to RGB (0-255 each, rounded).
 * @param hsv - HSV values (h clamped to [0,360), s/v clamped to [0,1]).
 * @returns RGB representation.
 */
export function hsvToRgb(hsv: Hsv): Rgb {
  const h = ((hsv.h % 360) + 360) % 360;
  const s = clamp01(hsv.s);
  const v = clamp01(hsv.v);
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let r1 = 0;
  let g1 = 0;
  let b1 = 0;
  if (h < 60) { r1 = c; g1 = x; }
  else if (h < 120) { r1 = x; g1 = c; }
  else if (h < 180) { g1 = c; b1 = x; }
  else if (h < 240) { g1 = x; b1 = c; }
  else if (h < 300) { r1 = x; b1 = c; }
  else { r1 = c; b1 = x; }
  return {
    r: Math.round((r1 + m) * 255),
    g: Math.round((g1 + m) * 255),
    b: Math.round((b1 + m) * 255),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Shortcut: hex <-> HSV
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Convert a hex colour to HSV. Returns `null` for invalid hex.
 * @param hex - Hex colour string.
 * @returns HSV, or `null` if the hex is invalid.
 */
export function hexToHsv(hex: string): Hsv | null {
  const rgb = hexToRgb(hex);
  return rgb ? rgbToHsv(rgb) : null;
}

/**
 * Convert HSV to a normalized `#rrggbb` hex string.
 * @param hsv - HSV values.
 * @returns Lowercase `#rrggbb` string.
 */
export function hsvToHex(hsv: Hsv): string {
  return rgbToHex(hsvToRgb(hsv));
}

// ── Internal helpers ────────────────────────────────────────────────────────

/**
 * Clamp a value to [0, 1].
 * @param v - Input value.
 * @returns Clamped value.
 */
export function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

/**
 * Clamp and round a value to an integer in [0, 255].
 * @param v - Input value.
 * @returns Integer byte.
 */
function clampByte(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v)));
}

function byteHex(byte: number): string {
  return byte.toString(16).padStart(2, "0");
}
