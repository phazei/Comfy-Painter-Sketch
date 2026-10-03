import { describe, expect, it } from "vitest";

import { formatColor, parseColor, parseFormat } from "./colorFields";
import { hsvToHex } from "./colorMath";

const orange = { h: 30, s: 1, v: 1 };

describe("formatColor", () => {
  it("writes each format", () => {
    expect(formatColor(orange, "hex")).toEqual(["FF8000"]);
    expect(formatColor(orange, "rgb")).toEqual(["255", "128", "0"]);
    expect(formatColor(orange, "hsv")).toEqual(["30", "100", "100"]);
    expect(formatColor(orange, "hsl")).toEqual(["30", "100", "50"]);
  });
});

describe("parseColor", () => {
  it("reads each format back", () => {
    for (const format of ["hex", "rgb", "hsv", "hsl"] as const) {
      const parsed = parseColor(formatColor(orange, format), format, orange);
      expect(parsed && hsvToHex(parsed)).toBe("#ff8000");
    }
  });

  it("accepts hex with or without #", () => {
    expect(parseColor(["#00ff00"], "hex", orange)?.h).toBe(120);
  });

  it("rejects empty, non-numeric and out-of-range fields", () => {
    expect(parseColor(["zz"], "hex", orange)).toBeNull();
    expect(parseColor(["255", "", "0"], "rgb", orange)).toBeNull();
    expect(parseColor(["256", "0", "0"], "rgb", orange)).toBeNull();
    expect(parseColor(["10", "x", "0"], "hsv", orange)).toBeNull();
    expect(parseColor(["10", "101", "0"], "hsl", orange)).toBeNull();
  });

  it("keeps the current hue for greys", () => {
    expect(parseColor(["808080"], "hex", orange)?.h).toBe(30);
    expect(parseColor(["0", "0", "0"], "rgb", orange)?.h).toBe(30);
  });

  it("wraps hue 360 to 0", () => {
    expect(parseColor(["360", "100", "100"], "hsv", orange)?.h).toBe(0);
  });
});

describe("parseFormat", () => {
  it("falls back to hex", () => {
    expect(parseFormat("hsl")).toBe("hsl");
    expect(parseFormat("cmyk")).toBe("hex");
    expect(parseFormat(null)).toBe("hex");
  });
});
