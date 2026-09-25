import { describe, expect, it } from "vitest";

import { coverageAt } from "./selection";
import { ellipseSelection, polygonSelection } from "./selectionRaster";

describe("ellipseSelection", () => {
  it("covers the inside fully, the outside not at all, with a soft edge", () => {
    const sel = ellipseSelection({ x: 0, y: 0, width: 20, height: 20 });
    expect(sel?.rect).toEqual({ x: 0, y: 0, width: 20, height: 20 });
    expect(coverageAt(sel, 10, 10)).toBe(255);
    expect(coverageAt(sel, 0, 0)).toBe(0);
    expect(coverageAt(sel, 19, 19)).toBe(0);
    // Pixels crossed by the edge are partial (anti-aliased).
    const edge = [coverageAt(sel, 0, 7), coverageAt(sel, 2, 2), coverageAt(sel, 7, 0)];
    for (const c of edge) {
      expect(c).toBeGreaterThan(0);
      expect(c).toBeLessThan(255);
    }
  });

  it("is symmetric and its total coverage matches the ellipse area", () => {
    const sel = ellipseSelection({ x: 2, y: 3, width: 30, height: 16 });
    if (!sel) throw new Error("empty");
    let sum = 0;
    for (const c of sel.data) sum += c;
    expect(sum / 255).toBeCloseTo(Math.PI * 15 * 8, 0);
    expect(coverageAt(sel, 2, 11)).toBe(coverageAt(sel, 31, 11));
    expect(coverageAt(sel, 10, 3)).toBe(coverageAt(sel, 10, 18));
  });

  it("returns null for an empty box", () => {
    expect(ellipseSelection({ x: 4, y: 4, width: 0, height: 10 })).toBeNull();
  });
});

describe("polygonSelection", () => {
  it("an integer square is hard-edged", () => {
    const sel = polygonSelection([
      { x: 1, y: 1 },
      { x: 5, y: 1 },
      { x: 5, y: 4 },
      { x: 1, y: 4 },
    ]);
    expect(sel?.rect).toEqual({ x: 1, y: 1, width: 4, height: 3 });
    expect([...(sel?.data ?? [])].every((c) => c === 255)).toBe(true);
  });

  it("a half-pixel edge gives half coverage", () => {
    const sel = polygonSelection([
      { x: 0, y: 0 },
      { x: 2.5, y: 0 },
      { x: 2.5, y: 2 },
      { x: 0, y: 2 },
    ]);
    expect(coverageAt(sel, 1, 1)).toBe(255);
    expect(coverageAt(sel, 2, 1)).toBe(128);
  });

  it("anti-aliases a diagonal and ignores winding direction", () => {
    const cw = polygonSelection([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 0, y: 10 },
    ]);
    const ccw = polygonSelection([
      { x: 0, y: 0 },
      { x: 0, y: 10 },
      { x: 10, y: 0 },
    ]);
    // Pixel (4, 5) is cut through its corners by x + y = 10: half covered.
    expect(coverageAt(cw, 4, 5)).toBeGreaterThan(100);
    expect(coverageAt(cw, 4, 5)).toBeLessThan(155);
    expect(coverageAt(cw, 1, 1)).toBe(255);
    expect(coverageAt(cw, 8, 8)).toBe(0);
    expect(cw?.data).toEqual(ccw?.data);
  });

  it("degenerate input selects nothing", () => {
    expect(polygonSelection([{ x: 0, y: 0 }, { x: 5, y: 5 }])).toBeNull();
    expect(polygonSelection([{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 9, y: 0 }])).toBeNull();
  });
});
