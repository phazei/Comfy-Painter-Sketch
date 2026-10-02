/**
 * Photoshop-style move cursors (SPEC "Shortcuts" > "Cursors"): while hovering, the stage cursor
 * shows what a drag would do right now -- decided from the tool
 * `ToolRegistry.resolve` picks for the held modifiers and whether the
 * pointer is inside the selection (coverage >= 50 %, the test the press uses).
 *
 * - `cut`: lift the selected pixels (Move inside; selection tool + Ctrl inside)
 *   -- pointer + scissors.
 * - `copy`: lift a copy (Alt with Move inside; Ctrl+Alt with selection tools)
 *   -- pointer + `copy-plus`.
 * - `outline`: drag only the outline (selection tool, plain, inside) --
 *   pointer + dashed square.
 * - `move`: whole-layer move (outside / no selection, or a float exists) --
 *   pointer + four-way arrow.
 *
 * All use the Photoshop pointer layout of `cursorArt.ts` (tiny arrow tip =
 * hotspot, glyph lower-right). Also: the layer row Ctrl+click "load
 * selection" cursors ({@link layerSelectCursorCss}).
 */

import { selectionMode } from "../engine/selection";
import type { SelectionMode } from "../engine/selection";
import { badgePart, cursorCss, POINTER_HOTSPOT, POINTER_SLOTS, pointerParts } from "./cursorArt";

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

// ── Cursors ────────────────────────────────────────────────────────────────

/** Glyph per move kind. */
const KIND_GLYPHS: Readonly<Record<MoveCursorKind, string>> = {
  cut: "cut",
  copy: "copyPlus",
  outline: "marqueeRect",
  move: "move",
};

/** Fallback keyword per move kind. */
const KIND_FALLBACK: Readonly<Record<MoveCursorKind, string>> = { cut: "move", copy: "copy", outline: "default", move: "move" };

/**
 * CSS `cursor` value for a move cursor kind (cached).
 * @param kind - Kind.
 * @param ban - The layer can't be moved now: `ban` badge.
 * @returns CSS value.
 */
export function moveCursorCss(kind: MoveCursorKind, ban = false): string {
  return cursorCss(`move:${kind}:${ban ? 1 : 0}`, () => {
    const parts = pointerParts(KIND_GLYPHS[kind]);
    if (ban) parts.push(badgePart("ban", POINTER_SLOTS.mode, "ban"));
    return { parts, hotspot: POINTER_HOTSPOT, fallback: KIND_FALLBACK[kind] };
  });
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

/** Dashed-square glyph per selection mode (the mark is part of the glyph). */
const MODE_GLYPHS: Readonly<Record<SelectionMode, string>> = {
  replace: "marqueeRect",
  add: "squareDashedPlus",
  subtract: "squareDashedMinus",
  intersect: "squareDashedX",
};

/**
 * CSS `cursor` for Ctrl-hovering a layer row: pointer + dashed square
 * carrying the mode mark. Cached per mode.
 * @param mode - Selection mode.
 * @returns CSS value.
 */
export function layerSelectCursorCss(mode: SelectionMode): string {
  return cursorCss(`row:${mode}`, () => ({ parts: pointerParts(MODE_GLYPHS[mode]), hotspot: POINTER_HOTSPOT, fallback: "default" }));
}