/**
 * Plain size/rect types and pure rect helpers shared by `document/`,
 * `engine/` and `widget/`. No DOM.
 */

/** A width/height pair. */
export interface Size {
  width: number;
  height: number;
}

/** An axis-aligned rectangle. */
export interface Rect extends Size {
  x: number;
  y: number;
}

/** A 2D point. */
export interface Point {
  x: number;
  y: number;
}

/**
 * Whether a rect has no area.
 * @param r - Rect to test.
 * @returns `true` when width or height is <= 0.
 */
export function isEmptyRect(r: Rect): boolean {
  return !(r.width > 0 && r.height > 0);
}

/**
 * Smallest rect containing both inputs. An empty input is ignored.
 * @param a - First rect.
 * @param b - Second rect.
 * @returns Union rect.
 */
export function unionRect(a: Rect, b: Rect): Rect {
  if (isEmptyRect(a)) return { ...b };
  if (isEmptyRect(b)) return { ...a };
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y,
  };
}

/**
 * Overlap of two rects (zero-size rect when disjoint).
 * @param a - First rect.
 * @param b - Second rect.
 * @returns Intersection rect.
 */
export function intersectRect(a: Rect, b: Rect): Rect {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) };
}

/**
 * Whether `outer` fully contains `inner`.
 * @param outer - Container rect.
 * @param inner - Contained rect.
 * @returns `true` if inner lies within outer.
 */
export function containsRect(outer: Rect, inner: Rect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}

/**
 * Expand a fractional rect outward to integer coordinates.
 * @param r - Rect with fractional edges.
 * @returns Integer rect covering `r`.
 */
export function roundOutRect(r: Rect): Rect {
  const x = Math.floor(r.x);
  const y = Math.floor(r.y);
  return { x, y, width: Math.ceil(r.x + r.width) - x, height: Math.ceil(r.y + r.height) - y };
}

/**
 * Rect equality.
 * @param a - First rect.
 * @param b - Second rect.
 * @returns `true` when all fields match.
 */
export function rectEquals(a: Rect, b: Rect): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

/**
 * Rect covering a frame at the origin.
 * @param frame - Frame size.
 * @returns `{x:0, y:0, ...frame}`.
 */
export function frameRect(frame: Size): Rect {
  return { x: 0, y: 0, width: frame.width, height: frame.height };
}
