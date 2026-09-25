import { describe, expect, it } from "vitest";

import { coverageAt } from "./selection";
import { wandSelection } from "./wand";

/** 6x4 RGBA: red left half (x < 3), blue right half, plus a red pixel at (5, 3). */
function pixels(): Uint8ClampedArray {
  const w = 6;
  const h = 4;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const red = x < 3 || (x === 5 && y === 3);
      data.set(red ? [255, 0, 0, 255] : [0, 0, 255, 255], (y * w + x) * 4);
    }
  }
  return data;
}

const hard = { tolerance: 32, contiguous: true, antiAlias: false };

describe("wandSelection", () => {
  it("maps flood-fill coverage into document coords (area offset)", () => {
    const area = { x: -10, y: 20, width: 6, height: 4 };
    const sel = wandSelection(pixels(), area, { x: -9.5, y: 21.2 }, hard);
    expect(sel?.rect).toEqual({ x: -10, y: 20, width: 3, height: 4 });
    expect(coverageAt(sel, -8, 23)).toBe(255);
    expect(coverageAt(sel, -7, 20)).toBe(0);
  });

  it("non-contiguous also picks the isolated match", () => {
    const area = { x: 0, y: 0, width: 6, height: 4 };
    const sel = wandSelection(pixels(), area, { x: 0, y: 0 }, { ...hard, contiguous: false });
    expect(coverageAt(sel, 5, 3)).toBe(255);
    expect(sel?.rect).toEqual({ x: 0, y: 0, width: 6, height: 4 });
  });

  it("anti-alias adds a soft fringe", () => {
    const area = { x: 0, y: 0, width: 6, height: 4 };
    const sel = wandSelection(pixels(), area, { x: 0, y: 0 }, { ...hard, antiAlias: true });
    const fringe = coverageAt(sel, 3, 1);
    expect(fringe).toBeGreaterThan(0);
    expect(fringe).toBeLessThan(255);
  });

  it("outside the area selects nothing", () => {
    expect(wandSelection(pixels(), { x: 0, y: 0, width: 6, height: 4 }, { x: 7, y: 1 }, hard)).toBeNull();
  });
});
