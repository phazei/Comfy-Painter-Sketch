import { describe, expect, it } from "vitest";
import {
  AA_PAD,
  arrowHeadPolygon,
  boxFromDrag,
  crispRect,
  headLength,
  isDrawableShape,
  lineGeometry,
  shapeBounds,
  snapAngle,
} from "./shapes";
import type { BoxShape, LineShape } from "./shapes";

const line = (over: Partial<LineShape> = {}): LineShape => ({
  kind: "line",
  from: { x: 0, y: 0 },
  to: { x: 100, y: 0 },
  width: 4,
  heads: "none",
  headRatio: 4,
  color: "#000000",
  ...over,
});

const box = (over: Partial<BoxShape> = {}): BoxShape => ({
  kind: "rect",
  rect: { x: 10, y: 20, width: 30, height: 40 },
  paint: "stroke",
  strokeWidth: 4,
  strokeColor: "#000000",
  fillColor: "#ffffff",
  ...over,
});

describe("snapAngle", () => {
  it("snaps to the nearest 15 degrees and keeps the length", () => {
    const end = snapAngle({ x: 0, y: 0 }, { x: 100, y: 10 });
    expect(end.x).toBeCloseTo(Math.hypot(100, 10));
    expect(end.y).toBe(0);
    const diag = snapAngle({ x: 10, y: 10 }, { x: 60, y: 58 });
    expect(diag.x - 10).toBeCloseTo(diag.y - 10);
  });

  it("snaps to vertical and to 15 degree steps", () => {
    const up = snapAngle({ x: 0, y: 0 }, { x: 3, y: -50 });
    expect(up.x).toBe(0);
    expect(up.y).toBeCloseTo(-Math.hypot(3, 50));
    const e = snapAngle({ x: 0, y: 0 }, { x: 100, y: 25 });
    expect((Math.atan2(e.y, e.x) * 180) / Math.PI).toBeCloseTo(15);
  });

  it("leaves a zero-length segment alone", () => {
    expect(snapAngle({ x: 5, y: 5 }, { x: 5, y: 5 })).toEqual({ x: 5, y: 5 });
  });
});

describe("boxFromDrag", () => {
  it("normalizes any drag direction", () => {
    expect(boxFromDrag({ x: 50, y: 50 }, { x: 10, y: 30 }, false, false)).toEqual({ x: 10, y: 30, width: 40, height: 20 });
  });

  it("Shift makes a square using the larger side, towards the pointer", () => {
    expect(boxFromDrag({ x: 50, y: 50 }, { x: 10, y: 60 }, true, false)).toEqual({ x: 10, y: 50, width: 40, height: 40 });
  });

  it("Alt draws from the centre; Shift+Alt a centred square", () => {
    expect(boxFromDrag({ x: 50, y: 50 }, { x: 60, y: 45 }, false, true)).toEqual({ x: 40, y: 45, width: 20, height: 10 });
    expect(boxFromDrag({ x: 50, y: 50 }, { x: 60, y: 45 }, true, true)).toEqual({ x: 40, y: 40, width: 20, height: 20 });
  });
});

describe("crispRect", () => {
  it("rounds to whole pixels and centres odd strokes on pixel centres", () => {
    expect(crispRect({ x: 1.4, y: 2.6, width: 10.2, height: 5 }, 2)).toEqual({ x: 1, y: 3, width: 11, height: 5 });
    expect(crispRect({ x: 1, y: 2, width: 10, height: 5 }, 3)).toEqual({ x: 1.5, y: 2.5, width: 10, height: 5 });
    expect(crispRect({ x: 1, y: 2, width: 10, height: 5 }, 0)).toEqual({ x: 1, y: 2, width: 10, height: 5 });
  });
});

describe("arrowheads", () => {
  it("builds a triangle pointing at the tip", () => {
    const [tip, left, right] = arrowHeadPolygon({ x: 100, y: 0 }, { x: 0, y: 0 }, 20);
    expect(tip).toEqual({ x: 100, y: 0 });
    expect(left?.x).toBeCloseTo(80);
    expect(right?.x).toBeCloseTo(80);
    expect(Math.abs((left?.y ?? 0) - (right?.y ?? 0))).toBeCloseTo(16);
  });

  it("returns no polygon for a degenerate line", () => {
    expect(arrowHeadPolygon({ x: 1, y: 1 }, { x: 1, y: 1 }, 10)).toEqual([]);
  });

  it("scales heads with the width and shrinks them on short lines", () => {
    expect(headLength(4, 4, 100, 1)).toBe(16);
    expect(headLength(4, 4, 10, 1)).toBeCloseTo(9);
    expect(headLength(4, 4, 10, 2)).toBeCloseTo(4.5);
    expect(headLength(4, 4, 100, 0)).toBe(0);
  });

  it("stops the shaft at the head base", () => {
    const end = lineGeometry(line({ heads: "end" }));
    expect(end?.heads).toHaveLength(1);
    expect(end?.shaft?.[1].x).toBeCloseTo(84);
    const both = lineGeometry(line({ heads: "both" }));
    expect(both?.heads).toHaveLength(2);
    expect(both?.shaft?.[0].x).toBeCloseTo(16);
    expect(both?.shaft?.[1].x).toBeCloseTo(84);
    const plain = lineGeometry(line());
    expect(plain?.heads).toHaveLength(0);
    expect(plain?.shaft?.[1]).toEqual({ x: 100, y: 0 });
  });

  it("has no geometry for zero-length lines", () => {
    expect(lineGeometry(line({ to: { x: 0, y: 0 } }))).toBeNull();
    expect(isDrawableShape(line({ to: { x: 0, y: 0 } }))).toBe(false);
  });
});

describe("shapeBounds", () => {
  it("pads a line by half its width (round caps) plus AA", () => {
    const pad = 2 + AA_PAD;
    expect(shapeBounds(line())).toEqual({ x: -pad, y: -pad, width: 100 + pad * 2, height: pad * 2 });
  });

  it("covers arrowheads wider than the line", () => {
    const r = shapeBounds(line({ heads: "end" }));
    expect(r.y).toBeCloseTo(-6.4 - AA_PAD);
    expect(r.x + r.width).toBeCloseTo(100 + AA_PAD);
  });

  it("pads stroked boxes by half the stroke, fills by AA only", () => {
    expect(shapeBounds(box())).toEqual({ x: 7, y: 17, width: 36, height: 46 });
    expect(shapeBounds(box({ paint: "fill" }))).toEqual({ x: 9, y: 19, width: 32, height: 42 });
    expect(shapeBounds(box({ kind: "ellipse", strokeWidth: 3 }))).toEqual({ x: 7.5, y: 17.5, width: 35, height: 45 });
  });

  it("is empty for zero-size boxes", () => {
    expect(shapeBounds(box({ rect: { x: 5, y: 5, width: 0, height: 10 } })).width).toBe(0);
  });
});
