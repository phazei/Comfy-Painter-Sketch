import { describe, expect, it } from "vitest";

import { floodFill } from "./floodFill";
import { blendCoverageBehind } from "./pixelColor";

/**
 * 8x1 transparent layer with a purple stroke edge ramp on the right:
 * alphas 0 0 0 0 10 120 255 255.
 */
function rampLayer(): Uint8ClampedArray {
  const alphas = [0, 0, 0, 0, 10, 120, 255, 255];
  const data = new Uint8ClampedArray(alphas.length * 4);
  alphas.forEach((a, i) => data.set([156, 43, 200, a], i * 4));
  return data;
}

const BASE = { x: 0, y: 0, tolerance: 32, contiguous: true, antiAlias: true };

describe("bucket fill around soft edges", () => {
  it("matches faint pixels by their alpha-weighted colour", () => {
    // Alpha 10 purple is ~(6, 2, 8, 10) premultiplied: within 32 of transparent.
    const r = floodFill(rampLayer(), 8, 1, { ...BASE, antiAlias: false });
    expect([...r.coverage]).toEqual([255, 255, 255, 255, 255, 0, 0, 0]);
  });

  it("goes behind the layer's rising soft edge, never behind opaque paint", () => {
    const layer = rampLayer();
    const r = floodFill(layer, 8, 1, { ...BASE, under: layer });
    expect(r.under ? [...r.under] : null).toEqual([0, 0, 0, 0, 0, 255, 0, 0]);
    // The behind pixel is not also in the normal fringe.
    expect(r.coverage[5]).toBe(0);
    expect(r.bbox).toEqual({ x: 0, y: 0, width: 6, height: 1 });
  });

  it("does nothing where the target layer is empty (boundary on another layer)", () => {
    const scene = new Uint8ClampedArray(4 * 4);
    [255, 255, 0, 0].forEach((v, i) => scene.set([v, v, v, 255], i * 4));
    const empty = new Uint8ClampedArray(4 * 4);
    const r = floodFill(scene, 4, 1, { ...BASE, under: empty });
    expect(r.under ? [...r.under] : null).toEqual([0, 0, 0, 0]);
    expect(r.coverage[2]).toBeGreaterThan(0); // normal anti-alias fringe
  });

  it("recolouring an opaque area never goes behind its soft edge", () => {
    const layer = rampLayer();
    const r = floodFill(layer, 8, 1, { ...BASE, x: 7, under: layer });
    expect(r.under ? [...r.under] : null).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it("behind blend keeps the paint on top and closes the transparency", () => {
    const px = new Uint8ClampedArray([156, 43, 200, 120]);
    blendCoverageBehind(px, { x: 0, y: 0, width: 1, height: 1 }, new Uint8Array([255]), 1, { r: 156, g: 43, b: 200 }, 1);
    expect([...px]).toEqual([156, 43, 200, 255]);
  });
});
