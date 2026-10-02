/**
 * Brush / eraser ring on the stage overlay (SPEC "Remaining work" item 2):
 * the size ring (halo circle + light circle just outside) and its
 * indicators just outside the ring on the 45-degree diagonals -- the mask
 * target bottom-left, the tool glyph (eraser) or `ban` bottom-right. The
 * CSS cursor meanwhile is only a dot (`cursors.ts`), since the ring can be
 * far larger than any cursor image.
 *
 * Indicators are the composer's glyph images (`cursorArt.ts`), loaded
 * once per glyph / size / palette; the first frame after a change may miss
 * them (`onLoad` asks for a redraw).
 */

import { cursorPalette, cursorPaletteGeneration, glyphImageUrl } from "./cursorArt";
import type { CursorTone } from "./cursorArt";

/** What the ring shows besides the circle. */
export interface RingIndicators {
  /** Glyph bottom-right (the eraser's), or none. */
  glyph?: string;
  /** Paints a cmask / lmask: mask badge bottom-left. */
  target: boolean;
  /** The tool can't edit its target: `ban` bottom-right (replaces the glyph). */
  ban: boolean;
}

/** Indicator size bounds, CSS px (grows slightly with large rings). */
const BADGE_MIN = 16;
const BADGE_MAX = 24;
/** Gap between the ring and an indicator's inner corner, CSS px. */
const RING_GAP = 3;
/** Indicators never come closer to the centre than this ring radius, CSS px. */
const MIN_RADIUS = 6;

/**
 * Indicator size for a ring (pure).
 * @param radiusCss - Ring radius, CSS px.
 * @returns Size, CSS px.
 */
export function ringBadgeSize(radiusCss: number): number {
  return Math.round(Math.min(BADGE_MAX, Math.max(BADGE_MIN, BADGE_MIN + (radiusCss - 50) / 25)));
}

/**
 * Centre offset of an indicator along a diagonal (pure): its inner corner
 * sits {@link RING_GAP} outside the ring (or the minimum radius).
 * @param radiusCss - Ring radius, CSS px.
 * @param size - Indicator size, CSS px.
 * @returns Offset on each axis, CSS px.
 */
export function ringBadgeOffset(radiusCss: number, size: number): number {
  const d = Math.max(radiusCss, MIN_RADIUS) + RING_GAP + size / Math.SQRT2;
  return d / Math.SQRT2;
}

interface GlyphImage {
  image: HTMLImageElement;
  /** Image size incl. halo margin, CSS px. */
  size: number;
}

const images = new Map<string, GlyphImage>();
let imagesGeneration = -1;

/**
 * Loaded glyph image, or `null` while loading.
 * @param icon - Icon name.
 * @param size - Glyph size, CSS px.
 * @param tone - Colour.
 * @param onLoad - Called once the image is ready.
 * @returns The image, or `null`.
 */
function glyphImage(icon: string, size: number, tone: CursorTone, onLoad: () => void): GlyphImage | null {
  if (imagesGeneration !== cursorPaletteGeneration()) {
    images.clear();
    imagesGeneration = cursorPaletteGeneration();
  }
  const key = `${icon}:${size}:${tone}`;
  let entry = images.get(key);
  if (!entry) {
    const { url, size: total } = glyphImageUrl(icon, size, tone);
    const image = new Image();
    image.onload = onLoad;
    image.src = url;
    entry = { image, size: total };
    images.set(key, entry);
  }
  return entry.image.complete && entry.image.naturalWidth > 0 ? entry : null;
}

/**
 * Draw the ring and its indicators.
 * @param ctx - Overlay context (identity transform, device px).
 * @param x - Centre x, device px.
 * @param y - Centre y, device px.
 * @param radius - Ring radius, device px.
 * @param pr - Device px per CSS px.
 * @param indicators - What to show.
 * @param onLoad - Redraw request for images still loading.
 */
export function drawRingCursor(ctx: CanvasRenderingContext2D, x: number, y: number, radius: number, pr: number, indicators: RingIndicators, onLoad: () => void): void {
  const colors = cursorPalette();
  ctx.save();
  ctx.globalAlpha = 0.8;
  ctx.lineWidth = Math.max(1, pr);
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.strokeStyle = colors.halo;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(x, y, radius + ctx.lineWidth, 0, Math.PI * 2);
  ctx.strokeStyle = colors.fg;
  ctx.stroke();
  ctx.restore();
  const radiusCss = radius / pr;
  const size = ringBadgeSize(radiusCss);
  const offset = ringBadgeOffset(radiusCss, size) * pr;
  const draw = (icon: string, tone: CursorTone, dx: number): void => {
    const glyph = glyphImage(icon, size, tone, onLoad);
    if (!glyph) return;
    const s = glyph.size * pr;
    ctx.drawImage(glyph.image, x + dx - s / 2, y + offset - s / 2, s, s);
  };
  if (indicators.target) draw("mask", "accent", -offset);
  if (indicators.ban) draw("ban", "ban", offset);
  else if (indicators.glyph) draw(indicators.glyph, "fg", offset);
}
