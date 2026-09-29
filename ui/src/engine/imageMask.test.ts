/**
 * M13a Image Mask pure conversions: alpha -> coverage polarity (LoadImage's
 * MASK = 1 - alpha), opaque images give no row, the mask-file format, and
 * resampling into document coords through the frame map.
 */

import { describe, expect, it } from "vitest";

import { frameMap } from "./frameMap";
import { coverageFromAlpha, coverageFromMaskFile, coverageInDoc, maskFilePixels } from "./imageMask";

/** RGBA pixels with the given alphas (RGB black, as `/view?channel=a` sends). */
function alphaPixels(alphas: number[]): Uint8ClampedArray {
  const out = new Uint8ClampedArray(alphas.length * 4);
  alphas.forEach((a, i) => (out[i * 4 + 3] = a));
  return out;
}

describe("coverageFromAlpha", () => {
  it("is 255 - alpha (transparent = fully masked)", () => {
    expect([...(coverageFromAlpha(alphaPixels([0, 255, 200, 1])) ?? [])]).toEqual([255, 0, 55, 254]);
  });

  it("is null for a fully opaque image (no row)", () => {
    expect(coverageFromAlpha(alphaPixels([255, 255, 255]))).toBeNull();
  });
});

describe("mask-file pixels", () => {
  it("store coverage in alpha over white and read back exactly", () => {
    const coverage = new Uint8Array([0, 128, 255]);
    const rgba = maskFilePixels(coverage);
    expect([...rgba.slice(4, 8)]).toEqual([255, 255, 255, 128]);
    expect([...coverageFromMaskFile(rgba)]).toEqual([0, 128, 255]);
  });
});

describe("coverageInDoc", () => {
  const size = { width: 4, height: 2 };
  // Column x has coverage 60 * x; both rows equal.
  const coverage = new Uint8Array([0, 60, 120, 180, 0, 60, 120, 180]);

  it("identity map copies the plane; outside the image is 0 even inverted", () => {
    const map = frameMap(size, size);
    const rect = { x: -1, y: 0, width: 6, height: 1 };
    expect([...coverageInDoc(coverage, size, map, rect, false)]).toEqual([0, 0, 60, 120, 180, 0]);
    expect([...coverageInDoc(coverage, size, map, rect, true)]).toEqual([0, 255, 195, 135, 75, 0]);
  });

  it("maps a larger frame onto the smaller image (frame fit)", () => {
    // Frame 8x4 on the 4x2 image: s = 0.5, doc px 2..3 -> image px 1.
    const map = frameMap({ width: 8, height: 4 }, size);
    const out = coverageInDoc(coverage, size, map, { x: 0, y: 0, width: 8, height: 1 }, false);
    expect(out[0]).toBe(0);
    expect(out[7]).toBe(180);
    // Doc px 3 centre = image x 1.75: between columns 1 and 2.
    expect(out[3]).toBe(Math.round(60 * 0.75 + 120 * 0.25 + 0.0));
  });
});
