/**
 * Free Transform pure math (M11a): matrices, handle drags (proportional /
 * free / Alt / edge), rotate snap, resize-cursor choice, hit zones with
 * rotation, transformed bounds, and the exact resample / flip paths.
 */

import { describe, expect, it } from "vitest";

import { rectSelection } from "./selection";
import {
  decomposeAffine,
  flipParams,
  mirrorAbout,
  paramsMatrix,
  rotateDrag,
  scaleDrag,
  transformedAabb,
  translation,
} from "./transformMath";
import type { TransformParams } from "./transformMath";
import { hitTransform, resizeAxis } from "./transformHit";
import { flipRgba, resampleCoverage, resampleRgba, supersampleFactor, transformSelection } from "./transformResample";

/** Identity parameters of a 10 x 10 float at (0, 0). */
const BOX: TransformParams = { cx: 5, cy: 5, sx: 1, sy: 1, angle: 0 };
const DEG = Math.PI / 180;

function close(p: TransformParams, q: Partial<TransformParams>): void {
  for (const [k, v] of Object.entries(q)) expect(p[k as keyof TransformParams]).toBeCloseTo(v as number, 9);
}

function pattern(w: number, h: number): Uint8ClampedArray {
  const px = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) px.set([i * 7 % 256, i * 13 % 256, i * 29 % 256, 255 - (i % 3) * 40], i * 4);
  return px;
}

describe("matrices", () => {
  it("round-trips parameters, flips included", () => {
    const p: TransformParams = { cx: 12.5, cy: -3, sx: -1.5, sy: 0.75, angle: 30 * DEG };
    const q = decomposeAffine(paramsMatrix(p, 8, 6), 8, 6);
    const m1 = paramsMatrix(p, 8, 6);
    const m2 = paramsMatrix(q, 8, 6);
    for (const k of ["a", "b", "c", "d", "e", "f"] as const) expect(m2[k]).toBeCloseTo(m1[k], 9);
    expect(paramsMatrix(BOX, 10, 10)).toEqual({ a: 1, b: 0, c: -0, d: 1, e: 0, f: 0 });
  });

  it("flipping twice is the identity; a flip mirrors about the centre", () => {
    const p = { ...BOX, angle: 20 * DEG };
    close(flipParams(flipParams(p, "h"), "h"), p);
    const m = paramsMatrix(flipParams(BOX, "h"), 10, 10);
    expect(m.a).toBe(-1);
    expect(m.e).toBe(10);
  });

  it("bounds of the transformed box", () => {
    expect(transformedAabb(paramsMatrix(BOX, 10, 10), 10, 10)).toEqual({ x: 0, y: 0, width: 10, height: 10 });
    expect(transformedAabb(paramsMatrix({ ...BOX, angle: 45 * DEG }, 10, 10), 10, 10)).toEqual({ x: -3, y: -3, width: 16, height: 16 });
    expect(transformedAabb(paramsMatrix({ ...BOX, sx: 2 }, 10, 10), 10, 10)).toEqual({ x: -5, y: 0, width: 20, height: 10 });
  });
});

describe("handle drags", () => {
  it("corner, proportional: projects onto the diagonal, opposite corner fixed", () => {
    close(scaleDrag(BOX, 10, 10, 4, { x: 15, y: 12 }, { proportional: true, fromCentre: false }), { sx: 1.35, sy: 1.35, cx: 6.75, cy: 6.75 });
  });

  it("corner, free (Shift): each axis follows the pointer", () => {
    close(scaleDrag(BOX, 10, 10, 4, { x: 15, y: 12 }, { proportional: false, fromCentre: false }), { sx: 1.5, sy: 1.2, cx: 7.5, cy: 6 });
  });

  it("Alt scales about the centre", () => {
    close(scaleDrag(BOX, 10, 10, 4, { x: 15, y: 12 }, { proportional: false, fromCentre: true }), { sx: 2, sy: 1.4, cx: 5, cy: 5 });
  });

  it("edge, proportional: both axes by the edge factor, perpendicular centre kept", () => {
    close(scaleDrag(BOX, 10, 10, 3, { x: 20, y: 0 }, { proportional: true, fromCentre: false }), { sx: 2, sy: 2, cx: 10, cy: 5 });
    close(scaleDrag(BOX, 10, 10, 3, { x: 20, y: 0 }, { proportional: false, fromCentre: false }), { sx: 2, sy: 1, cx: 10, cy: 5 });
  });

  it("dragging past the anchor flips; a rotated box scales along its own axes", () => {
    close(scaleDrag(BOX, 10, 10, 3, { x: -10, y: 5 }, { proportional: false, fromCentre: false }), { sx: -1, cx: -5 });
    const rot = { ...BOX, angle: 90 * DEG };
    // Handle 3 (local +x) points down after 90 deg: dragging it down by 10 doubles the width.
    close(scaleDrag(rot, 10, 10, 3, { x: 5, y: 20 }, { proportional: false, fromCentre: false }), { sx: 2, sy: 1, cx: 5, cy: 10 });
  });

  it("rotates about the centre; Shift snaps to 15 deg", () => {
    const at = { x: 5 + 10 * Math.cos(20 * DEG), y: 5 + 10 * Math.sin(20 * DEG) };
    close(rotateDrag(BOX, { x: 15, y: 5 }, at, false), { angle: 20 * DEG });
    close(rotateDrag(BOX, { x: 15, y: 5 }, at, true), { angle: 15 * DEG });
  });
});

describe("cursors and hit zones", () => {
  it("picks the resize cursor from the rotated handle direction", () => {
    const m = paramsMatrix(BOX, 10, 10);
    expect(resizeAxis(m, 10, 10, 4)).toBe("nwse");
    expect(resizeAxis(m, 10, 10, 2)).toBe("nesw");
    expect(resizeAxis(m, 10, 10, 3)).toBe("ew");
    expect(resizeAxis(m, 10, 10, 1)).toBe("ns");
    expect(resizeAxis(paramsMatrix({ ...BOX, angle: 90 * DEG }, 10, 10), 10, 10, 3)).toBe("ns");
    expect(resizeAxis(paramsMatrix({ ...BOX, angle: 45 * DEG }, 10, 10), 10, 10, 3)).toBe("nwse");
  });

  it("hit-tests inside / handle / rotate / outside on a rotated box", () => {
    const m = paramsMatrix({ ...BOX, angle: 45 * DEG }, 10, 10);
    const r = 5 * Math.SQRT2;
    expect(hitTransform(m, 10, 10, { x: 5, y: 5 }, 1, 3)).toEqual({ kind: "move" });
    // Local top-left corner lands straight above the centre after 45 deg.
    expect(hitTransform(m, 10, 10, { x: 5, y: 5 - r + 0.5 }, 1, 3)).toEqual({ kind: "scale", handle: 0 });
    expect(hitTransform(m, 10, 10, { x: 5, y: 5 - r - 3 }, 1, 3)).toEqual({ kind: "rotate" });
    // Inside the axis-aligned bounds, outside the rotated box, away from corners.
    expect(hitTransform(m, 10, 10, { x: 0, y: 0 }, 1, 3)).toEqual({ kind: "outside" });
    expect(hitTransform(m, 10, 10, { x: 40, y: 40 }, 1, 3)).toEqual({ kind: "outside" });
  });
});

describe("resampling", () => {
  it("whole-px translations and mirror matrices are exact", () => {
    const src = pattern(3, 2);
    const moved = resampleRgba(src, 3, 2, translation(7, -4), { x: 7, y: -4, width: 3, height: 2 });
    expect(Array.from(moved)).toEqual(Array.from(src));
    const mirrored = resampleRgba(src, 3, 2, mirrorAbout("h", { x: 1.5, y: 0 }), { x: 0, y: 0, width: 3, height: 2 });
    expect(Array.from(mirrored)).toEqual(Array.from(flipRgba(src, 3, 2, "h")));
  });

  it("flips exactly", () => {
    const src = pattern(3, 2);
    const h = flipRgba(src, 3, 2, "h");
    expect(Array.from(h.subarray(0, 4))).toEqual(Array.from(src.subarray(8, 12)));
    const v = flipRgba(src, 3, 2, "v");
    expect(Array.from(v.subarray(0, 4))).toEqual(Array.from(src.subarray(12, 16)));
    expect(Array.from(flipRgba(h, 3, 2, "h"))).toEqual(Array.from(src));
  });

  it("downscales by averaging (supersampled) and keeps opaque interiors opaque", () => {
    expect(supersampleFactor({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 })).toBe(1);
    expect(supersampleFactor({ a: 4, b: 0, c: 0, d: 4, e: 0, f: 0 })).toBe(4);
    const src = new Uint8ClampedArray(8 * 8 * 4);
    for (let i = 0; i < 64; i++) src.set([200, 100, 50, 255], i * 4);
    const out = resampleRgba(src, 8, 8, paramsMatrix({ cx: 2, cy: 2, sx: 0.5, sy: 0.5, angle: 0 }, 8, 8), { x: 0, y: 0, width: 4, height: 4 });
    const centre = (1 * 4 + 1) * 4;
    expect(Array.from(out.subarray(centre, centre + 4))).toEqual([200, 100, 50, 255]);
  });

  it("carries coverage (not thresholded) and selections through a matrix", () => {
    const cov = resampleCoverage(new Uint8Array([255, 0]), 2, 1, { a: 1, b: 0, c: 0, d: 1, e: 0.5, f: 0 }, { x: 0, y: 0, width: 3, height: 1 });
    expect(Array.from(cov)).toEqual([128, 128, 0]);
    const sel = rectSelection({ x: 2, y: 2, width: 4, height: 4 });
    expect(sel).not.toBeNull();
    if (!sel) return;
    const moved = transformSelection(sel, sel.rect, translation(12, 2));
    expect(moved?.rect).toEqual({ x: 12, y: 2, width: 4, height: 4 });
    expect(moved?.data.every((c) => c === 255)).toBe(true);
  });
});
