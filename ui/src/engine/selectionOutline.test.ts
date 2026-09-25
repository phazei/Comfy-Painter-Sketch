import { describe, expect, it } from "vitest";

import { combineSelection, invertSelection, rectSelection, selectionFromCoverage } from "./selection";
import type { Selection } from "./selection";
import { outlineContours } from "./selectionOutline";
import type { Contour } from "./selectionOutline";

/** Contours as arrays of "x,y" corners. */
function corners(contours: Contour[]): string[][] {
  return contours.map((c) => {
    const out: string[] = [];
    for (let i = 0; i < c.length; i += 2) out.push(`${c[i]},${c[i + 1]}`);
    return out;
  });
}

/** Total outline length (contours are closed, axis-aligned). */
function length(contours: Contour[]): number {
  let total = 0;
  for (const c of contours) {
    const n = c.length / 2;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      total += Math.abs((c[j * 2] as number) - (c[i * 2] as number)) + Math.abs((c[j * 2 + 1] as number) - (c[i * 2 + 1] as number));
    }
  }
  return total;
}

/** Selection from an ASCII grid ('#' selected) at the origin. */
function fromGrid(rows: string[]): Selection {
  const width = rows[0]?.length ?? 0;
  const data = new Uint8Array(width * rows.length);
  rows.forEach((row, y) => [...row].forEach((ch, x) => (data[y * width + x] = ch === "#" ? 255 : 0)));
  const sel = selectionFromCoverage(data, { x: 0, y: 0, width, height: rows.length });
  if (!sel) throw new Error("empty grid");
  return sel;
}

describe("outlineContours", () => {
  it("a rectangle is one contour of 4 corners", () => {
    expect(corners(outlineContours(rectSelection({ x: 1, y: 2, width: 3, height: 4 }) as Selection))).toEqual([["1,2", "4,2", "4,6", "1,6"]]);
  });

  it("a non-uniform square chains to one contour with 4 corners (colinear runs merged)", () => {
    const sel = fromGrid(["....", ".##.", ".##.", "...."]);
    expect(corners(outlineContours(sel))).toEqual([["1,1", "3,1", "3,3", "1,3"]]);
  });

  it("two disjoint blobs are two contours", () => {
    const sel = fromGrid(["##...", "##...", "....#"]);
    const contours = outlineContours(sel);
    expect(contours).toHaveLength(2);
    expect(length(contours)).toBe(8 + 4);
  });

  it("a ring (hole) is two contours: outer and hole", () => {
    const sel = fromGrid(["###", "#.#", "###"]);
    const contours = outlineContours(sel);
    expect(contours).toHaveLength(2);
    expect(length(contours)).toBe(12 + 4);
  });

  it("diagonal neighbours (saddle) stay separate contours", () => {
    const contours = outlineContours(fromGrid(["#.", ".#"]));
    expect(contours).toHaveLength(2);
    expect(corners(contours).every((c) => c.length === 4)).toBe(true);
  });

  it("a staircase is ONE contour (continuous dashes on diagonals)", () => {
    const sel = fromGrid(["#...", "##..", "###.", "####"]);
    const contours = outlineContours(sel);
    expect(contours).toHaveLength(1);
    expect(length(contours)).toBe(16);
  });

  it("merges the L shape into 6 corners", () => {
    const l = combineSelection(rectSelection({ x: 0, y: 0, width: 2, height: 2 }), rectSelection({ x: 0, y: 2, width: 4, height: 1 }), "add");
    const contours = outlineContours(l as Selection);
    expect(contours).toHaveLength(1);
    expect(contours[0]?.length).toBe(12);
    expect(length(contours)).toBe(14);
  });

  it("an inverted rect outlines the hole, plus the frame when given", () => {
    const inv = invertSelection(rectSelection({ x: 2, y: 2, width: 3, height: 2 })) as Selection;
    expect(length(outlineContours(inv))).toBe(10);
    const framed = outlineContours(inv, { x: 0, y: 0, width: 10, height: 8 });
    expect(framed).toHaveLength(2);
    expect(length(framed)).toBe(10 + 36);
  });

  it("uses the 50% threshold", () => {
    const soft: Selection = { rect: { x: 0, y: 0, width: 3, height: 1 }, data: Uint8Array.from([255, 127, 128]), outside: 0 };
    // Pixels 0 and 2 are in, pixel 1 is out: two unit squares.
    expect(outlineContours(soft)).toHaveLength(2);
    expect(length(outlineContours(soft))).toBe(8);
  });

  it("is fast enough for a 4k wand-like selection", () => {
    const size = 4096;
    const data = new Uint8Array(size * size);
    const c = size / 2;
    const r2 = (size * 0.45) ** 2;
    // A disc with a noisy (wand-like) edge and a few holes.
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const d = (x - c) ** 2 + (y - c) ** 2;
        const noise = ((x * 7919 + y * 104729) % 97) * 400;
        data[y * size + x] = d + noise < r2 && (x % 512 > 8 || y % 512 > 8) ? 255 : 0;
      }
    }
    const sel = selectionFromCoverage(data, { x: 0, y: 0, width: size, height: size }) as Selection;
    const t0 = performance.now();
    const contours = outlineContours(sel);
    const ms = performance.now() - t0;
    // Measured ~65 ms (12.7k contours) on the dev machine.
    expect(contours.length).toBeGreaterThan(0);
    expect(ms).toBeLessThan(2000);
  });
});
