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
 * The crosshair is a plain CSS keyword (browser-native, no image needed).
 * Ring cursors (brush/eraser) also keep the plain crosshair; the size ring
 * itself is drawn on the overlay canvas.
 */

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
const HOTSPOTS: Readonly<Record<Exclude<CursorIcon, "crosshair">, readonly [number, number]>> = {
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
 * canvas draws the size ring); icon cursors return an SVG data URL.
 *
 * @param cursor - Tool cursor descriptor.
 * @returns CSS `cursor` property value.
 */
export function cssCursor(cursor: ToolCursor): string {
  return cursor.kind === "ring" ? "crosshair" : iconCursor(cursor.icon);
}