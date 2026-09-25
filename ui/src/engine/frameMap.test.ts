import { describe, expect, it } from "vitest";

import {
  docRectToImage,
  docToImage,
  frameMap,
  IDENTITY_MAP,
  imageLengthToDoc,
  imageToDoc,
  layerPlacement,
  roundHalfEven,
} from "./frameMap";

describe("frameMap", () => {
  it("is the identity when sizes match", () => {
    expect(frameMap({ width: 640, height: 480 }, { width: 640, height: 480 })).toEqual(IDENTITY_MAP);
  });

  it("uses s = min(W/fw, H/fh), centred (contract formula)", () => {
    expect(frameMap({ width: 100, height: 100 }, { width: 200, height: 100 })).toEqual({ scale: 1, offsetX: 50, offsetY: 0 });
    expect(frameMap({ width: 400, height: 200 }, { width: 100, height: 100 })).toEqual({
      scale: 0.25,
      offsetX: 0,
      offsetY: 25,
    });
    expect(frameMap({ width: 512, height: 512 }, { width: 1024, height: 768 })).toEqual({
      scale: 1.5,
      offsetX: 128,
      offsetY: 0,
    });
  });

  it("maps the doc frame into the image and rects consistently", () => {
    const map = frameMap({ width: 400, height: 200 }, { width: 100, height: 100 });
    expect(docRectToImage(map, { x: 0, y: 0, width: 400, height: 200 })).toEqual({ x: 0, y: 25, width: 100, height: 50 });
    expect(docToImage(map, { x: -100, y: 0 })).toEqual({ x: -25, y: 25 });
  });

  it("round-trips through the inverse", () => {
    const map = frameMap({ width: 777, height: 333 }, { width: 1024, height: 1536 });
    for (const p of [{ x: 0, y: 0 }, { x: 12.25, y: -40.5 }, { x: 777, y: 333 }, { x: -300, y: 900 }]) {
      const back = imageToDoc(map, docToImage(map, p));
      expect(back.x).toBeCloseTo(p.x, 9);
      expect(back.y).toBeCloseTo(p.y, 9);
    }
  });

  it("A -> B -> A with different aspects returns exactly the original mapping (nothing resampled)", () => {
    const doc = { width: 800, height: 600 };
    const a = { width: 800, height: 600 };
    const b = { width: 512, height: 1024 };
    const first = frameMap(doc, a);
    const viaB = frameMap(doc, b);
    expect(viaB.scale).toBeLessThan(1);
    let last = first;
    for (let i = 0; i < 5; i++) {
      frameMap(doc, b);
      last = frameMap(doc, a);
    }
    expect(last).toEqual(first);
    expect(last).toEqual(IDENTITY_MAP);
  });

  it("converts image-space lengths (brush size) to doc px", () => {
    const map = frameMap({ width: 1000, height: 1000 }, { width: 500, height: 500 });
    expect(imageLengthToDoc(map, 20)).toBe(40);
  });

  it("falls back to identity for degenerate sizes", () => {
    expect(frameMap({ width: 0, height: 10 }, { width: 10, height: 10 })).toEqual(IDENTITY_MAP);
    expect(frameMap({ width: 10, height: 10 }, { width: Number.NaN, height: 10 })).toEqual(IDENTITY_MAP);
  });
});

describe("layerPlacement (matches nodes/composite.py _place_layer)", () => {
  it("rounds half to even like Python round()", () => {
    expect([0.5, 1.5, 2.5, -0.5, -1.5, 2.4, 2.6].map(roundHalfEven)).toEqual([0, 2, 2, 0, -2, 2, 3]);
  });

  it("keeps integer placement at s = 1", () => {
    const map = frameMap({ width: 100, height: 100 }, { width: 200, height: 100 });
    expect(layerPlacement(map, { x: -256, y: 0, width: 612, height: 100 })).toEqual({ x: -206, y: 0, width: 612, height: 100 });
  });

  it("snaps fractional offsets and scaled sizes", () => {
    // s = 1, ox = 0.5 -> Python round(0.5) = 0
    const half = frameMap({ width: 100, height: 100 }, { width: 101, height: 100 });
    expect(layerPlacement(half, { x: 0, y: 0, width: 100, height: 100 })).toEqual({ x: 0, y: 0, width: 100, height: 100 });
    // s = 1/3: 100 * s = 33.33 -> 33
    const third = frameMap({ width: 300, height: 300 }, { width: 100, height: 100 });
    expect(layerPlacement(third, { x: 0, y: 0, width: 100, height: 100 })).toEqual({ x: 0, y: 0, width: 33, height: 33 });
    expect(layerPlacement(third, { x: 0, y: 0, width: 1, height: 1 })).toEqual({ x: 0, y: 0, width: 1, height: 1 });
  });
});
