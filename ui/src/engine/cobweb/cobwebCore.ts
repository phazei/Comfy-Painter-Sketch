/**
 * Pure growth core of the cobweb backdrop (TypeScript port of the user's
 * reference `temp.cobweb-backdrop.js`): an organic, mycelium-like mesh grows
 * outward from the edges of a rect (`[0, gw] x [0, gh]` in gen units), strands
 * fuse when they meet, and webbing is draped across acute forks. No canvas,
 * no scheduling: runs in the worker or on the main thread and is unit-tested
 * directly. Deterministic for a seed.
 *
 * Timing (what animated growth shows): edge strands start staggered,
 * spreading along the edge from a few random points (`stagger`), and a drape
 * unrolls from its fork one arm node per step (`Drape.shown`) instead of
 * appearing whole.
 */

import { genExtent } from "./cobwebOptions";
import type { CobwebOptions } from "./cobwebOptions";

// ── Types ─────────────────────────────────────────────────────────────────────

/** Brightness buckets for batched stroking (bucket = distance from the rect). */
export const COBWEB_BUCKETS = 24;
/** Spatial hash cell size (gen units). */
const CELL = 8;
/** Grid key offset/stride (cells); coordinates stay far inside this. */
const KEY_OFFSET = 1 << 14;
const KEY_STRIDE = 1 << 15;

/** A point of the mesh. `owner` = growing tip id, 0 for edge seeds. */
export interface WebNode {
  readonly x: number;
  readonly y: number;
  readonly owner: number;
}

/** One draped web across a fork: fan from `o` along arms `a` and `b`. */
export interface Drape {
  o: WebNode;
  a: WebNode[];
  b: WebNode[];
  /** 0..1 strength. */
  alpha: number;
  /** How far threads bow back toward the fork. */
  sag: number;
  /** Per thread: add a diagonal thread. */
  diag: boolean[];
  /** Arm nodes revealed so far (1..`a.length`); grows one per step. */
  shown: number;
}

interface Fork {
  o: WebNode;
  a: WebNode[];
  b: WebNode[];
  ends: number;
  /** Target arm length (steps). */
  L: number;
}

interface Feed {
  fork: Fork;
  side: "a" | "b";
}

interface Tip {
  id: number;
  parent: number;
  x: number;
  y: number;
  a: number;
  drift: number;
  last: WebNode;
  age: number;
  feeds: Feed[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Mulberry32 PRNG (same sequence as the reference).
 * @param seed - 32-bit seed.
 * @returns Function yielding floats in [0, 1).
 */
export function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Wrap an angle to (-PI, PI].
 * @param a - Angle in radians.
 * @returns Wrapped angle.
 */
export function wrapAngle(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

const now = (): number => (typeof performance !== "undefined" ? performance.now() : Date.now());

// ═════════════════════════════════════════════════════════════════════════════
// Core
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Growth state for one rect aspect. Call {@link CobwebCore.grow} until it
 * returns `true`; `segs` / `drapes` only ever grow (rasterizers draw the new
 * tail since their last pass).
 */
export class CobwebCore {
  /** Rect width / height in gen units. */
  readonly gw: number;
  readonly gh: number;
  /** Per brightness bucket: flat `x1, y1, x2, y2` runs. */
  readonly segs: number[][];
  readonly drapes: Drape[] = [];
  /** Growth finished. */
  done = false;
  private readonly rand: () => number;
  private nodes = 0;
  private readonly grid = new Map<number, WebNode[]>();
  private tips: Tip[] = [];
  private tipId = 0;
  /** Edge strands not started yet, latest first (popped when `steps` reaches `at`). */
  private pending: { at: number; tip: Tip }[] = [];
  /** Drapes still unrolling. */
  private unrolling: Drape[] = [];
  private steps = 0;

  /**
   * @param o - Options.
   * @param aspect - Rect width / height.
   */
  constructor(
    readonly o: CobwebOptions,
    aspect: number,
  ) {
    this.rand = mulberry32(o.seed);
    const { gw, gh } = genExtent(o.genSize, aspect);
    this.gw = gw;
    this.gh = gh;
    this.segs = Array.from({ length: COBWEB_BUCKETS }, () => []);
    this.seedEdges();
  }

  /**
   * Grow for up to `ms` milliseconds (`Infinity` = to completion).
   * @param ms - Time budget.
   * @returns Whether growth has finished.
   */
  grow(ms: number): boolean {
    const t0 = now();
    while (this.active()) {
      this.step();
      if (now() - t0 >= ms) break;
    }
    this.done = !this.active();
    return this.done;
  }

  /**
   * Grow a fixed number of steps (rate-limited animated growth).
   * @param n - Steps to run.
   * @returns Whether growth has finished.
   */
  growSteps(n: number): boolean {
    for (let i = 0; i < n && this.active(); i++) this.step();
    this.done = !this.active();
    return this.done;
  }

  /** Strands can still grow (under the node cap), or a drape is still unrolling. */
  private active(): boolean {
    return ((this.tips.length > 0 || this.pending.length > 0) && this.nodes < this.o.maxNodes) || this.unrolling.length > 0;
  }

  /**
   * Distance from the rect (0 on or inside it).
   * @param x - Gen x.
   * @param y - Gen y.
   * @returns Distance in gen units.
   */
  dist(x: number, y: number): number {
    const dx = Math.max(-x, 0, x - this.gw);
    const dy = Math.max(-y, 0, y - this.gh);
    return Math.hypot(dx, dy);
  }

  // ── Setup ─────────────────────────────────────────────────────────────────

  private seedEdges(): void {
    const R = this.rand;
    const W = this.gw;
    const H = this.gh;
    const per = 2 * (W + H);
    const count = Math.round(per / this.o.seedSpacing);
    // Staggered start: growth spreads along the edge from a few random points.
    const origins = Array.from({ length: 3 + Math.trunc(R() * 3) }, () => R() * per);
    const seeds: { at: number; tip: Tip }[] = [];
    for (let i = 0; i < count; i++) {
      let t = ((i + R() * 0.8) / count) * per;
      const along = Math.min(...origins.map((p) => Math.min(Math.abs(t - p), per - Math.abs(t - p))));
      let x: number;
      let y: number;
      let a: number;
      if (t < W) {
        x = t;
        y = 0;
        a = -Math.PI / 2;
      } else if ((t -= W) < H) {
        x = W;
        y = t;
        a = 0;
      } else if ((t -= H) < W) {
        x = W - t;
        y = H;
        a = Math.PI / 2;
      } else {
        t -= W;
        x = 0;
        y = H - t;
        a = Math.PI;
      }
      const n = this.addNode(x, y, 0);
      const angle = a + (R() - 0.5) * 1.2;
      seeds.push({ at: along, tip: { id: ++this.tipId, parent: -1, x, y, a: angle, drift: (R() - 0.5) * 0.04, last: n, age: 0, feeds: [] } });
    }
    // Distance along the edge -> start step (the farthest strand starts near `stagger`).
    const far = Math.max(1, ...seeds.map((s) => s.at));
    for (const s of seeds) s.at = Math.round((s.at / far) * this.o.stagger * (0.85 + R() * 0.3));
    this.pending = seeds.sort((p, q) => q.at - p.at);
    this.release();
  }

  /** Start the edge strands whose time has come. */
  private release(): void {
    const p = this.pending;
    while (p.length && p[p.length - 1]!.at <= this.steps) this.tips.push(p.pop()!.tip);
  }

  // ── Mesh ──────────────────────────────────────────────────────────────────

  private key(gx: number, gy: number): number {
    return (gx + KEY_OFFSET) * KEY_STRIDE + (gy + KEY_OFFSET);
  }

  private addNode(x: number, y: number, owner: number): WebNode {
    const n: WebNode = { x, y, owner };
    this.nodes++;
    const k = this.key(Math.trunc(x / CELL), Math.trunc(y / CELL));
    let cell = this.grid.get(k);
    if (!cell) {
      cell = [];
      this.grid.set(k, cell);
    }
    cell.push(n);
    return n;
  }

  /** Nearest foreign node within `join` (not the tip's own or its parent's). */
  private near(x: number, y: number, tip: Tip): WebNode | null {
    const gx = Math.trunc(x / CELL);
    const gy = Math.trunc(y / CELL);
    let best: WebNode | null = null;
    let bd = this.o.join * this.o.join;
    for (let i = -1; i <= 1; i++) {
      for (let j = -1; j <= 1; j++) {
        const cell = this.grid.get(this.key(gx + i, gy + j));
        if (!cell) continue;
        for (const n of cell) {
          if (n.owner <= 0 || n.owner === tip.id || n.owner === tip.parent) continue;
          const d = (n.x - x) ** 2 + (n.y - y) ** 2;
          if (d < bd) {
            bd = d;
            best = n;
          }
        }
      }
    }
    return best;
  }

  private seg(a: WebNode, b: WebNode, d: number): void {
    const i = Math.min(COBWEB_BUCKETS - 1, Math.trunc((d / this.o.margin) * COBWEB_BUCKETS));
    this.segs[i]!.push(a.x, a.y, b.x, b.y);
  }

  // ── Drapes ────────────────────────────────────────────────────────────────

  private drapeWeight(d: number): number {
    const { start, ramp } = this.o.drape;
    const M = this.o.margin;
    return Math.max(0, Math.min(1, (d - M * start) / (M * ramp)));
  }

  /** One arm of a fork ended; when both have, maybe drape it. */
  private endSide(f: Fork): void {
    if (++f.ends < 2) return;
    const n = Math.min(f.a.length, f.b.length);
    if (n < 4) return;
    const o = f.o;
    const A = f.a[n - 1]!;
    const B = f.b[n - 1]!;
    const ang = Math.abs(wrapAngle(Math.atan2(A.y - o.y, A.x - o.x) - Math.atan2(B.y - o.y, B.x - o.x)));
    if (ang > (this.o.drape.maxAngle * Math.PI) / 180) return;
    const w = this.drapeWeight(this.dist(o.x, o.y));
    const R = this.rand;
    if (w <= 0 || R() > w) return;
    const diag: boolean[] = [];
    for (let i = 0; i < n; i++) diag.push(R() < 0.5);
    const d: Drape = { o, a: f.a.slice(0, n), b: f.b.slice(0, n), alpha: 0.35 + 0.65 * w, sag: 0.18 + R() * 0.22, diag, shown: 1 };
    this.drapes.push(d);
    this.unrolling.push(d);
  }

  private kill(t: Tip): void {
    for (const f of t.feeds) this.endSide(f.fork);
    t.feeds = [];
  }

  // ── Step ──────────────────────────────────────────────────────────────────

  private step(): void {
    this.steps++;
    if (this.nodes < this.o.maxNodes) {
      this.release();
      if (this.tips.length) this.stepTips();
    }
    // Drapes unroll at strand speed (one arm node per step).
    if (this.unrolling.length) this.unrolling = this.unrolling.filter((d) => ++d.shown < d.a.length);
  }

  private stepTips(): void {
    const o = this.o;
    const R = this.rand;
    const M = o.margin;
    const cx = this.gw / 2;
    const cy = this.gh / 2;
    const next: Tip[] = [];
    for (const t of this.tips) {
      // Wander, with a gentle pull away from the rect.
      const out = Math.atan2(t.y - cy, t.x - cx);
      t.a += (R() - 0.5) * 0.45 + t.drift + wrapAngle(out - t.a) * 0.015;
      const x = t.x + Math.cos(t.a) * o.step;
      const y = t.y + Math.sin(t.a) * o.step;
      const inside = x > 0 && x < this.gw && y > 0 && y < this.gh;
      if (inside || x < -M || y < -M || x > this.gw + M || y > this.gh + M) {
        this.kill(t);
        continue;
      }
      const d = this.dist(x, y);
      t.age++;
      const hit = t.age > 14 ? this.near(x, y, t) : null;
      if (hit) {
        this.seg(t.last, hit, d); // fuse into the mesh
        if (R() < 0.45) {
          this.kill(t);
          continue;
        }
      }
      const n = this.addNode(x, y, t.id);
      this.seg(t.last, n, d);
      t.x = x;
      t.y = y;
      t.last = n;
      t.feeds = t.feeds.filter((feed) => {
        const arm = feed.fork[feed.side];
        arm.push(n);
        if (arm.length < feed.fork.L) return true;
        this.endSide(feed.fork);
        return false;
      });
      if (R() < 0.0015 + (d / M) * 0.012) {
        this.kill(t); // thins with distance
        continue;
      }
      next.push(t);
      if (R() < o.branch) this.fork(t, n, d, next);
    }
    if (next.length > o.maxTips) {
      for (let i = next.length - 1; i > 0; i--) {
        const j = Math.trunc(R() * (i + 1));
        const tmp = next[i]!;
        next[i] = next[j]!;
        next[j] = tmp;
      }
      for (const t of next.slice(o.maxTips)) this.kill(t);
      next.length = o.maxTips;
    }
    this.tips = next;
  }

  private fork(t: Tip, n: WebNode, d: number, next: Tip[]): void {
    const R = this.rand;
    const s = R() < 0.5 ? -1 : 1;
    const L = Math.max(4, Math.round(this.o.drape.length * (0.5 + R()) * (1 + 0.8 * this.drapeWeight(d))));
    const f: Fork = { o: n, a: [], b: [], ends: 0, L };
    t.feeds.push({ fork: f, side: "a" });
    const a = t.a + s * (0.35 + R() * 0.7);
    next.push({ id: ++this.tipId, parent: t.id, x: n.x, y: n.y, a, drift: (R() - 0.5) * 0.04, last: n, age: 0, feeds: [{ fork: f, side: "b" }] });
  }
}
