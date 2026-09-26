/**
 * "Fill under soft edges" pass of the paint bucket (pure; used by
 * `floodFill.ts` when the caller passes the target layer's pixels).
 *
 * Filling around an anti-aliased stroke on the same layer used to leave a
 * halo: the stroke's semi-transparent edge pixels are outside the fill, so the
 * layer stays partly transparent there and whatever is below shows through.
 * This pass walks from the filled area into the target layer's soft edges --
 * as long as the layer's alpha keeps rising (the edge ramp towards the
 * stroke's core) -- and marks those pixels to be filled *behind* the existing
 * paint (`blendCoverageBehind`). The stroke keeps its look; the gap is closed.
 *
 * Only paint on the target layer itself counts: where the layer is empty the
 * pass does nothing, so boundaries in the background image or other layers
 * keep the normal 1 px anti-alias fringe.
 */

import type { Rect } from "../geometry/rect";

/** Longest edge ramp followed, px (a very soft, large brush). */
const MAX_DEPTH = 64;

/** Result of {@link growUnder}. */
export interface UnderResult {
  /** 255 where the fill goes behind the layer's paint, else 0 (`width * height`). */
  under: Uint8Array;
  /** `bbox` grown by the under pixels. */
  bbox: Rect;
}

/**
 * Find the target layer's soft-edge pixels next to a fill.
 * @param coverage - Fill coverage (255 = filled, 0 = not; no fringe yet).
 * @param layer - Target layer RGBA, same size as `coverage`.
 * @param width - Buffer width.
 * @param height - Buffer height.
 * @param bbox - Bbox of the filled pixels.
 * @param clip - Optional selection coverage (0 blocks).
 * @returns Under mask and the grown bbox.
 */
export function growUnder(
  coverage: Uint8Array,
  layer: Uint8ClampedArray,
  width: number,
  height: number,
  bbox: Rect,
  clip: Uint8Array | undefined,
): UnderResult {
  const under = new Uint8Array(width * height);
  if (bbox.width <= 0 || layer.length < width * height * 4) return { under, bbox };
  const alpha = (i: number): number => layer[i * 4 + 3] as number;
  const open = (i: number): boolean => coverage[i] === 0 && under[i] === 0 && !(clip && clip[i] === 0);

  let queue: number[] = [];
  let minX = bbox.x;
  let minY = bbox.y;
  let maxX = bbox.x + bbox.width - 1;
  let maxY = bbox.y + bbox.height - 1;
  const mark = (i: number): void => {
    under[i] = 255;
    queue.push(i);
    const x = i % width;
    const y = (i / width) | 0;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  };
  /** Try the 4 neighbours of `i`: join those whose alpha rises above `floor` (but isn't opaque). */
  const visit = (i: number, floor: number): void => {
    const x = i % width;
    const y = (i / width) | 0;
    const tryJoin = (n: number): void => {
      const a = alpha(n);
      if (a > floor && a < 255 && open(n)) mark(n);
    };
    if (x > 0) tryJoin(i - 1);
    if (x < width - 1) tryJoin(i + 1);
    if (y > 0) tryJoin(i - width);
    if (y < height - 1) tryJoin(i + width);
  };

  // Seeds: soft pixels touching the fill, more opaque than it (scan the bbox + 1 px ring).
  const x0 = Math.max(0, bbox.x - 1);
  const y0 = Math.max(0, bbox.y - 1);
  const x1 = Math.min(width - 1, bbox.x + bbox.width);
  const y1 = Math.min(height - 1, bbox.y + bbox.height);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const i = y * width + x;
      // Rising above the filled pixel's own alpha: filling an opaque area (recolouring) never goes behind.
      if (coverage[i] === 255) visit(i, alpha(i));
    }
  }
  // Follow each ramp while the alpha keeps rising.
  for (let depth = 1; depth < MAX_DEPTH && queue.length > 0; depth++) {
    const current = queue;
    queue = [];
    for (const i of current) visit(i, alpha(i));
  }
  return { under, bbox: { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 } };
}
