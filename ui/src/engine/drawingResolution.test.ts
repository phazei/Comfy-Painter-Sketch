import { describe, expect, it } from "vitest";

import { containsRect } from "../geometry/rect";
import type { Point, Rect, Size } from "../geometry/rect";
import type { Placement } from "../document/types";
import { pasteRect } from "./clipboardMath";
import { matchGeometry, minimumFrame, resolutionInfo, scaleTextData, transformPoint } from "./drawingResolution";
import { docToImage, documentMap, imageLengthToDoc } from "./frameMap";

// ── Minimum frame ─────────────────────────────────────────────────────────────

describe("minimumFrame", () => {
  it("boosts a small square to 1024", () => {
    expect(minimumFrame({ width: 512, height: 512 })).toEqual({ width: 1024, height: 1024 });
  });

  it("boosts 9:16 on the short side", () => {
    expect(minimumFrame({ width: 576, height: 1024 })).toEqual({ width: 1024, height: 1820 });
  });

  it("caps a tiny strip's boost by the 4096 long side", () => {
    expect(minimumFrame({ width: 100, height: 1000 })).toEqual({ width: 410, height: 4096 });
  });

  it("never boosts when the long side is already >= 4096, never shrinks", () => {
    expect(minimumFrame({ width: 200, height: 5000 })).toEqual({ width: 200, height: 5000 });
    expect(minimumFrame({ width: 2048, height: 1536 })).toEqual({ width: 2048, height: 1536 });
    expect(minimumFrame({ width: 1024, height: 1024 })).toEqual({ width: 1024, height: 1024 });
  });
});

// ── Ratio ─────────────────────────────────────────────────────────────────────

describe("resolutionInfo", () => {
  it("is 1 for a frame freshly set from the image", () => {
    const image = { width: 512, height: 768 };
    const info = resolutionInfo({ frame: minimumFrame(image) }, image);
    expect(info.ratio).toBeCloseTo(1, 9);
    expect(info.mismatch).toBe(false);
  });

  it("measures image px per doc px incl. placement scale", () => {
    const image = { width: 2048, height: 2048 };
    expect(resolutionInfo({ frame: { width: 1024, height: 1024 } }, image)).toEqual({ ratio: 2, gridPx: 1024, imagePx: 2048, mismatch: true });
    const scaled = resolutionInfo({ frame: { width: 2048, height: 2048 }, placement: { x: 0, y: 0, scale: 1.6 } }, image);
    expect(scaled.ratio).toBeCloseTo(1.6, 9);
    expect(scaled.mismatch).toBe(true);
  });

  it("stays quiet at 1.5x and below", () => {
    expect(resolutionInfo({ frame: { width: 1024, height: 1024 } }, { width: 1536, height: 1536 }).mismatch).toBe(false);
  });
});

// ── Match geometry ────────────────────────────────────────────────────────────

function corners(r: Rect): Point[] {
  return [{ x: r.x, y: r.y }, { x: r.x + r.width, y: r.y + r.height }, { x: r.x + r.width, y: r.y }, { x: r.x, y: r.y + r.height }];
}

function checkKeepsPosition(frame: Size, bounds: Rect, image: Size, placement?: Placement): void {
  const doc = { frame, bounds, ...(placement ? { placement } : {}) };
  const g = matchGeometry(doc, image);
  const before = documentMap(doc, image);
  const after = documentMap({ frame: g.frame, ...(g.placement ? { placement: g.placement } : {}) }, image);
  for (const p of [...corners(bounds), { x: 17.25, y: 3.5 }]) {
    const a = docToImage(before, p);
    const b = docToImage(after, transformPoint(g.transform, p));
    expect(Math.abs(a.x - b.x)).toBeLessThan(0.5);
    expect(Math.abs(a.y - b.y)).toBeLessThan(0.5);
  }
  expect(g.frame).toEqual(minimumFrame(image));
  expect(containsRect(g.bounds, { x: 0, y: 0, width: g.frame.width, height: g.frame.height })).toBe(true);
  if (!g.cropped) {
    const moved = corners(bounds).map((p) => transformPoint(g.transform, p));
    for (const q of moved) {
      expect(q.x).toBeGreaterThanOrEqual(g.bounds.x - 1e-6);
      expect(q.x).toBeLessThanOrEqual(g.bounds.x + g.bounds.width + 1e-6);
      expect(q.y).toBeGreaterThanOrEqual(g.bounds.y - 1e-6);
      expect(q.y).toBeLessThanOrEqual(g.bounds.y + g.bounds.height + 1e-6);
    }
  }
}

describe("matchGeometry", () => {
  it("2x upscale, identity placement: frame = image, content keeps its image position", () => {
    checkKeepsPosition({ width: 1024, height: 1024 }, { x: -256, y: 0, width: 1536, height: 1024 }, { width: 2048, height: 2048 });
    const g = matchGeometry({ frame: { width: 1024, height: 1024 }, bounds: { x: 0, y: 0, width: 1024, height: 1024 } }, { width: 2048, height: 2048 });
    expect(g.transform).toEqual({ factor: 2, tx: 0, ty: 0 });
    expect(g.bounds).toEqual({ x: 0, y: 0, width: 2048, height: 2048 });
    expect(g.placement).toBeUndefined();
  });

  it("folds a moved + scaled placement back to identity", () => {
    checkKeepsPosition({ width: 1024, height: 768 }, { x: -100, y: -50, width: 1300, height: 900 }, { width: 3000, height: 2000 }, { x: 37.5, y: -12, scale: 1.7 });
  });

  it("different aspect (letterboxed frame)", () => {
    checkKeepsPosition({ width: 1024, height: 1024 }, { x: 0, y: 0, width: 1024, height: 1024 }, { width: 4000, height: 2250 });
  });

  it("small image with a large placement scale (boosted frame)", () => {
    checkKeepsPosition({ width: 1024, height: 1024 }, { x: 0, y: 0, width: 1024, height: 1024 }, { width: 512, height: 512 }, { x: 0, y: 0, scale: 4 });
  });

  it("crops to the 16384 bounds limit and reports it", () => {
    const g = matchGeometry({ frame: { width: 2000, height: 2000 }, bounds: { x: -2000, y: 0, width: 6000, height: 2000 } }, { width: 8000, height: 8000 });
    expect(g.cropped).toBe(true);
    expect(g.bounds.width).toBe(16384);
    expect(containsRect(g.bounds, { x: 0, y: 0, width: 8000, height: 8000 })).toBe(true);
  });
});

describe("scaleTextData", () => {
  it("moves the anchor and scales the size", () => {
    const td = { text: "hi", x: 10, y: 20, size: 48, font: "Arial", color: "#000000", align: "left" as const, lineHeight: 1.25, bold: false, italic: false };
    const out = scaleTextData(td, { factor: 2, tx: 5, ty: -5 });
    expect(out).toMatchObject({ x: 25, y: 35, size: 96, text: "hi" });
    expect(scaleTextData(td, { factor: 1000, tx: 0, ty: 0 }).size).toBe(4096);
  });
});

// ── 1:1 paste and brush size with a fit scale != 1 ───────────────────────────

describe("image-px tools on a boosted frame (fit scale 0.5)", () => {
  const image = { width: 512, height: 512 };
  const map = documentMap({ frame: minimumFrame(image) }, image);

  it("maps 2 doc px per image px", () => {
    expect(map.scale).toBe(0.5);
    expect(imageLengthToDoc(map, 20)).toBe(40); // brush size is in image px
  });

  it("a pasted image covers exactly its own size in image px", () => {
    const rect = pasteRect({ width: 100, height: 60 }, 1 / map.scale, { centre: { x: 512, y: 512 } });
    expect(rect).toEqual({ x: 412, y: 452, width: 200, height: 120 });
    expect(rect.width * map.scale).toBe(100);
    expect(rect.height * map.scale).toBe(60);
  });
});
