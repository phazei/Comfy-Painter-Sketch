/**
 * Lifting a float (SPEC M10a "Floats"), the entry half of `floatOps.ts`:
 * read the selected pixels of the current edit layer, coverage-weighted
 * (`floatMath.liftPixels`), and (for a move) leave the remainder on the
 * layer at once. A whole-layer lift (Free Transform without a selection)
 * takes every pixel. All functions are stateless over {@link EditorState};
 * `FloatOps` owns the resulting {@link FloatState}.
 */

import { activeEditLayer } from "../document/masks";
import { intersectRect, isEmptyRect } from "../geometry/rect";
import type { Rect } from "../geometry/rect";
import type { EditorState } from "./editorState";
import { liftPixels } from "./floatMath";
import { EMPTY_LAYER_NOTE } from "./layerFlip";
import { layerContentRect } from "./layerTranslate";
import { editBlockNote, preparePixelEdit } from "./rasterize";
import { coverageFor, selectionExtent } from "./selection";
import type { Selection } from "./selection";
import { createSurface } from "./surface";
import type { Surface } from "./surface";
import type { Affine, TransformParams } from "./transformMath";

/** Note when the selection holds no pixels of the layer. */
export const EMPTY_FLOAT_NOTE = "No pixels are selected.";

/** One floating selection. */
export interface FloatState {
  layerId: string;
  /** Lifted document rect (inside the bounds at lift time). */
  area: Rect;
  /** Layer pixels over the hole ({@link holeOf}) before the lift (cancel / undo). */
  original: ImageData;
  /**
   * Layer rect `original` covers when it differs from `area` (a lift from
   * a kept original, M11b: the pixels are the original, the hole is the
   * layer's current content).
   */
  holeRect?: Rect;
  /** Matrix at lift time when not `translation(area)` (kept original): commit at it = cancel. */
  liftM?: Affine;
  /** Session parameters that produced `xf` (Free Transform), when known. */
  params?: TransformParams;
  /** Floating pixels over `area` (straight alpha). */
  pixels: ImageData;
  /** `pixels` on a canvas (display). */
  surface: Surface;
  /** Current offset, whole document px. */
  dx: number;
  dy: number;
  /** Selection at lift time (`null` = whole-layer lift); cancel restores it. */
  selBefore: Selection | null;
  /** Selection at offset (0, 0): `selBefore`, or its transformed copy. */
  selBase: Selection | null;
  /** Float-local -> document matrix before the offset; `null` = plain lift position. */
  xf: Affine | null;
  /**
   * Resampled display of `xf` after a session ended (exact, what lands);
   * `null` while a session runs (smoothed canvas preview). Always derived
   * from `pixels` (the ORIGINAL lift), never fed back.
   */
  baked: { surface: Surface; rect: Rect; m: Affine } | null;
  /** Offset at drag start while a drag is in progress. */
  dragBase: { dx: number; dy: number } | null;
  /** Display cache: layer + float, sized to the bounds. */
  preview: { surface: Surface; key: string } | null;
}

/**
 * What a lift of the current edit layer would do (see `FloatOps.check`).
 * @param s - Editor state.
 * @returns Check result (notes already shown for `"blocked"`).
 */
export function checkLift(s: EditorState): "ok" | "blocked" | "confirm" {
  const sel = s.selection.current;
  if (s.loading || s.stroke.active || !sel) return "blocked";
  const layer = activeEditLayer(s.doc, s.target, s.currentMaskId);
  if (!layer) return "blocked";
  const note = editBlockNote(s, layer);
  if (note) {
    s.events.emit("note", note);
    return "blocked";
  }
  if (layer.kind === "text") return "confirm";
  const area = intersectRect(selectionExtent(sel, s.store.bounds), layerContentRect(s, layer.id));
  if (isEmptyRect(area)) return empty(s, EMPTY_FLOAT_NOTE) || "blocked";
  return "ok";
}

/**
 * Outside any gesture: run the pixel-edit gate for a lift (text rasterize confirm).
 * @param s - Editor state.
 */
export function prepareLift(s: EditorState): void {
  const layer = activeEditLayer(s.doc, s.target, s.currentMaskId);
  if (layer) preparePixelEdit(s, layer);
}

/**
 * Lift pixels of the current edit layer (the pixel-edit gate runs first).
 * @param s - Editor state.
 * @param copy - `true` = copy (no hole).
 * @param sel - Selection to lift, or `null` for the whole layer.
 * @returns The new float, or `null` (note shown).
 */
export function liftFloat(s: EditorState, copy: boolean, sel: Selection | null): FloatState | null {
  if (s.loading || s.stroke.active) return null;
  const layer = activeEditLayer(s.doc, s.target, s.currentMaskId);
  if (!layer || preparePixelEdit(s, layer) === "blocked") return null;
  const note = sel ? EMPTY_FLOAT_NOTE : EMPTY_LAYER_NOTE;
  const content = layerContentRect(s, layer.id);
  // A selection lift takes the whole selection rect (transparent parts
  // included) so box, pixels and coverage stay aligned with the outline.
  const area = sel ? selectionExtent(sel, s.store.bounds) : content;
  const read = isEmptyRect(area) ? null : s.store.read(layer.id, area);
  if (!read) return empty(s, note) || null;
  const coverage = sel ? coverageFor(sel, read.rect) : new Uint8Array(read.rect.width * read.rect.height).fill(255);
  const { float, rest } = liftPixels(read.data.data, coverage, !copy);
  if (!hasAlpha(float)) return empty(s, note) || null;
  const w = read.rect.width;
  const h = read.rect.height;
  const pixels = new ImageData(float, w, h);
  if (!copy) {
    s.store.write(layer.id, read.rect.x, read.rect.y, new ImageData(rest, w, h));
    s.runtime.bump(layer.id);
  }
  const surface = createSurface(w, h);
  surface.ctx.putImageData(pixels, 0, 0);
  return { layerId: layer.id, area: read.rect, original: read.data, pixels, surface, dx: 0, dy: 0, selBefore: sel, selBase: sel, xf: null, baked: null, dragBase: null, preview: null };
}

/**
 * Whole-layer lift from the layer's kept original (M11b; no selection):
 * the float's pixels are the pre-transform original at its cumulative
 * matrix, the hole is the layer's current content. Same gate as a lift.
 * @param s - Editor state.
 * @returns The new float, or `null` (no valid original / blocked; notes shown when blocked).
 */
export function liftKept(s: EditorState): FloatState | null {
  if (s.loading || s.stroke.active || s.selection.current) return null;
  const layer = activeEditLayer(s.doc, s.target, s.currentMaskId);
  if (!layer || layer.kind === "text" || !s.kept.get(layer.id, s.runtime.revision(layer.id))) return null;
  if (preparePixelEdit(s, layer) === "blocked") return null;
  // The gate may have settled something: look again.
  const kept = s.kept.get(layer.id, s.runtime.revision(layer.id));
  const content = layerContentRect(s, layer.id);
  const read = kept && !isEmptyRect(content) ? s.store.read(layer.id, content) : null;
  if (!kept || !read) return null;
  const { width: w, height: h } = read.rect;
  s.store.write(layer.id, read.rect.x, read.rect.y, new ImageData(w, h));
  s.runtime.bump(layer.id);
  const { width: pw, height: ph } = kept.area;
  const surface = createSurface(pw, ph);
  surface.ctx.putImageData(kept.pixels, 0, 0);
  return {
    layerId: layer.id, area: { ...kept.area }, original: read.data, holeRect: read.rect, liftM: kept.m, params: kept.params, pixels: kept.pixels, surface,
    dx: 0, dy: 0, selBefore: null, selBase: null, xf: kept.m, baked: null, dragBase: null, preview: null,
  };
}

/**
 * Layer rect a float's `original` covers (its hole).
 * @param f - Float.
 * @returns Document rect.
 */
export function holeOf(f: Readonly<FloatState>): Rect {
  return f.holeRect ?? f.area;
}

function empty(s: EditorState, note: string): false {
  s.events.emit("note", note);
  return false;
}

function hasAlpha(px: Uint8ClampedArray): boolean {
  for (let p = 3; p < px.length; p += 4) if (px[p] !== 0) return true;
  return false;
}
