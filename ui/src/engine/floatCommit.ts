/**
 * Pixel work of a float's commit and preview (`floatOps.ts`), kept apart so
 * the float state machine stays small:
 *
 * - {@link writeFloatPatch}: land the float in its layer as ONE patch over
 *   (lifted area U destination), clipped to the bounds (pixels beyond the
 *   paint-area cap are cropped). Plain floats composite their pixels at the
 *   whole-px offset; transformed floats (M11) are resampled once from the
 *   lifted pixels (`transformResample.ts`) over the matrix's bounds.
 * - {@link drawFloatPreview}: the layer with its float drawn on top --
 *   plain floats at their offset (exact), transformed ones through the
 *   matrix with canvas smoothing (cheap, no `getImageData`).
 * - Layer masks (M14b, `layerMaskCarry.ts`): an lmask float lands by
 *   replacing (`landMaskPixels`) and shows as coverage `destination-out` +
 *   value `lighter`; a carried lmask lands in the same undo step.
 */

import { intersectRect, unionRect } from "../geometry/rect";
import type { Rect } from "../geometry/rect";
import type { EditorState } from "./editorState";
import { compositeOver, copyPixels } from "./floatMath";
import { holeOf, liftMatrix } from "./floatLift";
import type { FloatState } from "./floatLift";
import { carryMatrix, landMaskPixels, maskFloatSurfaces, releaseCarry, writeCarryPatch } from "./layerMaskCarry";
import { recordSelectionMove } from "./selectionFollow";
import { transformedAabb } from "./transformMath";
import type { Affine } from "./transformMath";
import { resampleRgba } from "./transformResample";
import { createSurface, releaseSurface } from "./surface";
import type { Surface } from "./surface";

/**
 * Whether a float lands without resampling (no matrix, whole-px offset).
 * @param f - Float.
 * @param m - Its full float-local -> document matrix.
 * @returns `true` for a plain placement.
 */
export function isPlainPlacement(f: Readonly<FloatState>, m: Affine): boolean {
  return !f.xf && m.a === 1 && m.b === 0 && m.c === 0 && m.d === 1;
}

/**
 * Write a (detached) float into its layer and record ONE undo step: the
 * patch, joined with the selection change since the lift.
 * @param s - Editor state.
 * @param f - The float (already cleared from `FloatOps`).
 * @param m - Its full float-local -> document matrix.
 */
export function writeFloatPatch(s: EditorState, f: Readonly<FloatState>, m: Affine): void {
  const plain = isPlainPlacement(f, m);
  const dest: Rect = plain ? { ...f.area, x: m.e, y: m.f } : transformedAabb(m, f.area.width, f.area.height);
  s.ensureBounds(dest, true);
  const hole = holeOf(f);
  const union = intersectRect(unionRect(hole, dest), s.store.bounds);
  const current = s.store.read(f.layerId, union);
  if (!current) return;
  const r = current.rect;
  const before = new Uint8ClampedArray(current.data.data);
  copyPixels(before, r, f.original.data, hole);
  const next = new Uint8ClampedArray(current.data.data);
  const at = plain ? dest : intersectRect(dest, r);
  const src = plain ? f.pixels.data : resampleRgba(f.pixels.data, f.area.width, f.area.height, m, at);
  if (f.cover) landMaskPixels(next, r.width, r.height, src, at.width, at.height, at.x - r.x, at.y - r.y);
  else compositeOver(next, r.width, r.height, src, at.width, at.height, at.x - r.x, at.y - r.y);
  s.store.write(f.layerId, r.x, r.y, new ImageData(next, r.width, r.height));
  // Re-read so the patch holds exactly what the canvas stores.
  const after = s.store.read(f.layerId, r);
  if (after) {
    const beforeData = new ImageData(before, r.width, r.height);
    const bytes = before.byteLength + after.data.data.byteLength;
    s.history.push({ kind: "patch", layerId: f.layerId, x: r.x, y: r.y, before: beforeData, after: after.data, bytes });
    recordSelectionMove(s, f.selBefore, s.selection.current, true);
    // The carried lmask lands with the layer, same step (M14b).
    if (f.carry) writeCarryPatch(s, f.carry, carryMatrix(f.carry, liftMatrix(f), m));
  }
  s.runtime.touch(f.layerId);
}

/**
 * Resample a transformed float once for display (from its lifted pixels).
 * @param f - Float.
 * @param m - Its full float-local -> document matrix.
 * @returns Surface over the matrix's bounds.
 */
export function bakeFloat(f: Readonly<FloatState>, m: Affine): { surface: Surface; rect: Rect; m: Affine; cover?: Surface } {
  const rect = transformedAabb(m, f.area.width, f.area.height);
  const w = Math.max(1, rect.width);
  const h = Math.max(1, rect.height);
  const px = rect.width > 0 && rect.height > 0 ? resampleRgba(f.pixels.data, f.area.width, f.area.height, m, rect) : new Uint8ClampedArray(w * h * 4);
  if (f.cover) {
    const shown = maskFloatSurfaces(px, w, h);
    return { surface: shown.value, cover: shown.cover, rect, m };
  }
  const surface = createSurface(w, h);
  surface.ctx.putImageData(new ImageData(px, w, h), 0, 0);
  return { surface, rect, m };
}

/**
 * The float's layer display (layer + float), cached on the float by layer
 * revision and bounds.
 * @param s - Editor state.
 * @param f - Float.
 * @param m - Its full float-local -> document matrix.
 * @returns Bounds-sized canvas.
 */
export function floatPreviewCanvas(s: EditorState, f: FloatState, m: Affine): HTMLCanvasElement {
  const b = s.store.bounds;
  const key = `${s.runtime.revision(f.layerId)}:${b.x},${b.y},${b.width},${b.height}`;
  if (f.preview?.key === key) return f.preview.surface.canvas;
  if (f.preview) releaseSurface(f.preview.surface);
  const surface = createSurface(b.width, b.height);
  drawFloatPreview(surface.ctx, s.store.ensure(f.layerId).canvas, f, m, b);
  f.preview = { surface, key };
  return surface.canvas;
}

/**
 * Drop the float's resampled display.
 * @param f - Float.
 */
export function dropBake(f: FloatState): void {
  if (f.baked) releaseSurface(f.baked.surface);
  if (f.baked?.cover) releaseSurface(f.baked.cover);
  f.baked = null;
}

/**
 * Release every surface of an ended float.
 * @param f - Float.
 */
export function releaseFloat(f: FloatState): void {
  releaseSurface(f.surface);
  if (f.cover) releaseSurface(f.cover);
  if (f.carry) releaseCarry(f.carry);
  dropBake(f);
  if (f.preview) releaseSurface(f.preview.surface);
  f.preview = null;
}

function isWholeShift(from: Affine, to: Affine): boolean {
  const dx = to.e - from.e;
  const dy = to.f - from.f;
  const whole = (v: number): boolean => Math.abs(v - Math.round(v)) < 1e-6;
  return from.a === to.a && from.b === to.b && from.c === to.c && from.d === to.d && whole(dx) && whole(dy);
}

/**
 * Draw a layer with its float on top into a bounds-sized context.
 * @param ctx - Target context (sized to `bounds`, cleared).
 * @param layer - The layer canvas (holding the hole).
 * @param f - Float.
 * @param m - Its full float-local -> document matrix.
 * @param bounds - Document bounds of `ctx`.
 */
export function drawFloatPreview(ctx: CanvasRenderingContext2D, layer: HTMLCanvasElement, f: Readonly<FloatState>, m: Affine, bounds: Rect): void {
  ctx.drawImage(layer, 0, 0);
  const cover = f.cover;
  if (!cover) {
    drawPlaced(ctx, f, m, bounds, f.surface.canvas, f.baked?.surface.canvas);
    return;
  }
  // lmask float (M14b): the coverage clears what it covers, the value adds in (`d (1 - c) + v c`).
  ctx.save();
  ctx.globalCompositeOperation = "destination-out";
  drawPlaced(ctx, f, m, bounds, cover.canvas, f.baked?.cover?.canvas);
  ctx.globalCompositeOperation = "lighter";
  drawPlaced(ctx, f, m, bounds, f.surface.canvas, f.baked?.surface.canvas);
  ctx.restore();
}

/** Draw a float canvas (or its baked counterpart) at the float's placement. */
function drawPlaced(ctx: CanvasRenderingContext2D, f: Readonly<FloatState>, m: Affine, bounds: Rect, canvas: HTMLCanvasElement, bakedCanvas: HTMLCanvasElement | undefined): void {
  if (isPlainPlacement(f, m)) {
    ctx.drawImage(canvas, m.e - bounds.x, m.f - bounds.y);
    return;
  }
  const baked = f.baked;
  if (baked && bakedCanvas && isWholeShift(baked.m, m)) {
    // Exact resample, moved by whole px since (resampling is shift-invariant).
    ctx.drawImage(bakedCanvas, baked.rect.x + Math.round(m.e - baked.m.e) - bounds.x, baked.rect.y + Math.round(m.f - baked.m.f) - bounds.y);
    return;
  }
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.setTransform(m.a, m.b, m.c, m.d, m.e - bounds.x, m.f - bounds.y);
  ctx.drawImage(canvas, 0, 0);
  ctx.restore();
}
