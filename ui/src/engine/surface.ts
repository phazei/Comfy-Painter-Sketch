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
 * @returns New surface sized to `to`.
 */
export function rebaseSurface(source: Surface, from: Rect, to: Rect): Surface {
  const next = createSurface(to.width, to.height);
  next.ctx.drawImage(source.canvas, from.x - to.x, from.y - to.y);
  return next;
}
