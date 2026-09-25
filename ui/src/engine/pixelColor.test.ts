import { describe, expect, it } from "vitest";

import { averageColor, blendCoverage, hexToRgb, rgbToHex } from "./pixelColor";

describe("hex <-> rgb", () => {
  it("round-trips and tolerates short / malformed input", () => {
    expect(hexToRgb("#ff8000")).toEqual({ r: 255, g: 128, b: 0 });
    expect(hexToRgb("#abc")).toEqual({ r: 0xaa, g: 0xbb, b: 0xcc });
    expect(hexToRgb("nope")).toEqual({ r: 0, g: 0, b: 0 });
    expect(rgbToHex({ r: 255, g: 128.4, b: -3 })).toBe("#ff8000");
  });
});

describe("averageColor", () => {
  it("weights by alpha and ignores transparent pixels", () => {
    const data = new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 255, 0, 0, 0, 255, 255]);
    expect(averageColor(data)).toEqual({ r: 128, g: 0, b: 128 });
  });

  it("returns null when fully transparent", () => {
    expect(averageColor(new Uint8ClampedArray(16))).toBeNull();
  });
});

describe("blendCoverage", () => {
  it("paints source-over in straight alpha through coverage x opacity", () => {
    // 2x1: transparent pixel, opaque blue pixel; both fully covered.
    const dst = new Uint8ClampedArray([0, 0, 0, 0, 0, 0, 255, 255]);
    blendCoverage(dst, { x: 0, y: 0, width: 2, height: 1 }, new Uint8Array([255, 255]), 2, { r: 255, g: 0, b: 0 }, 0.5);
    expect([...dst.slice(0, 4)]).toEqual([255, 0, 0, 128]);
    expect([...dst.slice(4)]).toEqual([128, 0, 128, 255]);
  });

  it("reads coverage at the rect offset and skips zero coverage", () => {
    const coverage = new Uint8Array([0, 0, 0, 255]); // 2x2, only (1,1)
    const dst = new Uint8ClampedArray(4);
    blendCoverage(dst, { x: 1, y: 1, width: 1, height: 1 }, coverage, 2, { r: 0, g: 255, b: 0 }, 1);
    expect([...dst]).toEqual([0, 255, 0, 255]);
    const untouched = new Uint8ClampedArray([1, 2, 3, 4]);
    blendCoverage(untouched, { x: 0, y: 0, width: 1, height: 1 }, coverage, 2, { r: 0, g: 255, b: 0 }, 1);
    expect([...untouched]).toEqual([1, 2, 3, 4]);
  });
});
