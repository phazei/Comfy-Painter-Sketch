import { describe, expect, it } from "vitest";

import { ColorState, normalizeHex } from "./colors";

describe("normalizeHex", () => {
  it("accepts #rgb / #rrggbb in any case, with or without #", () => {
    expect(normalizeHex("#ABC")).toBe("#aabbcc");
    expect(normalizeHex("FF8800")).toBe("#ff8800");
    expect(normalizeHex(" #00ff00 ")).toBe("#00ff00");
  });

  it("rejects everything else", () => {
    expect(normalizeHex("red")).toBeNull();
    expect(normalizeHex("#12345")).toBeNull();
    expect(normalizeHex("")).toBeNull();
  });
});

describe("ColorState", () => {
  it("sets, swaps (X) and resets (D), emitting only on change", () => {
    const colors = new ColorState();
    const seen: string[] = [];
    colors.events.on("change", (c) => seen.push(`${c.fg}/${c.bg}`));
    colors.set("fg", "#F00");
    colors.set("fg", "#ff0000");
    colors.set("bg", "nope");
    colors.swap();
    colors.reset();
    colors.reset();
    expect(seen).toEqual(["#ff0000/#ffffff", "#ffffff/#ff0000", "#000000/#ffffff"]);
  });
});
