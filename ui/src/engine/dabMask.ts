/**
 * Stroke coverage in JS (16-bit), the way Photoshop builds a stroke --
 * measured from its output (300 px soft round exports at 100%, 2026-09-25),
 * not guessed:
 *
 * - Tip: `10^-(d/R)^2`, a Gaussian that is 10% at the cursor ring and cut
 *   off at 1.5 R ({@link stampProfile}; hardness adds a solid core).
 * - Every dab composites `flow x tip` OVER what is there (`c += a (1 - c)`).
 *   So a stroke is much denser than a single click (at 25% spacing the
 *   cross-section is 0.74 where the tip is 0.52, matching PS to 0.02),
 *   crossings, corners and Shift-click joints fill in with no crease, and
 *   at large spacing the dabs show as even circles with a solid interior
 *   (PS at 40%: 10% dips between dab centres; predicted 9%).
 *   A "max" / swept-profile model was measured to be wrong by 2x in the
 *   fade, and creased wherever a stroke met itself.
 * - Pen pressure -> opacity caps the coverage at the local `cap`; it never
 *   lowers what is there.
 *
 * Dabs arrive as path segments (`strokePath.ts`: runs of evenly spaced
 * dabs). A segment is applied per pixel: the run's dabs within reach are
 * summed as `q = -ln(1 - a x tip)` (one `exp` per pixel instead of one
 * multiply per dab), which is exactly the over-composite of those dabs, so
 * batching and run merging never change the result. Under 5% spacing every
 * m-th dab stands for m (identical in the limit) to bound the cost.
 *
 * Pure (no canvas): `stroke.ts` copies dirty areas into its buffer canvas
 * with {@link CoverageMask.writeRgba}. Doing this in JS keeps the colour
 * exact (8-bit premultiplied canvas stacking drifted soft edges into rings).
 */

import type { Rect } from "../geometry/rect";
import { stampAlpha } from "./brush";
import type { StampProfile } from "./brush";
import type { Segment } from "./strokePath";

const MAX = 65535;
/** Entries of the `q` table over `[0, reach^2]` (indexed by squared distance: no sqrt per dab). */
const TABLE_N = 1024;
/** Summed `q` at which the pixel counts as fully covered (`1 - e^-12` rounds to 1). */
const Q_FULL = 12;
/** Smallest dab spacing applied exactly, as a fraction of the diameter; denser runs are thinned. */
const MIN_SPACING = 0.05;

/**
 * Per-stroke coverage over the document bounds.
 */
export class CoverageMask {
  private data: Uint16Array;
  /** `alpha x tip` and `-ln(1 - alpha x tip)` by squared distance over `[0, reach^2]`, for the current profile and flow. */
  private p: Float32Array | null = null;
  private q: Float32Array | null = null;
  private tableKey = "";

  /**
   * @param width - Bounds width, px.
   * @param height - Bounds height, px.
   */
  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.data = new Uint16Array(Math.max(0, width * height));
  }

  /**
   * Coverage at a pixel (tests / debugging).
   * @returns 0..1
   */
  at(x: number, y: number): number {
    return (this.data[y * this.width + x] ?? 0) / MAX;
  }

  /**
   * Composite one segment's dabs over the coverage. A point segment is its
   * dab `a`; a run is dabs `1..intervals` along `a -> b` (dab 0 belongs to
   * the previous segment). Size and cap are interpolated from `a` to `b`;
   * flow is the segment's.
   * @param seg - Segment in document coords.
   * @param originX - Document x of mask pixel 0.
   * @param originY - Document y of mask pixel 0.
   * @param profile - Stamp profile of the stroke.
   */
  sweep(seg: Segment, originX: number, originY: number, profile: StampProfile): void {
    const { a, b, intervals } = seg;
    const alpha = Math.min(1, Math.max(0, (a.alpha + b.alpha) / 2));
    if (alpha <= 0) return;
    this.tables(profile, alpha);
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (intervals === 0 || len < 1e-6) this.stamp(a.x - originX, a.y - originY, a.size / 2, a.cap, profile);
    else if (intervals === 1) this.stamp(b.x - originX, b.y - originY, b.size / 2, b.cap, profile);
    else this.run(seg, originX, originY, profile, len);
  }

  /** One dab (the common case on curves, where every pointer sample is its own short segment). */
  private stamp(cx: number, cy: number, r: number, capRaw: number, profile: StampProfile): void {
    const { data, width, height } = this;
    const p = this.p as Float32Array;
    const wk = TABLE_N / (profile.reach * profile.reach * r * r);
    const reach = r * profile.reach;
    const reach2 = reach * reach;
    const cap = Math.min(1, Math.max(0, capRaw)) * MAX;
    const y0 = Math.max(0, Math.floor(cy - reach));
    const y1 = Math.min(height - 1, Math.ceil(cy + reach));
    for (let y = y0; y <= y1; y++) {
      const py = y + 0.5 - cy;
      const h2 = reach2 - py * py;
      if (h2 <= 0) continue;
      const h = Math.sqrt(h2);
      const xs = Math.max(0, Math.floor(cx - h - 0.5));
      const xe = Math.min(width - 1, Math.ceil(cx + h - 0.5));
      const row = y * width;
      for (let x = xs; x <= xe; x++) {
        const i = row + x;
        const c = data[i] as number;
        if (c >= MAX) continue;
        const px = x + 0.5 - cx;
        const w = (px * px + py * py) * wk;
        if (w >= TABLE_N) continue;
        const iw = w | 0;
        const added = (p[iw] as number) + ((p[iw + 1] as number) - (p[iw] as number)) * (w - iw);
        if (added <= 0) continue;
        let next = c + (MAX - c) * added;
        if (next > cap) next = c > cap ? c : cap;
        data[i] = (next + 0.5) | 0;
      }
    }
  }

  /** A run of dabs `1..intervals` from `a` to `b`, summed per pixel as `q` (see the module doc). */
  private run(seg: Segment, originX: number, originY: number, profile: StampProfile, len: number): void {
    const { data, width, height } = this;
    const { a, b, intervals } = seg;
    const q = this.q as Float32Array;
    // Table index per squared distance, for a dab of radius r: `d^2 * wScale / r^2`.
    const wScale = TABLE_N / (profile.reach * profile.reach);
    const ax = a.x - originX;
    const ay = a.y - originY;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const ux = dx / len;
    const uy = dy / len;
    const step = len / intervals;
    const ra = a.size / 2;
    const rb = b.size / 2;
    const reachMax = Math.max(ra, rb) * profile.reach;
    const reach2 = reachMax * reachMax;
    const capA = Math.min(1, Math.max(0, a.cap));
    const capB = Math.min(1, Math.max(0, b.cap));
    // Thinning: every m-th dab stands for m dabs (placed at the group's centre).
    const m = Math.max(1, Math.ceil((MIN_SPACING * (ra + rb)) / step));
    const rem = intervals % m;
    const remCentre = intervals - (rem - 1) / 2;
    const wA = wScale / (ra * ra);
    const wB = wScale / (rb * rb);
    const wConst = ra === rb;

    const x0 = Math.max(0, Math.floor(Math.min(ax, ax + dx) - reachMax));
    const y0 = Math.max(0, Math.floor(Math.min(ay, ay + dy) - reachMax));
    const x1 = Math.min(width - 1, Math.ceil(Math.max(ax, ax + dx) + reachMax));
    const y1 = Math.min(height - 1, Math.ceil(Math.max(ay, ay + dy) + reachMax));
    // Unit normal, for the capsule's straight edges.
    const nx = -uy * reachMax;
    const ny = ux * reachMax;
    for (let y = y0; y <= y1; y++) {
      const py = y + 0.5 - ay;
      const row = y * width;
      // The capsule (segment +- reach) is convex: its extent on this row is the
      // widest of the two end discs' chords and the two straight edges. Diagonal
      // segments would otherwise scan a box several times the capsule's area.
      let xl = Infinity;
      let xr = -Infinity;
      let h2 = reach2 - py * py;
      if (h2 >= 0) {
        const h = Math.sqrt(h2);
        xl = -h;
        xr = h;
      }
      const pyb = py - dy;
      h2 = reach2 - pyb * pyb;
      if (h2 >= 0) {
        const h = Math.sqrt(h2);
        if (dx - h < xl) xl = dx - h;
        if (dx + h > xr) xr = dx + h;
      }
      if (uy !== 0) {
        const t1 = (py - ny) / uy;
        if (t1 >= 0 && t1 <= len) {
          const xe = t1 * ux + nx;
          if (xe < xl) xl = xe;
          if (xe > xr) xr = xe;
        }
        const t2 = (py + ny) / uy;
        if (t2 >= 0 && t2 <= len) {
          const xe = t2 * ux - nx;
          if (xe < xl) xl = xe;
          if (xe > xr) xr = xe;
        }
      }
      if (xl > xr) continue;
      const xs = Math.max(x0, Math.floor(xl + ax - 0.5));
      const xe = Math.min(x1, Math.ceil(xr + ax - 0.5));
      for (let x = xs; x <= xe; x++) {
        const i = row + x;
        const c = data[i] as number;
        if (c >= MAX) continue;
        const px = x + 0.5 - ax;
        // Distance to the segment (no dab can be closer): skip the rest.
        const s = px * ux + py * uy;
        const along = s < 0 ? 0 : s > len ? len : s;
        const ox = px - ux * along;
        const oy = py - uy * along;
        const d2 = ox * ox + oy * oy;
        if (d2 >= reach2) continue;
        // Dabs of the run within reach of this pixel (perpendicular distance to the line, offset along it).
        const perp = px * uy - py * ux;
        const p2 = perp * perp;
        const half = Math.sqrt(reach2 - p2);
        let k0 = Math.ceil((s - half) / step);
        let k1 = Math.floor((s + half) / step);
        if (k0 < 1) k0 = 1;
        if (k1 > intervals) k1 = intervals;
        const kStart = k0 + ((m - (k0 % m)) % m);
        const shift = (m - 1) / 2;
        let sum = 0;
        for (let k = kStart; k <= k1; k += m) {
          const e = s - (k - shift) * step;
          let wk = wA;
          if (!wConst) {
            const rk = ra + (rb - ra) * (k / intervals);
            wk = wScale / (rk * rk);
          }
          const w = (p2 + e * e) * wk;
          if (w >= TABLE_N) continue;
          const iw = w | 0;
          sum += m * ((q[iw] as number) + ((q[iw + 1] as number) - (q[iw] as number)) * (w - iw));
          if (sum >= Q_FULL) break;
        }
        if (rem !== 0 && sum < Q_FULL && intervals >= k0 && intervals <= k1) {
          const e = s - remCentre * step;
          const w = (p2 + e * e) * wB;
          if (w < TABLE_N) {
            const iw = w | 0;
            sum += rem * ((q[iw] as number) + ((q[iw + 1] as number) - (q[iw] as number)) * (w - iw));
          }
        }
        if (sum <= 0) continue;
        const added = sum >= Q_FULL ? 1 : 1 - Math.exp(-sum);
        let next = c + (MAX - c) * added;
        const cap = (capA + (capB - capA) * (along / len)) * MAX;
        if (next > cap) next = c > cap ? c : cap;
        data[i] = (next + 0.5) | 0;
      }
    }
  }

  /**
   * Zero an area (end of a stroke).
   * @param rect - Mask px.
   */
  clear(rect: Rect): void {
    const r = this.clampRect(rect);
    for (let y = r.y; y < r.y + r.height; y++) {
      const from = y * this.width + r.x;
      this.data.fill(0, from, from + r.width);
    }
  }

  /**
   * Write an area as straight-alpha RGBA (one colour, alpha = coverage).
   * @param rect - Mask px (clamped to the mask).
   * @param rgb - Colour.
   * @param out - `rect.width * rect.height * 4` bytes.
   */
  writeRgba(rect: Rect, rgb: { r: number; g: number; b: number }, out: Uint8ClampedArray): void {
    for (let y = 0; y < rect.height; y++) {
      const src = (rect.y + y) * this.width + rect.x;
      let p = y * rect.width * 4;
      for (let x = 0; x < rect.width; x++, p += 4) {
        out[p] = rgb.r;
        out[p + 1] = rgb.g;
        out[p + 2] = rgb.b;
        out[p + 3] = ((this.data[src + x] as number) * 255) / MAX + 0.5;
      }
    }
  }

  /**
   * A copy re-based onto new bounds (bounds grew mid-stroke; pixels keep
   * their document positions).
   * @param from - Current bounds (document).
   * @param to - New bounds (document).
   * @returns New mask.
   */
  rebased(from: Rect, to: Rect): CoverageMask {
    const next = new CoverageMask(to.width, to.height);
    const ox = from.x - to.x;
    const oy = from.y - to.y;
    for (let y = 0; y < this.height; y++) {
      const ty = y + oy;
      if (ty < 0 || ty >= to.height) continue;
      const sx0 = Math.max(0, -ox);
      const sx1 = Math.min(this.width, to.width - ox);
      if (sx1 <= sx0) continue;
      const from = y * this.width;
      const at = ty * to.width + sx0 + ox;
      next.data.set(this.data.subarray(from + sx0, from + sx1), at);
    }
    return next;
  }

  /** Build `p = alpha x tip` and `q = -ln(1 - p)` by squared distance over `[0, reach^2]` (cached for the stroke). */
  private tables(profile: StampProfile, alpha: number): void {
    const key = `${profile.core}|${profile.fade}|${alpha}`;
    if (this.q && this.tableKey === key) return;
    const p = new Float32Array(TABLE_N + 2);
    const q = new Float32Array(TABLE_N + 2);
    for (let i = 0; i < TABLE_N; i++) {
      const u = Math.sqrt(i / TABLE_N) * profile.reach;
      p[i] = alpha * stampAlpha(u, profile);
      q[i] = -Math.log(Math.max(1e-6, 1 - (p[i] as number)));
    }
    this.p = p;
    this.q = q;
    this.tableKey = key;
  }

  private clampRect(rect: Rect): Rect {
    const x = Math.max(0, rect.x);
    const y = Math.max(0, rect.y);
    return {
      x,
      y,
      width: Math.max(0, Math.min(this.width, rect.x + rect.width) - x),
      height: Math.max(0, Math.min(this.height, rect.y + rect.height) - y),
    };
  }
}
