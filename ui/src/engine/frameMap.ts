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
 * The Move tool's document `placement {x, y, scale}` (SPEC "Saved-file
 * contract", Placement) is composed in: scaling by `k = scale` about the
 * frame centre `c = (fw/2, fh/2)` and moving by `(x, y)` document px gives
 *
 *   effective scale  = s * k
 *   effective offset = offset + s * (c * (1 - k) + (x, y))
 *
 * evaluated in the same order as `nodes/composite.py::_layout`, so both sides
 * round to the same pixels. The result is still a plain {@link FrameMap}, so
 * every consumer (compositor, pointer input, brush size, fill, sampling,
 * selection) stays placement-agnostic: build it with {@link documentMap}.
 *
 * {@link layerPlacement} additionally reproduces the integer destination rect
 * `nodes/composite.py::_place_layer` uses (Python `round`, i.e. round half to
 * even), so the on-screen layer lands on exactly the pixels Python writes.
 * Pure, no DOM.
 */

import { isIdentityPlacement } from "../document/placement";
import type { Placement } from "../document/types";
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
 * Document -> image transform (contain, centred), with an optional Move-tool
 * placement composed in (see module doc). A pure function of its inputs:
 * flipping images A -> B -> A returns exactly the original mapping.
 * Degenerate sizes (zero/negative/non-finite) yield the identity.
 *
 * @param frame - Document frame (`fw x fh`).
 * @param image - Current image size (`W x H`).
 * @param placement - Document placement (`undefined` = identity; assumed valid, see `document/placement.ts`).
 * @returns Scale and offset.
 */
export function frameMap(frame: Size, image: Size, placement?: Readonly<Placement>): FrameMap {
  const { width: fw, height: fh } = frame;
  const { width: W, height: H } = image;
  if (!(fw > 0 && fh > 0 && W > 0 && H > 0) || ![fw, fh, W, H].every(Number.isFinite)) return { ...IDENTITY_MAP };
  const s = Math.min(W / fw, H / fh);
  const offsetX = (W - fw * s) / 2;
  const offsetY = (H - fh * s) / 2;
  if (!placement || isIdentityPlacement(placement)) return { scale: s, offsetX, offsetY };
  const k = placement.scale;
  return {
    scale: s * k,
    offsetX: offsetX + s * ((fw / 2) * (1 - k) + placement.x),
    offsetY: offsetY + s * ((fh / 2) * (1 - k) + placement.y),
  };
}

/**
 * THE document -> current-image map of a document (frame fit + placement).
 * Everything that converts between document and image coords uses this (via
 * `Editor.frameMap` where an editor is at hand).
 *
 * @param doc - Document frame and placement.
 * @param image - Current image size.
 * @returns Scale and offset.
 */
export function documentMap(doc: { readonly frame: Size; readonly placement?: Readonly<Placement> }, image: Size): FrameMap {
  return frameMap(doc.frame, image, doc.placement);
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
 * Image rect -> document rect (fractional; inverse of {@link docRectToImage}).
 * E.g. the current image's area in document coords: `imageRectToDoc(map, frameRect(imageSize))`.
 * @param map - Transform from {@link frameMap}.
 * @param r - Image rect.
 * @returns Document rect.
 */
export function imageRectToDoc(map: FrameMap, r: Rect): Rect {
  return {
    x: (r.x - map.offsetX) / map.scale,
    y: (r.y - map.offsetY) / map.scale,
    width: r.width / map.scale,
    height: r.height / map.scale,
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
