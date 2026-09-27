import { describe, expect, it } from "vitest";

import { boundsCap } from "./bounds";
import { applyCoverage, cropToCap, maskToGray, pastedLayerName, pasteRect } from "./clipboardMath";

describe("applyCoverage", () => {
  it("weights alpha by coverage and zeroes RGB of emptied pixels", () => {
    const px = new Uint8ClampedArray([10, 20, 30, 200, 40, 50, 60, 255]);
    expect(applyCoverage(px, new Uint8Array([128, 0]))).toBe(true);
    expect(Array.from(px)).toEqual([10, 20, 30, 100, 0, 0, 0, 0]);
  });

  it("reports an empty result", () => {
    const px = new Uint8ClampedArray([1, 2, 3, 0]);
    expect(applyCoverage(px, null)).toBe(false);
  });
});

describe("maskToGray", () => {
  it("turns coverage into opaque gray, times the selection", () => {
    const px = new Uint8ClampedArray([255, 255, 255, 255, 255, 255, 255, 0]);
    expect(maskToGray(px, new Uint8Array([51, 255]))).toBe(true);
    expect(Array.from(px)).toEqual([51, 51, 51, 255, 0, 0, 0, 255]);
  });

  it("is empty when nothing is masked", () => {
    expect(maskToGray(new Uint8ClampedArray([255, 255, 255, 0]), null)).toBe(false);
  });
});

describe("pasteRect", () => {
  it("centres the image on a document point, 1 px = 1 image px", () => {
    expect(pasteRect({ width: 100, height: 50 }, 1, { centre: { x: 200, y: 100 } })).toEqual({ x: 150, y: 75, width: 100, height: 50 });
  });

  it("scales by document px per source px (frame map scale != 1)", () => {
    expect(pasteRect({ width: 100, height: 50 }, 0.5, { centre: { x: 0, y: 0 } })).toEqual({ x: -25, y: -12, width: 50, height: 25 });
  });

  it("pastes in place at a top-left", () => {
    expect(pasteRect({ width: 3, height: 4 }, 1, { topLeft: { x: 7.2, y: -2 } })).toEqual({ x: 7, y: -2, width: 3, height: 4 });
  });
});

describe("cropToCap", () => {
  const cap = boundsCap({ width: 100, height: 100 });

  it("keeps a paste inside the cap", () => {
    expect(cropToCap({ x: 0, y: 0, width: 50, height: 50 }, cap)).toEqual({ rect: { x: 0, y: 0, width: 50, height: 50 }, cropped: false });
  });

  it("crops a paste larger than the 3x paint area", () => {
    const result = cropToCap({ x: -500, y: 0, width: 1000, height: 10 }, cap);
    expect(result.cropped).toBe(true);
    expect(result.rect).toEqual({ x: -100, y: 0, width: 300, height: 10 });
  });

  it("returns null when nothing fits", () => {
    expect(cropToCap({ x: 5000, y: 0, width: 10, height: 10 }, cap).rect).toBeNull();
  });
});

describe("pastedLayerName", () => {
  it("numbers repeats", () => {
    expect(pastedLayerName([{ name: "Layer 1" }])).toBe("Pasted");
    expect(pastedLayerName([{ name: "Pasted" }, { name: "Pasted 2" }])).toBe("Pasted 3");
  });
});
