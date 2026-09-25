import { describe, expect, it } from "vitest";

import {
  MAX_FRAME_SIDE,
  MIN_FRAME_SIDE,
  normalizeHexColor,
  resolveFallbackFrame,
  sanitizeDimension,
} from "./frameFallback";

describe("normalizeHexColor", () => {
  it("expands short forms and lowercases", () => {
    expect(normalizeHexColor("#FA0")).toBe("#ffaa00");
    expect(normalizeHexColor("fa08")).toBe("#ffaa0088");
    expect(normalizeHexColor(" #AbCdEf ")).toBe("#abcdef");
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
  it("uses schema defaults for missing widgets when there was never a frame", () => {
    expect(resolveFallbackFrame(null, undefined, undefined, undefined)).toEqual({
      size: { width: 1024, height: 1024 },
      color: "#ffffff",
    });
  });

  it("uses the width/height widgets when there was never a frame", () => {
    expect(resolveFallbackFrame(null, 640, 480, "#000")).toEqual({
      size: { width: 640, height: 480 },
      color: "#000000",
    });
  });

  it("keeps the last known frame size over the widgets, filled with background", () => {
    expect(resolveFallbackFrame({ width: 1920, height: 1080 }, 640, 480, "#123456")).toEqual({
      size: { width: 1920, height: 1080 },
      color: "#123456",
    });
  });

  it("ignores a degenerate known frame", () => {
    expect(resolveFallbackFrame({ width: 0, height: 100 }, 640, 480, "#fff").size).toEqual({
      width: 640,
      height: 480,
    });
  });
});
