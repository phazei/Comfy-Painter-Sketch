import { describe, expect, it } from "vitest";

import { floodFill } from "./floodFill";
import type { FloodFillOptions } from "./floodFill";

/** RGBA buffer filled with one colour. */
function buffer(width: number, height: number, rgba: [number, number, number, number] = [255, 255, 255, 255]): Uint8ClampedArray {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set(rgba, i * 4);
  return data;
}

function setPx(data: Uint8ClampedArray, width: number, x: number, y: number, rgba: [number, number, number, number]): void {
  data.set(rgba, (y * width + x) * 4);
}

const BASE: FloodFillOptions = { x: 0, y: 0, tolerance: 0, contiguous: true, antiAlias: false };

/** 7x5 white image split by a black vertical wall at x = 3. */
function walled(): Uint8ClampedArray {
  const data = buffer(7, 5);
  for (let y = 0; y < 5; y++) setPx(data, 7, 3, y, [0, 0, 0, 255]);
  return data;
}

describe("floodFill", () => {
  it("contiguous fill stops at a wall; global fill jumps it", () => {
    const contiguous = floodFill(walled(), 7, 5, { ...BASE, x: 1, y: 2 });
    expect(contiguous.bbox).toEqual({ x: 0, y: 0, width: 3, height: 5 });
    expect(contiguous.coverage[2 * 7 + 1]).toBe(255);
    expect(contiguous.coverage[2 * 7 + 3]).toBe(0);
    expect(contiguous.coverage[2 * 7 + 5]).toBe(0);

    const global = floodFill(walled(), 7, 5, { ...BASE, x: 1, y: 2, contiguous: false });
    expect(global.bbox).toEqual({ x: 0, y: 0, width: 7, height: 5 });
    expect(global.coverage[2 * 7 + 3]).toBe(0);
    expect(global.coverage[2 * 7 + 5]).toBe(255);
  });

  it("follows winding regions (scanline pushes every run)", () => {
    // 5x5 with a U-shaped wall: fill from inside the U reaches around it.
    const data = buffer(5, 5);
    for (const [x, y] of [[1, 1], [1, 2], [1, 3], [2, 3], [3, 3], [3, 2], [3, 1]] as const) setPx(data, 5, x, y, [0, 0, 0, 255]);
    const r = floodFill(data, 5, 5, { ...BASE, x: 2, y: 1 });
    // Inside the U opens upwards, so the whole outside is reachable too.
    expect(r.coverage[4 * 5 + 2]).toBe(255);
    expect(r.coverage[0]).toBe(255);
    expect(r.coverage[1 * 5 + 1]).toBe(0);
  });

  it("tolerance is a per-channel max difference, inclusive, incl. alpha", () => {
    const data = buffer(3, 1, [100, 100, 100, 255]);
    setPx(data, 3, 1, 0, [110, 100, 100, 255]);
    setPx(data, 3, 2, 0, [100, 100, 100, 244]);
    const at = (tolerance: number): number[] => [...floodFill(data, 3, 1, { ...BASE, tolerance, contiguous: false }).coverage];
    expect(at(9)).toEqual([255, 0, 0]);
    expect(at(10)).toEqual([255, 255, 0]);
    expect(at(11)).toEqual([255, 255, 255]);
    expect(at(255)).toEqual([255, 255, 255]);
  });

  it("treats all fully transparent pixels as one colour", () => {
    const data = new Uint8ClampedArray(3 * 4);
    setPx(data, 3, 1, 0, [255, 0, 0, 0]);
    setPx(data, 3, 2, 0, [0, 0, 0, 1]);
    const r = floodFill(data, 3, 1, { ...BASE });
    expect([...r.coverage]).toEqual([255, 255, 0]);
  });

  it("anti-alias adds a 1px partial fringe outside the fill, inside stays solid", () => {
    const hard = floodFill(walled(), 7, 5, { ...BASE, x: 1, y: 2 });
    const soft = floodFill(walled(), 7, 5, { ...BASE, x: 1, y: 2, antiAlias: true });
    const wall = 2 * 7 + 3;
    expect(hard.coverage[wall]).toBe(0);
    // Straight edge: 3 of 9 box neighbours filled.
    expect(soft.coverage[wall]).toBe(Math.round((3 * 255) / 9));
    expect(soft.coverage[2 * 7 + 2]).toBe(255);
    expect(soft.coverage[2 * 7 + 4]).toBe(0);
    expect(soft.bbox).toEqual({ x: 0, y: 0, width: 4, height: 5 });
  });

  it("returns an empty result for seeds outside the buffer or blocked by the clip", () => {
    expect(floodFill(walled(), 7, 5, { ...BASE, x: 9, y: 0 }).bbox.width).toBe(0);
    const clip = new Uint8Array(35);
    const blocked = floodFill(walled(), 7, 5, { ...BASE, x: 1, y: 2, clip });
    expect(blocked.bbox.width).toBe(0);
    expect(blocked.coverage.every((v) => v === 0)).toBe(true);
  });

  it("clip limits and scales the coverage", () => {
    const clip = new Uint8Array(35);
    for (let y = 0; y < 5; y++) clip[y * 7] = 128; // column 0 half selected
    clip[2 * 7 + 1] = 255;
    const r = floodFill(buffer(7, 5), 7, 5, { ...BASE, x: 1, y: 2, clip });
    expect(r.coverage[2 * 7 + 1]).toBe(255);
    expect(r.coverage[2 * 7]).toBe(128);
    expect(r.coverage[2 * 7 + 2]).toBe(0);
    expect(r.bbox).toEqual({ x: 0, y: 0, width: 2, height: 5 });
  });

  it("fills a 4096x4096 buffer quickly", () => {
    const size = 4096;
    const data = buffer(size, size);
    // A diagonal-ish wall so the fill is not one trivial span per row.
    for (let y = 0; y < size; y++) setPx(data, size, (y * 3) % size, y, [0, 0, 0, 255]);
    const t0 = performance.now();
    const r = floodFill(data, size, size, { ...BASE, x: size - 1, y: 0, tolerance: 32, antiAlias: true });
    const ms = performance.now() - t0;
    console.log(`[floodFill] 4096x4096 contiguous + anti-alias: ${ms.toFixed(0)} ms`);
    expect(r.bbox.width).toBeGreaterThan(0);
    expect(ms).toBeLessThan(1500); // generous for slow CI; target < 300 ms locally
  });
});
