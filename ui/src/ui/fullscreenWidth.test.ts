import { describe, expect, it } from "vitest";

import { MIN_FULLSCREEN_WIDTH, parseStoredWidth, widthForPointer } from "./fullscreenWidth";

describe("widthForPointer", () => {
  // Overlay content 3000 px centred at 1500, handles 16 px -> available 2968.
  const center = 1500;
  const available = 2968;
  const handle = 16;

  it("is symmetric: either handle at the same distance gives the same width", () => {
    expect(widthForPointer(center - 700, center, available, handle)).toBe(1384);
    expect(widthForPointer(center + 700, center, available, handle)).toBe(1384);
  });

  it("snaps to full width near the edge", () => {
    expect(widthForPointer(center + available / 2 + 8, center, available, handle)).toBeNull();
    expect(widthForPointer(center + available / 2, center, available, handle)).toBeNull();
    expect(widthForPointer(-50, center, available, handle)).toBeNull();
  });

  it("stops at the minimum width", () => {
    expect(widthForPointer(center, center, available, handle)).toBe(MIN_FULLSCREEN_WIDTH);
    expect(widthForPointer(center + 100, center, available, handle)).toBe(MIN_FULLSCREEN_WIDTH);
  });

  it("never goes below the available width on a small window", () => {
    expect(widthForPointer(300, 300, 500, handle)).toBe(500);
  });
});

describe("parseStoredWidth", () => {
  it("reads a stored width", () => {
    expect(parseStoredWidth("1800")).toBe(1800);
    expect(parseStoredWidth("1800.6")).toBe(1801);
  });

  it("treats missing, broken or too small values as full width", () => {
    expect(parseStoredWidth(null)).toBeNull();
    expect(parseStoredWidth("wide")).toBeNull();
    expect(parseStoredWidth("NaN")).toBeNull();
    expect(parseStoredWidth(String(MIN_FULLSCREEN_WIDTH - 1))).toBeNull();
  });
});
