/**
 * Cached tinted rendering of one mask layer for the on-screen overlay.
 *
 * Mask pixels store coverage in ALPHA (RGB is white, ignored). The overlay is
 * `color` wherever coverage is set (or, for an inverted layer, wherever it is
 * NOT set), so the compositor can draw it with plain `source-over` at the
 * layer's display opacity:
 *
 * - normal:   draw coverage, then `source-in` fill with `color`
 * - inverted: fill with `color`, then `destination-out` the coverage
 *
 * The cache is rebuilt fully when its inputs change (pixel revision, colour,
 * invert, bounds) and only inside the dirty rect while a stroke is previewed.
 * Area outside the layer's bounds is handled by the compositor (inverted
 * layers tint the rest of the image rect, matching Python: outside counts as
 * 0 before invert).
 */

import { intersectRect, isEmptyRect, rectEquals } from "../geometry/rect";
import type { Rect } from "../geometry/rect";
import { createSurface, releaseSurface } from "./surface";
import type { Surface } from "./surface";

/** Inputs that determine the whole tinted image. */
export interface MaskTintKey {
  /** Layer bounds (document coords); the source canvas is sized to it. */
  bounds: Rect;
  color: string;
  invert: boolean;
  /** Changes whenever the layer's committed pixels change. */
  revision: number;
}

/**
 * Tinted overlay cache for one mask layer.
 */
export class MaskTint {
  private surface: Surface | null = null;
  private key: MaskTintKey | null = null;

  /**
   * Bring the tint up to date and return it.
   * @param source - Coverage canvas (layer or stroke preview), sized to `key.bounds`.
   * @param key - Current inputs.
   * @param dirty - Document rect changed in `source` since the last call while
   *   the key is unchanged (live stroke preview); `null` = nothing extra.
   * @returns Tinted canvas sized to `key.bounds`.
   */
  update(source: HTMLCanvasElement, key: MaskTintKey, dirty: Rect | null): HTMLCanvasElement {
    const surface = this.ensureSurface(key.bounds);
    if (!this.key || !sameKey(this.key, key)) {
      paint(surface.ctx, source, { x: 0, y: 0, width: key.bounds.width, height: key.bounds.height }, key);
    } else if (dirty) {
      const local = intersectRect(
        { x: dirty.x - key.bounds.x, y: dirty.y - key.bounds.y, width: dirty.width, height: dirty.height },
        { x: 0, y: 0, width: key.bounds.width, height: key.bounds.height },
      );
      if (!isEmptyRect(local)) paint(surface.ctx, source, local, key);
    }
    this.key = { ...key, bounds: { ...key.bounds } };
    return surface.canvas;
  }

  /** Release the cached canvas. */
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

function sameKey(a: MaskTintKey, b: MaskTintKey): boolean {
  return a.revision === b.revision && a.color === b.color && a.invert === b.invert && rectEquals(a.bounds, b.bounds);
}

/** Re-tint `r` (surface-local, integer) from `source`. */
function paint(ctx: CanvasRenderingContext2D, source: HTMLCanvasElement, r: Rect, key: MaskTintKey): void {
  ctx.save();
  ctx.beginPath();
  ctx.rect(r.x, r.y, r.width, r.height);
  ctx.clip();
  ctx.globalAlpha = 1;
  ctx.clearRect(r.x, r.y, r.width, r.height);
  ctx.fillStyle = key.color;
  if (key.invert) {
    ctx.globalCompositeOperation = "source-over";
    ctx.fillRect(r.x, r.y, r.width, r.height);
    ctx.globalCompositeOperation = "destination-out";
    ctx.drawImage(source, r.x, r.y, r.width, r.height, r.x, r.y, r.width, r.height);
  } else {
    ctx.globalCompositeOperation = "source-over";
    ctx.drawImage(source, r.x, r.y, r.width, r.height, r.x, r.y, r.width, r.height);
    // source-in clears outside the drawn shape too -- the clip keeps it local.
    ctx.globalCompositeOperation = "source-in";
    ctx.fillRect(r.x, r.y, r.width, r.height);
  }
  ctx.restore();
}
