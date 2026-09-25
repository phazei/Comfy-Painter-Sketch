import { describe, expect, it } from "vitest";

import { cssCursor, iconCursor } from "./cursors";

describe("cursors", () => {
  it("uses the plain crosshair for rings and shapes", () => {
    expect(cssCursor({ kind: "ring", diameter: 20 })).toBe("crosshair");
    expect(cssCursor({ kind: "icon", icon: "crosshair" })).toBe("crosshair");
  });

  it("builds SVG data URL cursors with hotspot and crosshair fallback", () => {
    // eyedropper tip: M3 21 anchor → hotspot (3, 21)
    expect(iconCursor("eyedropper")).toMatch(/^url\("data:image\/svg\+xml,[^"]+"\) 3 21, crosshair$/);
    // bucket drip bottom: end of c0 1.5-.8 2.5-1.8 2.5 from (21,17) → (19.2, 19.5) → (19, 20)
    expect(iconCursor("bucket")).toMatch(/^url\("data:image\/svg\+xml,[^"]+"\) 19 20, crosshair$/);
  });

  it("encodes a well-formed SVG", () => {
    const match = /data:image\/svg\+xml,([^"]+)"/.exec(iconCursor("bucket"));
    const svg = decodeURIComponent(match?.[1] ?? "");
    expect(svg.startsWith("<svg xmlns='http://www.w3.org/2000/svg'")).toBe(true);
    expect(svg.endsWith("</svg>")).toBe(true);
  });

  it("reuses icon path data from icons.ts (no separate shape strings)", () => {
    // The bucket cursor SVG must contain the drip sub-path from icons.ts
    const match = /data:image\/svg\+xml,([^"]+)"/.exec(iconCursor("bucket"));
    const svg = decodeURIComponent(match?.[1] ?? "");
    expect(svg).toContain("M21 17");
    // The eyedropper cursor SVG must contain the pipette tip anchor from icons.ts
    const match2 = /data:image\/svg\+xml,([^"]+)"/.exec(iconCursor("eyedropper"));
    const svg2 = decodeURIComponent(match2?.[1] ?? "");
    expect(svg2).toContain("M3 21");
  });

  it("renders stroke-only (no fill) with two stroke passes", () => {
    const match = /data:image\/svg\+xml,([^"]+)"/.exec(iconCursor("eyedropper"));
    const svg = decodeURIComponent(match?.[1] ?? "");
    // Must not fill the open paths
    expect(svg).toContain("fill='none'");
    // Must have two <path> elements (dark outline + white icon)
    const pathCount = (svg.match(/<path /g) ?? []).length;
    expect(pathCount).toBe(2);
  });
});