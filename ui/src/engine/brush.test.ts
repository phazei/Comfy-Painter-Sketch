import { describe, expect, it } from "vitest";

import type { BrushDynamics } from "./brush";
import {
  createSpacer,
  curvePressure,
  dabAlpha,
  dabSize,
  normalizePressure,
  placeDabs,
  pressureSizeFactor,
  stampStops,
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
    expect(dabAlpha(0.5, { ...dyn, flow: 0.8 })).toBe(0.8);
    expect(dabAlpha(0.5, { ...dyn, flow: 0.8, pressureOpacity: true })).toBeCloseTo(0.4);
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
    expect(dabAlpha(0.5, { ...dyn, pressureOpacity: true, gamma: 2 })).toBeCloseTo(0.25);
  });
});

describe("placeDabs", () => {
  it("always stamps the first sample", () => {
    const s = createSpacer();
    expect(placeDabs(s, { x: 3, y: 4, pressure: 1 }, dyn)).toEqual([{ x: 3, y: 4, size: 10, alpha: 1 }]);
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
});

describe("stampStops", () => {
  it("keeps a soft ramp at hardness 0 and a 1px edge at hardness 1", () => {
    expect(stampStops(0, 10)).toEqual([
      [0, 1],
      [1, 0],
    ]);
    expect(stampStops(1, 10)).toEqual([
      [0, 1],
      [0.9, 1],
      [1, 0],
    ]);
    expect(stampStops(0.5, 10)).toEqual([
      [0, 1],
      [0.5, 1],
      [1, 0],
    ]);
  });
});
