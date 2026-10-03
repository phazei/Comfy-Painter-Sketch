import { describe, expect, it } from "vitest";

import { HARMONY_SET, VARIATION_SET, harmonyColors, mixToward, nextMode, parseMode, variationColors } from "./colorSchemes";
import { hsvToRgb } from "./colorMath";

describe("harmonies", () => {
  const base = { h: 10, s: 0.8, v: 0.6 };

  it("puts the base in the middle and the hue partners around it", () => {
    expect(harmonyColors(base, "analogous").map((c) => c.h)).toEqual([340, 10, 40]);
    expect(harmonyColors(base, "triadic").map((c) => c.h)).toEqual([250, 10, 130]);
    expect(harmonyColors(base, "split").map((c) => c.h)).toEqual([160, 10, 220]);
    for (const c of harmonyColors(base, "triadic")) expect([c.s, c.v]).toEqual([0.8, 0.6]);
  });
});

describe("variations", () => {
  const base = { h: 200, s: 0.6, v: 0.5 };

  it("lighter / darker mix 30 % white / black in RGB", () => {
    const [lighter, middle, darker] = variationColors(base, "tone");
    expect(middle).toEqual(base);
    const rgb = hsvToRgb(base);
    const light = hsvToRgb(lighter);
    expect(light.r).toBeCloseTo(rgb.r * 0.7 + 255 * 0.3, -0.5);
    expect(light.b).toBeCloseTo(rgb.b * 0.7 + 255 * 0.3, -0.5);
    expect(lighter.h).toBe(200);
    expect(darker).toEqual({ h: 200, s: 0.6, v: 0.35 });
  });

  it("lightens black and darkens white", () => {
    const [lighter] = variationColors({ h: 0, s: 0, v: 0 }, "tone");
    expect(lighter.v).toBeCloseTo(0.3, 9);
    const [, , darker] = variationColors({ h: 0, s: 0, v: 1 }, "tone");
    expect(darker.v).toBeCloseTo(0.7, 9);
  });

  it("warmer / cooler mix 20 % orange / blue in RGB", () => {
    const grey = { h: 0, s: 0, v: 0.5 };
    const [warmer, , cooler] = variationColors(grey, "temperature");
    const warm = hsvToRgb(warmer);
    const cool = hsvToRgb(cooler);
    expect(warm.r).toBeGreaterThan(warm.b);
    expect(cool.b).toBeGreaterThan(cool.r);
    expect(warm).toEqual({ r: 153, g: 127, b: 108 });
  });

  it("has no seam: neighbouring hues give neighbouring results", () => {
    const at = (h: number): number => variationColors({ h, s: 1, v: 1 }, "temperature")[0].h;
    expect(Math.abs(at(209) - at(211))).toBeLessThan(5);
  });

  it("more / less saturated step and clamp", () => {
    const [more, , less] = variationColors(base, "saturation");
    expect(more.s).toBeCloseTo(0.85, 9);
    expect(less.s).toBeCloseTo(0.35, 9);
    expect(variationColors({ h: 0, s: 0.9, v: 1 }, "saturation")[0].s).toBe(1);
  });
});

describe("mixToward", () => {
  it("mixes in RGB and keeps the hue of a grey result", () => {
    expect(hsvToRgb(mixToward({ h: 0, s: 0, v: 0 }, { r: 255, g: 255, b: 255 }, 0.5))).toEqual({ r: 128, g: 128, b: 128 });
    expect(mixToward({ h: 123, s: 0, v: 0 }, { r: 200, g: 200, b: 200 }, 0.5).h).toBe(123);
  });
});
describe("modes", () => {
  it("cycles and parses", () => {
    expect(nextMode(HARMONY_SET.modes, "analogous")).toBe("triadic");
    expect(nextMode(HARMONY_SET.modes, "split")).toBe("analogous");
    expect(parseMode(VARIATION_SET.modes, "saturation")).toBe("saturation");
    expect(parseMode(VARIATION_SET.modes, "nope")).toBe("tone");
    expect(parseMode(HARMONY_SET.modes, null)).toBe("analogous");
  });
});
