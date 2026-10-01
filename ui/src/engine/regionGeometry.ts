/**
 * Pure region hit testing and drag geometry in current-image px. Regions may
 * extend outside the image: every result is clamped to the region area with
 * `clampRegionRect` / `regionArea` (`document/regions.ts`), never to the image.
 */

import { clampRegionRect, regionArea, roundRegionEdge } from "../document/regions";
import { clampNumber, rectContainsPoint } from "../geometry/rect";
import type { Point, Rect, Size } from "../geometry/rect";

// ── Handles ───────────────────────────────────────────────────────────────────

/** Handle axes: -1 = left/top edge, 1 = right/bottom edge, 0 = axis not resized. */
export interface RegionHandle {
  x: -1 | 0 | 1;
  y: -1 | 0 | 1;
}

/** Eight handles, corners first so corners win on small rectangles. */
export const REGION_HANDLES: readonly RegionHandle[] = [
  { x: -1, y: -1 },
  { x: 1, y: -1 },
  { x: 1, y: 1 },
  { x: -1, y: 1 },
  { x: 0, y: -1 },
  { x: 1, y: 0 },
  { x: 0, y: 1 },
  { x: -1, y: 0 },
];

/**
 * Centre of a handle.
 * @param rect - Region rect (image px).
 * @param handle - Handle axes.
 * @returns Handle centre in image px.
 */
export function regionHandlePoint(rect: Rect, handle: RegionHandle): Point {
  return {
    x: rect.x + ((handle.x + 1) * rect.width) / 2,
    y: rect.y + ((handle.y + 1) * rect.height) / 2,
  };
}

/**
 * Handle under a point.
 * @param rect - Region rect (image px).
 * @param p - Pointer (image px).
 * @param tolerance - Hit half-size in image px.
 * @returns The first handle within tolerance, or null.
 */
export function hitRegionHandle(rect: Rect, p: Point, tolerance: number): RegionHandle | null {
  const hit = REGION_HANDLES.find((handle) => {
    const at = regionHandlePoint(rect, handle);
    return Math.abs(p.x - at.x) <= tolerance && Math.abs(p.y - at.y) <= tolerance;
  });
  return hit ?? null;
}

/**
 * Whether a point is inside a region (edges included).
 * @param rect - Region rect.
 * @param p - Point.
 * @returns `true` if inside.
 */
export function insideRegion(rect: Rect, p: Point): boolean {
  return rectContainsPoint(rect, p);
}

// ── Drag geometry ─────────────────────────────────────────────────────────────

/**
 * Rect spanned by a draw drag (any direction), clamped to the region area.
 * @param start - Press position (image px).
 * @param end - Current position (image px).
 * @param image - Current image size.
 * @returns Integer rect, at least 1x1.
 */
export function drawRegionRect(start: Point, end: Point, image: Size): Rect {
  const x = Math.min(start.x, end.x);
  const y = Math.min(start.y, end.y);
  const rect = { x, y, width: Math.max(start.x, end.x) - x, height: Math.max(start.y, end.y) - y };
  return clampRegionRect(rect, image);
}

/**
 * Move or resize a region by a pointer displacement.
 * Moving keeps the size and stops at the region area; resizing keeps the
 * opposite edge fixed and never flips.
 * @param rect - Rect at drag start.
 * @param delta - Pointer displacement (image px).
 * @param image - Current image size.
 * @param handle - Handle being dragged; null moves the whole rect.
 * @returns Integer rect inside the region area.
 */
export function dragRegionRect(rect: Rect, delta: Point, image: Size, handle: RegionHandle | null): Rect {
  const dx = roundRegionEdge(delta.x);
  const dy = roundRegionEdge(delta.y);
  if (!handle) return moveRect(rect, dx, dy, image);
  let left = rect.x;
  let top = rect.y;
  let right = rect.x + rect.width;
  let bottom = rect.y + rect.height;
  if (handle.x < 0) left = Math.min(left + dx, right - 1);
  if (handle.x > 0) right = Math.max(right + dx, left + 1);
  if (handle.y < 0) top = Math.min(top + dy, bottom - 1);
  if (handle.y > 0) bottom = Math.max(bottom + dy, top + 1);
  return clampRegionRect({ x: left, y: top, width: right - left, height: bottom - top }, image);
}

/** Translate without resizing, stopping at the region area edges. */
function moveRect(rect: Rect, dx: number, dy: number, image: Size): Rect {
  const area = regionArea(image);
  const x = clampNumber(rect.x + dx, area.x, area.x + area.width - rect.width);
  const y = clampNumber(rect.y + dy, area.y, area.y + area.height - rect.height);
  return clampRegionRect({ x, y, width: rect.width, height: rect.height }, image);
}

// ── Field bounds ──────────────────────────────────────────────────────────────

/** Editable field of a region rect. */
export type RegionRectField = keyof Rect;

/**
 * Allowed range of one X/Y/W/H field given the other three.
 * @param rect - Current rect.
 * @param field - Field being edited.
 * @param image - Current image size.
 * @returns Inclusive integer bounds inside the region area.
 */
export function regionFieldBounds(rect: Rect, field: RegionRectField, image: Size): { min: number; max: number } {
  const area = regionArea(image);
  const right = area.x + area.width;
  const bottom = area.y + area.height;
  if (field === "x") return { min: area.x, max: right - rect.width };
  if (field === "y") return { min: area.y, max: bottom - rect.height };
  if (field === "width") return { min: 1, max: right - rect.x };
  return { min: 1, max: bottom - rect.y };
}
