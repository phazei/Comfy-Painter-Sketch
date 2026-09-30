/**
 * Layer masks in the engine (M14a, SPEC "Layer masks (M14)"): session state,
 * the pixel surfaces and the compositor cache. Commands, history and
 * persistence bookkeeping are in `layerMaskOps.ts`.
 *
 * - Pixels: one canvas per masked layer in the `LayerStore` under
 *   `layerMaskKey(layerId)`, bounds-sized like the layer. ComfyUI / mask
 *   layer convention: white = hidden, so the HIDDEN amount lives in ALPHA
 *   with white RGB, exactly like mask-layer coverage; dirty-rect patches,
 *   the stroke buffer, bounds growth and resampling work unchanged. A mask
 *   whose `outside` hides is marked in the store so growth fills white.
 * - Target (not saved): per layer, strokes edit the layer's pixels or its
 *   mask ({@link LayerMaskState.targets}); only while Quick Mask is off.
 *   On the mask the real colours are ignored: the brush paints the
 *   foreground MASK swatch ({@link LayerMaskState.fgWhite}; white = hide =
 *   white `paint`, black = reveal = `erase`) with its own size / hardness /
 *   opacity / flow through the same stroke engine; the eraser always reveals.
 * - Display: an enabled mask shows the layer through {@link MaskedLayerCache}
 *   (layer `destination-out` mask, or `destination-in` when inverted),
 *   rebuilt only when the layer or mask revision / invert / bounds change,
 *   and only inside the dirty rect during a live stroke on either. Layers
 *   without an (enabled) mask take the plain path, untouched.
 * - The gate (`rasterize.ts` `editBlockNote`) asks {@link layerMaskBlockNote}:
 *   other pixel tools refuse on a targeted mask. A hidden layer's mask is
 *   refused like its pixels, except in the lmask-only view
 *   ({@link editsViewedMask}). Whole-layer operations carry the mask and
 *   floats / copy / cut respect the target (M14b, `layerMaskCarry.ts`).
 * - A float on the mask (lmask-targeted lift) or carrying it (whole-layer
 *   transform) shows through `EditorState.floatPreview(maskKey)` in the
 *   masked composite and the Alt view.
 */

import { canHaveLayerMask, layerMaskKey } from "../document/layerMask";
import type { LayerMask } from "../document/layerMask";
import { findPaintLayer } from "../document/masks";
import type { Layer } from "../document/types";
import { intersectRect, isEmptyRect, rectEquals } from "../geometry/rect";
import type { Rect } from "../geometry/rect";
import type { EditorState } from "./editorState";
import type { LayerPixels } from "./editorTypes";
import type { StrokeStyle } from "./stroke";
import { createSurface, fillOutside, releaseSurface } from "./surface";
import type { Surface } from "./surface";

// ── Notes / kinds ─────────────────────────────────────────────────────────────

/** Note when a pixel tool other than brush / eraser / fill targets a layer mask. */
export const LAYER_MASK_TOOL_NOTE = "Layer mask: use the brush, eraser or fill.";

/** Note when the eyedropper (or Alt with a paint tool) is used on a targeted layer mask. */
export const LAYER_MASK_EYEDROPPER_NOTE = "Layer mask: black and white only, no eyedropper (X swaps).";

/** Colour of mask pixels (alpha = hidden amount, like mask-layer coverage). */
export const MASK_WHITE = "#ffffff";

/**
 * What an edit does, for the gate: `"paint"` = brush / eraser / bucket /
 * selection fill-clear and lmask-targeted lifts / copy / cut (they know the
 * mask target), `"other"` = pixel tools that can't paint a mask (shapes,
 * line, text), `"whole"` = operations on the layer's pixels (move,
 * transform, flip, merge, copy / cut, lift; they carry or ignore the mask,
 * and the lmask-only view's hidden-layer exception does not apply).
 */
export type EditKind = "paint" | "other" | "whole";

// ── Queries ───────────────────────────────────────────────────────────────────

/**
 * The paint layer whose MASK the paint target edits now: Quick Mask off, the
 * paint target has a mask and its target is the mask.
 * @param s - Editor state.
 * @returns The layer, or `null`.
 */
export function targetedMaskLayer(s: EditorState): Layer | null {
  if (s.target !== "paint") return null;
  const layer = findPaintLayer(s.doc);
  return layer?.layerMask && s.layerMasks.targets.has(layer.id) ? layer : null;
}

/**
 * Store key a selection lift / copy / cut of `layer` acts on (M14b): its
 * mask while targeted, else the layer itself.
 * @param s - Editor state.
 * @param layer - Current edit layer.
 * @returns Layer id or mask key.
 */
export function selectedSurfaceKey(s: EditorState, layer: Layer): string {
  return targetedMaskLayer(s)?.id === layer.id ? layerMaskKey(layer.id) : layer.id;
}

/**
 * Whether an edit on `layer` goes to the mask shown in the lmask-only view
 * (Alt+click): the view shows this layer's mask and the mask is the paint
 * target. The gate lets this exact case through even with the layer's eye
 * off or hidden by solo (Photoshop); lock still refuses.
 * @param s - Editor state.
 * @param layer - Layer about to be edited.
 * @returns `true` in that case.
 */
export function editsViewedMask(s: EditorState, layer: Layer): boolean {
  return layer.layerMask !== undefined && s.layerMasks.view === layer.id && targetedMaskLayer(s)?.id === layer.id;
}

/**
 * The gate's layer-mask part (`rasterize.ts` `editBlockNote`).
 * @param s - Editor state.
 * @param layer - Layer about to be edited.
 * @param kind - What the edit is.
 * @returns Note, or `null` when allowed.
 */
export function layerMaskBlockNote(s: EditorState, layer: Layer, kind: EditKind): string | null {
  if (kind === "other" && targetedMaskLayer(s)?.id === layer.id) return LAYER_MASK_TOOL_NOTE;
  return null;
}

/**
 * Stroke style on a layer mask: real colour ignored; the eraser always
 * reveals (erases the hidden amount), the brush paints the foreground mask
 * swatch -- white hides (white paint), black reveals (erase).
 * @param style - Tool style.
 * @param fgWhite - The foreground mask swatch is white.
 * @returns Style for the mask surface.
 */
export function maskStrokeStyle(style: StrokeStyle, fgWhite: boolean): StrokeStyle {
  if (style.mode === "erase" || !fgWhite) return { ...style, mode: "erase" };
  return { ...style, mode: "paint", color: MASK_WHITE };
}

/**
 * Store keys of every surface the document owns: layer ids plus their masks.
 * @param layers - Document layers.
 * @returns Key set.
 */
export function surfaceKeys(layers: readonly Layer[]): Set<string> {
  const keys = new Set<string>();
  for (const layer of layers) {
    keys.add(layer.id);
    if (layer.layerMask) keys.add(layerMaskKey(layer.id));
  }
  return keys;
}

/**
 * Whether a store key belongs to the document (a layer, or the mask of a layer that has one).
 * @param s - Editor state.
 * @param key - Layer id or mask key.
 * @returns `true` if patches for it apply.
 */
export function surfaceAlive(s: EditorState, key: string): boolean {
  return s.doc.layers.some((l) => l.id === key || (l.layerMask !== undefined && layerMaskKey(l.id) === key));
}

// ── Surfaces ──────────────────────────────────────────────────────────────────

/**
 * (Re)create a layer's mask surface: `pixels` over the area they cover and
 * the mask's `outside` value everywhere else (all of it without pixels).
 * Fresh runtime bookkeeping: dirty until uploaded.
 * @param s - Editor state.
 * @param layerId - Owning layer (its `layerMask` is already set).
 * @param mask - Mask record.
 * @param pixels - Stored pixels (document coords), or `null`.
 */
export function installMaskSurface(s: EditorState, layerId: string, mask: Readonly<LayerMask>, pixels: LayerPixels | null): void {
  const key = layerMaskKey(layerId);
  if (pixels) s.ensureBounds({ x: pixels.x, y: pixels.y, width: pixels.data.width, height: pixels.data.height }, false);
  s.store.drop(key);
  const surface = s.store.ensure(key);
  const b = s.store.bounds;
  const hole = pixels ? { x: pixels.x - b.x, y: pixels.y - b.y, width: pixels.data.width, height: pixels.data.height } : { x: 0, y: 0, width: 0, height: 0 };
  if (mask.outside === "hide") fillOutside(surface, hole, MASK_WHITE);
  if (pixels) s.store.write(key, pixels.x, pixels.y, pixels.data);
  s.store.setHideOutside(key, mask.outside === "hide");
  s.runtime.reinstate(key, true);
}

/**
 * Remove a layer's mask surface and bookkeeping (the record is the caller's).
 * @param s - Editor state.
 * @param layerId - Owning layer.
 */
export function dropMaskSurface(s: EditorState, layerId: string): void {
  const key = layerMaskKey(layerId);
  if (s.strokeLayerId === key && s.stroke.active) s.cancelStroke();
  s.store.drop(key);
  s.runtime.remove(key);
  s.layerMasks.targets.delete(layerId);
  if (s.layerMasks.view === layerId) s.layerMasks.view = null;
}

/**
 * Surfaces for the masks of a freshly constructed editor (restore happens
 * later): every stored pixel starts at 0 (shown) -- a saved file shows the
 * layer unmasked until it loads, and no file means all 0. Forks keep their
 * cloned pixels.
 * @param s - Editor state.
 */
export function initMaskSurfaces(s: EditorState): void {
  for (const layer of s.doc.layers) {
    const mask = layer.layerMask;
    if (!mask) continue;
    if (!canHaveLayerMask(layer)) {
      delete layer.layerMask;
      continue;
    }
    const key = layerMaskKey(layer.id);
    s.store.setHideOutside(key, mask.outside === "hide");
    s.runtime.reset(key, mask.file !== null);
    s.store.ensure(key);
  }
}

/**
 * Masks after an empty document adopted a new frame (every layer is blank
 * again): each mask restarts at its `outside` value with no file.
 * @param s - Editor state.
 */
export function resetMaskSurfaces(s: EditorState): void {
  for (const layer of s.doc.layers) {
    if (!layer.layerMask) continue;
    layer.layerMask = { ...layer.layerMask, file: null };
    installMaskSurface(s, layer.id, layer.layerMask, null);
  }
}

// ── Display ───────────────────────────────────────────────────────────────────

/** Inputs of one masked layer's cached composite. */
export interface MaskedKey {
  bounds: Rect;
  layerRevision: number;
  maskRevision: number;
  invert: boolean;
}

/**
 * Cached `layer x mask` canvas of one layer.
 */
export class MaskedLayerCache {
  private surface: Surface | null = null;
  private key: MaskedKey | null = null;
  /** Full rebuilds so far (tests: cache invalidation). */
  rebuilds = 0;

  /**
   * Bring the composite up to date.
   * @param layer - Layer pixels (or its live stroke preview), bounds-sized.
   * @param mask - Mask pixels (or its live stroke preview), bounds-sized.
   * @param key - Current inputs.
   * @param dirty - Document rect changed in either source while the key is
   *   unchanged (live stroke), or `null`.
   * @returns Masked layer canvas, bounds-sized.
   */
  update(layer: CanvasImageSource, mask: CanvasImageSource, key: MaskedKey, dirty: Rect | null): HTMLCanvasElement {
    const { bounds } = key;
    const surface = this.ensureSurface(bounds);
    const full = { x: 0, y: 0, width: bounds.width, height: bounds.height };
    if (!this.key || !sameMaskedKey(this.key, key)) {
      this.rebuilds++;
      paintMasked(surface.ctx, layer, mask, full, key.invert);
    } else if (dirty) {
      const local = intersectRect({ x: dirty.x - bounds.x, y: dirty.y - bounds.y, width: dirty.width, height: dirty.height }, full);
      if (!isEmptyRect(local)) paintMasked(surface.ctx, layer, mask, local, key.invert);
    }
    this.key = { ...key, bounds: { ...bounds } };
    return surface.canvas;
  }

  /** Release the canvas. */
  dispose(): void {
    if (this.surface) releaseSurface(this.surface);
    this.surface = null;
    this.key = null;
  }

  private ensureSurface(bounds: Rect): Surface {
    const s = this.surface;
    if (s && s.canvas.width === bounds.width && s.canvas.height === bounds.height) return s;
    if (s) releaseSurface(s);
    this.key = null;
    this.surface = createSurface(bounds.width, bounds.height);
    return this.surface;
  }
}

function sameMaskedKey(a: MaskedKey, b: MaskedKey): boolean {
  return a.layerRevision === b.layerRevision && a.maskRevision === b.maskRevision && a.invert === b.invert && rectEquals(a.bounds, b.bounds);
}

/**
 * Re-composite `r` (surface-local): layer, then remove it where the mask is
 * white (hidden; alpha = hidden amount) -- or keep only there when inverted.
 */
function paintMasked(ctx: CanvasRenderingContext2D, layer: CanvasImageSource, mask: CanvasImageSource, r: Rect, invert: boolean): void {
  ctx.save();
  ctx.beginPath();
  ctx.rect(r.x, r.y, r.width, r.height);
  ctx.clip();
  ctx.globalAlpha = 1;
  ctx.clearRect(r.x, r.y, r.width, r.height);
  ctx.globalCompositeOperation = "source-over";
  ctx.drawImage(layer, r.x, r.y, r.width, r.height, r.x, r.y, r.width, r.height);
  // `destination-in` clears outside the drawn image too -- the clip keeps it local.
  ctx.globalCompositeOperation = invert ? "destination-in" : "destination-out";
  ctx.drawImage(mask, r.x, r.y, r.width, r.height, r.x, r.y, r.width, r.height);
  ctx.restore();
}

/**
 * Session state of the layer masks of one editor (not saved, not undoable),
 * plus the display caches.
 */
export class LayerMaskState {
  /** Layers whose mask (not pixels) is the edit target. */
  readonly targets = new Set<string>();
  /** Alt+click view: the layer whose mask is shown alone (grayscale), or `null`. */
  view: string | null = null;
  /**
   * Mask swatches (shown instead of the colour swatches while a layer mask
   * is targeted): the foreground is white (hide; the default) and the
   * background black, or swapped (X). They only ever hold black / white, so
   * one flag is the whole state. Per editor, session only.
   */
  fgWhite = true;
  private readonly caches = new Map<string, MaskedLayerCache>();
  private viewSurface: { surface: Surface; key: string } | null = null;

  /**
   * Cache of one layer's masked composite.
   * @param layerId - Layer id.
   * @returns The cache (created on first use).
   */
  cache(layerId: string): MaskedLayerCache {
    let cache = this.caches.get(layerId);
    if (!cache) {
      cache = new MaskedLayerCache();
      this.caches.set(layerId, cache);
    }
    return cache;
  }

  /**
   * The mask alone as an opaque grayscale image (white = hidden), cached.
   * @param mask - Mask pixels (or its live stroke preview).
   * @param width - Bounds width.
   * @param height - Bounds height.
   * @param invert - Show `1 - mask`.
   * @param key - Cache key (revision, invert, bounds).
   * @param live - The source changes without a key change (stroke preview): redraw.
   * @returns Bounds-sized canvas.
   */
  viewCanvas(mask: CanvasImageSource, width: number, height: number, invert: boolean, key: string, live: boolean): HTMLCanvasElement {
    let v = this.viewSurface;
    if (!v || v.surface.canvas.width !== width || v.surface.canvas.height !== height) {
      if (v) releaseSurface(v.surface);
      v = { surface: createSurface(width, height), key: "" };
      this.viewSurface = v;
    }
    if (v.key !== key || live) {
      const { ctx } = v.surface;
      ctx.save();
      ctx.globalCompositeOperation = "source-over";
      ctx.fillStyle = "#000000";
      ctx.fillRect(0, 0, width, height);
      ctx.drawImage(mask, 0, 0);
      if (invert) {
        ctx.globalCompositeOperation = "difference";
        ctx.fillStyle = MASK_WHITE;
        ctx.fillRect(0, 0, width, height);
      }
      ctx.restore();
      v.key = key;
    }
    return v.surface.canvas;
  }

  /**
   * Drop caches of layers that no longer have a mask.
   * @param keep - Layer ids with a mask.
   */
  prune(keep: ReadonlySet<string>): void {
    for (const [id, cache] of this.caches) {
      if (keep.has(id)) continue;
      cache.dispose();
      this.caches.delete(id);
    }
  }

  /** Release every cache. */
  dispose(): void {
    for (const cache of this.caches.values()) cache.dispose();
    this.caches.clear();
    if (this.viewSurface) releaseSurface(this.viewSurface.surface);
    this.viewSurface = null;
  }
}

/**
 * What the stage / sampling draw for a paint layer: its pixels through its
 * enabled mask (cached), or `source` unchanged when it has none.
 * @param s - Editor state.
 * @param layer - Paint layer.
 * @param source - The layer's pixels (or its live stroke preview).
 * @param live - Stage rendering: follow a live stroke on the layer or its mask.
 * @returns Canvas to draw.
 */
export function maskedSource(s: EditorState, layer: Layer, source: CanvasImageSource, live: boolean): CanvasImageSource {
  const mask = layer.layerMask;
  if (!mask?.enabled) return source;
  const key = layerMaskKey(layer.id);
  const surface = s.store.ensure(key);
  const maskStroking = live && s.stroke.active && s.strokeLayerId === key;
  const layerStroking = live && s.stroke.active && s.strokeLayerId === layer.id;
  // A float on (or carrying) the mask shows live (M14b); its revision bumps key the cache.
  const maskSource = s.floatPreview(key) ?? (maskStroking ? s.stroke.updatePreview(surface).canvas : surface.canvas);
  const cacheKey: MaskedKey = {
    bounds: s.store.bounds,
    layerRevision: s.runtime.revision(layer.id),
    maskRevision: s.runtime.revision(key),
    invert: mask.invert,
  };
  return s.layerMasks.cache(layer.id).update(source, maskSource, cacheKey, maskStroking || layerStroking ? s.stroke.lastRefreshed : null);
}

/**
 * The Alt+click view (mask alone, grayscale) as the only stage layer, or `null` when not viewing.
 * @param s - Editor state.
 * @returns Canvas to draw at full opacity, or `null`.
 */
export function maskViewSource(s: EditorState): HTMLCanvasElement | null {
  const id = s.layerMasks.view;
  const layer = id ? s.doc.layers.find((l) => l.id === id) : undefined;
  const mask = layer?.layerMask;
  if (!layer || !mask) return null;
  const key = layerMaskKey(layer.id);
  const surface = s.store.ensure(key);
  const live = s.stroke.active && s.strokeLayerId === key;
  const source = s.floatPreview(key) ?? (live ? s.stroke.updatePreview(surface).canvas : surface.canvas);
  const b = s.store.bounds;
  const cacheKey = `${s.runtime.revision(key)}|${mask.invert}|${b.x},${b.y},${b.width},${b.height}`;
  return s.layerMasks.viewCanvas(source, b.width, b.height, mask.invert, cacheKey, live);
}
