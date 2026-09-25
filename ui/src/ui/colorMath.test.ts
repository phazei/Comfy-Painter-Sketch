import { describe, expect, it } from "vitest";

import {
  clamp01,
  hexToHsv,
  hexToRgb,
  hsvToHex,
  hsvToRgb,
  rgbToHex,
  rgbToHsv,
} from "./colorMath";

// ── hexToRgb ──────────────────────────────────────────────────────────────

describe("hexToRgb", () => {
  it("parses #rrggbb", () => {
    expect(hexToRgb("#ff8000")).toEqual({ r: 255, g: 128, b: 0 });
  });

  it("parses #rgb (shorthand)", () => {
    expect(hexToRgb("#f80")).toEqual({ r: 255, g: 136, b: 0 });
  });

  it("parses without leading #", () => {
    expect(hexToRgb("aabbcc")).toEqual({ r: 170, g: 187, b: 204 });
  });

  it("is case-insensitive", () => {
    expect(hexToRgb("#FF0000")).toEqual({ r: 255, g: 0, b: 0 });
  });

  it("returns null for invalid input", () => {
    expect(hexToRgb("gg0000")).toBeNull();
    expect(hexToRgb("")).toBeNull();
    expect(hexToRgb("#fffff")).toBeNull();
  });
});

// ── rgbToHex ──────────────────────────────────────────────────────────────

describe("rgbToHex", () => {
  it("produces lowercase #rrggbb", () => {
    expect(rgbToHex({ r: 255, g: 128, b: 0 })).toBe("#ff8000");
    expect(rgbToHex({ r: 0, g: 0, b: 0 })).toBe("#000000");
    expect(rgbToHex({ r: 255, g: 255, b: 255 })).toBe("#ffffff");
  });

  it("clamps and rounds channels", () => {
    expect(rgbToHex({ r: -10, g: 300, b: 127.6 })).toBe("#00ff80");
  });
});

// ── rgbToHsv / hsvToRgb ───────────────────────────────────────────────────

describe("rgbToHsv", () => {
  it("maps black to v=0", () => {
    const { h, s, v } = rgbToHsv({ r: 0, g: 0, b: 0 });
    expect(v).toBe(0);
    expect(s).toBe(0);
    expect(h).toBe(0);
  });

  it("maps white to s=0, v=1", () => {
    const { s, v } = rgbToHsv({ r: 255, g: 255, b: 255 });
    expect(s).toBeCloseTo(0);
    expect(v).toBeCloseTo(1);
  });

  it("maps pure red to h=0, s=1, v=1", () => {
    const { h, s, v } = rgbToHsv({ r: 255, g: 0, b: 0 });
    expect(h).toBeCloseTo(0);
    expect(s).toBeCloseTo(1);
    expect(v).toBeCloseTo(1);
  });

  it("maps pure green to h=120", () => {
    const { h } = rgbToHsv({ r: 0, g: 255, b: 0 });
    expect(h).toBeCloseTo(120);
  });

  it("maps pure blue to h=240", () => {
    const { h } = rgbToHsv({ r: 0, g: 0, b: 255 });
    expect(h).toBeCloseTo(240);
  });
});

describe("hsvToRgb", () => {
  it("returns red for h=0, s=1, v=1", () => {
    expect(hsvToRgb({ h: 0, s: 1, v: 1 })).toEqual({ r: 255, g: 0, b: 0 });
  });

  it("returns green for h=120, s=1, v=1", () => {
    expect(hsvToRgb({ h: 120, s: 1, v: 1 })).toEqual({ r: 0, g: 255, b: 0 });
  });

  it("returns blue for h=240, s=1, v=1", () => {
    expect(hsvToRgb({ h: 240, s: 1, v: 1 })).toEqual({ r: 0, g: 0, b: 255 });
  });

  it("returns black for v=0", () => {
    expect(hsvToRgb({ h: 0, s: 0, v: 0 })).toEqual({ r: 0, g: 0, b: 0 });
  });

  it("returns white for s=0, v=1", () => {
    expect(hsvToRgb({ h: 0, s: 0, v: 1 })).toEqual({ r: 255, g: 255, b: 255 });
  });

  it("wraps hue >= 360", () => {
    expect(hsvToRgb({ h: 360, s: 1, v: 1 })).toEqual(hsvToRgb({ h: 0, s: 1, v: 1 }));
  });

  it("clamps s/v to [0,1]", () => {
    expect(hsvToRgb({ h: 0, s: 2, v: 2 })).toEqual({ r: 255, g: 0, b: 0 });
    expect(hsvToRgb({ h: 0, s: -1, v: -1 })).toEqual({ r: 0, g: 0, b: 0 });
  });
});

// ── Round-trips ───────────────────────────────────────────────────────────

describe("round-trips", () => {
  const samples = ["#000000", "#ffffff", "#ff0000", "#00ff00", "#0000ff", "#ff8000", "#4a90d9", "#1a2b3c"];

  it("hex -> rgb -> hex is lossless", () => {
    for (const hex of samples) {
      const rgb = hexToRgb(hex);
      expect(rgb).not.toBeNull();
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      expect(rgbToHex(rgb!)).toBe(hex);
    }
  });

  it("hex -> hsv -> hex is within 1 LSB per channel", () => {
    for (const hex of samples) {
      const hsv = hexToHsv(hex);
      expect(hsv).not.toBeNull();
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const result = hsvToHex(hsv!);
      const original = hexToRgb(hex)!;
      const roundtripped = hexToRgb(result)!;
      expect(Math.abs(roundtripped.r - original.r)).toBeLessThanOrEqual(1);
      expect(Math.abs(roundtripped.g - original.g)).toBeLessThanOrEqual(1);
      expect(Math.abs(roundtripped.b - original.b)).toBeLessThanOrEqual(1);
    }
  });
});

// ── clamp01 ───────────────────────────────────────────────────────────────

describe("clamp01", () => {
  it("clamps below 0", () => expect(clamp01(-0.5)).toBe(0));
  it("clamps above 1", () => expect(clamp01(1.5)).toBe(1));
  it("passes through values in range", () => expect(clamp01(0.5)).toBe(0.5));
});
