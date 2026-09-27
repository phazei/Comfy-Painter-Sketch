import { describe, expect, it } from "vitest";

import { isPlainClick } from "../../ui/webClick";
import { CobwebBackdrop, workerSupported } from "./cobwebBackdrop";
import { CobwebCore, wrapAngle } from "./cobwebCore";
import { COBWEB_DEFAULTS, genExtent, mergeCobwebOptions } from "./cobwebOptions";
import { CobwebRaster, makeCanvas } from "./cobwebRaster";

/** Smaller web so tests stay fast. */
const small = (seed: number) => mergeCobwebOptions(COBWEB_DEFAULTS, { seed, maxNodes: 12000, maxTips: 400 });

function grown(seed: number, aspect = 1.5): CobwebCore {
  const core = new CobwebCore(small(seed), aspect);
  core.grow(Infinity);
  return core;
}

describe("CobwebCore", () => {
  it("is deterministic per seed", () => {
    const a = grown(7);
    const b = grown(7);
    const c = grown(8);
    expect(a.segs).toEqual(b.segs);
    expect(a.drapes.length).toBe(b.drapes.length);
    expect(a.segs).not.toEqual(c.segs);
  });

  it("finishes and keeps every segment endpoint outside the rect", () => {
    for (const aspect of [0.5, 1, 2]) {
      const core = grown(3, aspect);
      expect(core.done).toBe(true);
      const { gw, gh } = genExtent(COBWEB_DEFAULTS.genSize, aspect);
      let count = 0;
      for (const bucket of core.segs) {
        for (let i = 0; i < bucket.length; i += 2) {
          const x = bucket[i]!;
          const y = bucket[i + 1]!;
          expect(x > 0 && x < gw && y > 0 && y < gh).toBe(false);
          expect(core.dist(x, y)).toBeLessThanOrEqual(COBWEB_DEFAULTS.margin + 1);
          count++;
        }
      }
      expect(count).toBeGreaterThan(1000);
    }
  });

  it("drapes only forks within maxAngle", () => {
    const limit = (COBWEB_DEFAULTS.drape.maxAngle * Math.PI) / 180;
    for (const maxAngle of [COBWEB_DEFAULTS.drape.maxAngle, 40]) {
      const core = new CobwebCore(mergeCobwebOptions(COBWEB_DEFAULTS, { seed: 5, drape: { maxAngle } }), 1);
      core.grow(Infinity);
      expect(core.drapes.length).toBeGreaterThan(0);
      for (const d of core.drapes) {
        const A = d.a[d.a.length - 1]!;
        const B = d.b[d.b.length - 1]!;
        const ang = Math.abs(wrapAngle(Math.atan2(A.y - d.o.y, A.x - d.o.x) - Math.atan2(B.y - d.o.y, B.x - d.o.x)));
        expect(ang).toBeLessThanOrEqual(Math.min(limit, (maxAngle * Math.PI) / 180) + 1e-9);
        expect(d.a.length).toBe(d.b.length);
      }
    }
  });

  it("uses the user's drape settings", () => {
    expect(COBWEB_DEFAULTS.drape.maxAngle).toBe(160);
    expect(COBWEB_DEFAULTS.drape.length * COBWEB_DEFAULTS.step).toBeCloseTo(80, -1);
    expect(COBWEB_DEFAULTS.drape.start).toBe(0.03);
    expect(COBWEB_DEFAULTS.drape.ramp).toBe(0.12);
  });
});

describe("canvas / worker guards", () => {
  it("creates no canvas or worker without browser support", () => {
    expect(makeCanvas(10, 10)).toBeNull();
    expect(CobwebRaster.create(new CobwebCore(small(1), 1), 1, 1, { x0: 0, y0: 0, x1: 10, y1: 10 })).toBeNull();
    expect(workerSupported()).toBe(false);
    const web = new CobwebBackdrop(() => undefined);
    web.dispose();
    web.dispose();
  });
});

describe("isPlainClick", () => {
  it("accepts small, short presses only", () => {
    expect(isPlainClick({ x: 0, y: 0, t: 0 }, { x: 2, y: 2, t: 100 })).toBe(true);
    expect(isPlainClick({ x: 0, y: 0, t: 0 }, { x: 10, y: 0, t: 100 })).toBe(false);
    expect(isPlainClick({ x: 0, y: 0, t: 0 }, { x: 0, y: 0, t: 2000 })).toBe(false);
  });
});
