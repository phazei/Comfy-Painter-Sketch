/**
 * Viewport geometry: mapping view-content coordinates to stage CSS pixels,
 * fit / zoom-around-point / pan, and canvas backing-store sizing. Pure, no DOM.
 *
 * The view content is the current IMAGE (background, or `doc.frame` without
 * one); "doc" in the names below means that content space. Document (layer)
 * coordinates are one more step away, through `frameMap.ts` (decision 4).
 *
 * Convention: `stage = content * scale + offset` (per axis).
 */

import type { Point, Rect, Size } from "../geometry/rect";

export type { Point, Rect, Size } from "../geometry/rect";

// ── Types ─────────────────────────────────────────────────────────────────────

/** Result of fitting content into a viewport. */
export interface FitResult extends Rect {
  /** Uniform scale from content units to viewport units. */
  scale: number;
}

/** Document -> stage transform. */
export interface ViewTransform {
  scale: number;
  offsetX: number;
  offsetY: number;
}

/** Zoom limits (document px per stage CSS px). */
export const MIN_ZOOM = 0.02;
export const MAX_ZOOM = 64;

// ── Fit ───────────────────────────────────────────────────────────────────────

/**
 * Fit `content` inside `viewport` preserving aspect ratio ("contain"),
 * centered, with an optional inset on every side.
 *
 * Degenerate inputs (zero/negative/non-finite sizes) yield an empty rect
 * centered in the viewport instead of NaN/Infinity.
 *
 * @param content - Size of the thing being displayed (e.g. the image frame).
 * @param viewport - Size of the area to display it in.
 * @param padding - Inset applied on each side of the viewport before fitting.
 * @returns Placement rect in viewport units plus the uniform scale used.
 */
export function fitContain(content: Size, viewport: Size, padding = 0): FitResult {
  const vw = finitePositive(viewport.width);
  const vh = finitePositive(viewport.height);
  const pad = Math.max(0, Math.min(finitePositive(padding), vw / 2, vh / 2));
  const availW = vw - pad * 2;
  const availH = vh - pad * 2;
  const cw = finitePositive(content.width);
  const ch = finitePositive(content.height);

  if (cw === 0 || ch === 0 || availW === 0 || availH === 0) {
    return { x: vw / 2, y: vh / 2, width: 0, height: 0, scale: 0 };
  }

  const scale = Math.min(availW / cw, availH / ch);
  const width = cw * scale;
  const height = ch * scale;
  return { x: (vw - width) / 2, y: (vh - height) / 2, width, height, scale };
}

/**
 * View transform that fits the frame into the stage.
 *
 * @param frame - Document frame size.
 * @param stage - Stage size in CSS px.
 * @param padding - Inset in CSS px.
 * @returns Transform (scale clamped to zoom limits; identity-ish when degenerate).
 */
export function fitView(frame: Size, stage: Size, padding = 8): ViewTransform {
  const fit = fitContain(frame, stage, padding);
  if (fit.scale <= 0) return { scale: 1, offsetX: 0, offsetY: 0 };
  const scale = clampZoom(fit.scale);
  return {
    scale,
    offsetX: (stage.width - frame.width * scale) / 2,
    offsetY: (stage.height - frame.height * scale) / 2,
  };
}

// ── Zoom / pan ────────────────────────────────────────────────────────────────

/**
 * Clamp a zoom factor to the supported range.
 * @param scale - Requested scale.
 * @returns Clamped scale.
 */
export function clampZoom(scale: number): number {
  if (!Number.isFinite(scale) || scale <= 0) return 1;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, scale));
}

/**
 * Set a new scale while keeping the document point under `anchor` fixed.
 *
 * @param view - Current transform.
 * @param newScale - Requested scale (clamped).
 * @param anchor - Stage point that must not move.
 * @returns New transform.
 */
export function zoomAt(view: ViewTransform, newScale: number, anchor: Point): ViewTransform {
  const scale = clampZoom(newScale);
  const ratio = scale / view.scale;
  return {
    scale,
    offsetX: anchor.x - (anchor.x - view.offsetX) * ratio,
    offsetY: anchor.y - (anchor.y - view.offsetY) * ratio,
  };
}

/**
 * Multiplicative zoom factor for a wheel delta (normalized to pixels).
 * @param deltaPx - Wheel delta in pixels (positive = zoom out).
 * @returns Factor to multiply the scale by.
 */
export function wheelZoomFactor(deltaPx: number): number {
  const clamped = Math.max(-300, Math.min(300, deltaPx));
  return Math.exp(-clamped * 0.0015);
}

/**
 * Translate the view by a stage-pixel delta.
 * @param view - Current transform.
 * @param dx - Stage px.
 * @param dy - Stage px.
 * @returns New transform.
 */
export function panBy(view: ViewTransform, dx: number, dy: number): ViewTransform {
  return { scale: view.scale, offsetX: view.offsetX + dx, offsetY: view.offsetY + dy };
}

/**
 * Clamp the view offset so at least `min(64, onScreenSize)` CSS px of the
 * image rect remains visible inside the stage on each axis. This prevents
 * the image from going completely off-screen after a pan, zoom, or resize.
 *
 * The "grip" on each axis is `Math.min(64, imageStagePx)`, where
 * `imageStagePx` is the image's on-screen extent (frame * scale). Offsets
 * are then clamped so the image rect's trailing edge never goes further than
 * `grip` past the stage's leading edge, and vice-versa.
 *
 * Degenerate inputs (zero stage or zero frame) are returned unchanged.
 *
 * @param view - Current transform.
 * @param frame - Image (frame) size in document / content units.
 * @param stage - Stage size in CSS px.
 * @returns Transform with clamped offsets (scale unchanged).
 */
export function clampOffset(view: ViewTransform, frame: Size, stage: Size): ViewTransform {
  const sw = finitePositive(stage.width);
  const sh = finitePositive(stage.height);
  const fw = finitePositive(frame.width) * view.scale;
  const fh = finitePositive(frame.height) * view.scale;
  if (sw === 0 || sh === 0 || fw === 0 || fh === 0) return view;

  // Minimum grip in CSS px per axis; never more than the image's on-screen size.
  const gripX = Math.min(64, fw);
  const gripY = Math.min(64, fh);

  // offsetX is the stage-x of the image's left edge.
  // Right edge = offsetX + fw. We need right edge >= gripX and left edge <= sw - gripX.
  const minOffsetX = gripX - fw; // right edge at least gripX past stage left
  const maxOffsetX = sw - gripX; // left edge at most (sw - gripX) from stage left
  const minOffsetY = gripY - fh;
  const maxOffsetY = sh - gripY;

  return {
    scale: view.scale,
    offsetX: Math.min(maxOffsetX, Math.max(minOffsetX, view.offsetX)),
    offsetY: Math.min(maxOffsetY, Math.max(minOffsetY, view.offsetY)),
  };
}

/**
 * Stage CSS point -> document point.
 * @param view - Transform.
 * @param p - Stage point.
 * @returns Document point.
 */
export function stageToDoc(view: ViewTransform, p: Point): Point {
  return { x: (p.x - view.offsetX) / view.scale, y: (p.y - view.offsetY) / view.scale };
}

/**
 * Document rect -> stage CSS rect.
 * @param view - Transform.
 * @param r - Document rect.
 * @returns Stage rect.
 */
export function docRectToStage(view: ViewTransform, r: Rect): Rect {
  return {
    x: r.x * view.scale + view.offsetX,
    y: r.y * view.scale + view.offsetY,
    width: r.width * view.scale,
    height: r.height * view.scale,
  };
}

// ── Backing store ─────────────────────────────────────────────────────────────

/**
 * Compute the device-pixel size of a canvas backing store.
 *
 * `cssSize` is the element's layout size (`clientWidth`/`clientHeight`), which
 * excludes CSS transforms. `displayScale` is the extra on-screen scale applied
 * by ancestors (the LiteGraph DOM-widget overlay scales with graph zoom); pass
 * `boundingRect.width / clientWidth`. Each side is clamped to `maxSide`.
 *
 * @param cssSize - Layout size in CSS pixels.
 * @param devicePixelRatio - `window.devicePixelRatio`.
 * @param displayScale - Ancestor transform scale (1 when unknown).
 * @param maxSide - Maximum pixels per side.
 * @returns Integer backing-store size (at least 1x1) and the effective ratio
 *   from CSS px to backing px.
 */
export function backingStoreSize(
  cssSize: Size,
  devicePixelRatio: number,
  displayScale = 1,
  maxSide = 4096,
): Size & { ratio: number } {
  const cw = finitePositive(cssSize.width);
  const ch = finitePositive(cssSize.height);
  const dpr = finitePositive(devicePixelRatio) || 1;
  const zoom = finitePositive(displayScale) || 1;
  let ratio = dpr * zoom;
  const largest = Math.max(cw, ch) * ratio;
  if (largest > maxSide) ratio *= maxSide / largest;
  return {
    width: Math.max(1, Math.round(cw * ratio)),
    height: Math.max(1, Math.round(ch * ratio)),
    ratio,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Clamp to a finite, non-negative number (NaN/Infinity/negative -> 0). */
function finitePositive(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}