/**
 * Document -> image mapping (decision 4, SPEC "Saved-file contract", frame
 * mismatch). Layer pixels live in the document's own `frame` coordinates and
 * are never resampled; the editor and Python both map them onto the current
 * image with the same contain-and-centre transform:
 *
 *   s  = min(W / fw, H / fh)
 *   ox = (W - fw * s) / 2,  oy = (H - fh * s) / 2
 *   image = offset + doc * s
 *
 * {@link layerPlacement} additionally reproduces the integer destination rect
 * `nodes/composite.py::_place_layer` uses (Python `round`, i.e. round half to
 * even), so the on-screen layer lands on exactly the pixels Python writes.
 * Pure, no DOM.
 */

import type { Point, Rect, Size } from "../geometry/rect";

// ── Types ─────────────────────────────────────────────────────────────────────

/** Uniform scale + offset from document coords to image coords. */
export interface FrameMap {
  /** Image px per document px. */
  scale: number;
  /** Image x of document x = 0. */
  offsetX: number;
  /** Image y of document y = 0. */
  offsetY: number;
}

/** Identity mapping (image size == document frame). */
export const IDENTITY_MAP: Readonly<FrameMap> = { scale: 1, offsetX: 0, offsetY: 0 };

// ── Mapping ───────────────────────────────────────────────────────────────────

/**
 * Document -> image transform (contain, centred). A pure function of the two
 * sizes: flipping images A -> B -> A returns exactly the original mapping.
 * Degenerate sizes (zero/negative/non-finite) yield the identity.
 *
 * @param frame - Document frame (`fw x fh`).
 * @param image - Current image size (`W x H`).
 * @returns Scale and offset.
 */
export function frameMap(frame: Size, image: Size): FrameMap {
  const { width: fw, height: fh } = frame;
  const { width: W, height: H } = image;
  if (!(fw > 0 && fh > 0 && W > 0 && H > 0) || ![fw, fh, W, H].every(Number.isFinite)) return { ...IDENTITY_MAP };
  const scale = Math.min(W / fw, H / fh);
  return { scale, offsetX: (W - fw * scale) / 2, offsetY: (H - fh * scale) / 2 };
}

/**
 * Document point -> image point.
 * @param map - Transform from {@link frameMap}.
 * @param p - Document point.
 * @returns Image point.
 */
export function docToImage(map: FrameMap, p: Point): Point {
  return { x: map.offsetX + p.x * map.scale, y: map.offsetY + p.y * map.scale };
}

/**
 * Image point -> document point (inverse of {@link docToImage}).
 * @param map - Transform from {@link frameMap}.
 * @param p - Image point.
 * @returns Document point.
 */
export function imageToDoc(map: FrameMap, p: Point): Point {
  return { x: (p.x - map.offsetX) / map.scale, y: (p.y - map.offsetY) / map.scale };
}

/**
 * Document rect -> image rect (fractional).
 * @param map - Transform from {@link frameMap}.
 * @param r - Document rect.
 * @returns Image rect.
 */
export function docRectToImage(map: FrameMap, r: Rect): Rect {
  return {
    x: map.offsetX + r.x * map.scale,
    y: map.offsetY + r.y * map.scale,
    width: r.width * map.scale,
    height: r.height * map.scale,
  };
}

/**
 * Document length (e.g. brush diameter) for a length measured on the image.
 * @param map - Transform from {@link frameMap}.
 * @param imageLength - Length in image px.
 * @returns Length in document px.
 */
export function imageLengthToDoc(map: FrameMap, imageLength: number): number {
  return imageLength / map.scale;
}

// ── Python-exact placement ────────────────────────────────────────────────────

/**
 * Python's built-in `round()` for floats: nearest integer, ties to even.
 * @param value - Number to round.
 * @returns Rounded integer.
 */
export function roundHalfEven(value: number): number {
  const floor = Math.floor(value);
  const diff = value - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

/**
 * Integer image rect a layer of size `bounds` is drawn into, matching
 * `_place_layer` in `nodes/composite.py`: top-left `round(offset + bounds.xy*s)`,
 * size `max(1, round(bounds.wh * s))` (equal to the layer size when s == 1).
 *
 * @param map - Transform from {@link frameMap}.
 * @param bounds - Layer bounds in document coords (integer rect).
 * @returns Destination rect in image px (not clipped to the image).
 */
export function layerPlacement(map: FrameMap, bounds: Rect): Rect {
  return {
    x: roundHalfEven(map.offsetX + bounds.x * map.scale),
    y: roundHalfEven(map.offsetY + bounds.y * map.scale),
    width: Math.max(1, roundHalfEven(bounds.width * map.scale)),
    height: Math.max(1, roundHalfEven(bounds.height * map.scale)),
  };
}
