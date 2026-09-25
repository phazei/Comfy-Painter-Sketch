/**
 * CSS cursors for the stage, keyed by the tool's {@link ToolCursor}.
 *
 * Icon cursors are inline SVG data URLs (no files: the bundle is one `.js`).
 * Each cursor reuses the exact toolbar path data from {@link iconPath} so the
 * cursor shape matches the rail icon pixel-for-pixel.  Rendering uses two
 * stroke passes for legibility on any background:
 *   1. Dark outline (~4 px, round caps/joins) for contrast.
 *   2. White stroke (~1.75 px) matching the toolbar style.
 * No fills are added; the paths are open strokes just as in the toolbar.
 *
 * The crosshair and the Move tool's `move` are plain CSS keywords
 * (browser-native, no image needed).
 * Ring cursors (brush/eraser) also keep the plain crosshair; the size ring
 * itself is drawn on the overlay canvas.
 *
 * Selection tools with a selection get a composed crosshair + mode badge
 * ("+" add, "−" subtract, "×" intersect; {@link badgeCursor}).
 */

import { selectionMode } from "../engine/selection";
import type { SelectionMode } from "../engine/selection";
import type { CursorIcon, ToolCursor } from "../tools/types";
import { iconPath } from "./icons";

// ── Constants ──────────────────────────────────────────────────────────────

/** Icon canvas size in CSS px (browsers accept up to 128; 32 is safe everywhere). */
const ICON_SIZE = 24;

/** Outline stroke width for legibility (dark pass). */
const OUTLINE_WIDTH = 4;

/** Icon stroke width (white pass) matching toolbar style. */
const ICON_WIDTH = 1.75;

/** Dark outline colour. */
const OUTLINE_COLOR = "#111";

/** Icon stroke colour. */
const ICON_COLOR = "#fff";

// ── Hotspots ───────────────────────────────────────────────────────────────

/**
 * Hotspot (x, y) in icon px for each cursor icon, matching the working point
 * of the corresponding toolbar icon path.
 *
 * eyedropper: tip is the `M3 21` anchor at the bottom-left of the pipette → (3, 21).
 * bucket: drip bottom is the end of `c0 1.5-.8 2.5-1.8 2.5` from (21,17)
 *         → (21-1.8, 17+2.5) = (19.2, 19.5) → rounded (19, 20).
 */
const HOTSPOTS: Readonly<Record<Exclude<CursorIcon, "crosshair" | "move">, readonly [number, number]>> = {
  eyedropper: [3, 21],
  bucket: [19, 20],
};

// ── Cache ──────────────────────────────────────────────────────────────────

const cache = new Map<CursorIcon, string>();

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * CSS `cursor` value for a named icon cursor.
 *
 * Renders the toolbar icon path with a dark outline pass then a white stroke
 * pass, both stroke-only (no fills), inside a 24x24 SVG data URL.
 *
 * @param icon - Icon name (must be a non-`"crosshair"` {@link CursorIcon}).
 * @returns CSS value (`url(...) x y, crosshair`, or `"crosshair"` for the crosshair name).
 */
export function iconCursor(icon: CursorIcon): string {
  if (icon === "crosshair") return "crosshair";
  // Move tool: the native four-way cursor.
  if (icon === "move") return "move";
  const cached = cache.get(icon);
  if (cached) return cached;

  const d = iconPath(icon);
  const [x, y] = HOTSPOTS[icon];

  // Two-pass stroke-only render: dark outline first, white icon on top.
  const pathAttrs = `fill='none' stroke-linecap='round' stroke-linejoin='round'`;
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' width='${ICON_SIZE}' height='${ICON_SIZE}' viewBox='0 0 ${ICON_SIZE} ${ICON_SIZE}'>` +
    `<path ${pathAttrs} stroke='${OUTLINE_COLOR}' stroke-width='${OUTLINE_WIDTH}' d='${d}'/>` +
    `<path ${pathAttrs} stroke='${ICON_COLOR}' stroke-width='${ICON_WIDTH}' d='${d}'/>` +
    `</svg>`;

  const value = `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${x} ${y}, crosshair`;
  cache.set(icon, value);
  return value;
}

/**
 * CSS `cursor` value for a tool cursor descriptor.
 *
 * Ring cursors and the crosshair icon both return `"crosshair"` (the overlay
 * canvas draws the size ring); icon cursors return an SVG data URL. A
 * selection-mode badge turns the crosshair into {@link badgeCursor}.
 *
 * @param cursor - Tool cursor descriptor.
 * @param badge - Selection-mode badge (only applied to the crosshair), or `null`.
 * @returns CSS `cursor` property value.
 */
export function cssCursor(cursor: ToolCursor, badge: CursorBadge | null = null): string {
  if (badge && cursor.kind === "icon" && cursor.icon === "crosshair") return badgeCursor(badge);
  return cursor.kind === "ring" ? "crosshair" : iconCursor(cursor.icon);
}

// ── Selection-mode badges ──────────────────────────────────────────────────

/** Photoshop's cursor badge for a selection mode: "+" add, "−" subtract, "×" intersect. */
export type CursorBadge = Exclude<SelectionMode, "replace">;

/**
 * Badge a selection tool's cursor shows for the modifiers held now (the
 * mode pointer-down would use; `selectionModifiers.ts`). Without a
 * selection the modifiers are drag constraints, so there is no badge.
 * @param state - Tool flag, selection presence and modifiers.
 * @returns Badge, or `null`.
 */
export function cursorBadge(state: { combinesSelection: boolean; hasSelection: boolean; shift: boolean; alt: boolean }): CursorBadge | null {
  if (!state.combinesSelection || !state.hasSelection) return null;
  const mode = selectionMode(state.shift, state.alt);
  return mode === "replace" ? null : mode;
}

/** Badged cursor canvas size, CSS px. */
const BADGE_CURSOR_SIZE = 32;
/** Crosshair centre (= hotspot) in the badged cursor, px. */
const BADGE_HOTSPOT = 11;

/** Glyph strokes of each badge, centred at (24, 24) (bottom-right of the crosshair). */
const BADGE_GLYPHS: Readonly<Record<CursorBadge, string>> = {
  add: "M20 24h8M24 20v8",
  subtract: "M20 24h8",
  intersect: "M21 21l6 6M27 21l-6 6",
};

const badgeCache = new Map<CursorBadge, string>();

/**
 * CSS `cursor` value: a crosshair (1 px white on a dark outline, hotspot at
 * its centre) with a selection-mode badge at the bottom-right, as one SVG
 * data URL -- crisp, and free (no overlay redraw on modifier changes).
 * @param badge - Badge.
 * @returns CSS value (`url(...) x y, crosshair`).
 */
export function badgeCursor(badge: CursorBadge): string {
  const cached = badgeCache.get(badge);
  if (cached) return cached;
  const s = BADGE_CURSOR_SIZE;
  const c = BADGE_HOTSPOT + 0.5; // pixel centre: 1 px lines stay crisp
  const cross = `M${c} 1v21M1 ${c}h21`;
  const glyph = BADGE_GLYPHS[badge];
  const attrs = `fill='none' stroke-linecap='square'`;
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' width='${s}' height='${s}' viewBox='0 0 ${s} ${s}'>` +
    `<path ${attrs} stroke='${OUTLINE_COLOR}' stroke-width='3' d='${cross}'/>` +
    `<path ${attrs} stroke='${ICON_COLOR}' stroke-width='1' d='${cross}'/>` +
    `<path ${attrs} stroke='${OUTLINE_COLOR}' stroke-width='4' d='${glyph}'/>` +
    `<path ${attrs} stroke='${ICON_COLOR}' stroke-width='2' d='${glyph}'/>` +
    `</svg>`;
  const value = `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${BADGE_HOTSPOT} ${BADGE_HOTSPOT}, crosshair`;
  badgeCache.set(badge, value);
  return value;
}