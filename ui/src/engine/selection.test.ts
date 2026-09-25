import { describe, expect, it } from "vitest";

import {
  clipSelection,
  combineSelection,
  coverageAt,
  coverageFor,
  eraseCoverage,
  invertSelection,
  rectSelection,
  selectionExtent,
  selectionFromCoverage,
  selectionMode,
  selectionsEqual,
  snapRect,
} from "./selection";
import type { Selection } from "./selection";

const rect = (x: number, y: number, width: number, height: number): Selection => {
  const sel = rectSelection({ x, y, width, height });
  if (!sel) throw new Error("empty rect");
  return sel;
};

/** Selected pixels (coverage >= 128) inside an area, as "x,y" strings. */
function pixels(sel: Selection | null, area = { x: -2, y: -2, width: 16, height: 16 }): string[] {
  const out: string[] = [];
  for (let y = area.y; y < area.y + area.height; y++) {
    for (let x = area.x; x < area.x + area.width; x++) if (coverageAt(sel, x, y) >= 128) out.push(`${x},${y}`);
  }
  return out;
}

describe("modes", () => {
  it("maps Photoshop modifiers", () => {
    expect(selectionMode(false, false)).toBe("replace");
    expect(selectionMode(true, false)).toBe("add");
    expect(selectionMode(false, true)).toBe("subtract");
    expect(selectionMode(true, true)).toBe("intersect");
  });
});

describe("rect rasterization", () => {
  it("snaps edges to whole pixels (pixel centres inside, AA off)", () => {
    expect(snapRect({ x: 1.4, y: 2.6, width: 2.2, height: 1 })).toEqual({ x: 1, y: 3, width: 3, height: 1 });
    const sel = rect(1.4, 2.6, 2.2, 1);
    expect([...sel.data]).toEqual([255, 255, 255]);
    expect(sel.outside).toBe(0);
  });

  it("returns null for a box that covers no pixel centre", () => {
    expect(rectSelection({ x: 1.1, y: 1, width: 0.3, height: 5 })).toBeNull();
  });
});

describe("combine", () => {
  const a = rect(0, 0, 4, 4);
  const b = rect(2, 2, 4, 4);

  it("replace takes the new coverage", () => {
    expect(combineSelection(a, b, "replace")).toBe(b);
    expect(combineSelection(a, null, "replace")).toBeNull();
  });

  it("add = union", () => {
    const sel = combineSelection(a, b, "add");
    expect(sel?.rect).toEqual({ x: 0, y: 0, width: 6, height: 6 });
    expect(pixels(sel)).toHaveLength(16 + 16 - 4);
  });

  it("subtract removes the overlap and trims", () => {
    const sel = combineSelection(a, rect(0, 2, 4, 2), "subtract");
    expect(sel?.rect).toEqual({ x: 0, y: 0, width: 4, height: 2 });
    expect(pixels(sel)).toHaveLength(8);
  });

  it("intersect keeps the overlap only", () => {
    const sel = combineSelection(a, b, "intersect");
    expect(sel?.rect).toEqual({ x: 2, y: 2, width: 2, height: 2 });
  });

  it("an empty result is no selection", () => {
    expect(combineSelection(a, rect(0, 0, 4, 4), "subtract")).toBeNull();
    expect(combineSelection(a, rect(10, 10, 2, 2), "intersect")).toBeNull();
  });

  it("modes without a current selection", () => {
    expect(combineSelection(null, b, "add")).toEqual(b);
    expect(combineSelection(null, b, "subtract")).toBeNull();
    expect(combineSelection(null, b, "intersect")).toBeNull();
    expect(combineSelection(a, null, "add")).toBe(a);
  });

  it("uses min/max for soft coverage", () => {
    const soft: Selection = { rect: { x: 0, y: 0, width: 2, height: 1 }, data: Uint8Array.from([100, 200]), outside: 0 };
    const other: Selection = { rect: { x: 0, y: 0, width: 2, height: 1 }, data: Uint8Array.from([150, 50]), outside: 0 };
    expect([...(combineSelection(soft, other, "add")?.data ?? [])]).toEqual([150, 200]);
    expect([...(combineSelection(soft, other, "intersect")?.data ?? [])]).toEqual([100, 50]);
    expect([...(combineSelection(soft, other, "subtract")?.data ?? [])]).toEqual([100, 200]);
  });
});

describe("invert", () => {
  it("selects everything outside, also beyond the old rect", () => {
    const inv = invertSelection(rect(2, 2, 2, 2));
    expect(inv?.outside).toBe(255);
    expect(coverageAt(inv, 2, 2)).toBe(0);
    expect(coverageAt(inv, 1, 2)).toBe(255);
    expect(coverageAt(inv, 500, -500)).toBe(255);
  });

  it("round-trips", () => {
    const sel = combineSelection(rect(0, 0, 4, 4), rect(2, 2, 4, 4), "add");
    expect(selectionsEqual(invertSelection(invertSelection(sel)), sel)).toBe(true);
  });

  it("no selection stays none", () => {
    expect(invertSelection(null)).toBeNull();
  });

  it("combines with an inverted selection", () => {
    const inv = invertSelection(rect(0, 0, 4, 4));
    const sel = combineSelection(inv, rect(-2, 0, 4, 1), "intersect");
    expect(sel?.outside).toBe(0);
    expect(pixels(sel)).toEqual(["-2,0", "-1,0"]);
  });
});

describe("coverage + extent", () => {
  it("coverageFor fills outside and copies the overlap", () => {
    const cov = coverageFor(rect(1, 0, 1, 1), { x: 0, y: 0, width: 3, height: 1 });
    expect([...cov]).toEqual([0, 255, 0]);
    const inv = coverageFor(invertSelection(rect(1, 0, 1, 1)) as Selection, { x: 0, y: 0, width: 3, height: 1 });
    expect([...inv]).toEqual([255, 0, 255]);
  });

  it("extent is the bbox, or the whole area when inverted", () => {
    const area = { x: 0, y: 0, width: 10, height: 10 };
    expect(selectionExtent(rect(2, 3, 4, 5), area)).toEqual({ x: 2, y: 3, width: 4, height: 5 });
    expect(selectionExtent(invertSelection(rect(2, 3, 4, 5)) as Selection, area)).toEqual(area);
  });

  it("clip restricts to a rect (inverted -> finite)", () => {
    const clipped = clipSelection(invertSelection(rect(0, 0, 2, 2)), { x: 0, y: 0, width: 3, height: 2 });
    expect(clipped?.outside).toBe(0);
    expect(pixels(clipped)).toEqual(["2,0", "2,1"]);
  });

  it("builds a trimmed selection from flood-fill style coverage", () => {
    const cov = new Uint8Array(16);
    cov[5] = 255;
    cov[6] = 128;
    const sel = selectionFromCoverage(cov, { x: 10, y: 20, width: 4, height: 4 });
    expect(sel?.rect).toEqual({ x: 11, y: 21, width: 2, height: 1 });
    expect([...(sel?.data ?? [])]).toEqual([255, 128]);
    expect(selectionFromCoverage(new Uint8Array(16), { x: 0, y: 0, width: 4, height: 4 })).toBeNull();
  });
});

describe("eraseCoverage", () => {
  it("scales alpha by 1 - coverage", () => {
    const px = Uint8ClampedArray.from([10, 20, 30, 255, 10, 20, 30, 200]);
    eraseCoverage(px, { x: 0, y: 0, width: 2, height: 1 }, Uint8Array.from([255, 0]), 2);
    expect([...px]).toEqual([10, 20, 30, 0, 10, 20, 30, 200]);
  });
});
