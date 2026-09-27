/**
 * Cobweb backdrop host (one per editor stage): grows the web around a rect
 * once per rect aspect, in the rect's own (gen) space so it stays attached
 * through pan/zoom, and blits a screen-resolution bitmap of the visible part.
 * Per-frame cost is one `drawImage`.
 *
 * Growth + raster run in an inline Web Worker (`?worker&inline`: a Blob URL
 * from a string in the main bundle, so `js/` stays ONE file) when Worker +
 * OffscreenCanvas exist; otherwise (or if the worker fails) on the main thread
 * in small per-frame slices. Zooming stretches the current bitmap at once and
 * a sharp one follows after the zoom settles; panning past the padded area
 * restrokes. Neither regrows. Port of the user's `temp.cobweb-backdrop.js`.
 */

import { CobwebCore } from "./cobwebCore";
import { COBWEB_DEFAULTS, genExtent, mergeCobwebOptions } from "./cobwebOptions";
import type { CobwebOptions, CobwebOverrides, FromWorker, GenRegion, ToWorker, ViewRequest } from "./cobwebOptions";
import { CobwebRaster } from "./cobwebRaster";
import CobwebWorker from "./cobweb.worker?worker&inline";

/** A rect in the target context's current units. */
export interface ScreenRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

type Bitmap = ImageBitmap | HTMLCanvasElement | OffscreenCanvas;

/**
 * Whether an inline worker can be used here.
 * @returns `true` with Worker + OffscreenCanvas + Blob URLs.
 */
export function workerSupported(): boolean {
  return typeof Worker !== "undefined" && typeof OffscreenCanvas !== "undefined" && typeof URL !== "undefined" && typeof URL.createObjectURL === "function";
}

// ═════════════════════════════════════════════════════════════════════════════
// Backdrop
// ═════════════════════════════════════════════════════════════════════════════

/** The web around one rect; see the module doc. */
export class CobwebBackdrop {
  private o: CobwebOptions;
  private aspect: number | null = null;
  /** Latest bitmap and the gen region it covers. */
  private img: Bitmap | null = null;
  private imgReg: GenRegion | null = null;
  private gen = 0;
  /** View last asked for. */
  private want: ViewRequest | null = null;
  private animate = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private raf = 0;
  private worker: Worker | null = null;
  private core: CobwebCore | null = null;
  private raster: CobwebRaster | null = null;
  private disposed = false;

  /**
   * @param onUpdate - Called when the host should redraw.
   * @param options - Option overrides.
   * @param useWorker - `false` forces main-thread mode.
   */
  constructor(
    private readonly onUpdate: () => void,
    options: CobwebOverrides = {},
    useWorker = true,
  ) {
    this.o = mergeCobwebOptions(COBWEB_DEFAULTS, options);
    if (useWorker && workerSupported()) {
      try {
        const worker = new CobwebWorker();
        worker.onmessage = (e: MessageEvent<FromWorker>) => this.receive(e.data);
        worker.onerror = () => this.dropWorker();
        this.worker = worker;
      } catch {
        this.worker = null;
      }
    }
  }

  /**
   * Regrow with a new seed, animated (the web-area click).
   * @param seed - Seed (random if omitted).
   */
  regrow(seed: number = Math.trunc(Math.random() * 2 ** 31)): void {
    this.o = mergeCobwebOptions(this.o, { seed });
    this.restart(true);
  }

  /** Stop timers, terminate the worker, drop bitmaps. Idempotent. */
  dispose(): void {
    this.disposed = true;
    this.gen++;
    clearTimeout(this.timer);
    if (this.raf) cancelAnimationFrame(this.raf);
    this.worker?.terminate();
    this.worker = null;
    this.closeImg();
    this.core = null;
    this.raster = null;
  }

  /**
   * Draw the web around `rect`.
   * @param ctx - Target context (any transform; units = "screen" units).
   * @param rect - The rect the web grows from, in ctx units.
   * @param pixelRatio - Device px per ctx unit.
   * @param vp - Visible area in ctx units.
   */
  draw(ctx: CanvasRenderingContext2D, rect: ScreenRect, pixelRatio: number, vp: ScreenRect): void {
    if (this.disposed || !(rect.w > 0 && rect.h > 0)) return;
    const aspect = rect.w / rect.h;
    const M = this.o.margin;
    const { gw, gh } = genExtent(this.o.genSize, aspect);
    const k = rect.w / gw;
    const vis: GenRegion = {
      x0: Math.max(-M, (vp.x - rect.x) / k),
      y0: Math.max(-M, (vp.y - rect.y) / k),
      x1: Math.min(gw + M, (vp.x + vp.w - rect.x) / k),
      y1: Math.min(gh + M, (vp.y + vp.h - rect.y) / k),
    };
    if (vis.x1 <= vis.x0 || vis.y1 <= vis.y0) return;
    this.track(aspect, k, pixelRatio, vis, gw, gh);
    const img = this.img;
    const r = this.imgReg;
    if (!img || !r) return;
    // Blit the bitmap's region, clipped to the viewport.
    const dx = rect.x + r.x0 * k;
    const dy = rect.y + r.y0 * k;
    const dw = (r.x1 - r.x0) * k;
    const dh = (r.y1 - r.y0) * k;
    const x0 = Math.max(dx, vp.x);
    const y0 = Math.max(dy, vp.y);
    const x1 = Math.min(dx + dw, vp.x + vp.w);
    const y1 = Math.min(dy + dh, vp.y + vp.h);
    if (x1 <= x0 || y1 <= y0) return;
    const sx = img.width / dw;
    const sy = img.height / dh;
    ctx.drawImage(img, (x0 - dx) * sx, (y0 - dy) * sy, (x1 - x0) * sx, (y1 - y0) * sy, x0, y0, x1 - x0, y1 - y0);
  }

  // ── View tracking ─────────────────────────────────────────────────────────

  /** New aspect -> regrow (not animated); zoom / uncovered pan -> re-raster later. */
  private track(aspect: number, k: number, pr: number, vis: GenRegion, gw: number, gh: number): void {
    const padded = (): GenRegion => {
      const M = this.o.margin;
      const px = (vis.x1 - vis.x0) * this.o.panPad;
      const py = (vis.y1 - vis.y0) * this.o.panPad;
      return { x0: Math.max(-M, vis.x0 - px), y0: Math.max(-M, vis.y0 - py), x1: Math.min(gw + M, vis.x1 + px), y1: Math.min(gh + M, vis.y1 + py) };
    };
    const w = this.want;
    if (this.aspect === null || !w || Math.abs(aspect / this.aspect - 1) > 1e-3) {
      this.aspect = aspect;
      this.want = { k, pr, reg: padded() };
      this.restart(false);
      return;
    }
    const zoomed = Math.abs(k / w.k - 1) > 0.01 || pr !== w.pr;
    const covered = vis.x0 >= w.reg.x0 && vis.y0 >= w.reg.y0 && vis.x1 <= w.reg.x1 && vis.y1 <= w.reg.y1;
    if (!zoomed && covered) return;
    this.want = { k, pr, reg: padded() };
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.view(), zoomed ? this.o.rasterDelayMs : 16);
  }

  // ── Growth ────────────────────────────────────────────────────────────────

  private restart(animate: boolean): void {
    const want = this.want;
    if (this.disposed || this.aspect === null || !want) return;
    this.animate = animate;
    const gen = ++this.gen;
    clearTimeout(this.timer);
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    // Animated regrow keeps the old bitmap until the first new frame (no flash).
    if (!animate) this.closeImg();
    if (this.worker) {
      this.post({ type: "start", gen, opts: this.o, aspect: this.aspect, animate, ...want });
      return;
    }
    // Main-thread fallback: grow in slices per frame.
    const core = new CobwebCore(this.o, this.aspect);
    this.core = core;
    this.raster = CobwebRaster.create(core, want.k, want.pr, want.reg);
    const tick = (): void => {
      this.raf = 0;
      if (gen !== this.gen) return;
      const done = animate ? core.growSteps(this.o.stepsPerFrame) : core.grow(this.o.budgetMs * 2);
      if ((animate || done) && this.raster) {
        this.raster.drawNew();
        this.showMain();
      }
      if (!done) this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  private view(): void {
    const want = this.want;
    if (!want || this.disposed) return;
    if (this.worker) {
      this.post({ type: "view", gen: this.gen, ...want });
      return;
    }
    if (!this.core) return;
    this.raster = CobwebRaster.create(this.core, want.k, want.pr, want.reg);
    if (this.core.done || this.animate) this.showMain();
  }

  /** Main-thread mode: show the live raster canvas. */
  private showMain(): void {
    if (!this.raster) return;
    if (this.img !== this.raster.canvas) this.closeImg();
    this.img = this.raster.canvas;
    this.imgReg = this.raster.reg;
    this.onUpdate();
  }

  // ── Worker ────────────────────────────────────────────────────────────────

  private post(message: ToWorker): void {
    try {
      this.worker?.postMessage(message);
    } catch {
      this.dropWorker();
    }
  }

  private receive(m: FromWorker): void {
    if (this.disposed || m.gen !== this.gen) {
      m.bitmap.close();
      return;
    }
    this.closeImg();
    this.img = m.bitmap;
    this.imgReg = m.reg;
    this.onUpdate();
  }

  /** Worker failed (e.g. Blob workers blocked): continue on the main thread. */
  private dropWorker(): void {
    this.worker?.terminate();
    this.worker = null;
    console.warn("[PainterSketch] cobweb worker unavailable; growing on the main thread");
    this.restart(this.animate);
  }

  private closeImg(): void {
    const img = this.img;
    if (img && typeof ImageBitmap !== "undefined" && img instanceof ImageBitmap) img.close();
    this.img = null;
    this.imgReg = null;
  }
}
