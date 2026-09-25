import { describe, expect, it } from "vitest";

import { boundsCap, growBounds } from "./bounds";

const frame = { width: 1000, height: 500 };
const initial = { x: 0, y: 0, width: 1000, height: 500 };

describe("boundsCap", () => {
  it("is 3x the frame per axis, centred", () => {
    expect(boundsCap(frame)).toEqual({ x: -1000, y: -500, width: 3000, height: 1500 });
  });

  it("respects the absolute max side but never shrinks below the frame", () => {
    expect(boundsCap({ width: 8000, height: 100 }).width).toBe(16384);
    expect(boundsCap({ width: 20000, height: 100 }).width).toBe(20000);
  });
});

describe("growBounds", () => {
  it("returns the same bounds when the need is inside", () => {
    expect(growBounds(initial, { x: 10, y: 10, width: 5, height: 5 }, frame)).toEqual(initial);
  });

  it("grows only the touched side, in whole chunks", () => {
    expect(growBounds(initial, { x: -10.5, y: 100, width: 20, height: 20 }, frame)).toEqual({
      x: -256,
      y: 0,
      width: 1256,
      height: 500,
    });
    expect(growBounds(initial, { x: 900, y: 450, width: 400, height: 300 }, frame)).toEqual({
      x: 0,
      y: 0,
      width: 1512,
      height: 756,
    });
  });

  it("clips growth to the cap", () => {
    expect(growBounds(initial, { x: -5000, y: 0, width: 10, height: 10 }, frame)).toEqual(initial);
    expect(growBounds(initial, { x: -999, y: 0, width: 10, height: 10 }, frame)).toEqual({
      x: -1000,
      y: 0,
      width: 2000,
      height: 500,
    });
  });
});
