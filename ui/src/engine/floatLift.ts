/**
 * Lifting a float (SPEC "Floating selections"), the entry half of
 * `floatOps.ts`: read the selected pixels of the current edit layer, coverage-weighted
 * (`floatMath.liftPixels`), and (for a move) leave the remainder on the
 * layer at once. A whole-layer lift (Free Transform without a selection)
 * takes every pixel. All functions are stateless over {@link EditorState};
 * `FloatOps` owns the resulting {@link FloatState}.
 *
 * Layer masks (`layerMaskCarry.ts`): a selection lift takes the
 * targeted part -- the layer's pixels (the lmask stays put) or, with the
 * lmask targeted, the mask's own pixels as grayscale. A whole-layer lift
 * always carries the layer's lmask along ({@link FloatState.carry}).
 */

import { activeEditLayer } from "../document/masks";
import type { Layer } from "../document/types";
import { intersectRect, isEmptyRect } from "../geometry/rect";
import type { Rect } from "../geometry/rect";
import type { EditorState } from "./editorState";
import { liftPixels } from "./floatMath";
import { selectedSurfaceKey } from "./layerMask";
import type { EditKind } from "./layerMask";
import { liftCarry, liftMaskPixels, maskFloatSurfaces } from "./layerMaskCarry";
import type { MaskCarry } from "./layerMaskCarry";
import { EMPTY_LAYER_NOTE } from "./layerFlip";
import { layerContentRect } from "./layerTranslate";
import { editBlockNote, preparePixelEdit } from "./rasterize";
import { coverageFor, selectionExtent } from "./selection";
import type { Selection } from "./selection";
import { createSurface } from "./surface";
import type { Surface } from "./surface";
import { translation } from "./transformMath";
import type { Affine, TransformParams } from "./transformMath";

/** Note when the selection holds no pixels of the layer. */
export const EMPTY_FLOAT_NOTE = "No pixels are selected.";

/** One floating selection. */
export interface FloatState {
  /** Store key the float belongs to: a layer id, or a layer mask key (lmask-targeted lift). */
  layerId: string;
  /** Lifted document rect (inside the bounds at lift time). */
  area: Rect;
  /** Layer pixels over the hole ({@link holeOf}) before the lift (cancel / undo). */
  original: ImageData;
  /**
   * Layer rect `original` covers when it differs from `area` (a lift from
   * a kept original: the pixels are the original, the hole is the
   * layer's current content).
   */
  holeRect?: Rect;
  /** Matrix at lift time when not `translation(area)` (kept original): commit at it = cancel. */
  liftM?: Affine;
  /** Session parameters that produced `xf` (Free Transform), when known. */
  params?: TransformParams;
  /** Floating pixels over `area` (straight alpha; lmask floats: value in RGB, coverage in alpha). */
  pixels: ImageData;
  /** `pixels` on a canvas (display; lmask floats: the value as mask pixels). */
  surface: Surface;
  /** lmask float: the coverage as mask pixels (display, `layerMaskCarry.ts`). */
  cover?: Surface;
  /** Whole-layer lift of a layer with an lmask: the mask travelling with it. */
  carry?: MaskCarry;
  /** Current offset, whole document px. */
  dx: number;
  dy: number;
  /** Selection at lift time (`null` = whole-layer lift); cancel restores it. */
  selBefore: Selection | null;
  /** Selection at offset (0, 0): `selBefore`, or its transformed copy. */
  selBase: Selection | null;
  /**
   * A pasted float (`clipboardOps.ts`): the selection before the paste
   * (`selBefore` is then the float's own outline, or `null` in Free
   * Transform). Cancel restores it; commit drops the outline and records
   * the change from it, in the commit's step.
   */
  selPrior?: Selection | null;
  /** Float-local -> document matrix before the offset; `null` = plain lift position. */
  xf: Affine | null;
  /**
   * Resampled display of `xf` after a session ended (exact, what lands);
   * `null` while a session runs (smoothed canvas preview). Always derived
   * from `pixels` (the ORIGINAL lift), never fed back.
   */
  baked: { surface: Surface; rect: Rect; m: Affine; cover?: Surface } | null;
  /** Offset at drag start while a drag is in progress. */
  dragBase: { dx: number; dy: number } | null;
  /** Display cache: layer + float, sized to the bounds. */
  preview: { surface: Surface; key: string } | null;
  /** An inserted image (`sourceInsert.ts`): has no lift position, so a commit always lands. */
  inserted?: boolean;
  /**
   * Paint bounds before this float existed. The bounds grow while it moves /
   * transforms only so it can be shown; commit and cancel go back to these,
   * then the commit grows them for where the float actually lands.
   * Set by creators that grow the bounds first; otherwise on adopt.
   */
  boundsBase?: Rect;
  /**
   * A shape tool's result (`shapeFloat.ts`): independent of the selection
   * (commit and cancel leave it alone; the shape was clipped when drawn).
   */
  shape?: boolean;
  /**
   * Layer pixels over `rect` as an untouched commit lands them (the shape
   * composited exactly as a direct commit would); used while the matrix is
   * still the lift matrix.
   */
  exact?: { rect: Rect; data: ImageData };
  /** Called once when the float ends: `true` = committed (landed), `false` = cancelled. */
  onEnd?: (landed: boolean) => void;
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
  const key = selectedSurfaceKey(s, layer);
  const note = editBlockNote(s, layer, liftKind(layer, key));
  if (note) {
    s.events.emit("note", note);
    return "blocked";
  }
  if (layer.kind === "text") return "confirm";
  // A mask has a value everywhere: any selected part of it lifts.
  const content = key === layer.id ? layerContentRect(s, layer.id) : s.store.bounds;
  const area = intersectRect(selectionExtent(sel, s.store.bounds), content);
  if (isEmptyRect(area)) return empty(s, EMPTY_FLOAT_NOTE) || "blocked";
  return "ok";
}

/**
 * Outside any gesture: run the pixel-edit gate for a lift (text rasterize confirm).
 * @param s - Editor state.
 */
export function prepareLift(s: EditorState): void {
  const layer = activeEditLayer(s.doc, s.target, s.currentMaskId);
  if (layer) preparePixelEdit(s, layer, "whole");
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
  if (!layer) return null;
  // A selection lift takes the targeted part (lmask or pixels); a whole-layer lift the pixels + carry.
  const key = sel ? selectedSurfaceKey(s, layer) : layer.id;
  const gray = key !== layer.id;
  if (preparePixelEdit(s, layer, liftKind(layer, key)) === "blocked") return null;
  const note = sel ? EMPTY_FLOAT_NOTE : EMPTY_LAYER_NOTE;
  const content = layerContentRect(s, layer.id);
  // A selection lift takes the whole selection rect (transparent parts
  // included) so box, pixels and coverage stay aligned with the outline.
  const area = sel ? selectionExtent(sel, s.store.bounds) : content;
  const read = isEmptyRect(area) ? null : s.store.read(key, area);
  if (!read) return empty(s, note) || null;
  const coverage = sel ? coverageFor(sel, read.rect) : new Uint8Array(read.rect.width * read.rect.height).fill(255);
  const { float, rest } = gray ? liftMaskPixels(read.data.data, coverage, !copy) : liftPixels(read.data.data, coverage, !copy);
  if (gray ? !coverage.some((c) => c > 0) : !hasAlpha(float)) return empty(s, note) || null;
  const w = read.rect.width;
  const h = read.rect.height;
  const pixels = new ImageData(float, w, h);
  if (!copy) {
    s.store.write(key, read.rect.x, read.rect.y, new ImageData(rest, w, h));
    s.runtime.bump(key);
  }
  const shown = gray ? maskFloatSurfaces(float, w, h) : null;
  const surface = shown?.value ?? createSurface(w, h);
  if (!shown) surface.ctx.putImageData(pixels, 0, 0);
  const carry = sel ? null : liftCarry(s, layer);
  return {
    layerId: key, area: read.rect, original: read.data, pixels, surface, dx: 0, dy: 0, selBefore: sel, selBase: sel, xf: null, baked: null, dragBase: null, preview: null,
    ...(shown ? { cover: shown.cover } : {}),
    ...(carry ? { carry } : {}),
  };
}

/**
 * Whole-layer lift from the layer's kept original (no selection):
 * the float's pixels are the pre-transform original at its cumulative
 * matrix, the hole is the layer's current content. Same gate as a lift.
 * @param s - Editor state.
 * @returns The new float, or `null` (no valid original / blocked; notes shown when blocked).
 */
export function liftKept(s: EditorState): FloatState | null {
  if (s.loading || s.stroke.active || s.selection.current) return null;
  const layer = activeEditLayer(s.doc, s.target, s.currentMaskId);
  if (!layer || layer.kind === "text" || !s.kept.get(layer.id, s.runtime.revision(layer.id))) return null;
  if (preparePixelEdit(s, layer, "whole") === "blocked") return null;
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
  // The lmask restarts from its own kept original when that is valid too (`liftCarry`).
  const carry = liftCarry(s, layer);
  return {
    layerId: layer.id, area: { ...kept.area }, original: read.data, holeRect: read.rect, liftM: kept.m, params: kept.params, pixels: kept.pixels, surface,
    dx: 0, dy: 0, selBefore: null, selBase: null, xf: kept.m, baked: null, dragBase: null, preview: null,
    ...(carry ? { carry } : {}),
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

/**
 * A float's matrix at lift time (a commit there is a cancel).
 * @param f - Float.
 * @returns Float-local -> document matrix.
 */
export function liftMatrix(f: Readonly<FloatState>): Affine {
  return f.liftM ?? translation(f.area.x, f.area.y);
}

/** Gate kind of a lift: lmask pixels are a mask-aware edit (lmask-only view exception applies). */
function liftKind(layer: Layer, key: string): EditKind {
  return key === layer.id ? "whole" : "paint";
}

function empty(s: EditorState, note: string): false {
  s.events.emit("note", note);
  return false;
}

function hasAlpha(px: Uint8ClampedArray): boolean {
  for (let p = 3; p < px.length; p += 4) if (px[p] !== 0) return true;
  return false;
}
