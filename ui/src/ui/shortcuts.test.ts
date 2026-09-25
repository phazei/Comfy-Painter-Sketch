import { describe, expect, it } from "vitest";

import { stepHardness, stepSize } from "./shortcuts";

describe("bracket steps", () => {
  it("steps size finer for small brushes and clamps", () => {
    expect(stepSize(5, true)).toBe(6);
    expect(stepSize(10, true)).toBe(15);
    expect(stepSize(15, false)).toBe(10);
    expect(stepSize(10, false)).toBe(9);
    expect(stepSize(1, false)).toBe(1);
    expect(stepSize(1000, true)).toBe(1000);
  });

  it("steps hardness by 25%", () => {
    expect(stepHardness(0.8, true)).toBe(1);
    expect(stepHardness(0.5, false)).toBe(0.25);
    expect(stepHardness(0, false)).toBe(0);
  });
});
