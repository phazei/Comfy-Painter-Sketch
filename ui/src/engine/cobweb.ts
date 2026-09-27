/**
 * Procedural cobweb texture for the stage area outside the maximum paint area
 * (`boundsCap`). The geometry is pure and deterministic (seeded PRNG) so it is
 * unit-testable without a canvas; {@link cobwebPattern} renders it once into
 * an offscreen tile and caches a repeating `CanvasPattern` per context.
 *
 * Each web: radial spokes from a centre plus sagging spiral threads between
 * neighbouring spokes (each thread bows toward the centre). Webs are placed
 * so they stay fully inside the tile (no cut lines at tile seams).
 */

// ── Geometry (pure) ───────────────────────────────────────────────────────────

/** One line segment in tile px. */
export interface Segment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** `true` for spokes, `false` for spiral threads. */
  spoke: boolean;
}

/** Tile side in px. */
export const COBWEB_TILE = 384;

/**
 * Mulberry32 PRNG.
 * @param seed - 32-bit seed.
 * @returns Function yielding floats in [0, 1).
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Generate the cobweb segments for one tile.
 * @param size - Tile side in px.
 * @param seed - PRNG seed (same seed -> same segments).
 * @returns Segments, all inside `[0, size]` on both axes.
 */
export function cobwebSegments(size: number = COBWEB_TILE, seed = 0x5eb): Segment[] {
  const rnd = mulberry32(seed);
  const out: Segment[] = [];
  // Three webs on a loose diagonal so the tiling doesn't look like a grid.
  const slots = [
    { cx: 0.27, cy: 0.3, r: 0.22 },
    { cx: 0.72, cy: 0.62, r: 0.24 },
    { cx: 0.3, cy: 0.8, r: 0.14 },
  ];
  for (const s of slots) {
    const r = size * s.r * (0.85 + rnd() * 0.15);
    const margin = 2;
    const cx = clamp(size * s.cx + (rnd() - 0.5) * size * 0.06, r + margin, size - r - margin);
    const cy = clamp(size * s.cy + (rnd() - 0.5) * size * 0.06, r + margin, size - r - margin);
    addWeb(out, cx, cy, r, rnd);
  }
  return out;
}

function addWeb(out: Segment[], cx: number, cy: number, radius: number, rnd: () => number): void {
  const spokes = 7 + Math.floor(rnd() * 4);
  const base = rnd() * Math.PI * 2;
  const angles: number[] = [];
  const lengths: number[] = [];
  for (let i = 0; i < spokes; i++) {
    angles.push(base + ((i + (rnd() - 0.5) * 0.5) / spokes) * Math.PI * 2);
    lengths.push(radius * (0.8 + rnd() * 0.2));
  }
  for (let i = 0; i < spokes; i++) {
    const a = angles[i]!;
    const l = lengths[i]!;
    out.push({ x1: cx, y1: cy, x2: cx + Math.cos(a) * l, y2: cy + Math.sin(a) * l, spoke: true });
  }
  const rings = 4 + Math.floor(rnd() * 3);
  const SUB = 4;
  for (let k = 1; k <= rings; k++) {
    const f = (k / (rings + 0.4)) * (0.95 + rnd() * 0.05);
    for (let i = 0; i < spokes; i++) {
      const j = (i + 1) % spokes;
      const a0 = angles[i]!;
      let a1 = angles[j]!;
      if (a1 < a0) a1 += Math.PI * 2;
      const r0 = lengths[i]! * f;
      const r1 = lengths[j]! * f;
      const sag = 0.12 + rnd() * 0.1; // fraction of radius pulled toward centre at mid-thread
      let px = cx + Math.cos(a0) * r0;
      let py = cy + Math.sin(a0) * r0;
      for (let t = 1; t <= SUB; t++) {
        const u = t / SUB;
        // Straight chord point, then pulled inward by a parabola (0 at ends).
        const qx = Math.cos(a0) * r0 * (1 - u) + Math.cos(a1) * r1 * u;
        const qy = Math.sin(a0) * r0 * (1 - u) + Math.sin(a1) * r1 * u;
        const pull = 1 - sag * 4 * u * (1 - u);
        const nx = cx + qx * pull;
        const ny = cy + qy * pull;
        out.push({ x1: px, y1: py, x2: nx, y2: ny, spoke: false });
        px = nx;
        py = ny;
      }
    }
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

// ── Pattern (canvas) ──────────────────────────────────────────────────────────

/** Cobweb line styles (light grey, low alpha: must stay subtle). */
export const COBWEB_STYLE = {
  spoke: "rgba(210, 210, 210, 0.10)",
  thread: "rgba(210, 210, 210, 0.07)",
} as const;

const patterns = new WeakMap<CanvasRenderingContext2D, CanvasPattern>();
let tileCanvas: HTMLCanvasElement | null | undefined;

/**
 * The cached repeating cobweb pattern for a context (tile generated once per
 * page, pattern once per context). Screen space: use with an identity-ish
 * transform so it does not scale with zoom.
 * @param ctx - Target context.
 * @returns The pattern, or `null` when canvas is unavailable.
 */
export function cobwebPattern(ctx: CanvasRenderingContext2D): CanvasPattern | null {
  const cached = patterns.get(ctx);
  if (cached) return cached;
  if (tileCanvas === undefined) tileCanvas = renderTile();
  if (!tileCanvas) return null;
  const pattern = ctx.createPattern(tileCanvas, "repeat");
  if (pattern) patterns.set(ctx, pattern);
  return pattern;
}

function renderTile(): HTMLCanvasElement | null {
  if (typeof document === "undefined") return null;
  const tile = document.createElement("canvas");
  tile.width = tile.height = COBWEB_TILE;
  const t = tile.getContext("2d");
  if (!t) return null;
  const segs = cobwebSegments(COBWEB_TILE);
  t.lineWidth = 1;
  t.lineCap = "round";
  for (const spoke of [true, false]) {
    t.strokeStyle = spoke ? COBWEB_STYLE.spoke : COBWEB_STYLE.thread;
    t.beginPath();
    for (const s of segs) {
      if (s.spoke !== spoke) continue;
      t.moveTo(s.x1, s.y1);
      t.lineTo(s.x2, s.y2);
    }
    t.stroke();
  }
  return tile;
}
