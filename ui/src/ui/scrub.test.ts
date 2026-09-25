import { describe, expect, it } from "vitest";

import type { NumberOption } from "../tools/options";
import { scrubPixelsPerStep, scrubValue } from "./scrub";

const size: NumberOption = { kind: "number", key: "size", label: "Size", min: 1, max: 1000, step: 1 };
const percent: NumberOption = { kind: "number", key: "opacity", label: "Opac", min: 0, max: 100, step: 1, scale: 100 };
const gamma: NumberOption = { kind: "number", key: "gamma", label: "g", min: 0.2, max: 5, step: 0.05 };
const tiny: NumberOption = { kind: "number", key: "n", label: "n", min: 0, max: 4, step: 1 };

describe("scrub math", () => {
  it("adapts speed to the number of steps (clamped 1..8 px per step)", () => {
    expect(scrubPixelsPerStep(size)).toBe(1);
    expect(scrubPixelsPerStep(percent)).toBeCloseTo(2.4);
    expect(scrubPixelsPerStep(tiny)).toBe(8);
  });

  it("moves by whole steps, right = up, left = down", () => {
    expect(scrubValue(size, 24, 10, false)).toBe(34);
    expect(scrubValue(size, 24, -10, false)).toBe(14);
    expect(scrubValue(percent, 50, 5, false)).toBe(52);
    expect(scrubValue(percent, 50, 2, false)).toBe(50);
    expect(scrubValue(gamma, 1, 5, false)).toBe(1.1);
  });

  it("Shift is 10x and results clamp to the range", () => {
    expect(scrubValue(size, 24, 10, true)).toBe(124);
    expect(scrubValue(size, 24, -100, false)).toBe(1);
    expect(scrubValue(percent, 90, 100, true)).toBe(100);
  });
});
