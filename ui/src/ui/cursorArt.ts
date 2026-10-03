/**
 * Cursor composer (SPEC "Remaining work" item 2): builds stage cursors as
 * SVG data URLs from icon glyphs (`icons.ts`) placed on a 64 x 64 canvas --
 * a base glyph plus badges in fixed slots (mode / ban
 * bottom-right). Every glyph is drawn twice: a wide halo stroke, then the
 * glyph stroke on top, so it reads on any background.
 *
 * Colours come from the `--cps-cursor-*` CSS variables. A cursor image
 * can't read CSS variables, so the stage reads them ({@link setCursorPalette})
 * and every cached cursor is rebuilt when they change. Pure string building
 * (no DOM), so it is unit-testable.
 */

import { iconMarkup } from "./icons";

// ── Palette ───────────────────────────────────────────────────────────────

/** Cursor colours (CSS colour strings). */
export interface CursorPalette {
  /** Glyph colour (`--cps-cursor-fg`). */
  fg: string;
  /** Outline under every glyph (`--cps-cursor-halo`). */
  halo: string;
  /** Not-allowed badge (`--cps-cursor-ban`). */
  ban: string;
  /** Mask-target badge (`--cps-cursor-accent`). */
  accent: string;
}

/** Built-in colours (also the CSS fallbacks in `editor.css`). */
export const DEFAULT_CURSOR_PALETTE: Readonly<CursorPalette> = { fg: "#ffffff", halo: "#111111", ban: "#e5484d", accent: "#b48cff" };

/** CSS variable per palette entry. */
export const CURSOR_PALETTE_VARS: Readonly<Record<keyof CursorPalette, string>> = {
  fg: "--cps-cursor-fg",
  halo: "--cps-cursor-halo",
  ban: "--cps-cursor-ban",
  accent: "--cps-cursor-accent",
};

let palette: CursorPalette = { ...DEFAULT_CURSOR_PALETTE };
const cache = new Map<string, string>();
/** Bumped on every palette change (consumers caching images compare it). */
let generation = 0;

/**
 * Use new cursor colours; clears the cursor cache when they differ.
 * @param next - Colours (empty strings fall back to the defaults).
 * @returns `true` if the palette changed.
 */
export function setCursorPalette(next: Readonly<CursorPalette>): boolean {
  const merged: CursorPalette = {
    fg: next.fg || DEFAULT_CURSOR_PALETTE.fg,
    halo: next.halo || DEFAULT_CURSOR_PALETTE.halo,
    ban: next.ban || DEFAULT_CURSOR_PALETTE.ban,
    accent: next.accent || DEFAULT_CURSOR_PALETTE.accent,
  };
  if (merged.fg === palette.fg && merged.halo === palette.halo && merged.ban === palette.ban && merged.accent === palette.accent) return false;
  palette = merged;
  cache.clear();
  generation++;
  return true;
}

/** @returns The cursor colours in use. */
export function cursorPalette(): Readonly<CursorPalette> {
  return palette;
}

/** @returns A counter that changes whenever the palette does. */
export function cursorPaletteGeneration(): number {
  return generation;
}

// ── Parts ─────────────────────────────────────────────────────────────────

/** Which palette colour a glyph uses. */
export type CursorTone = "fg" | "ban" | "accent";

/** One glyph on the cursor canvas. */
export interface CursorPart {
  /** Icon name (`icons.ts`). */
  icon: string;
  /** Top-left of the glyph's 24-unit box, canvas px. */
  x: number;
  y: number;
  /** Rendered size of the 24-unit box, px. */
  size: number;
  /** Colour (default `fg`). */
  tone?: CursorTone;
  /** Fill closed shapes too (the pointer tip). */
  filled?: boolean;
}

/** A complete cursor. */
export interface CursorArt {
  parts: readonly CursorPart[];
  /** Hotspot, canvas px. */
  hotspot: readonly [number, number];
  /** CSS keyword used when the image can't be shown. */
  fallback: string;
  /** Canvas size, px (default {@link CURSOR_CANVAS}). */
  canvas?: number;
}

/** Cursor canvas size, px (Chrome shows up to 128; 64 leaves room for badges). */
export const CURSOR_CANVAS = 64;
/** Base glyph size, px. */
export const GLYPH_SIZE = 24;
/** Badge size, px. */
export const BADGE_SIZE = 16;

/**
 * On-screen stroke widths of a glyph drawn at `size` px.
 * @param size - Glyph size, px.
 * @returns Glyph and halo stroke widths, px.
 */
export function strokeWidths(size: number): { fg: number; halo: number } {
  return size >= 20 ? { fg: 2, halo: 4 } : { fg: 1.5, halo: 3.5 };
}

/** Halo outline around fill-only elements, px. */
const THIN_HALO = 1.5;

/**
 * SVG elements of one part (halo pass, then glyph pass).
 * @param part - Part.
 * @param colors - Palette.
 * @returns Markup.
 */
export function partSvg(part: CursorPart, colors: Readonly<CursorPalette> = palette): string {
  const k = part.size / 24;
  const widths = strokeWidths(part.size);
  const color = colors[part.tone ?? "fg"];
  const box = `transform='translate(${round(part.x)} ${round(part.y)}) scale(${round(k)})'`;
  const markup = iconMarkup(part.icon);
  const fill = (c: string): string => (part.filled ? c : "none");
  return (
    `<g ${box} class='h' style='--t:${round(THIN_HALO / k)}' color='${colors.halo}' stroke='${colors.halo}' fill='${fill(colors.halo)}' stroke-width='${round(widths.halo / k)}'>${markup}</g>` +
    `<g ${box} color='${color}' stroke='${color}' fill='${fill(color)}' stroke-width='${round(widths.fg / k)}'>${markup}</g>`
  );
}

/**
 * Standalone SVG document of a cursor.
 * @param art - Cursor.
 * @param colors - Palette.
 * @returns SVG markup.
 */
export function cursorSvg(art: CursorArt, colors: Readonly<CursorPalette> = palette): string {
  const s = art.canvas ?? CURSOR_CANVAS;
  // The halo pass ignores per-element widths and also outlines fill-only
  // elements (stroke='none'), thinly, so small filled details stay apart.
  const style = "<style>.h *{stroke:inherit!important;stroke-width:inherit!important}.h [stroke='none']{stroke-width:var(--t)!important}</style>";
  return (
    `<svg xmlns='http://www.w3.org/2000/svg' width='${s}' height='${s}' viewBox='0 0 ${s} ${s}' ` +
    `stroke-linecap='round' stroke-linejoin='round'>${style}${art.parts.map((p) => partSvg(p, colors)).join("")}</svg>`
  );
}

/**
 * CSS `cursor` value of a cursor (cached until the palette changes).
 * @param key - Cache key (unique per drawing).
 * @param art - Builds the cursor on a cache miss.
 * @returns CSS value (`url(...) x y, fallback`).
 */
export function cursorCss(key: string, art: () => CursorArt): string {
  const cached = cache.get(key);
  if (cached) return cached;
  const a = art();
  const value = `url("data:image/svg+xml,${encodeURIComponent(cursorSvg(a))}") ${a.hotspot[0]} ${a.hotspot[1]}, ${a.fallback}`;
  cache.set(key, value);
  return value;
}

/**
 * Data URL of a lone glyph with its halo (overlay indicators drawn on a
 * canvas, e.g. the brush ring's badges).
 * @param icon - Icon name.
 * @param size - Glyph size, px.
 * @param tone - Colour.
 * @returns The data URL and the image size (glyph + halo margin), px.
 */
export function glyphImageUrl(icon: string, size: number, tone: CursorTone = "fg"): { url: string; size: number } {
  const margin = Math.ceil(strokeWidths(size).halo / 2) + 1;
  const total = size + margin * 2;
  const svg = cursorSvg({ parts: [{ icon, x: margin, y: margin, size, tone }], hotspot: [0, 0], fallback: "none", canvas: total });
  return { url: `data:image/svg+xml,${encodeURIComponent(svg)}`, size: total };
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

// ── Layouts ───────────────────────────────────────────────────────────────

/** Badge slots of a layout (top-left of a {@link BADGE_SIZE} box). */
export interface BadgeSlots {
  /** Mode / ban badge, bottom-right. */
  mode: readonly [number, number];
}

/** Base glyph centred on the canvas; hotspot at the centre. */
export const CENTRED_SLOTS: BadgeSlots = { mode: [46, 46] };
/** Photoshop pointer layout: tiny arrow tip (the hotspot) top-left, glyph lower-right. */
export const POINTER_SLOTS: BadgeSlots = { mode: [40, 40] };

/** Pointer-tip glyph size, px (Lucide `mouse-pointer-2`, tip at (4, 4.7) of 24). */
const POINTER_SIZE = 12;

/**
 * Parts of a centred base glyph (hotspot = canvas centre).
 * @param icon - Icon name.
 * @returns Parts.
 */
export function centredParts(icon: string): CursorPart[] {
  const at = (CURSOR_CANVAS - GLYPH_SIZE) / 2;
  return [{ icon, x: at, y: at, size: GLYPH_SIZE }];
}

/** Hotspot of {@link centredParts}. */
export const CENTRED_HOTSPOT: readonly [number, number] = [CURSOR_CANVAS / 2, CURSOR_CANVAS / 2];

/**
 * Parts of the Photoshop pointer layout: the tool glyph lower-right, the
 * tiny filled arrow (whose tip is the hotspot) top-left, drawn last.
 * @param icon - Tool glyph.
 * @returns Parts.
 */
export function pointerParts(icon: string): CursorPart[] {
  return [
    { icon, x: 14, y: 14, size: GLYPH_SIZE },
    { icon: "pointer", x: 1, y: 1, size: POINTER_SIZE, filled: true },
  ];
}

/** Hotspot of {@link pointerParts} (the arrow tip). */
export const POINTER_HOTSPOT: readonly [number, number] = [3, 3];

/**
 * A badge part in a slot.
 * @param icon - Badge icon.
 * @param at - Slot.
 * @param tone - Colour.
 * @returns Part.
 */
export function badgePart(icon: string, at: readonly [number, number], tone: CursorTone = "fg"): CursorPart {
  return { icon, x: at[0], y: at[1], size: BADGE_SIZE, tone };
}
