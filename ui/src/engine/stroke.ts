/**
 * Per-stroke buffer (the ComfySketch trick): dabs accumulate at `flow` into a
 * separate buffer, and the buffer is composited onto the layer at the stroke
 * `opacity` once, on pointer-up. Overlapping dabs therefore never exceed the
 * stroke opacity. While drawing, a preview surface shows
 * `layer + buffer @ opacity`, updated only inside the region dirtied since
 * the last frame.
 *
 * Brush composites with `source-over`, eraser with `destination-out`.
 */

import { intersectRect, isEmptyRect, roundOutRect, unionRect } from "../geometry/rect";
import type { Rect } from "../geometry/rect";
import type { Dab } from "./brush";
import { dabBounds } from "./brush";
import type { StampCache } from "./stampCache";
import { createSurface, rebaseSurface, releaseSurface } from "./surface";
import type { Surface } from "./surface";

/** Paint or erase. */
export type StrokeMode = "paint" | "erase";

/** Appearance of the current stroke. */
export interface StrokeStyle {
  mode: StrokeMode;
  /** 0..1, applied once at commit. */
  opacity: number;
  /** 0..1 */
  hardness: number;
  /** CSS colour (ignored when erasing). */
  color: string;
}

const EMPTY: Rect = { x: 0, y: 0, width: 0, height: 0 };

/**
 * Stroke buffer + preview for one document.
 */
export class StrokeBuffer {
  private buffer: Surface | null = null;
  private preview: Surface | null = null;
  private bounds: Rect = EMPTY;
  private style: StrokeStyle | null = null;
  private strokeRect: Rect = EMPTY;
  private pendingPreview: Rect = EMPTY;

  /** Whether a stroke is in progress. */
  get active(): boolean {
    return this.style !== null;
  }

  /** Document rect touched by the current stroke (integer). */
  get touched(): Rect {
    return intersectRect(roundOutRect(this.strokeRect), this.bounds);
  }

  /**
   * Start a stroke over `layer`.
   * @param layer - Target layer surface (sized to `bounds`).
   * @param bounds - Current document bounds.
   * @param style - Stroke appearance.
   */
  begin(layer: Surface, bounds: Rect, style: StrokeStyle): void {
    this.ensureSize(bounds);
    this.style = style;
    this.strokeRect = EMPTY;
    this.pendingPreview = EMPTY;
    const preview = this.surfaces().preview;
    preview.ctx.clearRect(0, 0, preview.canvas.width, preview.canvas.height);
    preview.ctx.drawImage(layer.canvas, 0, 0);
  }

  /**
   * Follow a bounds change mid-stroke (pixels keep document positions).
   * @param bounds - New bounds.
   */
  rebase(bounds: Rect): void {
    if (!this.buffer || !this.preview) {
      this.bounds = { ...bounds };
      return;
    }
    const nextBuffer = rebaseSurface(this.buffer, this.bounds, bounds);
    const nextPreview = rebaseSurface(this.preview, this.bounds, bounds);
    releaseSurface(this.buffer);
    releaseSurface(this.preview);
    this.buffer = nextBuffer;
    this.preview = nextPreview;
    this.bounds = { ...bounds };
  }

  /**
   * Draw dabs into the buffer.
   * @param dabs - Dabs in document coords.
   * @param stamps - Stamp cache.
   * @param maxDiameter - Largest diameter in this stroke (stamp resolution).
   */
  addDabs(dabs: readonly Dab[], stamps: StampCache, maxDiameter: number): void {
    if (!this.style || dabs.length === 0) return;
    const { ctx } = this.surfaces().buffer;
    const color = this.style.mode === "erase" ? "#000000" : this.style.color;
    const stamp = stamps.get(maxDiameter, this.style.hardness, color);
    for (const dab of dabs) {
      ctx.globalAlpha = dab.alpha;
      const r = dab.size / 2;
      ctx.drawImage(stamp.canvas, dab.x - r - this.bounds.x, dab.y - r - this.bounds.y, dab.size, dab.size);
      const rect = dabBounds(dab);
      this.strokeRect = unionRect(this.strokeRect, rect);
      this.pendingPreview = unionRect(this.pendingPreview, rect);
    }
    ctx.globalAlpha = 1;
  }

  /**
   * Refresh the preview inside the region dirtied since the last call.
   * @param layer - Target layer surface.
   * @returns Preview surface to draw instead of the layer.
   */
  updatePreview(layer: Surface): Surface {
    const { buffer, preview } = this.surfaces();
    const r = intersectRect(roundOutRect(this.pendingPreview), this.bounds);
    this.pendingPreview = EMPTY;
    if (this.style && !isEmptyRect(r)) {
      const x = r.x - this.bounds.x;
      const y = r.y - this.bounds.y;
      const { ctx } = preview;
      ctx.clearRect(x, y, r.width, r.height);
      ctx.drawImage(layer.canvas, x, y, r.width, r.height, x, y, r.width, r.height);
      this.compositeBuffer(ctx, buffer, x, y, r.width, r.height);
    }
    return preview;
  }

  /**
   * Composite the buffer onto the layer inside the touched rect and end the
   * stroke. The caller snapshots `touched` before/after for history.
   * @param layer - Target layer surface.
   */
  commit(layer: Surface): void {
    const r = this.touched;
    if (this.style && !isEmptyRect(r)) {
      const x = r.x - this.bounds.x;
      const y = r.y - this.bounds.y;
      this.compositeBuffer(layer.ctx, this.surfaces().buffer, x, y, r.width, r.height);
    }
    this.end();
  }

  /** Abort the stroke without touching the layer. */
  cancel(): void {
    this.end();
  }

  /** Release buffers. */
  dispose(): void {
    if (this.buffer) releaseSurface(this.buffer);
    if (this.preview) releaseSurface(this.preview);
    this.buffer = null;
    this.preview = null;
    this.style = null;
  }

  // ── Internals ───────────────────────────────────────────────────────────

  private compositeBuffer(
    ctx: CanvasRenderingContext2D,
    buffer: Surface,
    x: number,
    y: number,
    width: number,
    height: number,
  ): void {
    if (!this.style) return;
    ctx.save();
    ctx.globalAlpha = this.style.opacity;
    ctx.globalCompositeOperation = this.style.mode === "erase" ? "destination-out" : "source-over";
    ctx.drawImage(buffer.canvas, x, y, width, height, x, y, width, height);
    ctx.restore();
  }

  private end(): void {
    const r = this.touched;
    if (this.buffer && !isEmptyRect(r)) {
      this.buffer.ctx.clearRect(r.x - this.bounds.x, r.y - this.bounds.y, r.width, r.height);
    }
    this.style = null;
    this.strokeRect = EMPTY;
    this.pendingPreview = EMPTY;
  }

  private ensureSize(bounds: Rect): void {
    const same =
      this.buffer &&
      this.bounds.width === bounds.width &&
      this.bounds.height === bounds.height &&
      this.bounds.x === bounds.x &&
      this.bounds.y === bounds.y;
    if (same) return;
    this.dispose();
    this.buffer = createSurface(bounds.width, bounds.height);
    this.preview = createSurface(bounds.width, bounds.height);
    this.bounds = { ...bounds };
  }

  private surfaces(): { buffer: Surface; preview: Surface } {
    if (!this.buffer || !this.preview) throw new Error("StrokeBuffer used before begin()");
    return { buffer: this.buffer, preview: this.preview };
  }
}
