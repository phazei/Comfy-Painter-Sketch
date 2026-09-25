/**
 * Move-tool interaction math (SPEC M5 Move tool): turning image-space drags,
 * nudges and wheel steps into document `placement` values. Placement is in
 * document-frame px; image deltas convert through the frame-fit scale `s`
 * only (not the placement scale), so a drag moves the drawing exactly with
 * the pointer at any image size. Pure, no DOM.
 */

import { clampPlacementScale } from "../document/placement";
import type { Placement } from "../document/types";
import type { Point, Size } from "../geometry/rect";
import { frameMap } from "./frameMap";

/** Placement scale factor per wheel notch (100 px of delta). */
export const WHEEL_SCALE_STEP = 1.05;

/** Largest wheel delta (px) honoured per event (stops giant jumps). */
const MAX_WHEEL_DELTA = 300;

/**
 * Frame-fit scale `s` (image px per document px, without placement).
 * @param frame - Document frame.
 * @param image - Current image size.
 * @returns Scale.
 */
function fitScale(frame: Size, image: Size): number {
  return frameMap(frame, image).scale;
}

/**
 * Move a placement by an image-px delta.
 * @param p - Current placement.
 * @param frame - Document frame.
 * @param image - Current image size.
 * @param dx - Image px (right = positive).
 * @param dy - Image px (down = positive).
 * @returns New placement (scale unchanged).
 */
export function translatePlacement(p: Readonly<Placement>, frame: Size, image: Size, dx: number, dy: number): Placement {
  const s = fitScale(frame, image);
  return { x: p.x + dx / s, y: p.y + dy / s, scale: p.scale };
}

/**
 * Multiply the placement scale while keeping the drawing point under an
 * image point fixed (wheel-scale around the cursor). The new scale is
 * clamped; the anchor stays fixed for the clamped value.
 * @param p - Current placement.
 * @param frame - Document frame.
 * @param image - Current image size.
 * @param factor - Scale multiplier (> 0).
 * @param anchor - Image point that must not move.
 * @returns New placement.
 */
export function scalePlacementAt(p: Readonly<Placement>, frame: Size, image: Size, factor: number, anchor: Point): Placement {
  const base = frameMap(frame, image);
  const now = frameMap(frame, image, p);
  const k = clampPlacementScale(p.scale * factor);
  // Document point under the anchor now, and where the translation must put it.
  const docX = (anchor.x - now.offsetX) / now.scale;
  const docY = (anchor.y - now.offsetY) / now.scale;
  const s = base.scale;
  return {
    x: (anchor.x - base.offsetX) / s - (frame.width / 2) * (1 - k) - k * docX,
    y: (anchor.y - base.offsetY) / s - (frame.height / 2) * (1 - k) - k * docY,
    scale: k,
  };
}

/**
 * Wheel delta -> placement scale multiplier: {@link WHEEL_SCALE_STEP} per
 * 100 px notch, proportional for small (trackpad) deltas; wheel up (negative
 * delta) grows the drawing.
 * @param deltaPx - Wheel delta in px.
 * @returns Multiplier.
 */
export function wheelScaleFactor(deltaPx: number): number {
  if (!Number.isFinite(deltaPx)) return 1;
  const d = Math.max(-MAX_WHEEL_DELTA, Math.min(MAX_WHEEL_DELTA, deltaPx));
  return Math.pow(WHEEL_SCALE_STEP, -d / 100);
}

/**
 * Placement offset as shown in the options bar: image px (document px x `s`).
 * @param p - Placement.
 * @param frame - Document frame.
 * @param image - Current image size.
 * @returns Offset in image px.
 */
export function placementImageOffset(p: Readonly<Placement>, frame: Size, image: Size): Point {
  const s = fitScale(frame, image);
  return { x: p.x * s, y: p.y * s };
}

/**
 * Inverse of {@link placementImageOffset} for one axis.
 * @param imagePx - Offset in image px.
 * @param frame - Document frame.
 * @param image - Current image size.
 * @returns Offset in document px.
 */
export function imageOffsetToPlacement(imagePx: number, frame: Size, image: Size): number {
  return imagePx / fitScale(frame, image);
}
