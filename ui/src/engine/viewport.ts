/**
 * Viewport geometry: fitting the document frame into the visible stage and
 * sizing the canvas backing store. Pure functions, no DOM.
 *
 * M0 only needs "fit to view" (letterboxed contain). Pan/zoom and
 * screen<->document conversion land here in M1.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

/** A width/height pair in some unit (CSS px, device px, or document px). */
export interface Size {
  width: number;
  height: number;
}

/** An axis-aligned rectangle. */
export interface Rect extends Size {
  x: number;
  y: number;
}

/** Result of fitting content into a viewport. */
export interface FitResult extends Rect {
  /** Uniform scale from content units to viewport units. */
  scale: number;
}

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
  return {
    x: (vw - width) / 2,
    y: (vh - height) / 2,
    width,
    height,
    scale,
  };
}

// ── Backing store ─────────────────────────────────────────────────────────────

/**
 * Compute the device-pixel size of a canvas backing store.
 *
 * `cssSize` is the element's layout size (`clientWidth`/`clientHeight`), which
 * excludes CSS transforms. `displayScale` is the extra on-screen scale applied
 * by ancestors (the LiteGraph DOM-widget overlay scales with graph zoom); pass
 * `boundingRect.width / clientWidth`. Each side is clamped to `maxSide` so a
 * huge node at high zoom cannot allocate an enormous canvas.
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
