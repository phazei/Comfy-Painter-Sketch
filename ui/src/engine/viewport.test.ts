import { describe, expect, it } from "vitest";

import { backingStoreSize, clampOffset, fitContain, fitView, MAX_ZOOM, panBy, stageToDoc, zoomAt } from "./viewport";

describe("view transform", () => {
  it("fits the frame centered", () => {
    expect(fitView({ width: 200, height: 100 }, { width: 120, height: 120 }, 10)).toEqual({
      scale: 0.5,
      offsetX: 10,
      offsetY: 35,
    });
  });

  it("zooms around the anchor keeping the document point fixed", () => {
    const view = { scale: 1, offsetX: 10, offsetY: 20 };
    const anchor = { x: 60, y: 70 };
    const before = stageToDoc(view, anchor);
    const zoomed = zoomAt(view, 4, anchor);
    expect(zoomed.scale).toBe(4);
    expect(stageToDoc(zoomed, anchor)).toEqual(before);
  });

  it("clamps zoom and pans", () => {
    expect(zoomAt({ scale: 1, offsetX: 0, offsetY: 0 }, 1e9, { x: 0, y: 0 }).scale).toBe(MAX_ZOOM);
    expect(panBy({ scale: 2, offsetX: 1, offsetY: 1 }, 5, -3)).toEqual({ scale: 2, offsetX: 6, offsetY: -2 });
  });
});

describe("fitContain", () => {
  it("letterboxes a wide image top and bottom", () => {
    const fit = fitContain({ width: 200, height: 100 }, { width: 100, height: 100 });
    expect(fit).toEqual({ x: 0, y: 25, width: 100, height: 50, scale: 0.5 });
  });

  it("pillarboxes a tall image left and right", () => {
    const fit = fitContain({ width: 100, height: 400 }, { width: 300, height: 200 });
    expect(fit).toEqual({ x: 125, y: 0, width: 50, height: 200, scale: 0.5 });
  });

  it("scales small content up to fill the viewport", () => {
    const fit = fitContain({ width: 10, height: 10 }, { width: 100, height: 50 });
    expect(fit.scale).toBe(5);
    expect(fit).toMatchObject({ x: 25, y: 0, width: 50, height: 50 });
  });

  it("applies padding on every side before fitting", () => {
    const fit = fitContain({ width: 100, height: 100 }, { width: 120, height: 220 }, 10);
    expect(fit).toEqual({ x: 10, y: 60, width: 100, height: 100, scale: 1 });
  });

  it("returns an empty centered rect for degenerate sizes instead of NaN", () => {
    for (const [content, viewport] of [
      [{ width: 0, height: 10 }, { width: 100, height: 100 }],
      [{ width: 10, height: 10 }, { width: 0, height: 100 }],
      [{ width: Number.NaN, height: 10 }, { width: 100, height: 100 }],
    ] as const) {
      const fit = fitContain(content, viewport);
      expect(fit.width).toBe(0);
      expect(fit.height).toBe(0);
      expect(Number.isFinite(fit.x) && Number.isFinite(fit.y)).toBe(true);
    }
  });
});

describe("backingStoreSize", () => {
  it("multiplies layout size by devicePixelRatio and display scale", () => {
    expect(backingStoreSize({ width: 100, height: 50 }, 2, 1.5)).toEqual({
      width: 300,
      height: 150,
      ratio: 3,
    });
  });

  it("clamps the longest side while keeping aspect ratio", () => {
    const size = backingStoreSize({ width: 2000, height: 1000 }, 2, 2, 4000);
    expect(size.width).toBe(4000);
    expect(size.height).toBe(2000);
  });

  it("never returns a zero-sized store and tolerates bad ratios", () => {
    expect(backingStoreSize({ width: 0, height: 0 }, Number.NaN, 0)).toEqual({
      width: 1,
      height: 1,
      ratio: 1,
    });
  });
});

describe("clampOffset", () => {
  // frame 200x100 at scale 1 -> on-screen 200x100, stage 400x300
  // grip = min(64, 200)=64 on X, min(64,100)=64 on Y
  // minOffsetX = 64-200 = -136, maxOffsetX = 400-64 = 336
  // minOffsetY = 64-100 = -36,  maxOffsetY = 300-64 = 236
  const frame = { width: 200, height: 100 };
  const stage = { width: 400, height: 300 };

  it("leaves a well-placed view unchanged", () => {
    const view = { scale: 1, offsetX: 100, offsetY: 100 };
    expect(clampOffset(view, frame, stage)).toEqual(view);
  });

  it("clamps a panned-too-far-right offset (image off right edge)", () => {
    // offsetX=380 means left edge of image at 380 > maxOffsetX=336 -> clamp to 336
    const view = { scale: 1, offsetX: 380, offsetY: 100 };
    const result = clampOffset(view, frame, stage);
    expect(result.offsetX).toBe(336);
    expect(result.offsetY).toBe(100);
    expect(result.scale).toBe(1);
  });

  it("clamps a panned-too-far-left offset (image off left edge)", () => {
    // offsetX=-200 means right edge = -200+200=0 < grip=64 -> clamp to -136
    const view = { scale: 1, offsetX: -200, offsetY: 100 };
    const result = clampOffset(view, frame, stage);
    expect(result.offsetX).toBe(-136);
  });

  it("clamps a panned-too-far-up offset (image above stage)", () => {
    // offsetY=-100 means bottom=0 < grip=64 -> clamp to -36
    const view = { scale: 1, offsetX: 100, offsetY: -100 };
    const result = clampOffset(view, frame, stage);
    expect(result.offsetY).toBe(-36);
  });

  it("clamps a panned-too-far-down offset (image below stage)", () => {
    // offsetY=300 > maxOffsetY=236 -> clamp to 236
    const view = { scale: 1, offsetX: 100, offsetY: 300 };
    const result = clampOffset(view, frame, stage);
    expect(result.offsetY).toBe(236);
  });

  it("uses image on-screen size as grip when image is smaller than 64px", () => {
    // frame 20x20 at scale=1 -> on-screen 20x20; grip = min(64,20)=20
    // stage 400x400; minOffsetX=20-20=0, maxOffsetX=400-20=380
    const smallFrame = { width: 20, height: 20 };
    const bigStage = { width: 400, height: 400 };
    const view = { scale: 1, offsetX: -5, offsetY: -5 };
    const result = clampOffset(view, smallFrame, bigStage);
    // minOffset = 20-20=0, so -5 is clamped to 0
    expect(result.offsetX).toBe(0);
    expect(result.offsetY).toBe(0);
  });

  it("returns unchanged when stage or frame is degenerate", () => {
    const view = { scale: 1, offsetX: -9999, offsetY: -9999 };
    expect(clampOffset(view, { width: 0, height: 100 }, stage)).toEqual(view);
    expect(clampOffset(view, frame, { width: 0, height: 300 })).toEqual(view);
  });
});