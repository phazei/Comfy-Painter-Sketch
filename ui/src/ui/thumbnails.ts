/**
 * Layer thumbnails for the layers panel: small canvases (aspect preserved,
 * checkerboard via CSS behind transparent paint) redrawn only when their
 * cache key -- the layer's pixel revision plus geometry plus Move-drawing
 * placement (x/y/scale) -- changes, and at most once per
 * {@link THUMB_MIN_INTERVAL_MS} (never per pointermove: the revision only
 * moves when a stroke commits, an undo applies or a restore lands).
 */

import type { FrameBackground } from "../engine/compositor";
import type { Rect, Size } from "../geometry/rect";

/** Thumbnail box, CSS px (the longer side). */
export const THUMB_BOX = 36;

/** Minimum time between thumbnail refresh passes. */
export const THUMB_MIN_INTERVAL_MS = 150;

/**
 * CSS size of a thumbnail fitting `size` into a square box.
 * @param size - Content size (any units).
 * @param box - Box side, CSS px.
 * @returns Integer CSS size, at least 4 px per side.
 */
export function thumbSize(size: Size, box: number = THUMB_BOX): Size {
  const w = Math.max(1, size.width);
  const h = Math.max(1, size.height);
  const s = box / Math.max(w, h);
  return { width: Math.max(4, Math.round(w * s)), height: Math.max(4, Math.round(h * s)) };
}

/** What a thumbnail shows. */
export type ThumbSource =
  | {
      kind: "layer";
      /** Layer canvas (sized to `bounds`). */
      canvas: HTMLCanvasElement;
      /** Canvas-pixel rect to show (the document frame inside the bounds). */
      region: Rect;
      /** Mask layers render coverage white-on-black (inverted if `invert`). */
      mask: boolean;
      invert: boolean;
    }
  | { kind: "background"; background: FrameBackground; size: Size };

/**
 * One thumbnail canvas with its cache key.
 */
export class Thumbnail {
  readonly canvas: HTMLCanvasElement;
  private key = "";

  constructor() {
    this.canvas = document.createElement("canvas");
    this.canvas.className = "cps-layer-thumb";
    // Constrain immediately so a newly inserted canvas never renders at its
    // default 300×150 intrinsic size before the first update() call.
    this.canvas.width = THUMB_BOX;
    this.canvas.height = THUMB_BOX;
    this.canvas.style.width = `${THUMB_BOX}px`;
    this.canvas.style.height = `${THUMB_BOX}px`;
  }

  /**
   * Redraw if `key` changed.
   * @param key - Cache key (revision + geometry + display state).
   * @param size - Content size (for the aspect ratio).
   * @param source - What to draw.
   */
  update(key: string, size: Size, source: ThumbSource): void {
    if (key === this.key) return;
    this.key = key;
    const css = thumbSize(size);
    const dpr = Math.min(2, Math.max(1, globalThis.devicePixelRatio || 1));
    const w = Math.round(css.width * dpr);
    const h = Math.round(css.height * dpr);
    const canvas = this.canvas;
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    canvas.style.width = `${css.width}px`;
    canvas.style.height = `${css.height}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.save();
    ctx.clearRect(0, 0, w, h);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "medium";
    if (source.kind === "background") drawBackground(ctx, source.background, w, h);
    else drawLayer(ctx, source, w, h);
    ctx.restore();
  }

  /** Force the next {@link update} to redraw. */
  invalidate(): void {
    this.key = "";
  }
}

function drawBackground(ctx: CanvasRenderingContext2D, background: FrameBackground, w: number, h: number): void {
  if (background.kind === "fill") {
    ctx.fillStyle = background.color;
    ctx.fillRect(0, 0, w, h);
    return;
  }
  try {
    ctx.drawImage(background.image, 0, 0, w, h);
  } catch {
    // Image not decodable (yet); leave the checkerboard.
  }
}

function drawLayer(
  ctx: CanvasRenderingContext2D,
  source: Extract<ThumbSource, { kind: "layer" }>,
  w: number,
  h: number,
): void {
  const { canvas, region } = source;
  if (source.mask) {
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, w, h);
  }
  if (region.width > 0 && region.height > 0 && canvas.width > 0 && canvas.height > 0) {
    ctx.drawImage(canvas, region.x, region.y, region.width, region.height, 0, 0, w, h);
  }
  if (source.mask && source.invert) {
    ctx.globalCompositeOperation = "difference";
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, w, h);
  }
}

/**
 * Coalesces refresh requests: runs `refresh` on the next animation frame,
 * but no more often than every {@link THUMB_MIN_INTERVAL_MS}.
 */
export class RefreshThrottle {
  private frame: number | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private last = 0;

  /**
   * @param refresh - Work to run.
   */
  constructor(private readonly refresh: () => void) {}

  /** Request a refresh (cheap; call on every editor event). */
  request(): void {
    if (this.frame !== null || this.timer !== null) return;
    const wait = this.last + THUMB_MIN_INTERVAL_MS - performance.now();
    if (wait > 0) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.request();
      }, wait);
      return;
    }
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      this.last = performance.now();
      this.refresh();
    });
  }

  /** Cancel pending work. */
  dispose(): void {
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    if (this.timer !== null) clearTimeout(this.timer);
    this.frame = null;
    this.timer = null;
  }
}
