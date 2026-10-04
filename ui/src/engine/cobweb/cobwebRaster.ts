/**
 * Incremental rasterizer for a {@link CobwebCore}: one bitmap covering a gen
 * region at a given zoom, stroking only what has grown since the last pass
 * (strands batched per brightness bucket, drapes behind them). Works on an
 * `OffscreenCanvas` (worker) or an `HTMLCanvasElement` (main-thread fallback).
 */

import { COBWEB_BUCKETS } from "./cobwebCore";
import type { CobwebCore, Drape } from "./cobwebCore";
import type { GenRegion } from "./cobwebOptions";

// ── Canvas ────────────────────────────────────────────────────────────────────

/** A 2D context of either canvas kind. */
export type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** A canvas + its 2D context. */
export interface CanvasPair {
  canvas: HTMLCanvasElement | OffscreenCanvas;
  ctx: Ctx2D;
}

/**
 * Create a canvas (OffscreenCanvas when available, else a DOM canvas).
 * @param w - Width px.
 * @param h - Height px.
 * @returns The pair, or `null` without any canvas support (tests).
 */
export function makeCanvas(w: number, h: number): CanvasPair | null {
  if (typeof OffscreenCanvas !== "undefined") {
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext("2d");
    return ctx ? { canvas, ctx } : null;
  }
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  return ctx ? { canvas, ctx } : null;
}

// ═════════════════════════════════════════════════════════════════════════════
// Raster
// ═════════════════════════════════════════════════════════════════════════════

/** One bitmap of a core's region. */
export class CobwebRaster {
  readonly canvas: HTMLCanvasElement | OffscreenCanvas;
  readonly ctx: Ctx2D;
  /** One screen px in gen units. */
  private readonly px: number;
  private readonly drawnSegs = new Array<number>(COBWEB_BUCKETS).fill(0);
  /** Per drape: last band edge drawn (arm index, -1 = none). */
  private readonly drapeDrawn: number[] = [];
  /** Drapes before this index are drawn completely. */
  private drapeFrom = 0;

  /**
   * @param core - Growth state.
   * @param pair - Target canvas (sized by {@link CobwebRaster.create}).
   * @param scale - Device px per gen unit.
   * @param k - Screen units per gen unit.
   * @param reg - Covered gen region.
   */
  private constructor(
    private readonly core: CobwebCore,
    pair: CanvasPair,
    scale: number,
    k: number,
    readonly reg: GenRegion,
  ) {
    this.canvas = pair.canvas;
    this.ctx = pair.ctx;
    this.px = 1 / k;
    this.ctx.setTransform(scale, 0, 0, scale, -reg.x0 * scale, -reg.y0 * scale);
    this.ctx.lineCap = "round";
  }

  /**
   * New bitmap at zoom `k` and pixel ratio `pr` covering `reg`, with
   * everything grown so far drawn.
   * @param core - Growth state.
   * @param k - Screen units per gen unit.
   * @param pr - Device px per screen unit.
   * @param reg - Gen region.
   * @returns The raster, or `null` without canvas support.
   */
  static create(core: CobwebCore, k: number, pr: number, reg: GenRegion): CobwebRaster | null {
    let W = (reg.x1 - reg.x0) * k * pr;
    let H = (reg.y1 - reg.y0) * k * pr;
    const es = Math.min(1, Math.sqrt(core.o.maxBitmapPixels / Math.max(1, W * H)));
    W = Math.max(1, Math.ceil(W * es));
    H = Math.max(1, Math.ceil(H * es));
    const pair = makeCanvas(W, H);
    if (!pair) return null;
    const raster = new CobwebRaster(core, pair, k * pr * es, k, reg);
    raster.drawNew();
    return raster;
  }

  /** Draw whatever has grown since the last pass. */
  drawNew(): void {
    const core = this.core;
    const ctx = this.ctx;
    if (this.drapeFrom < core.drapes.length) {
      ctx.save();
      ctx.globalCompositeOperation = "destination-over"; // webbing sits behind strands
      for (let i = this.drapeFrom; i < core.drapes.length; i++) {
        const d = core.drapes[i]!;
        const last = this.drapeDrawn[i] ?? -1;
        const to = drapeStop(d.a.length, d.shown);
        if (to <= last) continue;
        this.drawDrape(d, last, to);
        this.drapeDrawn[i] = to;
      }
      ctx.restore();
      while (this.drapeFrom < core.drapes.length && this.drapeDrawn[this.drapeFrom] === core.drapes[this.drapeFrom]!.a.length - 1) this.drapeFrom++;
    }
    const [c0, c1, c2] = core.o.color;
    const [lw0, lw1] = core.o.lineWidth;
    for (let b = 0; b < COBWEB_BUCKETS; b++) {
      const arr = core.segs[b]!;
      const from = this.drawnSegs[b]!;
      if (from >= arr.length) continue;
      const p = new Path2D();
      for (let i = from; i < arr.length; i += 4) {
        p.moveTo(arr[i]!, arr[i + 1]!);
        p.lineTo(arr[i + 2]!, arr[i + 3]!);
      }
      const t = (b + 0.5) / COBWEB_BUCKETS;
      ctx.strokeStyle = `rgba(${c0},${c1},${c2},${0.85 * (1 - t) ** 1.4 + 0.06})`;
      ctx.lineWidth = (lw0 + (lw1 - lw0) * t) * this.px;
      ctx.stroke(p);
      this.drawnSegs[b] = arr.length;
    }
  }

  // ── Drapes ────────────────────────────────────────────────────────────────

  /**
   * Draw the band of a drape between arm indices `last` (exclusive; -1 = from
   * the fork) and `to`. Band edges are cross-thread curves (or the outer
   * edge), so the seam between two bands sits under a thread; drawn in one
   * go (`-1 .. n-1`) it is the whole drape.
   */
  private drawDrape(d: Drape, last: number, to: number): void {
    const ctx = this.ctx;
    const { o, a, b, alpha, sag, diag } = d;
    const n = a.length;
    const [r, g, bl] = this.core.o.drapeColor;
    const col = (x: number): string => `rgba(${r},${g},${bl},${x})`;
    const A = a[n - 1]!;
    // Cross curve at arm index i: control point pulled back toward the fork,
    // more the farther out (the outer edge bows by `sag`).
    const control = (p: { x: number; y: number }, q: { x: number; y: number }, i: number): [number, number] => {
      const k = (sag * i) / (n - 1);
      const mx = (p.x + q.x) / 2;
      const my = (p.y + q.y) / 2;
      return [mx + (o.x - mx) * k, my + (o.y - my) * k];
    };
    const grad = ctx.createRadialGradient(o.x, o.y, 0, o.x, o.y, Math.hypot(A.x - o.x, A.y - o.y) + 1);
    grad.addColorStop(0, col(0.42 * alpha));
    grad.addColorStop(1, col(0.08 * alpha));
    ctx.fillStyle = grad;
    ctx.beginPath();
    const lo = Math.max(0, last);
    if (last < 0) ctx.moveTo(o.x, o.y);
    else ctx.moveTo(a[last]!.x, a[last]!.y);
    for (let i = lo; i <= to; i++) ctx.lineTo(a[i]!.x, a[i]!.y);
    const [qx, qy] = control(a[to]!, b[to]!, to);
    ctx.quadraticCurveTo(qx, qy, b[to]!.x, b[to]!.y);
    for (let i = to - 1; i >= lo; i--) ctx.lineTo(b[i]!.x, b[i]!.y);
    if (last >= 0) {
      const [px, py] = control(a[last]!, b[last]!, last);
      ctx.quadraticCurveTo(px, py, a[last]!.x, a[last]!.y);
    }
    ctx.closePath();
    ctx.fill();

    ctx.lineWidth = 0.55 * this.px;
    for (const i of drapeThreads(n)) {
      const p = a[i]!;
      if (i > last && i <= to) {
        const q = b[i]!;
        const [cx, cy] = control(p, q, i);
        ctx.strokeStyle = col(alpha * (0.95 - (0.45 * i) / n));
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.quadraticCurveTo(cx, cy, q.x, q.y);
        ctx.stroke();
      }
      // The diagonal reaches 3 nodes farther: drawn with the band holding its end.
      if (i + 3 < n && diag[i] && i + 3 > last && i + 3 <= to) {
        const q2 = b[i + 3]!;
        const [dx, dy] = control(p, q2, i);
        ctx.strokeStyle = col(alpha * 0.5);
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.quadraticCurveTo(dx, dy, q2.x, q2.y);
        ctx.stroke();
      }
    }
  }
}

// ── Drape bands ───────────────────────────────────────────────────────────────

/**
 * Arm indices of a drape's cross threads (denser near the fork).
 * @param n - Arm length (nodes).
 * @returns Increasing indices in [1, n).
 */
export function drapeThreads(n: number): number[] {
  const out: number[] = [];
  for (let i = 1; i < n; i += 1 + Math.trunc(i / 6)) out.push(i);
  return out;
}

/**
 * How far an unrolling drape may be drawn: the outermost cross thread within
 * the revealed nodes (bands end on threads so their seams stay hidden), or
 * the outer edge once fully revealed.
 * @param n - Arm length (nodes).
 * @param shown - Revealed arm nodes.
 * @returns Arm index of the band edge, -1 = nothing yet.
 */
export function drapeStop(n: number, shown: number): number {
  if (shown >= n) return n - 1;
  let stop = -1;
  for (const i of drapeThreads(n)) {
    if (i > shown - 1) break;
    stop = i;
  }
  return stop;
}
