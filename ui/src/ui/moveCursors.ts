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
 */

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

/** Badge drawings at the lower right (drawn white-wide, then black). */
const BADGES: Readonly<Record<Exclude<MoveCursorKind, "move">, string>> = {
  cut: "<circle cx='22' cy='28' r='2.2'/><circle cx='28.5' cy='28' r='2.2'/><path d='M23.2 26.2L28 18.5M27.3 26.2L22.5 18.5'/>",
  copy: "<path d='M25 19v10M20 24h10'/>",
  outline: "<rect x='18.5' y='20.5' width='11' height='8'/>",
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
  const badge = BADGES[kind];
  const dash = kind === "outline" ? " stroke-dasharray='2 1.5'" : "";
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' width='${SIZE}' height='${SIZE}' viewBox='0 0 ${SIZE} ${SIZE}'>` +
    `<path d='${shape}' fill='#000' stroke='#fff' stroke-width='1.5' stroke-linejoin='round' paint-order='stroke'/>` +
    `<g fill='none' stroke='#fff' stroke-width='3.5' stroke-linecap='round'>${badge}</g>` +
    `<g fill='none' stroke='#000' stroke-width='1.5' stroke-linecap='round'${dash}>${badge}</g>` +
    `</svg>`;
  const [x, y, fallback] = HOTSPOTS[kind];
  const value = `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${x} ${y}, ${fallback}`;
  cache.set(kind, value);
  return value;
}
