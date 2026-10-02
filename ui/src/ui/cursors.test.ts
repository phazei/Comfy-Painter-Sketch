import { afterEach, describe, expect, it } from "vitest";

import { cursorSvg, DEFAULT_CURSOR_PALETTE, setCursorPalette } from "./cursorArt";
import { cssCursor, cursorBadge, dotCursor, iconCursor, iconCursorArt, RING_CROSS_BELOW, RING_DOT_FROM, stateCursors } from "./cursors";
import { hasIcon } from "./icons";
import { layerSelectCursorCss, moveCursorCss } from "./moveCursors";
import { ringBadgeOffset, ringBadgeSize } from "./ringCursor";

/** Decoded SVG of a CSS cursor value. */
function svgOf(css: string): string {
  const match = /data:image\/svg\+xml,([^"]+)"/.exec(css);
  return decodeURIComponent(match?.[1] ?? "");
}

afterEach(() => {
  setCursorPalette(DEFAULT_CURSOR_PALETTE);
});

describe("cursors", () => {
  it("every cursor is an SVG image (the OS cursor set never shows)", () => {
    for (const icon of ["crosshair", "eyedropper", "bucket", "move", "text", "lasso", "polygonLasso", "wand", "resize-ns", "resize-ew", "resize-nwse", "resize-nesw", "rotate"] as const) {
      expect(iconCursor(icon)).toMatch(/^url\("data:image\/svg\+xml,[^"]+"\) \d+ \d+, [a-z-]+$/);
    }
    for (const kind of ["cut", "copy", "outline", "move"] as const) expect(moveCursorCss(kind)).toMatch(/^url\(/);
    expect(moveCursorCss("move", true)).not.toBe(moveCursorCss("move"));
    expect(svgOf(moveCursorCss("move", true))).toContain(DEFAULT_CURSOR_PALETTE.ban);
    expect(layerSelectCursorCss("add")).toMatch(/^url\(/);
    const states = stateCursors();
    expect([states.grab, states.grabbing, states.busy].every((v) => v.startsWith("url("))).toBe(true);
  });

  it("hotspots: centre, Photoshop pointer tip, tool tips", () => {
    expect(iconCursor("crosshair")).toMatch(/\) 32 32, crosshair$/);
    expect(iconCursor("text")).toMatch(/\) 32 32, text$/);
    expect(iconCursor("bucket")).toMatch(/\) 3 3, default$/);
    expect(iconCursor("lasso")).toMatch(/\) 3 3, default$/);
    expect(iconCursor("move")).toMatch(/\) 3 3, move$/);
    expect(moveCursorCss("cut")).toMatch(/\) 3 3, move$/);
    expect(iconCursor("eyedropper")).toMatch(/\) 22 42, crosshair$/);
    expect(iconCursor("wand")).toMatch(/\) 41 23, crosshair$/);
  });

  it("ring tools: nothing in the centre, a dot on huge rings, the precise cross on tiny ones", () => {
    expect(cssCursor({ kind: "ring", diameter: 20 }, {}, 20)).toBe("none");
    expect(cssCursor({ kind: "ring", diameter: 20 }, {}, RING_DOT_FROM)).toBe(dotCursor());
    expect(cssCursor({ kind: "ring", diameter: 2 }, {}, RING_CROSS_BELOW - 1)).toBe(iconCursor("crosshair"));
    expect(dotCursor()).toMatch(/\) 4 4, crosshair$/);
  });

  it("badges: mode, target and ban change the cursor; ban replaces the mode", () => {
    const plain = iconCursor("crosshair");
    const add = iconCursor("crosshair", { mode: "add" });
    expect(new Set([plain, add, iconCursor("crosshair", { mode: "subtract" }), iconCursor("crosshair", { mode: "intersect" })]).size).toBe(4);
    const art = iconCursorArt("bucket", { mode: "add", target: true, ban: true });
    expect(art.parts.map((p) => p.icon)).toEqual(["bucket", "pointer", "mask", "ban"]);
    expect(art.parts.find((p) => p.icon === "ban")?.tone).toBe("ban");
    expect(art.parts.find((p) => p.icon === "mask")?.tone).toBe("accent");
  });

  it("selection badges: mode at pointer-down, only with a selection", () => {
    const base = { combinesSelection: true, hasSelection: true, shift: false, alt: false };
    expect(cursorBadge(base)).toBeNull();
    expect(cursorBadge({ ...base, shift: true })).toBe("add");
    expect(cursorBadge({ ...base, alt: true })).toBe("subtract");
    expect(cursorBadge({ ...base, shift: true, alt: true })).toBe("intersect");
    expect(cursorBadge({ ...base, shift: true, hasSelection: false })).toBeNull();
    expect(cursorBadge({ ...base, shift: true, combinesSelection: false })).toBeNull();
  });

  it("draws a halo pass under each glyph, in the palette colours", () => {
    const svg = svgOf(iconCursor("bucket"));
    expect(svg.startsWith("<svg xmlns='http://www.w3.org/2000/svg'")).toBe(true);
    expect(svg.endsWith("</svg>")).toBe(true);
    expect((svg.match(/class='h'/g) ?? []).length).toBe(2);
    expect(svg).toContain(DEFAULT_CURSOR_PALETTE.halo);
  });

  it("a palette change rebuilds the cursors", () => {
    const before = iconCursor("crosshair");
    expect(setCursorPalette({ ...DEFAULT_CURSOR_PALETTE, fg: "#ffff00" })).toBe(true);
    expect(setCursorPalette({ ...DEFAULT_CURSOR_PALETTE, fg: "#ffff00" })).toBe(false);
    const after = iconCursor("crosshair");
    expect(after).not.toBe(before);
    expect(svgOf(after)).toContain("#ffff00");
    expect(cursorSvg(iconCursorArt("crosshair"))).toContain("#ffff00");
  });

  it("every glyph the cursors use exists", () => {
    for (const name of ["preciseCross", "textCursor", "pointer", "bucket", "lasso", "polygonLasso", "eyedropper", "magicWand", "move", "cut", "copyPlus", "marqueeRect", "squareDashedPlus", "squareDashedMinus", "squareDashedX", "bgSlot", "mask", "ban", "eraser", "dot", "resizeNS", "resizeEW", "resizeNWSE", "resizeNESW", "rotate", "hand", "handGrab", "hourglass"]) {
      expect(hasIcon(name), name).toBe(true);
    }
  });
});

describe("ring indicators", () => {
  it("grow slightly with large rings, within bounds", () => {
    expect(ringBadgeSize(4)).toBe(16);
    expect(ringBadgeSize(50)).toBe(16);
    expect(ringBadgeSize(150)).toBe(20);
    expect(ringBadgeSize(1000)).toBe(24);
  });

  it("sit outside the ring, never on the centre dot", () => {
    const size = 16;
    // Inner corner distance from the centre = offset * sqrt2 - size / sqrt2.
    const inner = (r: number): number => ringBadgeOffset(r, size) * Math.SQRT2 - size / Math.SQRT2;
    expect(inner(100)).toBeCloseTo(103);
    expect(inner(1)).toBeCloseTo(9);
  });
});
