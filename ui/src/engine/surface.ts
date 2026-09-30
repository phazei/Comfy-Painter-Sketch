/**
 * Offscreen 2D surfaces (one `<canvas>` + context). Plain `<canvas>` elements
 * are used (not `OffscreenCanvas`) so `toBlob` and `drawImage` work everywhere.
 */

import type { Rect } from "../geometry/rect";

/** A canvas and its 2D context. */
export interface Surface {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
}

/**
 * Create a transparent surface.
 *
 * @param width - Pixels (min 1).
 * @param height - Pixels (min 1).
 * @returns The surface.
 * @throws If the browser cannot create a 2D context (out of memory).
 */
export function createSurface(width: number, height: number): Surface {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error(`Could not create a ${canvas.width}x${canvas.height} canvas`);
  return { canvas, ctx };
}

/**
 * Release a surface's pixel memory early (browsers free it on GC otherwise).
 * @param surface - Surface to release.
 */
export function releaseSurface(surface: Surface): void {
  surface.canvas.width = 0;
  surface.canvas.height = 0;
}

/**
 * Copy of a surface re-based from `from` bounds to `to` bounds (document
 * coords), keeping every pixel at the same document position.
 *
 * @param source - Surface sized to `from`.
 * @param from - Bounds of `source`.
 * @param to - Bounds of the new surface.
 * @param fill - Colour of the area outside `from` (layer masks that reveal
 *   outside, `layerMask.ts`); transparent by default.
 * @returns New surface sized to `to`.
 */
export function rebaseSurface(source: Surface, from: Rect, to: Rect, fill?: string): Surface {
  const next = createSurface(to.width, to.height);
  if (fill) fillOutside(next, { x: from.x - to.x, y: from.y - to.y, width: from.width, height: from.height }, fill);
  next.ctx.drawImage(source.canvas, from.x - to.x, from.y - to.y);
  return next;
}

/**
 * Fill a fresh surface with a colour except inside `hole` (left transparent,
 * so drawing the old pixels there keeps their exact alpha).
 * @param surface - Transparent surface.
 * @param hole - Surface-local rect to keep clear.
 * @param fill - CSS colour.
 */
export function fillOutside(surface: Surface, hole: Rect, fill: string): void {
  const { ctx, canvas } = surface;
  ctx.save();
  ctx.fillStyle = fill;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.clearRect(hole.x, hole.y, hole.width, hole.height);
  ctx.restore();
}
