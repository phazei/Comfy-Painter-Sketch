/**
 * Pixel storage: one offscreen canvas per layer, all sized to the document's
 * `bounds`. Canvas pixel `(px, py)` is document point
 * `(bounds.x + px, bounds.y + py)` -- the same mapping as the saved PNGs.
 */

import { intersectRect, isEmptyRect, rectEquals } from "../geometry/rect";
import type { Rect } from "../geometry/rect";
import { createSurface, rebaseSurface, releaseSurface } from "./surface";
import type { Surface } from "./surface";

/**
 * Layer canvases for one document.
 */
export class LayerStore {
  private surfaces = new Map<string, Surface>();
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
    }
  }

  /**
   * Change the paint area, keeping every pixel at its document position
   * (pixels outside the new bounds are dropped).
   * @param bounds - New bounds.
   */
  rebase(bounds: Rect): void {
    if (rectEquals(bounds, this.currentBounds)) return;
    for (const [id, surface] of this.surfaces) {
      this.surfaces.set(id, rebaseSurface(surface, this.currentBounds, bounds));
      releaseSurface(surface);
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
   * @param data - Pixels.
   */
  write(layerId: string, x: number, y: number, data: ImageData): void {
    const { ctx } = this.ensure(layerId);
    ctx.putImageData(data, x - this.currentBounds.x, y - this.currentBounds.y);
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
