import { describe, expect, it } from "vitest";

import {
  MAX_FRAME_SIDE,
  MIN_FRAME_SIDE,
  normalizeHexColor,
  resolveFallbackFrame,
  sanitizeDimension,
  widgetDimension,
} from "./frameFallback";

describe("normalizeHexColor", () => {
  it("expands short forms and lowercases", () => {
    expect(normalizeHexColor("#FA0")).toBe("#ffaa00");
    expect(normalizeHexColor(" #AbCdEf ")).toBe("#abcdef");
  });

  it("drops alpha so the background is opaque like the IMAGE output", () => {
    expect(normalizeHexColor("fa08")).toBe("#ffaa00");
    expect(normalizeHexColor("#11223380")).toBe("#112233");
  });

  it("falls back on invalid input", () => {
    expect(normalizeHexColor("red")).toBe("#ffffff");
    expect(normalizeHexColor("#12345")).toBe("#ffffff");
    expect(normalizeHexColor(null, "#000000")).toBe("#000000");
  });
});

describe("sanitizeDimension", () => {
  it("rounds and clamps", () => {
    expect(sanitizeDimension(511.6, 1)).toBe(512);
    expect(sanitizeDimension(0, 1)).toBe(MIN_FRAME_SIDE);
    expect(sanitizeDimension(1e9, 1)).toBe(MAX_FRAME_SIDE);
    expect(sanitizeDimension("768", 1)).toBe(768);
    expect(sanitizeDimension("abc", 64)).toBe(64);
  });
});

describe("resolveFallbackFrame", () => {
  it("uses schema defaults for missing widgets", () => {
    expect(resolveFallbackFrame(undefined, undefined, undefined)).toEqual({
      size: { width: 1024, height: 1024 },
      color: "#ffffff",
    });
  });

  it("always uses the width/height widgets", () => {
    expect(resolveFallbackFrame(640, 480, "#000")).toEqual({
      size: { width: 640, height: 480 },
      color: "#000000",
    });
  });
});

describe("widgetDimension", () => {
  it("rounds to the nearest widget step", () => {
    expect(widgetDimension(1024)).toBe(1024);
    expect(widgetDimension(1917)).toBe(1920);
    expect(widgetDimension(1083)).toBe(1080);
    expect(widgetDimension(1084)).toBe(1088);
  });

  it("clamps to the widget range", () => {
    expect(widgetDimension(10)).toBe(MIN_FRAME_SIDE);
    expect(widgetDimension(20000)).toBe(MAX_FRAME_SIDE);
  });
});
