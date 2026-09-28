/**
 * Pixel side of Free Transform (SPEC M11), pure typed-array code (no canvas,
 * so it is unit-testable and deterministic):
 *
 * - {@link resampleRgba}: the commit resample -- ONE pass from the original
 *   float pixels through the session matrix. Bilinear on premultiplied
 *   alpha, with `n x n` supersampling when the transform shrinks (n = the
 *   inverse scale, capped at 4), so downscales average instead of alias.
 *   Pixel-centre sampling makes whole-px translations and flips exact.
 * - {@link resampleCoverage}: the same for a selection coverage mask
 *   (0..255 kept, no thresholding) -> {@link transformSelection}.
 * - {@link flipRgba}: exact mirror of a pixel buffer (Flip without a session).
 *
 * The live preview does not use this: it draws the float canvas through the
 * matrix with canvas smoothing (`floatOps.ts`).
 */

import type { Rect } from "../geometry/rect";
import { coverageFor, selectionFromCoverage } from "./selection";
import type { Selection } from "./selection";
import { invert, transformedAabb } from "./transformMath";
import type { Affine } from "./transformMath";

/** Largest supersampling factor per axis. */
const MAX_SUPERSAMPLE = 4;

/**
 * Supersampling factor for a destination -> source matrix: source px
 * covered by one destination px, rounded up (1 when enlarging).
 * @param inv - Destination -> source matrix.
 * @returns Samples per axis (1..4).
 */
export function supersampleFactor(inv: Affine): number {
  const stretch = Math.max(Math.hypot(inv.a, inv.b), Math.hypot(inv.c, inv.d));
  return Math.min(MAX_SUPERSAMPLE, Math.max(1, Math.ceil(stretch - 1e-6)));
}

/**
 * Resample straight-alpha RGBA through a matrix into a destination rect.
 * @param src - Source RGBA (`sw * sh * 4`).
 * @param sw - Source width.
 * @param sh - Source height.
 * @param m - Source-local -> destination (document) matrix.
 * @param dest - Integer destination rect, document px.
 * @returns RGBA over `dest` (straight alpha).
 */
export function resampleRgba(src: Uint8ClampedArray, sw: number, sh: number, m: Affine, dest: Rect): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(Math.max(0, dest.width * dest.height * 4));
  const inv = invert(m);
  if (!inv) return out;
  const n = supersampleFactor(inv);
  const taps = n * n;
  const acc = [0, 0, 0, 0];
  for (let y = 0; y < dest.height; y++) {
    for (let x = 0; x < dest.width; x++) {
      acc.fill(0);
      for (let j = 0; j < n; j++) {
        const py = dest.y + y + (j + 0.5) / n;
        for (let i = 0; i < n; i++) {
          const px = dest.x + x + (i + 0.5) / n;
          const u = inv.a * px + inv.c * py + inv.e - 0.5;
          const v = inv.b * px + inv.d * py + inv.f - 0.5;
          bilinearRgba(src, sw, sh, u, v, acc);
        }
      }
      const alpha = acc[3] as number;
      if (alpha <= 0) continue;
      const o = (y * dest.width + x) * 4;
      out[o] = Math.round((acc[0] as number) / alpha);
      out[o + 1] = Math.round((acc[1] as number) / alpha);
      out[o + 2] = Math.round((acc[2] as number) / alpha);
      out[o + 3] = Math.round(alpha / taps);
    }
  }
  return out;
}

/**
 * Resample a coverage mask (one byte per px) through a matrix.
 * @param src - Source coverage (`sw * sh`).
 * @param sw - Source width.
 * @param sh - Source height.
 * @param m - Source-local -> destination matrix.
 * @param dest - Integer destination rect.
 * @returns Coverage over `dest`.
 */
export function resampleCoverage(src: Uint8Array, sw: number, sh: number, m: Affine, dest: Rect): Uint8Array {
  const out = new Uint8Array(Math.max(0, dest.width * dest.height));
  const inv = invert(m);
  if (!inv) return out;
  const n = supersampleFactor(inv);
  for (let y = 0; y < dest.height; y++) {
    for (let x = 0; x < dest.width; x++) {
      let sum = 0;
      for (let j = 0; j < n; j++) {
        const py = dest.y + y + (j + 0.5) / n;
        for (let i = 0; i < n; i++) {
          const px = dest.x + x + (i + 0.5) / n;
          sum += bilinearByte(src, sw, sh, inv.a * px + inv.c * py + inv.e - 0.5, inv.b * px + inv.d * py + inv.f - 0.5);
        }
      }
      out[y * dest.width + x] = Math.round(sum / (n * n));
    }
  }
  return out;
}

/**
 * A selection carried through a float's transform: its coverage over the
 * lifted `area`, resampled by the float-local -> document matrix.
 * @param sel - Selection at lift time.
 * @param area - Lifted document rect (float-local origin).
 * @param m - Float-local -> document matrix.
 * @returns Transformed selection, or `null` when nothing stays covered.
 */
export function transformSelection(sel: Selection, area: Rect, m: Affine): Selection | null {
  const coverage = coverageFor(sel, area);
  const dest = transformedAabb(m, area.width, area.height);
  if (dest.width <= 0 || dest.height <= 0) return null;
  return selectionFromCoverage(resampleCoverage(coverage, area.width, area.height, m, dest), dest);
}

/**
 * Exact mirror of an RGBA buffer.
 * @param src - RGBA (`w * h * 4`).
 * @param w - Width.
 * @param h - Height.
 * @param axis - `"h"` mirrors left/right, `"v"` top/bottom.
 * @returns New mirrored buffer.
 */
export function flipRgba(src: Uint8ClampedArray, w: number, h: number, axis: "h" | "v"): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(src.length);
  for (let y = 0; y < h; y++) {
    const ty = axis === "v" ? h - 1 - y : y;
    for (let x = 0; x < w; x++) {
      const tx = axis === "h" ? w - 1 - x : x;
      const s = (y * w + x) * 4;
      out.set(src.subarray(s, s + 4), (ty * w + tx) * 4);
    }
  }
  return out;
}

// ── Sampling ──────────────────────────────────────────────────────────────────

/** Add a premultiplied bilinear sample at source px coords (u, v) to `acc` (transparent outside). */
function bilinearRgba(src: Uint8ClampedArray, sw: number, sh: number, u: number, v: number, acc: number[]): void {
  const x0 = Math.floor(u);
  const y0 = Math.floor(v);
  const fx = u - x0;
  const fy = v - y0;
  for (let k = 0; k < 4; k++) {
    const xx = x0 + (k & 1);
    const yy = y0 + (k >> 1);
    const wgt = ((k & 1) ? fx : 1 - fx) * ((k >> 1) ? fy : 1 - fy);
    if (wgt <= 0 || xx < 0 || yy < 0 || xx >= sw || yy >= sh) continue;
    const p = (yy * sw + xx) * 4;
    const a = ((src[p + 3] as number) * wgt);
    if (a <= 0) continue;
    acc[0] = (acc[0] as number) + (src[p] as number) * a;
    acc[1] = (acc[1] as number) + (src[p + 1] as number) * a;
    acc[2] = (acc[2] as number) + (src[p + 2] as number) * a;
    acc[3] = (acc[3] as number) + a;
  }
}

/** Bilinear sample of a byte buffer at (u, v) (0 outside). */
function bilinearByte(src: Uint8Array, sw: number, sh: number, u: number, v: number): number {
  const x0 = Math.floor(u);
  const y0 = Math.floor(v);
  const fx = u - x0;
  const fy = v - y0;
  let sum = 0;
  for (let k = 0; k < 4; k++) {
    const xx = x0 + (k & 1);
    const yy = y0 + (k >> 1);
    const wgt = ((k & 1) ? fx : 1 - fx) * ((k >> 1) ? fy : 1 - fy);
    if (wgt <= 0 || xx < 0 || yy < 0 || xx >= sw || yy >= sh) continue;
    sum += (src[yy * sw + xx] as number) * wgt;
  }
  return sum;
}
