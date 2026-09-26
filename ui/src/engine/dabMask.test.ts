import { describe, expect, it } from "vitest";

import { createSpacer, placeDabs, stampAlpha, stampProfile } from "./brush";
import type { BrushDynamics, Dab, StampProfile } from "./brush";
import { CoverageMask } from "./dabMask";
import { planSegments } from "./strokePath";

const SOFT = stampProfile(0, 40);
/** A dab at (x, 40.5): on the centre line of pixel row 40 (pixel centres are at +0.5). */
const dab = (x: number, over: Partial<Dab> = {}): Dab => ({ x, y: 40.5, size: 80, alpha: 1, cap: 1, ...over });

/** Paint dabs as one stroke batch (the first dab is a single stamp, like a stroke start). */
function paint(m: CoverageMask, dabs: readonly Dab[], profile: StampProfile = SOFT, prev: Dab | null = null): void {
  for (const seg of planSegments(prev, dabs)) m.sweep(seg, 0, 0, profile);
}

/** Dabs along a straight line from `a` to `b` (excluding `a`), `step` px apart. */
function line(a: { x: number; y: number }, b: { x: number; y: number }, step: number, size = 80): Dab[] {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const out: Dab[] = [];
  for (let s = step; s <= len + 1e-9; s += step) {
    const t = s / len;
    out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, size, alpha: 1, cap: 1 });
  }
  return out;
}

/** The model computed directly: every dab composited over, at a pixel centre. */
function overOfDabs(dabs: readonly Dab[], x: number, y: number, profile: StampProfile = SOFT): number {
  let keep = 1;
  for (const d of dabs) keep *= 1 - d.alpha * stampAlpha(Math.hypot(x + 0.5 - d.x, y + 0.5 - d.y) / (d.size / 2), profile);
  return 1 - keep;
}

describe("planSegments", () => {
  it("starts with a single stamp and merges straight, evenly spaced runs", () => {
    const segs = planSegments(null, [dab(10), dab(14), dab(18), dab(22)]);
    expect(segs.map((s) => [s.a.x, s.b.x, s.intervals])).toEqual([
      [10, 10, 0],
      [10, 22, 3],
    ]);
  });

  it("continues from the previous batch and splits at corners", () => {
    const segs = planSegments(dab(0), [dab(5), { ...dab(5), y: 45.5 }]);
    expect(segs).toHaveLength(2);
    expect(segs[0]?.a.x).toBe(0);
  });

  it("never merges past 4 radii, only evenly spaced runs, and handles coincident dabs", () => {
    const segs = planSegments(null, [dab(0, { size: 30 }), dab(40, { size: 30 }), dab(80, { size: 30 }), dab(80, { size: 30 })]);
    expect(segs.map((s) => [s.a.x, s.b.x, s.intervals])).toEqual([
      [0, 0, 0],
      [0, 40, 1],
      [40, 80, 1],
      [80, 80, 0],
    ]);
    // On the chord but not at even steps: not one run (a run would invent a dab at 30).
    const uneven = planSegments(null, [dab(0), dab(10), dab(50)]);
    expect(uneven.map((s) => [s.a.x, s.b.x, s.intervals])).toEqual([
      [0, 0, 0],
      [0, 10, 1],
      [10, 50, 1],
    ]);
  });
});

describe("colouring in", () => {
  it("scribbling over a square with a soft brush fills it solid (no cells between dabs)", () => {
    // Back-and-forth passes 20 px apart with an 80 px soft brush at 25% spacing, through the
    // real spacer so the dabs land where a pointer stroke puts them (pass ends, corners, jitter).
    const dyn: BrushDynamics = { size: 80, flow: 1, spacing: 0.25, pressureSize: false, pressureOpacity: false, minSizeRatio: 0.1, gamma: 1 };
    const m = new CoverageMask(400, 400);
    const spacer = createSpacer();
    let prev: Dab | null = null;
    let seed = 7;
    const jitter = (): number => (((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) - 0.5) * 2;
    for (let pass = 0; pass <= 15; pass++) {
      const y = 50 + pass * 20;
      const xs = pass % 2 ? [350, 50] : [50, 350];
      for (let i = 0; i <= 15; i++) {
        const x = (xs[0] as number) + (((xs[1] as number) - (xs[0] as number)) * i) / 15;
        const dabs = placeDabs(spacer, { x: x + jitter(), y: y + jitter(), pressure: 1 }, dyn);
        paint(m, dabs, SOFT, prev);
        prev = dabs[dabs.length - 1] ?? prev;
      }
    }
    let min = 1;
    for (let y = 60; y <= 340; y++) for (let x = 60; x <= 340; x++) min = Math.min(min, m.at(x, y));
    expect(min).toBeGreaterThan(0.995);
    // (Passes 30 px apart leave 1% stripes: 3 levels of 255, the same as Photoshop's model.)
  });

  it("the same with a hard brush", () => {
    const dyn: BrushDynamics = { size: 80, flow: 1, spacing: 0.25, pressureSize: false, pressureOpacity: false, minSizeRatio: 0.1, gamma: 1 };
    const m = new CoverageMask(400, 400);
    const spacer = createSpacer();
    let prev: Dab | null = null;
    for (let pass = 0; pass <= 10; pass++) {
      const y = 50 + pass * 30;
      for (const x of pass % 2 ? [350, 50] : [50, 350]) {
        const dabs = placeDabs(spacer, { x, y, pressure: 1 }, dyn);
        paint(m, dabs, stampProfile(1, 40), prev);
        prev = dabs[dabs.length - 1] ?? prev;
      }
    }
    for (let y = 60; y <= 340; y += 3) for (let x = 60; x <= 340; x += 3) expect(m.at(x, y)).toBe(1);
  });
});

describe("CoverageMask: every dab composited over (Photoshop, measured)", () => {
  it("a single dab is flow x the tip profile", () => {
    const m = new CoverageMask(120, 80);
    paint(m, [dab(60.5)]);
    expect(m.at(60, 40)).toBe(1);
    expect(m.at(82, 40)).toBeCloseTo(stampAlpha(22 / 40, SOFT), 3);
    expect(m.at(100, 40)).toBeCloseTo(0.1, 3);
    expect(m.at(119, 40)).toBeCloseTo(stampAlpha(59 / 40, SOFT), 3);
    const half = new CoverageMask(120, 80);
    paint(half, [dab(60.5, { alpha: 0.5 })]);
    expect(half.at(60, 40)).toBeCloseTo(0.5, 3);
    expect(half.at(82, 40)).toBeCloseTo(0.5 * stampAlpha(22 / 40, SOFT), 3);
  });

  it("a run is exactly the over-composite of its dabs, however it is batched", () => {
    const dabs = [dab(40), ...line({ x: 40, y: 40.5 }, { x: 200, y: 40.5 }, 20)];
    const whole = new CoverageMask(260, 80);
    paint(whole, dabs);
    const batched = new CoverageMask(260, 80);
    paint(batched, dabs.slice(0, 3));
    paint(batched, dabs.slice(3, 4), SOFT, dabs[2] ?? null);
    paint(batched, dabs.slice(4), SOFT, dabs[3] ?? null);
    for (let y = 0; y < 80; y++) {
      for (let x = 0; x < 260; x++) {
        // The `q` table interpolates the 1.5 R cutoff over its last cell (0.15% of a radius wide,
        // under 0.6% coverage there); everywhere else the model is exact.
        expect(Math.abs(whole.at(x, y) - overOfDabs(dabs, x, y))).toBeLessThan(0.006);
        expect(batched.at(x, y)).toBeCloseTo(whole.at(x, y), 3);
      }
    }
    expect(Math.abs(whole.at(100, 20) - overOfDabs(dabs, 100, 20))).toBeLessThan(0.0005);
  });

  it("matches Photoshop's measured cross-section at 25% spacing (much denser than a dab)", () => {
    // PS, 300 px soft round, 25%: coverage at d = 40, 80, 120, 160 px from the path.
    const measured: Array<[number, number]> = [[40, 0.942], [80, 0.744], [120, 0.428], [160, 0.179]];
    const m = new CoverageMask(1200, 700);
    const dabs = [
      { x: 100, y: 350.5, size: 300, alpha: 1, cap: 1 },
      ...line({ x: 100, y: 350.5 }, { x: 1100, y: 350.5 }, 75, 300),
    ];
    paint(m, dabs, stampProfile(0, 150));
    for (const [d, c] of measured) {
      expect(Math.abs(m.at(600, 350 - d) - c)).toBeLessThan(0.045);
      // And nowhere near the swept tip (the old model).
      expect(m.at(600, 350 - d)).toBeGreaterThan(stampAlpha(d / 150, SOFT) + 0.08);
    }
  });

  it("matches Photoshop's measured beading at 40% spacing", () => {
    // PS, 300 px, 40% (120 px steps): centreline dips to 0.902 between dabs;
    // at d = 100 px 0.415..0.463; at d = 150 px 0.122..0.146.
    const m = new CoverageMask(1500, 700);
    const dabs = [
      { x: 60, y: 350.5, size: 300, alpha: 1, cap: 1 },
      ...line({ x: 60, y: 350.5 }, { x: 1380, y: 350.5 }, 120, 300),
    ];
    paint(m, dabs, stampProfile(0, 150));
    const at = (x: number, d: number): number => m.at(x, 350 - d);
    expect(at(660, 0)).toBeCloseTo(1, 3);
    expect(at(720, 0)).toBeGreaterThan(0.89);
    expect(at(720, 0)).toBeLessThan(0.93);
    expect(at(660, 100)).toBeGreaterThan(0.44);
    expect(at(660, 100)).toBeLessThan(0.48);
    expect(at(720, 150)).toBeGreaterThan(0.12);
    expect(at(660, 150)).toBeLessThan(0.16);
  });

  it("crossings fill in: painting the two arms separately and compositing over gives the same", () => {
    const arm1 = [dab(40, { y: 100.5 }), ...line({ x: 40, y: 100.5 }, { x: 260, y: 100.5 }, 20)];
    const arm2 = [{ ...dab(150, { y: 20.5 }) }, ...line({ x: 150, y: 20.5 }, { x: 150, y: 180.5 }, 20)];
    const one = new CoverageMask(300, 200);
    paint(one, arm1);
    paint(one, arm2, SOFT, arm1[arm1.length - 1] ?? null);
    const a = new CoverageMask(300, 200);
    paint(a, arm1);
    const b = new CoverageMask(300, 200);
    paint(b, arm2);
    for (let y = 0; y < 200; y += 3) {
      for (let x = 0; x < 300; x += 3) {
        const over = 1 - (1 - a.at(x, y)) * (1 - b.at(x, y));
        expect(one.at(x, y)).toBeCloseTo(over, 3);
      }
    }
    // Inside the crossing's wedge: more than either arm alone (no crease).
    expect(one.at(180, 70)).toBeGreaterThan(Math.max(a.at(180, 70), b.at(180, 70)) + 0.05);
  });

  it("a Shift-click joint (spacing carried on) is pixel-identical to one continuous stroke", () => {
    const all = [dab(40), ...line({ x: 40, y: 40.5 }, { x: 240, y: 40.5 }, 20)];
    const whole = new CoverageMask(300, 80);
    paint(whole, all);
    // Stroke 1: dabs up to x = 120, ends at x = 130 (residual 10). Stroke 2 starts at 130 without a dab: next at 140.
    const first = all.slice(0, 5);
    const second = all.slice(5);
    const one = new CoverageMask(300, 80);
    paint(one, first);
    const two = new CoverageMask(300, 80);
    paint(two, second, SOFT, { ...dab(130) });
    for (let x = 0; x < 300; x += 2) {
      for (const y of [40, 20, 5]) expect(1 - (1 - one.at(x, y)) * (1 - two.at(x, y))).toBeCloseTo(whole.at(x, y), 3);
    }
  });

  it("low flow builds up over repeated passes, exactly 1 - (1 - a)^n at the centre", () => {
    const m = new CoverageMask(80, 80);
    for (let n = 1; n <= 5; n++) {
      paint(m, [dab(40, { alpha: 0.2 })]);
      expect(m.at(40, 40)).toBeCloseTo(1 - 0.8 ** n, 3);
    }
  });

  it("pressure -> opacity caps the coverage and never lowers it", () => {
    const m = new CoverageMask(80, 80);
    paint(m, [dab(40, { cap: 0.4 })]);
    expect(m.at(40, 40)).toBeCloseTo(0.4, 3);
    paint(m, [dab(40, { cap: 0.4 })]);
    expect(m.at(40, 40)).toBeCloseTo(0.4, 3);
    paint(m, [dab(40, { cap: 0.7 })]);
    expect(m.at(40, 40)).toBeCloseTo(0.7, 3);
    paint(m, [dab(40, { cap: 0.2 })]);
    expect(m.at(40, 40)).toBeCloseTo(0.7, 3);
  });

  it("thins runs under 5% spacing without changing the look", () => {
    const exact = new CoverageMask(400, 80);
    const fine = [dab(40), ...line({ x: 40, y: 40.5 }, { x: 360, y: 40.5 }, 4)];
    paint(exact, fine);
    for (const [x, y] of [[200, 40], [200, 20], [200, 5], [60, 40], [350, 30]] as const) {
      expect(exact.at(x, y)).toBeCloseTo(overOfDabs(fine, x, y), 2);
    }
    // Even at 1%: the profile still builds up smoothly (bounded cost, same result).
    const dense = [dab(40), ...line({ x: 40, y: 40.5 }, { x: 360, y: 40.5 }, 0.8)];
    const thin = new CoverageMask(400, 80);
    paint(thin, dense);
    for (const [x, y] of [[200, 40], [200, 20], [200, 5], [350, 30]] as const) {
      expect(thin.at(x, y)).toBeCloseTo(overOfDabs(dense, x, y), 2);
    }
  });

  it("hard brushes get a 1 px antialiased edge on the ring", () => {
    const m = new CoverageMask(120, 80);
    paint(m, [dab(60.5)], stampProfile(1, 40));
    expect(m.at(60, 40)).toBe(1);
    expect(m.at(99, 40)).toBe(1);
    // The pixel centred on the ring (d = 40) is about half covered; one px out is gone.
    expect(m.at(100, 40)).toBeGreaterThan(0.4);
    expect(m.at(100, 40)).toBeLessThan(0.7);
    expect(m.at(101, 40)).toBeLessThan(0.01);
  });

  it("writes one colour with alpha = coverage, rebases and clears", () => {
    const m = new CoverageMask(80, 80);
    paint(m, [dab(40.5)]);
    const out = new Uint8ClampedArray(4);
    m.writeRgba({ x: 40, y: 40, width: 1, height: 1 }, { r: 90, g: 60, b: 60 }, out);
    expect([...out]).toEqual([90, 60, 60, 255]);
    const moved = m.rebased({ x: 0, y: 0, width: 80, height: 80 }, { x: -10, y: 0, width: 90, height: 80 });
    expect(moved.at(50, 40)).toBe(1);
    moved.clear({ x: 0, y: 0, width: 90, height: 80 });
    expect(moved.at(50, 40)).toBe(0);
  });
});
