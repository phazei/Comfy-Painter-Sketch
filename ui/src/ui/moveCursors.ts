/**
 * Photoshop-style move cursors (SPEC M10a): while hovering, the stage cursor
 * shows what a drag would do right now -- decided from the tool
 * `ToolRegistry.resolve` picks for the held modifiers and whether the
 * pointer is inside the selection (coverage >= 50 %, the test the press uses).
 *
 * - `cut`: lift the selected pixels (Move inside; selection tool + Ctrl inside)
 *   -- move cursor + scissors badge.
 * - `copy`: lift a copy (Alt with Move inside; Ctrl+Alt with selection tools)
 *   -- move cursor + "+" badge.
 * - `outline`: drag only the outline (selection tool, plain, inside) -- arrow
 *   + dotted-rectangle badge.
 * - `move`: whole-layer move (outside / no selection, or a float exists) --
 *   the native `move` keyword, as before.
 *
 * Cursors are SVG data URLs (black shape, white outline), built once per kind.
 * Marquee badges reuse the rail's `marqueeRect` icon path. Also: the layer
 * row Ctrl+click "load selection" cursors ({@link layerSelectCursorCss}).
 */

import { selectionMode } from "../engine/selection";
import type { SelectionMode } from "../engine/selection";
import { iconPath } from "./icons";

/** What a Move-type drag would do. */
export type MoveCursorKind = "cut" | "copy" | "outline" | "move";

/** Tool id of the layer Move tool (`tools/moveLayer.ts`). */
const MOVE_LAYER_ID = "move-layer";
/** Tool id of the outline drag substitute (`tools/outlineDrag.ts`). */
const OUTLINE_ID = "selection-outline";

/**
 * Which move cursor applies (pure).
 * @param state - Resolved tool id, Alt held, pointer inside the selection, a float exists.
 * @returns The kind, or `null` if the tool is not a move tool.
 */
export function moveCursorKind(state: { toolId: string; alt: boolean; inSelection: boolean; floatActive: boolean }): MoveCursorKind | null {
  if (state.toolId === OUTLINE_ID) return "outline";
  if (state.toolId !== MOVE_LAYER_ID) return null;
  // With a float every drag moves the float; outside the selection the whole layer moves.
  if (state.floatActive || !state.inSelection) return "move";
  return state.alt ? "copy" : "cut";
}

// ── SVG ────────────────────────────────────────────────────────────────────

const SIZE = 32;
/** Four-way move arrows centred on (11, 11). */
const MOVE_PATH = "M11 1.5l-3.5 3.5h2.5v5H5V7.5L1.5 11 5 14.5V12h5v5H7.5l3.5 3.5 3.5-3.5H12v-5h5v2.5l3.5-3.5L17 7.5V10h-5V5h2.5z";
/** Pointer arrow, tip at (2, 2). */
const ARROW_PATH = "M2 2v16l4.2-4 3 6.6 2.6-1.2-3-6.4H14.5z";

/**
 * The rail's rectangular-marquee icon (`icons.ts` `marqueeRect`, 24 box,
 * dashes x 4-20 / y 6-18) scaled 0.7 into the lower-right badge area.
 * The stroke width is not scaled (`non-scaling-stroke`).
 */
const MARQUEE_BADGE = `<path transform='translate(14.2 16.8) scale(0.7)' vector-effect='non-scaling-stroke' d='${iconPath("marqueeRect")}'/>`;

/** Selection-mode marks drawn above the marquee badge (Photoshop's +, -, x). */
const MODE_MARKS: Readonly<Record<SelectionMode, string>> = {
  replace: "",
  add: "<path d='M26 9v6M23 12h6'/>",
  subtract: "<path d='M23 12h6'/>",
  intersect: "<path d='M23.5 9.5l5 5M28.5 9.5l-5 5'/>",
};

/** Badge drawings at the lower right (drawn white-wide, then black). */
const BADGES: Readonly<Record<Exclude<MoveCursorKind, "move">, string>> = {
  cut: "<circle cx='22' cy='28' r='2.2'/><circle cx='28.5' cy='28' r='2.2'/><path d='M23.2 26.2L28 18.5M27.3 26.2L22.5 18.5'/>",
  copy: "<path d='M25 19v10M20 24h10'/>",
  outline: MARQUEE_BADGE,
};

const HOTSPOTS: Readonly<Record<Exclude<MoveCursorKind, "move">, readonly [number, number, string]>> = {
  cut: [11, 11, "move"],
  copy: [11, 11, "move"],
  outline: [2, 2, "default"],
};

const cache = new Map<MoveCursorKind, string>();

/**
 * CSS `cursor` value for a move cursor kind (cached; `move` is the native keyword).
 * @param kind - Kind.
 * @returns CSS value.
 */
export function moveCursorCss(kind: MoveCursorKind): string {
  if (kind === "move") return "move";
  const cached = cache.get(kind);
  if (cached) return cached;
  const shape = kind === "outline" ? ARROW_PATH : MOVE_PATH;
  const [x, y, fallback] = HOTSPOTS[kind];
  const value = badgedCursor(shape, BADGES[kind], x, y, fallback);
  cache.set(kind, value);
  return value;
}

/**
 * Cursor shape + badge as a CSS `cursor` value (black on a white outline).
 * @param shape - Main path (arrow / move arrows).
 * @param badge - Badge SVG elements.
 * @param x - Hotspot x.
 * @param y - Hotspot y.
 * @param fallback - Fallback cursor keyword.
 * @returns CSS value.
 */
function badgedCursor(shape: string, badge: string, x: number, y: number, fallback: string): string {
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' width='${SIZE}' height='${SIZE}' viewBox='0 0 ${SIZE} ${SIZE}'>` +
    `<path d='${shape}' fill='#000' stroke='#fff' stroke-width='1.5' stroke-linejoin='round' paint-order='stroke'/>` +
    `<g fill='none' stroke='#fff' stroke-width='3.5' stroke-linecap='round'>${badge}</g>` +
    `<g fill='none' stroke='#000' stroke-width='1.5' stroke-linecap='round'>${badge}</g>` +
    `</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${x} ${y}, ${fallback}`;
}

// ── Layer row: load selection (Ctrl+click) ─────────────────────────────────

/**
 * Which selection mode a Ctrl+click on a layer row would use (pure; the
 * hover cursor and the click share it): Ctrl = replace, +Shift add,
 * +Alt subtract, +Shift+Alt intersect.
 * @param mods - Held modifiers (`ctrl` includes Cmd).
 * @returns Mode, or `null` without Ctrl.
 */
export function layerSelectMode(mods: { ctrl: boolean; shift: boolean; alt: boolean }): SelectionMode | null {
  return mods.ctrl ? selectionMode(mods.shift, mods.alt) : null;
}

const selectCache = new Map<SelectionMode, string>();

/**
 * CSS `cursor` for Ctrl-hovering a layer row: arrow + marquee badge, plus
 * the mode mark (+ add, - subtract, x intersect). Cached per mode.
 * @param mode - Selection mode.
 * @returns CSS value.
 */
export function layerSelectCursorCss(mode: SelectionMode): string {
  const cached = selectCache.get(mode);
  if (cached) return cached;
  const value = badgedCursor(ARROW_PATH, MARQUEE_BADGE + MODE_MARKS[mode], 2, 2, "default");
  selectCache.set(mode, value);
  return value;
}

// ── Free Transform rotate ──────────────────────────────────────────────────

/**
 * Two circling arcs (refresh icon) on a radius-9 circle centred (16, 16),
 * each ~130 deg with a gap for its arrowhead (clockwise).
 */
const ROTATE_ARCS = "M16 7A9 9 0 0 1 24.46 19.08M16 25A9 9 0 0 1 7.54 12.92";
/** Filled arrowheads at the arcs' clockwise ends. */
const ROTATE_HEADS = "M27.5 17.5 24 23.5 20.2 18.4zM4.5 14.5 8 8.5 11.8 13.6z";

let rotateCursor = "";

/**
 * CSS `cursor` for the Free Transform rotate zone: two circling arrows,
 * black with a white outline like the move cursors, hotspot at the centre
 * (built once).
 * @returns CSS value.
 */
export function rotateCursorCss(): string {
  if (rotateCursor) return rotateCursor;
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' width='${SIZE}' height='${SIZE}' viewBox='0 0 ${SIZE} ${SIZE}'>` +
    `<path d='${ROTATE_ARCS}' fill='none' stroke='#fff' stroke-width='4.5'/>` +
    `<path d='${ROTATE_HEADS}' fill='#fff' stroke='#fff' stroke-width='3' stroke-linejoin='round'/>` +
    `<path d='${ROTATE_ARCS}' fill='none' stroke='#000' stroke-width='2'/>` +
    `<path d='${ROTATE_HEADS}' fill='#000'/>` +
    `</svg>`;
  rotateCursor = `url("data:image/svg+xml,${encodeURIComponent(svg)}") 16 16, crosshair`;
  return rotateCursor;
}
