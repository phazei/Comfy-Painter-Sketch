import { describe, expect, it } from "vitest";

import type { BrushDynamics } from "./brush";
import {
  FADE_CUTOFF,
  createSpacer,
  curvePressure,
  dabAlpha,
  dabBounds,
  dabCap,
  dabSize,
  normalizePressure,
  placeDabs,
  pressureSizeFactor,
  ringDiameter,
  stampAlpha,
  stampProfile,
} from "./brush";

const dyn: BrushDynamics = {
  size: 10,
  flow: 1,
  spacing: 0.25,
  pressureSize: false,
  pressureOpacity: false,
  minSizeRatio: 0,
  gamma: 1,
};

describe("pressure", () => {
  it("treats mouse and touch as full pressure, clamps pens", () => {
    expect(normalizePressure("mouse", 0.5)).toBe(1);
    expect(normalizePressure("touch", 0)).toBe(1);
    expect(normalizePressure("pen", 0.3)).toBe(0.3);
    expect(normalizePressure("pen", 2)).toBe(1);
  });

  it("maps pressure to size and alpha only when enabled", () => {
    expect(dabSize(0.5, dyn)).toBe(10);
    expect(dabSize(0.5, { ...dyn, pressureSize: true })).toBe(5);
    expect(dabSize(0, { ...dyn, pressureSize: true, minSizeRatio: 0.2 })).toBe(2);
    expect(dabSize(0.5, { ...dyn, pressureSize: true, gamma: 2 })).toBe(2.5);
    expect(dabAlpha({ ...dyn, flow: 0.8 })).toBe(0.8);
    expect(dabCap(0.5, { ...dyn, flow: 0.8 })).toBe(1);
    expect(dabCap(0.5, { ...dyn, flow: 0.8, pressureOpacity: true })).toBeCloseTo(0.5);
  });
});

describe("pressure curve", () => {
  it("maps zero pressure to the min size and full pressure to 1", () => {
    expect(pressureSizeFactor(0, 0.25, 1)).toBe(0.25);
    expect(pressureSizeFactor(1, 0.25, 2)).toBe(1);
    expect(pressureSizeFactor(0.5, 0.2, 1)).toBeCloseTo(0.6);
  });

  it("bends the curve with gamma (> 1 softer start, < 1 harder start)", () => {
    expect(pressureSizeFactor(0.5, 0, 2)).toBeCloseTo(0.25);
    expect(pressureSizeFactor(0.25, 0, 0.5)).toBeCloseTo(0.5);
    expect(curvePressure(0.5, 1)).toBe(0.5);
  });

  it("clamps inputs and falls back to linear on invalid gamma", () => {
    expect(pressureSizeFactor(2, -1, 1)).toBe(1);
    expect(pressureSizeFactor(0, 3, 1)).toBe(1);
    expect(pressureSizeFactor(0.5, Number.NaN, 0)).toBe(0.5);
    expect(curvePressure(0.5, Number.NaN)).toBe(0.5);
  });

  it("applies gamma to pressure -> opacity too", () => {
    expect(dabCap(0.5, { ...dyn, pressureOpacity: true, gamma: 2 })).toBeCloseTo(0.25);
  });
});

describe("placeDabs", () => {
  it("always stamps the first sample", () => {
    const s = createSpacer();
    expect(placeDabs(s, { x: 3, y: 4, pressure: 1 }, dyn)).toEqual([{ x: 3, y: 4, size: 10, alpha: 1, cap: 1 }]);
  });

  it("spaces dabs by distance and carries the remainder across samples", () => {
    const s = createSpacer();
    placeDabs(s, { x: 0, y: 0, pressure: 1 }, dyn);
    const a = placeDabs(s, { x: 6, y: 0, pressure: 1 }, dyn);
    expect(a.map((d) => d.x)).toEqual([2.5, 5]);
    const b = placeDabs(s, { x: 10, y: 0, pressure: 1 }, dyn);
    expect(b.map((d) => d.x)).toEqual([7.5, 10]);
  });

  it("produces ~length/step dabs over a long segment and none for zero length", () => {
    const s = createSpacer();
    placeDabs(s, { x: 0, y: 0, pressure: 1 }, dyn);
    expect(placeDabs(s, { x: 100, y: 0, pressure: 1 }, dyn)).toHaveLength(40);
    expect(placeDabs(s, { x: 100, y: 0, pressure: 1 }, dyn)).toHaveLength(0);
  });

  it("interpolates pressure along the segment", () => {
    const s = createSpacer();
    const d = { ...dyn, pressureSize: true, spacing: 1 };
    placeDabs(s, { x: 0, y: 0, pressure: 1 }, d);
    const dabs = placeDabs(s, { x: 20, y: 0, pressure: 0.5 }, d);
    expect(dabs[0]?.x).toBe(10);
    expect(dabs[0]?.size).toBeCloseTo(7.5);
  });

  it("started from a point (Shift-click line) places no dab there and carries the residual on", () => {
    // The previous stroke's last dab was 1 px before its end: the next dab comes 1.5 px in, not 2.5.
    const s = createSpacer({ x: 0, y: 0, pressure: 1 }, 1);
    expect(placeDabs(s, { x: 6, y: 0, pressure: 1 }, dyn).map((d) => d.x)).toEqual([1.5, 4]);
    expect(createSpacer({ x: 0, y: 0, pressure: 1 }).residual).toBe(0);
  });
});

describe("stampProfile (measured from Photoshop)", () => {
  it("soft round: 10^-(d/R)^2, 10% at the ring, 50% at 0.55 R, cut off at 1.5 R", () => {
    const p = stampProfile(0, 150);
    expect(p).toEqual({ core: 0, fade: 1, reach: FADE_CUTOFF });
    expect(stampAlpha(0, p)).toBe(1);
    expect(stampAlpha(0.55, p)).toBeCloseTo(0.5, 1);
    expect(stampAlpha(1, p)).toBeCloseTo(0.1, 6);
    expect(stampAlpha(1.4, p)).toBeCloseTo(0.011, 3);
    expect(stampAlpha(1.5, p)).toBe(0);
    // Against the measured dot (300 px, r -> coverage), within 1/255.
    const measured: Array<[number, number]> = [[0.1, 0.976], [0.3, 0.81], [0.5, 0.563], [0.7, 0.324], [0.9, 0.153], [1.2, 0.036]];
    for (const [u, c] of measured) expect(Math.abs(stampAlpha(u, p) - c)).toBeLessThan(1 / 255);
  });

  it("hardness keeps a solid core and squeezes the fade into the rest; 100% is a 1 px edge on the ring", () => {
    const half = stampProfile(0.5, 40);
    expect(half.core).toBe(0.5);
    expect(half.fade).toBe(0.5);
    expect(stampAlpha(0.5, half)).toBe(1);
    expect(stampAlpha(1, half)).toBeCloseTo(0.1, 6);
    expect(stampAlpha(1.25, half)).toBe(0);
    const hard = stampProfile(1, 40);
    expect(hard.fade).toBeCloseTo(1 / 40);
    expect(hard.reach * 40).toBeCloseTo(41);
    expect(stampAlpha(1 - 1 / 40, hard)).toBe(1);
    expect(stampAlpha(1, hard)).toBeCloseTo(0.56, 1);
    expect(stampAlpha(1 + 1 / 40, hard)).toBeLessThan(0.01);
  });

  it("the cursor ring shrinks with softness: 0.77 of the size when soft (PS: 230 px for 300 px), the full size when hard", () => {
    expect(ringDiameter(300, 0)).toBeCloseTo(231, 0);
    expect(ringDiameter(80, 0)).toBeCloseTo(61.6, 1);
    expect(ringDiameter(80, 0.5)).toBeCloseTo(70.8, 1);
    expect(ringDiameter(80, 1)).toBeCloseTo(80, 0);
  });

  it("dab bounds cover the reach plus a margin", () => {
    const r = dabBounds({ x: 0, y: 0, size: 80, alpha: 1, cap: 1 }, 1.5);
    expect(r).toEqual({ x: -62, y: -62, width: 124, height: 124 });
  });
});
