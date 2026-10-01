/**
 * Drawing resolution (SPEC "Layers" > "Background row and drawing resolution"). Pure math, no DOM:
 *
 * - {@link minimumFrame}: the frame a document gets when its frame is set from
 *   an image size -- short side boosted to >= 1024 px, the boost never pushing
 *   the long side past 4096.
 * - {@link resolutionInfo}: how many times finer the current image is than the
 *   drawing grid, measured as the factor Match image resolution would resample
 *   by (= image px per document px, placement scale included, for images whose
 *   short side is >= 1024).
 * - {@link matchGeometry}: the new frame, bounds and placement of Match image
 *   resolution plus the affine map old document px -> new document px that
 *   keeps every layer exactly where it is on the image.
 */

import { unionRect } from "../geometry/rect";
import type { Point, Rect, Size } from "../geometry/rect";
import type { TextData } from "../document/textData";
import { clampSize } from "../document/textData";
import type { Placement } from "../document/types";
import { boundsCap } from "./bounds";
import { docRectToImage, documentMap, frameMap } from "./frameMap";

// ── Constants ─────────────────────────────────────────────────────────────────

/** Short side a frame set from an image is boosted to (at least). */
export const MIN_FRAME_SHORT_SIDE = 1024;

/** The boost never pushes the long side past this. */
export const MAX_BOOSTED_LONG_SIDE = 4096;

/** Ratio above which the mismatch notice + Match image resolution appear. */
export const RESOLUTION_NOTICE_RATIO = 1.5;

/** Largest bounds side a manifest may hold (`MAX_DOCUMENT_SIDE`, parse.ts / document.py). */
export const MAX_BOUNDS_SIDE = 16384;

// ── Minimum frame ─────────────────────────────────────────────────────────────

/**
 * Frame for a document whose frame is set from `size`: scaled up
 * proportionally so the short side is >= {@link MIN_FRAME_SHORT_SIDE}, but
 * the boost never makes the long side exceed {@link MAX_BOOSTED_LONG_SIDE}
 * (a long side already >= 4096 gets no boost). Never shrinks; integer sides.
 *
 * @param size - Image (or fallback widget) size.
 * @returns Integer frame size (at least 1 x 1).
 */
export function minimumFrame(size: Size): Size {
  const w = Math.max(1, Math.round(size.width));
  const h = Math.max(1, Math.round(size.height));
  const boost = Math.max(1, Math.min(MIN_FRAME_SHORT_SIDE / Math.min(w, h), MAX_BOOSTED_LONG_SIDE / Math.max(w, h)));
  if (boost === 1) return { width: w, height: h };
  return { width: Math.max(1, Math.round(w * boost)), height: Math.max(1, Math.round(h * boost)) };
}

// ── Ratio ─────────────────────────────────────────────────────────────────────

/** Mismatch between the drawing grid and the current image. */
export interface ResolutionInfo {
  /** Resample factor Match image resolution would apply (> 1 = image is finer). */
  ratio: number;
  /** Document (drawing grid) px across the image's long side. */
  gridPx: number;
  /** Image long side, px. */
  imagePx: number;
  /** Whether the notice / Match button should show ({@link RESOLUTION_NOTICE_RATIO}). */
  mismatch: boolean;
}

/**
 * Resolution mismatch of a document against the current image: the effective
 * image px per document px (frame fit x placement scale -- what blurs) divided
 * by that of a frame freshly set from this image ({@link minimumFrame}).
 *
 * @param doc - Frame and placement.
 * @param image - Current image size.
 * @returns Ratio and label numbers.
 */
export function resolutionInfo(doc: { readonly frame: Size; readonly placement?: Readonly<Placement> }, image: Size): ResolutionInfo {
  const current = documentMap(doc, image).scale;
  const ideal = frameMap(minimumFrame(image), image).scale;
  const ratio = current > 0 && ideal > 0 ? current / ideal : 1;
  const imagePx = Math.max(image.width, image.height);
  const gridPx = current > 0 ? Math.round(imagePx / current) : imagePx;
  return { ratio, gridPx, imagePx, mismatch: ratio > RESOLUTION_NOTICE_RATIO };
}

// ── Match geometry ────────────────────────────────────────────────────────────

/** Old document px -> new document px: `q = p * factor + (tx, ty)`. */
export interface DocTransform {
  factor: number;
  tx: number;
  ty: number;
}

/** Result of {@link matchGeometry}. */
export interface MatchGeometry {
  frame: Size;
  bounds: Rect;
  /** `undefined` = identity. */
  placement: Placement | undefined;
  transform: DocTransform;
  /** Some existing content falls outside {@link MAX_BOUNDS_SIDE} and is cropped. */
  cropped: boolean;
}

/**
 * Apply a {@link DocTransform} to a point.
 * @param t - Transform.
 * @param p - Old document point.
 * @returns New document point.
 */
export function transformPoint(t: DocTransform, p: Point): Point {
  return { x: p.x * t.factor + t.tx, y: p.y * t.factor + t.ty };
}

/**
 * Apply a {@link DocTransform} to a rect (fractional).
 * @param t - Transform.
 * @param r - Old document rect.
 * @returns New document rect.
 */
export function transformRect(t: DocTransform, r: Rect): Rect {
  return { x: r.x * t.factor + t.tx, y: r.y * t.factor + t.ty, width: r.width * t.factor, height: r.height * t.factor };
}

/**
 * Clip a rect to at most `max` px per side, centred on `centre` (then shifted
 * back inside `r` so it stays a sub-rect).
 */
function clipSide(start: number, length: number, centre: number, max: number): [number, number] {
  if (length <= max) return [start, length];
  const lo = Math.min(start + length - max, Math.max(start, Math.round(centre - max / 2)));
  return [lo, max];
}

/**
 * Never shrink resolution: when `frame` would hold fewer document px per
 * image px than the current map (`currentScale` image px per doc px), enlarge
 * it proportionally to the current density (each side at most
 * {@link MAX_BOUNDS_SIDE}). Only the image-shape (fit) case can get here.
 * @param frame - Candidate frame ({@link minimumFrame} of the image).
 * @param image - Current image size.
 * @param currentScale - Current image px per document px.
 * @returns Frame with at least the current resolution (up to the side limit).
 */
function keepResolution(frame: Size, image: Size, currentScale: number): Size {
  const ideal = frameMap(frame, image).scale;
  if (!(currentScale > 0) || currentScale >= ideal) return frame;
  const k = Math.min(ideal / currentScale, MAX_BOUNDS_SIDE / Math.max(frame.width, frame.height));
  if (k <= 1) return frame;
  return { width: Math.max(1, Math.round(frame.width * k)), height: Math.max(1, Math.round(frame.height * k)) };
}

/**
 * Whether the current image area lies inside the maximum paint area
 * ({@link boundsCap} of the frame united with the existing bounds, which are
 * never shrunk), mapped through the placement-aware document map. Plain image
 * area, no `PLACEMENT_MARGIN` (placement clamp): a frame at the 16384 side limit can
 * cover the image exactly but not the margin, and Match could not fix that.
 * @param doc - Frame, bounds and placement.
 * @param image - Current image size.
 * @returns `true` when every image pixel is paintable.
 */
export function imageFits(
  doc: { readonly frame: Size; readonly bounds: Rect; readonly placement?: Readonly<Placement> },
  image: Size,
): boolean {
  const r = docRectToImage(documentMap(doc, image), unionRect(boundsCap(doc.frame), doc.bounds));
  const eps = 1e-6;
  return r.x <= eps && r.y <= eps && r.x + r.width >= image.width - eps && r.y + r.height >= image.height - eps;
}

/**
 * Geometry of Match image resolution: the frame becomes {@link minimumFrame}
 * of the image (enlarged if needed so resolution never drops, see
 * `keepResolution`), the placement returns to identity (never clamped), and every old document point `p` moves to `q` with
 * `newMap(q) == oldMap(p)` -- the drawing stays exactly where it is on the
 * image. New bounds = the old bounds' image (rounded out) united with the
 * new frame, limited to {@link MAX_BOUNDS_SIDE} per side around the frame.
 *
 * @param doc - Current frame, bounds and placement.
 * @param image - Current image size.
 * @returns New geometry and the old -> new transform.
 */
export function matchGeometry(
  doc: { readonly frame: Size; readonly bounds: Rect; readonly placement?: Readonly<Placement> },
  image: Size,
): MatchGeometry {
  const placement = undefined; // identity, like Reset position
  const before = documentMap(doc, image);
  const frame = keepResolution(minimumFrame(image), image, before.scale);
  const after = frameMap(frame, image, placement);
  const factor = before.scale / after.scale;
  const transform = { factor, tx: (before.offsetX - after.offsetX) / after.scale, ty: (before.offsetY - after.offsetY) / after.scale };
  const moved = transformRect(transform, doc.bounds);
  const x0 = Math.floor(moved.x + 1e-6);
  const y0 = Math.floor(moved.y + 1e-6);
  const out = { x: x0, y: y0, width: Math.ceil(moved.x + moved.width - 1e-6) - x0, height: Math.ceil(moved.y + moved.height - 1e-6) - y0 };
  const full = unionRect(out, { x: 0, y: 0, width: frame.width, height: frame.height });
  const [bx, bw] = clipSide(full.x, full.width, frame.width / 2, MAX_BOUNDS_SIDE);
  const [by, bh] = clipSide(full.y, full.height, frame.height / 2, MAX_BOUNDS_SIDE);
  const bounds = { x: bx, y: by, width: bw, height: bh };
  const cropped = bw < full.width || bh < full.height;
  return { frame, bounds, placement, transform, cropped };
}

/**
 * Text data after Match image resolution: anchor moved, size scaled (clamped
 * to the supported font sizes).
 * @param td - Old text data.
 * @param t - Old -> new document transform.
 * @returns New text data.
 */
export function scaleTextData(td: Readonly<TextData>, t: DocTransform): TextData {
  const p = transformPoint(t, td);
  return { ...td, x: p.x, y: p.y, size: clampSize(td.size * t.factor) };
}
