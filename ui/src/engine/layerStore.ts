/**
 * Pixel storage: one offscreen canvas per layer, all sized to the document's
 * `bounds`. Canvas pixel `(px, py)` is document point
 * `(bounds.x + px, bounds.y + py)` -- the same mapping as the saved PNGs.
 * Layer masks live here too, under `layerMaskKey(layerId)`; a mask
 * whose `outside` hides is marked with {@link LayerStore.setHideOutside}
 * so bounds growth / resampling fill the new area white (hidden, like mask
 * layer coverage) instead of transparent (shown).
 */

import { intersectRect, isEmptyRect, rectEquals } from "../geometry/rect";
import type { Rect } from "../geometry/rect";
import { createSurface, fillOutside, rebaseSurface, releaseSurface } from "./surface";
import type { Surface } from "./surface";
import type { PixelData } from "./editorTypes";

/** Canvas copy rather than `ImageData`. */
function isCanvas(data: PixelData): data is HTMLCanvasElement {
  return "getContext" in data;
}

/** Fill of hiding layer-mask surfaces beyond their old pixels. */
const HIDE_FILL = "#ffffff";

/**
 * Layer canvases for one document.
 */
export class LayerStore {
  private surfaces = new Map<string, Surface>();
  /** Surfaces whose area beyond the stored pixels is white (hiding layer masks). */
  private readonly hideOutside = new Set<string>();
  private currentBounds: Rect;

  /**
   * @param bounds - Initial paint area (document coords, integers).
   */
  constructor(bounds: Rect) {
    this.currentBounds = { ...bounds };
  }

  /** Current paint area. */
  get bounds(): Rect {
    return { ...this.currentBounds };
  }

  /**
   * Surface for a layer, created (transparent) on first use.
   * @param layerId - Layer id.
   * @returns Its surface.
   */
  ensure(layerId: string): Surface {
    let surface = this.surfaces.get(layerId);
    if (!surface) {
      surface = createSurface(this.currentBounds.width, this.currentBounds.height);
      this.surfaces.set(layerId, surface);
    }
    return surface;
  }

  /**
   * Existing surface for a layer.
   * @param layerId - Layer id.
   * @returns Surface or `undefined`.
   */
  get(layerId: string): Surface | undefined {
    return this.surfaces.get(layerId);
  }

  /**
   * Drop layers not in `keep`.
   * @param keep - Layer ids to keep.
   */
  retain(keep: ReadonlySet<string>): void {
    for (const [id, surface] of this.surfaces) {
      if (keep.has(id)) continue;
      releaseSurface(surface);
      this.surfaces.delete(id);
      this.hideOutside.delete(id);
    }
  }

  /**
   * Whether growth / resampling fills a surface's new area white (a layer
   * mask whose `outside` hides) instead of leaving it transparent.
   * @param id - Surface key.
   * @param hide - Fill white outside.
   */
  setHideOutside(id: string, hide: boolean): void {
    if (hide) this.hideOutside.add(id);
    else this.hideOutside.delete(id);
  }

  /**
   * Remove one surface (a deleted layer mask).
   * @param id - Surface key.
   */
  drop(id: string): void {
    const surface = this.surfaces.get(id);
    if (surface) releaseSurface(surface);
    this.surfaces.delete(id);
    this.hideOutside.delete(id);
  }

  /**
   * Change the paint area, keeping every pixel at its document position
   * (pixels outside the new bounds are dropped).
   * @param bounds - New bounds.
   */
  rebase(bounds: Rect): void {
    if (rectEquals(bounds, this.currentBounds)) return;
    for (const [id, surface] of this.surfaces) {
      const fill = this.hideOutside.has(id) ? HIDE_FILL : undefined;
      this.surfaces.set(id, rebaseSurface(surface, this.currentBounds, bounds, fill));
      releaseSurface(surface);
    }
    this.currentBounds = { ...bounds };
  }

  /**
   * Resample every layer once into new bounds (Match image resolution): old
   * document point `p` lands on `p * factor + (tx, ty)`, high-quality smoothing.
   * @param bounds - New bounds (new document coords).
   * @param factor - Scale, new px per old px.
   * @param tx - X shift, new document px.
   * @param ty - Y shift, new document px.
   */
  resample(bounds: Rect, factor: number, tx: number, ty: number): void {
    const from = this.currentBounds;
    for (const [id, surface] of this.surfaces) {
      const next = createSurface(bounds.width, bounds.height);
      const place = { x: from.x * factor + tx - bounds.x, y: from.y * factor + ty - bounds.y, width: from.width * factor, height: from.height * factor };
      if (this.hideOutside.has(id)) fillOutside(next, place, HIDE_FILL);
      next.ctx.imageSmoothingEnabled = true;
      next.ctx.imageSmoothingQuality = "high";
      next.ctx.drawImage(surface.canvas, place.x, place.y, place.width, place.height);
      releaseSurface(surface);
      this.surfaces.set(id, next);
    }
    this.currentBounds = { ...bounds };
  }

  /**
   * Replace bounds and clear every layer (no pixel preservation).
   * @param bounds - New bounds.
   */
  reset(bounds: Rect): void {
    for (const surface of this.surfaces.values()) releaseSurface(surface);
    this.surfaces.clear();
    this.currentBounds = { ...bounds };
  }

  /**
   * Read pixels of a document rect (clipped to bounds).
   * @param layerId - Layer id.
   * @param rect - Integer document rect.
   * @returns Pixels and the clipped rect, or `null` if nothing overlaps.
   */
  read(layerId: string, rect: Rect): { rect: Rect; data: ImageData } | null {
    const clipped = intersectRect(rect, this.currentBounds);
    if (isEmptyRect(clipped)) return null;
    const { ctx } = this.ensure(layerId);
    const data = ctx.getImageData(
      clipped.x - this.currentBounds.x,
      clipped.y - this.currentBounds.y,
      clipped.width,
      clipped.height,
    );
    return { rect: clipped, data };
  }

  /**
   * Write pixels at a document position (replaces, no blending).
   * @param layerId - Layer id.
   * @param x - Document x of the data's top-left.
   * @param y - Document y of the data's top-left.
   * @param data - Pixels (`ImageData` or a canvas copy from {@link copy}).
   */
  write(layerId: string, x: number, y: number, data: PixelData): void {
    const { ctx } = this.ensure(layerId);
    const dx = x - this.currentBounds.x;
    const dy = y - this.currentBounds.y;
    if (!isCanvas(data)) {
      ctx.putImageData(data, dx, dy);
      return;
    }
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    ctx.clearRect(dx, dy, data.width, data.height);
    ctx.drawImage(data, dx, dy);
    ctx.restore();
  }

  /**
   * Whole-layer copy on a new canvas (canvas to canvas: no GPU readback,
   * unlike {@link snapshot}). For history records that only restore it.
   * @param layerId - Layer id.
   * @returns Canvas covering `bounds`.
   */
  copy(layerId: string): HTMLCanvasElement {
    const { canvas } = this.ensure(layerId);
    const next = createSurface(canvas.width, canvas.height);
    next.ctx.drawImage(canvas, 0, 0);
    return next.canvas;
  }

  /**
   * Whole-layer snapshot.
   * @param layerId - Layer id.
   * @returns Pixels covering `bounds`.
   */
  snapshot(layerId: string): ImageData {
    const { ctx, canvas } = this.ensure(layerId);
    return ctx.getImageData(0, 0, canvas.width, canvas.height);
  }

  /**
   * Deep copy (pixels duplicated).
   * @returns Independent store.
   */
  clone(): LayerStore {
    const copy = new LayerStore(this.currentBounds);
    for (const [id, surface] of this.surfaces) {
      copy.ensure(id).ctx.drawImage(surface.canvas, 0, 0);
    }
    for (const id of this.hideOutside) copy.hideOutside.add(id);
    return copy;
  }

  /** Estimated bytes held by layer canvases. */
  get bytes(): number {
    return this.surfaces.size * this.currentBounds.width * this.currentBounds.height * 4;
  }

  /** Release every canvas. */
  dispose(): void {
    for (const surface of this.surfaces.values()) releaseSurface(surface);
    this.surfaces.clear();
  }
}
