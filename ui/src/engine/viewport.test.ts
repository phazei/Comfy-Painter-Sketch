import { describe, expect, it } from "vitest";

import { backingStoreSize, fitContain } from "./viewport";

describe("fitContain", () => {
  it("letterboxes a wide image top and bottom", () => {
    const fit = fitContain({ width: 200, height: 100 }, { width: 100, height: 100 });
    expect(fit).toEqual({ x: 0, y: 25, width: 100, height: 50, scale: 0.5 });
  });

  it("pillarboxes a tall image left and right", () => {
    const fit = fitContain({ width: 100, height: 400 }, { width: 300, height: 200 });
    expect(fit).toEqual({ x: 125, y: 0, width: 50, height: 200, scale: 0.5 });
  });

  it("scales small content up to fill the viewport", () => {
    const fit = fitContain({ width: 10, height: 10 }, { width: 100, height: 50 });
    expect(fit.scale).toBe(5);
    expect(fit).toMatchObject({ x: 25, y: 0, width: 50, height: 50 });
  });

  it("applies padding on every side before fitting", () => {
    const fit = fitContain({ width: 100, height: 100 }, { width: 120, height: 220 }, 10);
    expect(fit).toEqual({ x: 10, y: 60, width: 100, height: 100, scale: 1 });
  });

  it("returns an empty centered rect for degenerate sizes instead of NaN", () => {
    for (const [content, viewport] of [
      [{ width: 0, height: 10 }, { width: 100, height: 100 }],
      [{ width: 10, height: 10 }, { width: 0, height: 100 }],
      [{ width: Number.NaN, height: 10 }, { width: 100, height: 100 }],
    ] as const) {
      const fit = fitContain(content, viewport);
      expect(fit.width).toBe(0);
      expect(fit.height).toBe(0);
      expect(Number.isFinite(fit.x) && Number.isFinite(fit.y)).toBe(true);
    }
  });
});

describe("backingStoreSize", () => {
  it("multiplies layout size by devicePixelRatio and display scale", () => {
    expect(backingStoreSize({ width: 100, height: 50 }, 2, 1.5)).toEqual({
      width: 300,
      height: 150,
      ratio: 3,
    });
  });

  it("clamps the longest side while keeping aspect ratio", () => {
    const size = backingStoreSize({ width: 2000, height: 1000 }, 2, 2, 4000);
    expect(size.width).toBe(4000);
    expect(size.height).toBe(2000);
  });

  it("never returns a zero-sized store and tolerates bad ratios", () => {
    expect(backingStoreSize({ width: 0, height: 0 }, Number.NaN, 0)).toEqual({
      width: 1,
      height: 1,
      ratio: 1,
    });
  });
});
