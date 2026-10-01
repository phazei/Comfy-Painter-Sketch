/**
 * Layer masks in whole-layer operations and floats (SPEC "Layer masks
 * (lmask)", Carry). Mask pixels: white RGB, hidden amount in
 * alpha (`layerMask.ts`).
 *
 * - Whole-layer Move / Free Transform / flip carry the lmask with the layer
 *   exactly (same delta / matrix / mirror); the mask's `outside` value fills
 *   what they expose. Only the mask's CONTENT moves -- the bbox of values
 *   that differ from `outside` ({@link maskContentRect}); everything else
 *   already holds the outside value. Moves: `layerTranslate.ts`; flips:
 *   {@link flipMaskPatch}.
 * - Free Transform carries it as a {@link MaskCarry} on the layer's float:
 *   the mask surface stays untouched while floating (the display draws it
 *   through the carry matrix, {@link carryPreviewCanvas}) and lands in the
 *   layer's undo step ({@link writeCarryPatch}). The mask has its own kept
 *   original (keyed by its mask key, same revision rule as a layer's),
 *   which restarts the carry when valid.
 * - lmask-targeted selection floats lift the mask's own pixels as opaque
 *   grayscale (value in RGB, selection coverage in alpha), so what lands
 *   REPLACES what it covers like Photoshop's mask pixels -- `d (1 - c) + v c`
 *   ({@link liftMaskPixels}, {@link landMaskPixels}); the display draws the
 *   coverage `destination-out` and the value `lighter` ({@link maskFloatSurfaces}).
 * - {@link applyMaskAlpha}: layer alpha x the mask's shown part (Apply,
 *   Merge Down, copy of the masked result).
 */

import { layerMaskKey } from "../document/layerMask";
import type { Layer } from "../document/types";
import { intersectRect, isEmptyRect, unionRect } from "../geometry/rect";
import type { Rect } from "../geometry/rect";
import type { HistoryEntry } from "./editorTypes";
import type { EditorState } from "./editorState";
import { compositeOver } from "./floatMath";
import { MASK_WHITE } from "./layerMask";
import { createSurface, releaseSurface } from "./surface";
import type { Surface } from "./surface";
import { invert, multiply, transformedAabb, translation } from "./transformMath";
import type { Affine } from "./transformMath";
import { resampleRgba } from "./transformResample";

/** Note when Merge Down bakes the upper layer's mask into the merge. */
export const LAYER_MASK_APPLIED_NOTE = "Layer mask applied.";

const EMPTY: Rect = { x: 0, y: 0, width: 0, height: 0 };

// ── Content ───────────────────────────────────────────────────────────────────

/** Content bbox cache per editor state: mask key -> (revision, outside, doc rect). */
const contentCache = new WeakMap<EditorState, Map<string, { revision: number; hide: boolean; rect: Rect }>>();

/**
 * Bbox of a layer mask's values that differ from its `outside` value
 * (hidden amount > 0 for reveal masks, < 255 for hide masks), document
 * coords. Cached per mask revision.
 * @param s - Editor state.
 * @param layerId - Owning layer.
 * @returns Rect (zero-size without a mask or when uniform).
 */
export function maskContentRect(s: EditorState, layerId: string): Rect {
  const mask = s.doc.layers.find((l) => l.id === layerId)?.layerMask;
  if (!mask) return { ...EMPTY };
  const key = layerMaskKey(layerId);
  const hide = mask.outside === "hide";
  let cache = contentCache.get(s);
  if (!cache) {
    cache = new Map();
    contentCache.set(s, cache);
  }
  const revision = s.runtime.revision(key);
  const hit = cache.get(key);
  if (hit && hit.revision === revision && hit.hide === hide) return { ...hit.rect };
  const b = s.store.bounds;
  const data = s.store.snapshot(key);
  const local = differsBounds(data.data, data.width, data.height, hide ? 255 : 0);
  const rect = isEmptyRect(local) ? { ...EMPTY } : { ...local, x: local.x + b.x, y: local.y + b.y };
  cache.set(key, { revision, hide, rect });
  return { ...rect };
}

/** Local bbox of pixels whose alpha differs from `value`. */
function differsBounds(px: Uint8ClampedArray, w: number, h: number, value: number): Rect {
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w * 4;
    for (let x = 0; x < w; x++) {
      if (px[row + x * 4 + 3] === value) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      maxY = y;
    }
  }
  return maxX < 0 ? { ...EMPTY } : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

// ── Pixel formats ─────────────────────────────────────────────────────────────

/**
 * Mask pixels (alpha = hidden) -> opaque grayscale (RGB = hidden, alpha 255), in place.
 * @param px - RGBA (modified).
 */
export function maskToOpaque(px: Uint8ClampedArray): void {
  for (let p = 0; p < px.length; p += 4) {
    const v = px[p + 3] as number;
    px[p] = v;
    px[p + 1] = v;
    px[p + 2] = v;
    px[p + 3] = 255;
  }
}

/**
 * Opaque grayscale -> mask pixels (white, alpha = gray; 0 stays all zero), in place.
 * @param px - RGBA (modified).
 */
export function opaqueToMask(px: Uint8ClampedArray): void {
  for (let p = 0; p < px.length; p += 4) {
    const v = px[p] as number;
    const rgb = v === 0 ? 0 : 255;
    px[p] = rgb;
    px[p + 1] = rgb;
    px[p + 2] = rgb;
    px[p + 3] = v;
  }
}

/**
 * Layer alpha times the mask's shown part (`255 - m`, or `m` inverted), in
 * place; pixels left fully transparent get RGB 0.
 * @param px - Layer RGBA (modified).
 * @param mask - Mask RGBA over the same rect (hidden amount in alpha).
 * @param inverted - The mask's invert setting.
 */
export function applyMaskAlpha(px: Uint8ClampedArray, mask: Uint8ClampedArray, inverted: boolean): void {
  for (let p = 0; p < px.length; p += 4) {
    const m = mask[p + 3] ?? 0;
    const shown = inverted ? m : 255 - m;
    if (shown === 255) continue;
    const a = Math.round(((px[p + 3] as number) * shown) / 255);
    px[p + 3] = a;
    if (a === 0) px.fill(0, p, p + 3);
  }
}

// ── lmask-targeted floats ─────────────────────────────────────────────────────

/**
 * Split mask pixels by selection coverage (an lmask-targeted lift): the float
 * is opaque grayscale with the coverage as alpha; a move leaves `hidden x (1 - c)`
 * behind (the vacated part reveals, like a cut).
 * @param src - Mask RGBA (hidden amount in alpha).
 * @param coverage - Selection coverage per pixel.
 * @param cut - `true` = leave a hole (move); `false` = copy.
 * @returns `float` (gray + coverage) and `rest` (mask pixels), new arrays.
 */
export function liftMaskPixels(
  src: Uint8ClampedArray,
  coverage: Uint8Array,
  cut: boolean,
): { float: Uint8ClampedArray<ArrayBuffer>; rest: Uint8ClampedArray<ArrayBuffer> } {
  const float = new Uint8ClampedArray(src.length);
  const rest = new Uint8ClampedArray(src);
  for (let i = 0; i < src.length >> 2; i++) {
    const c = coverage[i] ?? 0;
    if (c === 0) continue;
    const p = i * 4;
    const v = src[p + 3] as number;
    float[p] = v;
    float[p + 1] = v;
    float[p + 2] = v;
    float[p + 3] = c;
    if (cut) rest[p + 3] = Math.round((v * (255 - c)) / 255);
  }
  return { float, rest };
}

/**
 * Land grayscale float pixels on mask pixels, in place: `d (1 - c) + v c`.
 * @param dst - Mask RGBA (modified), `dw x dh`.
 * @param dw - Width.
 * @param dh - Height.
 * @param src - Gray float RGBA (value in RGB, coverage in alpha), `sw x sh`.
 * @param sw - Width.
 * @param sh - Height.
 * @param ox - Source top-left in destination px.
 * @param oy - Source top-left in destination px.
 */
export function landMaskPixels(dst: Uint8ClampedArray, dw: number, dh: number, src: Uint8ClampedArray, sw: number, sh: number, ox: number, oy: number): void {
  maskToOpaque(dst);
  compositeOver(dst, dw, dh, src, sw, sh, ox, oy);
  opaqueToMask(dst);
}

/**
 * Display surfaces of gray float pixels: the value (white, alpha = `v c`)
 * and the coverage (white, alpha = `c`).
 * @param gray - Gray float RGBA.
 * @param w - Width.
 * @param h - Height.
 * @returns Both surfaces.
 */
export function maskFloatSurfaces(gray: Uint8ClampedArray, w: number, h: number): { value: Surface; cover: Surface } {
  const value = new ImageData(w, h);
  const cover = new ImageData(w, h);
  for (let p = 0; p < gray.length; p += 4) {
    const c = gray[p + 3] as number;
    if (c === 0) continue;
    cover.data.set([255, 255, 255, c], p);
    const a = Math.round(((gray[p] as number) * c) / 255);
    if (a > 0) value.data.set([255, 255, 255, a], p);
  }
  const surfaces = { value: createSurface(w, h), cover: createSurface(w, h) };
  surfaces.value.ctx.putImageData(value, 0, 0);
  surfaces.cover.ctx.putImageData(cover, 0, 0);
  return surfaces;
}

// ── Flip ──────────────────────────────────────────────────────────────────────

/**
 * Mirror a layer's mask with its layer (whole-layer flip about `about`'s
 * centre): exact, the vacated part gets `outside`. Records nothing.
 * @param s - Editor state.
 * @param layer - Layer (without a mask: nothing happens).
 * @param about - Layer content rect the layer was mirrored in.
 * @param axis - `"h"` or `"v"`.
 * @returns The mask's patch entry, or `null` when nothing changed.
 */
export function flipMaskPatch(s: EditorState, layer: Layer, about: Rect, axis: "h" | "v"): HistoryEntry | null {
  const mask = layer.layerMask;
  const c = maskContentRect(s, layer.id);
  if (!mask || isEmptyRect(c)) return null;
  const key = layerMaskKey(layer.id);
  const sx0 = 2 * about.x + about.width - 1;
  const sy0 = 2 * about.y + about.height - 1;
  const mirrored = axis === "h" ? { ...c, x: sx0 + 1 - c.x - c.width } : { ...c, y: sy0 + 1 - c.y - c.height };
  s.ensureBounds(mirrored, true);
  const src = s.store.read(key, c);
  const region = s.store.read(key, unionRect(c, mirrored));
  if (!src || !region) return null;
  const r = region.rect;
  const S = src.rect;
  const next = new Uint8ClampedArray(r.width * r.height * 4);
  if (mask.outside === "hide") next.fill(255);
  for (let y = 0; y < S.height; y++) {
    for (let x = 0; x < S.width; x++) {
      const tx = axis === "h" ? sx0 - (S.x + x) : S.x + x;
      const ty = axis === "v" ? sy0 - (S.y + y) : S.y + y;
      if (tx < r.x || ty < r.y || tx >= r.x + r.width || ty >= r.y + r.height) continue;
      const si = (y * S.width + x) * 4;
      next.set(src.data.data.subarray(si, si + 4), ((ty - r.y) * r.width + (tx - r.x)) * 4);
    }
  }
  return writeMaskPatch(s, key, region, next);
}

/** Write `next` over `before.rect` and return the patch (touches the key). */
function writeMaskPatch(s: EditorState, key: string, before: { rect: Rect; data: ImageData }, next: Uint8ClampedArray<ArrayBuffer>): HistoryEntry | null {
  const r = before.rect;
  s.store.write(key, r.x, r.y, new ImageData(next, r.width, r.height));
  const after = s.store.read(key, r);
  s.runtime.touch(key);
  if (!after) return null;
  const bytes = before.data.data.byteLength + after.data.data.byteLength;
  return { kind: "patch", layerId: key, x: r.x, y: r.y, before: before.data, after: after.data, bytes };
}

// ── Transform carry ───────────────────────────────────────────────────────────

/** A layer mask carried by a whole-layer float (Free Transform). */
export interface MaskCarry {
  /** Mask store key. */
  key: string;
  /** The mask's `outside` is hide (what the carry vacates / exposes turns white). */
  hide: boolean;
  /** Opaque grayscale mask pixels (hidden amount in RGB, alpha 255) over `area`. */
  pixels: ImageData;
  /** Mask-local origin of `pixels` (document rect at lift, or a kept original's). */
  area: Rect;
  /** Mask-local -> document matrix at lift (a kept original's cumulative matrix). */
  m0: Affine;
  /** Mask content at lift ({@link maskContentRect}): what the carry vacates. */
  hole: Rect;
  /** `pixels` as mask pixels (white, alpha = value), for the display. */
  surface: Surface;
  /** Display cache (bounds-sized), keyed by matrix, bounds and revision. */
  preview: { surface: Surface; key: string } | null;
}

/**
 * The mask a whole-layer lift of `layer` carries: its kept original when
 * valid, else its current content; `null` without a mask or when the mask is
 * uniform (nothing to move).
 * @param s - Editor state.
 * @param layer - Layer being lifted.
 * @returns Carry, or `null`.
 */
export function liftCarry(s: EditorState, layer: Layer): MaskCarry | null {
  const mask = layer.layerMask;
  if (!mask) return null;
  const key = layerMaskKey(layer.id);
  const hole = maskContentRect(s, layer.id);
  const kept = s.kept.get(key, s.runtime.revision(key));
  let pixels: ImageData;
  let area: Rect;
  let m0: Affine;
  if (kept) {
    ({ pixels, m: m0 } = kept);
    area = { ...kept.area };
  } else {
    const read = isEmptyRect(hole) ? null : s.store.read(key, hole);
    if (!read) return null;
    const px = new Uint8ClampedArray(read.data.data);
    maskToOpaque(px);
    area = read.rect;
    pixels = new ImageData(px, area.width, area.height);
    m0 = translation(area.x, area.y);
  }
  const shown = new Uint8ClampedArray(pixels.data);
  opaqueToMask(shown);
  const surface = createSurface(area.width, area.height);
  surface.ctx.putImageData(new ImageData(shown, area.width, area.height), 0, 0);
  return { key, hide: mask.outside === "hide", pixels, area, m0, hole, surface, preview: null };
}

/**
 * The carry's mask-local -> document matrix for a layer float matrix: the
 * layer's change since its lift, applied to the mask's lift placement.
 * @param carry - Carry.
 * @param liftM - The layer float's matrix at lift.
 * @param m - The layer float's current matrix.
 * @returns Matrix.
 */
export function carryMatrix(carry: Readonly<MaskCarry>, liftM: Affine, m: Affine): Affine {
  const inv = invert(liftM);
  return inv ? multiply(multiply(m, inv), carry.m0) : carry.m0;
}

/**
 * Display of the carried mask (bounds-sized mask pixels): `outside`
 * everywhere, the carried content drawn through `mc` replacing it.
 * @param s - Editor state.
 * @param carry - Carry (its preview cache is updated).
 * @param mc - Carry matrix ({@link carryMatrix}).
 * @returns Canvas.
 */
export function carryPreviewCanvas(s: EditorState, carry: MaskCarry, mc: Affine): HTMLCanvasElement {
  const b = s.store.bounds;
  const key = `${mc.a},${mc.b},${mc.c},${mc.d},${mc.e},${mc.f}|${b.x},${b.y},${b.width},${b.height}|${s.runtime.revision(carry.key)}`;
  if (carry.preview?.key === key) return carry.preview.surface.canvas;
  if (carry.preview) releaseSurface(carry.preview.surface);
  const surface = createSurface(b.width, b.height);
  const { ctx } = surface;
  ctx.save();
  ctx.fillStyle = MASK_WHITE;
  if (carry.hide) ctx.fillRect(0, 0, b.width, b.height);
  const { width: w, height: h } = carry.area;
  const draw = (x: number, y: number): void => {
    ctx.globalCompositeOperation = "destination-out";
    ctx.fillRect(x, y, w, h);
    ctx.globalCompositeOperation = "lighter";
    ctx.drawImage(carry.surface.canvas, x, y);
  };
  if (isWholeTranslation(mc)) draw(Math.round(mc.e) - b.x, Math.round(mc.f) - b.y);
  else {
    ctx.imageSmoothingEnabled = true;
    ctx.setTransform(mc.a, mc.b, mc.c, mc.d, mc.e - b.x, mc.f - b.y);
    draw(0, 0);
  }
  ctx.restore();
  carry.preview = { surface, key };
  return surface.canvas;
}

/**
 * Land the carried mask at `mc` (one resample from the carried pixels) and
 * join its patch to the newest history entry (the layer's float patch): the
 * old content's area gets `outside`, the resampled content replaces what it
 * covers. Pixels beyond the bounds are dropped (the outside value is there).
 * @param s - Editor state.
 * @param carry - Carry.
 * @param mc - Carry matrix.
 */
export function writeCarryPatch(s: EditorState, carry: Readonly<MaskCarry>, mc: Affine): void {
  const { width: w, height: h } = carry.area;
  const b = s.store.bounds;
  const dest = intersectRect(transformedAabb(mc, w, h), b);
  const current = s.store.read(carry.key, unionRect(intersectRect(carry.hole, b), dest));
  if (!current) return;
  const r = current.rect;
  const next = new Uint8ClampedArray(current.data.data);
  maskToOpaque(next);
  const hole = intersectRect(carry.hole, r);
  const out = carry.hide ? 255 : 0;
  for (let y = hole.y; y < hole.y + hole.height; y++) {
    const row = ((y - r.y) * r.width + (hole.x - r.x)) * 4;
    for (let i = 0; i < hole.width * 4; i += 4) next.fill(out, row + i, row + i + 3);
  }
  if (!isEmptyRect(dest)) {
    const src = resampleRgba(carry.pixels.data, w, h, mc, dest);
    compositeOver(next, r.width, r.height, src, dest.width, dest.height, dest.x - r.x, dest.y - r.y);
  }
  opaqueToMask(next);
  const entry = writeMaskPatch(s, carry.key, current, next);
  if (!entry) return;
  s.history.joinNext();
  s.history.push(entry);
}

/**
 * Release a carry's surfaces.
 * @param carry - Carry.
 */
export function releaseCarry(carry: MaskCarry): void {
  releaseSurface(carry.surface);
  if (carry.preview) releaseSurface(carry.preview.surface);
  carry.preview = null;
}

function isWholeTranslation(m: Affine): boolean {
  const whole = (v: number): boolean => Math.abs(v - Math.round(v)) < 1e-6;
  return m.a === 1 && m.b === 0 && m.c === 0 && m.d === 1 && whole(m.e) && whole(m.f);
}
