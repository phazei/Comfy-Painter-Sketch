import { describe, expect, it } from "vitest";

import { docToImage, frameMap } from "./frameMap";
import {
  imageOffsetToPlacement,
  placementImageOffset,
  scalePlacementAt,
  translatePlacement,
  wheelScaleFactor,
} from "./placementMath";

const frame = { width: 200, height: 100 };
const image = { width: 100, height: 50 }; // s = 0.5

describe("placement interaction math", () => {
  it("translates by image px through the frame-fit scale", () => {
    expect(translatePlacement({ x: 0, y: 0, scale: 1 }, frame, image, 10, -3)).toEqual({ x: 20, y: -6, scale: 1 });
    // Placement scale does not change the conversion: the drawing follows the pointer.
    const p = translatePlacement({ x: 4, y: 0, scale: 3 }, frame, image, 1, 0);
    expect(p).toEqual({ x: 6, y: 0, scale: 3 });
  });

  it("image offset <-> placement", () => {
    expect(placementImageOffset({ x: 20, y: -6, scale: 2 }, frame, image)).toEqual({ x: 10, y: -3 });
    expect(imageOffsetToPlacement(10, frame, image)).toBe(20);
  });

  it("wheel scaling keeps the point under the cursor fixed", () => {
    const start = { x: 7, y: -3, scale: 1.3 };
    const anchor = { x: 31, y: 12 };
    const before = frameMap(frame, image, start);
    const docUnder = { x: (anchor.x - before.offsetX) / before.scale, y: (anchor.y - before.offsetY) / before.scale };
    const next = scalePlacementAt(start, frame, image, 1.5, anchor);
    expect(next.scale).toBeCloseTo(1.95, 12);
    const after = docToImage(frameMap(frame, image, next), docUnder);
    expect(after.x).toBeCloseTo(anchor.x, 9);
    expect(after.y).toBeCloseTo(anchor.y, 9);
  });

  it("clamps the scale and still keeps the anchor", () => {
    const next = scalePlacementAt({ x: 0, y: 0, scale: 19 }, frame, image, 2, { x: 10, y: 10 });
    expect(next.scale).toBe(20);
    const map = frameMap(frame, image, next);
    const prev = frameMap(frame, image, { x: 0, y: 0, scale: 19 });
    const doc = { x: (10 - prev.offsetX) / prev.scale, y: (10 - prev.offsetY) / prev.scale };
    expect(docToImage(map, doc).x).toBeCloseTo(10, 9);
  });

  it("wheel factor: 1.05 per notch, proportional for trackpads, capped", () => {
    expect(wheelScaleFactor(-100)).toBeCloseTo(1.05, 12);
    expect(wheelScaleFactor(100)).toBeCloseTo(1 / 1.05, 12);
    expect(wheelScaleFactor(-10)).toBeCloseTo(Math.pow(1.05, 0.1), 12);
    expect(wheelScaleFactor(-10000)).toBeCloseTo(Math.pow(1.05, 3), 12);
    expect(wheelScaleFactor(Number.NaN)).toBe(1);
  });
});
