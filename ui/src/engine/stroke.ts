/**
 * Per-stroke buffer (the ComfySketch trick): dabs accumulate at `flow` into a
 * separate buffer, and the buffer is composited onto the layer at the stroke
 * `opacity` once, on pointer-up. Overlapping dabs therefore never exceed the
 * stroke opacity. While drawing, a preview surface shows
 * `layer + buffer @ opacity`, updated only inside the region dirtied since
 * the last frame.
 *
 * Brush composites with `source-over`, eraser with `destination-out`.
 * Dabs become path segments composited over each other in a 16-bit JS
 * coverage mask (`dabMask.ts`, Photoshop's model as measured) and dirty
 * areas are written into the buffer canvas as one colour with alpha =
 * coverage right before compositing. So the colour is exact at every pixel
 * (stacking coloured low-alpha dabs in the 8-bit premultiplied canvas
 * drifted soft edges into dark "dust" rings).
 * A Shift-click line is its own stroke composited over the previous one
 * (Photoshop: one history state per click); its spacing carries on through
 * the joint (`paintTool.ts`), so at 100% opacity it is pixel-identical to
 * one continuous stroke.
 * Shape tools use the same buffer but replace its content on every move
 * ({@link StrokeBuffer.replaceContent}) instead of accumulating dabs.
 * With a selection ({@link StrokeBuffer.setClip}) both the preview and the
 * commit composite `buffer x selection coverage` (M5 clipping).
 */

import { intersectRect, isEmptyRect, roundOutRect, unionRect } from "../geometry/rect";
import type { Point, Rect } from "../geometry/rect";
import type { Dab, StampProfile } from "./brush";
import { dabBounds, stampProfile } from "./brush";
import { CoverageMask } from "./dabMask";
import { planSegments } from "./strokePath";
import { hexToRgb } from "./pixelColor";
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
  private refreshed: Rect = EMPTY;
  /** Selection clip (alpha = coverage, sized to the bounds) or `null` = unclipped. */
  private clipSource: () => CanvasImageSource | null = () => null;
  /** Buffer x clip, composited instead of the buffer while a selection exists. */
  private clipped: Surface | null = null;
  /** Dab coverage (bounds-sized, created by the first dab stroke). */
  private mask: CoverageMask | null = null;
  /** Document rect of coverage not yet written into the buffer canvas. */
  private maskDirty: Rect = EMPTY;
  /** Last dab of the stroke so far (the next batch's segments start there). */
  private lastDab: Dab | null = null;
  /** Stamp profile of the current stroke (hardness, largest radius). */
  private profile: StampProfile = stampProfile(0, 1);

  /**
   * Clip every composite (live preview and commit) to a selection: the
   * buffer is multiplied by the clip's alpha right before compositing, so
   * soft coverage never compounds over overlapping dabs.
   * @param source - Returns the clip canvas for the current bounds, or `null`.
   */
  setClip(source: () => CanvasImageSource | null): void {
    this.clipSource = source;
  }

  /** Document rect refreshed by the last {@link updatePreview} call (may be empty). */
  get lastRefreshed(): Rect {
    return { ...this.refreshed };
  }

  /** Stamp extent as a multiple of the radius for the current stroke ({@link StampProfile.reach}). */
  get reach(): number {
    return this.profile.reach;
  }

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
   * @param maxDiameter - Largest dab diameter this stroke can produce, px
   *   (sets the stamp profile's 1 px minimum fade).
   */
  begin(layer: Surface, bounds: Rect, style: StrokeStyle, maxDiameter = 1): void {
    this.ensureSize(bounds);
    this.style = style;
    this.profile = stampProfile(style.hardness, Math.max(1, maxDiameter / 2));
    this.lastDab = null;
    this.strokeRect = EMPTY;
    this.pendingPreview = EMPTY;
    this.refreshed = EMPTY;
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
    this.releaseClipped();
    this.buffer = nextBuffer;
    this.preview = nextPreview;
    if (this.mask) this.mask = this.mask.rebased(this.bounds, bounds);
    this.bounds = { ...bounds };
  }

  /**
   * Add dabs to the stroke coverage (written to the buffer on the next
   * preview / commit).
   * @param dabs - Dabs in document coords.
   */
  addDabs(dabs: readonly Dab[]): void {
    if (!this.style || dabs.length === 0) return;
    this.surfaces();
    const { width, height, x, y } = this.bounds;
    if (!this.mask || this.mask.width !== width || this.mask.height !== height) this.mask = new CoverageMask(width, height);
    for (const seg of planSegments(this.lastDab, dabs)) this.mask.sweep(seg, x, y, this.profile);
    // The first segment starts at the previous batch's last dab: refresh around it too.
    const touchedDabs = this.lastDab ? [this.lastDab, ...dabs] : dabs;
    this.lastDab = dabs[dabs.length - 1] ?? this.lastDab;
    for (const dab of touchedDabs) {
      const rect = dabBounds(dab, this.reach);
      this.strokeRect = unionRect(this.strokeRect, rect);
      this.pendingPreview = unionRect(this.pendingPreview, rect);
      this.maskDirty = unionRect(this.maskDirty, rect);
    }
  }

  /**
   * Replace the buffer content with one shape (shape tools redraw the whole
   * shape on every move): clears what the previous shape drew, draws the
   * new one, and marks both areas for the preview. {@link touched} becomes
   * the new shape's rect.
   * @param rect - Document rect the new shape can touch (empty = nothing).
   * @param draw - Draws into the buffer context; `origin` is the document point at its (0, 0).
   */
  replaceContent(rect: Rect, draw: (ctx: CanvasRenderingContext2D, origin: Point) => void): void {
    if (!this.style) return;
    const { ctx } = this.surfaces().buffer;
    const old = this.touched;
    if (!isEmptyRect(old)) ctx.clearRect(old.x - this.bounds.x, old.y - this.bounds.y, old.width, old.height);
    this.pendingPreview = unionRect(unionRect(this.pendingPreview, old), rect);
    this.strokeRect = isEmptyRect(rect) ? EMPTY : { ...rect };
    if (!isEmptyRect(rect)) draw(ctx, { x: this.bounds.x, y: this.bounds.y });
  }

  /**
   * Refresh the preview inside the region dirtied since the last call.
   * The refreshed document rect is available as {@link lastRefreshed}.
   * @param layer - Target layer surface.
   * @returns Preview surface to draw instead of the layer.
   */
  updatePreview(layer: Surface): Surface {
    const { buffer, preview } = this.surfaces();
    const r = intersectRect(roundOutRect(this.pendingPreview), this.bounds);
    this.pendingPreview = EMPTY;
    this.refreshed = r;
    this.flushMask();
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
    this.flushMask();
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
    this.releaseClipped();
    this.buffer = null;
    this.preview = null;
    this.mask = null;
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
    const source = this.sourceFor(buffer, x, y, width, height);
    ctx.save();
    ctx.globalAlpha = this.style.opacity;
    ctx.globalCompositeOperation = this.style.mode === "erase" ? "destination-out" : "source-over";
    ctx.drawImage(source, x, y, width, height, x, y, width, height);
    ctx.restore();
  }

  /** Write pending dab coverage into the buffer canvas (stroke colour, alpha = coverage). */
  private flushMask(): void {
    const r = intersectRect(roundOutRect(this.maskDirty), this.bounds);
    this.maskDirty = EMPTY;
    if (!this.mask || !this.style || !this.buffer || isEmptyRect(r)) return;
    const local: Rect = { x: r.x - this.bounds.x, y: r.y - this.bounds.y, width: r.width, height: r.height };
    const image = new ImageData(local.width, local.height);
    const rgb = this.style.mode === "erase" ? { r: 0, g: 0, b: 0 } : hexToRgb(this.style.color);
    this.mask.writeRgba(local, rgb, image.data);
    this.buffer.ctx.putImageData(image, local.x, local.y);
  }

  /** The buffer region multiplied by the selection clip (or the buffer itself without one). */
  private sourceFor(buffer: Surface, x: number, y: number, width: number, height: number): HTMLCanvasElement {
    const clip = this.clipSource();
    if (!clip) return buffer.canvas;
    this.clipped ??= createSurface(buffer.canvas.width, buffer.canvas.height);
    const { ctx } = this.clipped;
    ctx.save();
    // `destination-in` clears everything outside the drawn image: limit it to the region.
    ctx.beginPath();
    ctx.rect(x, y, width, height);
    ctx.clip();
    ctx.clearRect(x, y, width, height);
    ctx.drawImage(buffer.canvas, x, y, width, height, x, y, width, height);
    ctx.globalCompositeOperation = "destination-in";
    ctx.drawImage(clip, x, y, width, height, x, y, width, height);
    ctx.restore();
    return this.clipped.canvas;
  }

  private releaseClipped(): void {
    if (this.clipped) releaseSurface(this.clipped);
    this.clipped = null;
  }

  private end(): void {
    const r = this.touched;
    if (!isEmptyRect(r)) {
      const local: Rect = { x: r.x - this.bounds.x, y: r.y - this.bounds.y, width: r.width, height: r.height };
      if (this.buffer) this.buffer.ctx.clearRect(local.x, local.y, local.width, local.height);
      if (this.mask) this.mask.clear(local);
    }
    this.maskDirty = EMPTY;
    this.lastDab = null;
    this.style = null;
    this.strokeRect = EMPTY;
    this.pendingPreview = EMPTY;
    this.refreshed = EMPTY;
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
