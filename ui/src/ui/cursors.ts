/**
 * CSS cursors for the stage, keyed by the tool's {@link ToolCursor}
 * (SPEC "Shortcuts" > "Cursors"). All are SVG data URLs from the composer
 * (`cursorArt.ts`), so the OS cursor set never shows over the stage:
 *
 * - centred: precise cross (shapes, marquees, region tool), text I-beam,
 *   Free Transform resize / rotate glyphs, pan hands, busy hourglass;
 * - Photoshop pointer layout (tiny arrow tip = hotspot, glyph lower-right):
 *   bucket, lasso, polygonal lasso, move;
 * - tip hotspot: eyedropper, magic wand;
 * - ring tools (brush, eraser): nothing (a tiny dot from a 300 px ring on) -- the ring and its indicators
 *   are drawn on the overlay (`ringCursor.ts`); the precise cross while the
 *   ring is too small to see.
 *
 * Badges: mode bottom-right (selection add / subtract / intersect, the
 * eyedropper's background slot; `ban` replaces it while the tool can't edit
 * its target).
 */

import { selectionMode } from "../engine/selection";
import type { SelectionMode } from "../engine/selection";
import type { CursorIcon, ToolCursor, TransformCursorIcon } from "../tools/types";
import type { CursorArt, CursorPart } from "./cursorArt";
import {
  badgePart,
  CENTRED_HOTSPOT,
  CENTRED_SLOTS,
  centredParts,
  cursorCss,
  GLYPH_SIZE,
  POINTER_HOTSPOT,
  POINTER_SLOTS,
  pointerParts,
} from "./cursorArt";
import type { BadgeSlots } from "./cursorArt";

// ── Badges ────────────────────────────────────────────────────────────────

/** Photoshop's cursor badge for a selection mode: add, subtract, intersect. */
export type CursorBadge = Exclude<SelectionMode, "replace">;

/** Mode-slot badge: a selection mode, or the eyedropper's background slot. */
export type ModeBadge = CursorBadge | "bgSlot";

/** Icon of each mode badge. */
const MODE_ICONS: Readonly<Record<ModeBadge, string>> = {
  add: "squareDashedPlus",
  subtract: "squareDashedMinus",
  intersect: "squareDashedX",
  bgSlot: "bgSlot",
};

/** What the stage adds to a tool's cursor. */
export interface CursorExtras {
  /** Mode badge (bottom-right), or `null`. */
  mode?: ModeBadge | null;
  /** The tool can't edit its target: `ban` replaces the mode badge. */
  ban?: boolean;
}

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

// ── Base drawings ─────────────────────────────────────────────────────────

/** Layout of a named cursor: parts, hotspot, badge slots, fallback keyword. */
interface Base {
  parts: CursorPart[];
  hotspot: readonly [number, number];
  slots: BadgeSlots;
  fallback: string;
}

/** Native keyword per transform icon (fallback only). */
const TRANSFORM_FALLBACK: Readonly<Record<TransformCursorIcon, string>> = {
  "resize-ns": "ns-resize",
  "resize-ew": "ew-resize",
  "resize-nwse": "nwse-resize",
  "resize-nesw": "nesw-resize",
  rotate: "crosshair",
};

/** Glyph per transform icon. */
const TRANSFORM_GLYPH: Readonly<Record<TransformCursorIcon, string>> = {
  "resize-ns": "resizeNS",
  "resize-ew": "resizeEW",
  "resize-nwse": "resizeNWSE",
  "resize-nesw": "resizeNESW",
  rotate: "rotate",
};

/** Glyph top-left for tip-hotspot tools (same box as a centred glyph). */
const TIP_BOX = (64 - GLYPH_SIZE) / 2;

/**
 * Layout of a named cursor.
 * @param icon - Cursor name.
 * @returns Layout.
 */
function baseOf(icon: CursorIcon): Base {
  const centred = (glyph: string, fallback = "crosshair"): Base => ({ parts: centredParts(glyph), hotspot: CENTRED_HOTSPOT, slots: CENTRED_SLOTS, fallback });
  const pointer = (glyph: string, fallback = "default"): Base => ({ parts: pointerParts(glyph), hotspot: POINTER_HOTSPOT, slots: POINTER_SLOTS, fallback });
  // Glyph point (24-unit coords) that is the hotspot.
  const tip = (glyph: string, gx: number, gy: number): Base => ({
    parts: centredParts(glyph),
    hotspot: [TIP_BOX + gx, TIP_BOX + gy],
    slots: CENTRED_SLOTS,
    fallback: "crosshair",
  });
  switch (icon) {
    case "crosshair":
      return centred("preciseCross");
    case "text":
      return centred("textCursor", "text");
    case "move":
      return pointer("move", "move");
    case "bucket":
      return pointer("bucket");
    case "lasso":
      return pointer("lasso");
    case "polygonLasso":
      return pointer("polygonLasso");
    // Pipette tip (Lucide: bottom-left end at (2, 22)).
    case "eyedropper":
      return tip("eyedropper", 2, 22);
    // Magic wand: the star point at the stick's top-right end (21, 3).
    case "wand":
      return tip("magicWand", 21, 3);
    default:
      return centred(TRANSFORM_GLYPH[icon], TRANSFORM_FALLBACK[icon]);
  }
}

/**
 * Cursor of a named icon with badges.
 * @param icon - Cursor name.
 * @param extras - Badges.
 * @returns Art.
 */
export function iconCursorArt(icon: CursorIcon, extras: CursorExtras = {}): CursorArt {
  const base = baseOf(icon);
  const parts = [...base.parts];
  if (extras.ban) parts.push(badgePart("ban", base.slots.mode, "ban"));
  else if (extras.mode) parts.push(badgePart(MODE_ICONS[extras.mode], base.slots.mode));
  return { parts, hotspot: base.hotspot, fallback: base.fallback };
}

/**
 * CSS `cursor` value for a named icon with badges (cached).
 * @param icon - Cursor name.
 * @param extras - Badges.
 * @returns CSS value.
 */
export function iconCursor(icon: CursorIcon, extras: CursorExtras = {}): string {
  const key = `icon:${icon}:${extras.mode ?? ""}:${extras.ban ? 1 : 0}`;
  return cursorCss(key, () => iconCursorArt(icon, extras));
}

// ── Ring tools ────────────────────────────────────────────────────────────

/** Below this on-screen ring diameter (CSS px) the ring tools show the precise cross. */
export const RING_CROSS_BELOW = 6;
/** From this on-screen ring diameter (CSS px) on, a dot marks the centre; smaller rings show nothing there. */
export const RING_DOT_FROM = 300;

/**
 * The ring tools' CSS cursor: a tiny dot (dark centre, light edge) at the
 * hotspot; the ring itself is overlay-drawn.
 * @returns CSS value.
 */
export function dotCursor(): string {
  return cursorCss("dot", () => ({ parts: [{ icon: "dot", x: 0, y: 0, size: 8, filled: true }], hotspot: [4, 4], fallback: "crosshair", canvas: 8 }));
}

/**
 * CSS `cursor` value for a tool cursor descriptor.
 * @param cursor - Tool cursor.
 * @param extras - Badges (icon cursors; ring badges are overlay-drawn).
 * @param ringCss - The ring's on-screen diameter, CSS px (ring cursors).
 * @returns CSS `cursor` property value.
 */
export function cssCursor(cursor: ToolCursor, extras: CursorExtras = {}, ringCss = Infinity): string {
  if (cursor.kind === "ring") return ringCss < RING_CROSS_BELOW ? iconCursor("crosshair") : ringCss < RING_DOT_FROM ? "none" : dotCursor();
  return iconCursor(cursor.icon, extras);
}

// ── Stage states ──────────────────────────────────────────────────────────

/**
 * Cursors the stage CSS uses for pan / busy (`--cps-cursor-grab`,
 * `--cps-cursor-grabbing`, `--cps-cursor-busy`).
 * @returns CSS values.
 */
export function stateCursors(): { grab: string; grabbing: string; busy: string } {
  const centred = (key: string, glyph: string, fallback: string): string =>
    cursorCss(key, () => ({ parts: centredParts(glyph), hotspot: CENTRED_HOTSPOT, fallback }));
  return { grab: centred("grab", "hand", "grab"), grabbing: centred("grabbing", "handGrab", "grabbing"), busy: centred("busy", "hourglass", "progress") };
}
