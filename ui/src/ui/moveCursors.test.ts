import { describe, expect, it } from "vitest";

import { moveCursorCss, moveCursorKind } from "./moveCursors";

const base = { toolId: "move-layer", alt: false, inSelection: true, floatActive: false };

describe("moveCursorKind", () => {
  it("Move tool inside the selection: cut; Alt: copy", () => {
    expect(moveCursorKind(base)).toBe("cut");
    expect(moveCursorKind({ ...base, alt: true })).toBe("copy");
  });

  it("outside the selection or with a float: plain move", () => {
    expect(moveCursorKind({ ...base, inSelection: false })).toBe("move");
    expect(moveCursorKind({ ...base, inSelection: false, alt: true })).toBe("move");
    expect(moveCursorKind({ ...base, floatActive: true })).toBe("move");
  });

  it("outline drag substitute: outline; other tools: none", () => {
    expect(moveCursorKind({ ...base, toolId: "selection-outline" })).toBe("outline");
    expect(moveCursorKind({ ...base, toolId: "brush" })).toBeNull();
    expect(moveCursorKind({ ...base, toolId: "eyedropper-temp", alt: true })).toBeNull();
  });
});

describe("moveCursorCss", () => {
  it("every kind is a cached pointer-layout SVG URL with hotspot + fallback", () => {
    expect(moveCursorCss("move")).toMatch(/^url\("data:image\/svg\+xml,.+"\) 3 3, move$/);
    const cut = moveCursorCss("cut");
    expect(cut).toMatch(/^url\("data:image\/svg\+xml,.+"\) 3 3, move$/);
    expect(moveCursorCss("cut")).toBe(cut);
    expect(moveCursorCss("copy")).not.toBe(cut);
    expect(moveCursorCss("outline")).toMatch(/\) 3 3, default$/);
  });
});
