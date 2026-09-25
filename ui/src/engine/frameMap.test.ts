import { describe, expect, it } from "vitest";

import {
  docRectToImage,
  docToImage,
  documentMap,
  frameMap,
  IDENTITY_MAP,
  imageLengthToDoc,
  imageRectToDoc,
  imageToDoc,
  layerPlacement,
  roundHalfEven,
} from "./frameMap";

describe("frameMap", () => {
  it("is the identity when sizes match", () => {
    expect(frameMap({ width: 640, height: 480 }, { width: 640, height: 480 })).toEqual(IDENTITY_MAP);
  });

  it("uses s = min(W/fw, H/fh), centred (contract formula)", () => {
    expect(frameMap({ width: 100, height: 100 }, { width: 200, height: 100 })).toEqual({ scale: 1, offsetX: 50, offsetY: 0 });
    expect(frameMap({ width: 400, height: 200 }, { width: 100, height: 100 })).toEqual({
      scale: 0.25,
      offsetX: 0,
      offsetY: 25,
    });
    expect(frameMap({ width: 512, height: 512 }, { width: 1024, height: 768 })).toEqual({
      scale: 1.5,
      offsetX: 128,
      offsetY: 0,
    });
  });

  it("maps the doc frame into the image and rects consistently", () => {
    const map = frameMap({ width: 400, height: 200 }, { width: 100, height: 100 });
    expect(docRectToImage(map, { x: 0, y: 0, width: 400, height: 200 })).toEqual({ x: 0, y: 25, width: 100, height: 50 });
    expect(docToImage(map, { x: -100, y: 0 })).toEqual({ x: -25, y: 25 });
  });

  it("round-trips through the inverse", () => {
    const map = frameMap({ width: 777, height: 333 }, { width: 1024, height: 1536 });
    for (const p of [{ x: 0, y: 0 }, { x: 12.25, y: -40.5 }, { x: 777, y: 333 }, { x: -300, y: 900 }]) {
      const back = imageToDoc(map, docToImage(map, p));
      expect(back.x).toBeCloseTo(p.x, 9);
      expect(back.y).toBeCloseTo(p.y, 9);
    }
  });

  it("A -> B -> A with different aspects returns exactly the original mapping (nothing resampled)", () => {
    const doc = { width: 800, height: 600 };
    const a = { width: 800, height: 600 };
    const b = { width: 512, height: 1024 };
    const first = frameMap(doc, a);
    const viaB = frameMap(doc, b);
    expect(viaB.scale).toBeLessThan(1);
    let last = first;
    for (let i = 0; i < 5; i++) {
      frameMap(doc, b);
      last = frameMap(doc, a);
    }
    expect(last).toEqual(first);
    expect(last).toEqual(IDENTITY_MAP);
  });

  it("converts image-space lengths (brush size) to doc px", () => {
    const map = frameMap({ width: 1000, height: 1000 }, { width: 500, height: 500 });
    expect(imageLengthToDoc(map, 20)).toBe(40);
  });

  it("falls back to identity for degenerate sizes", () => {
    expect(frameMap({ width: 0, height: 10 }, { width: 10, height: 10 })).toEqual(IDENTITY_MAP);
    expect(frameMap({ width: 10, height: 10 }, { width: Number.NaN, height: 10 })).toEqual(IDENTITY_MAP);
  });
});

describe("frameMap with placement (matches nodes/composite.py _layout)", () => {
  const sizes = [
    [{ width: 640, height: 480 }, { width: 640, height: 480 }],
    [{ width: 400, height: 200 }, { width: 100, height: 100 }],
    [{ width: 512, height: 512 }, { width: 1024, height: 768 }],
  ] as const;

  it("identity placement equals the old (placement-free) map exactly", () => {
    for (const [frame, image] of sizes) {
      expect(frameMap(frame, image, { x: 0, y: 0, scale: 1 })).toEqual(frameMap(frame, image));
      expect(documentMap({ frame }, image)).toEqual(frameMap(frame, image));
    }
  });

  it("matches hand-computed values", () => {
    // Same numbers as tests/test_placement.py::test_hand_computed.
    expect(frameMap({ width: 100, height: 100 }, { width: 50, height: 50 }, { x: 10, y: 4, scale: 2 })).toEqual({
      scale: 1,
      offsetX: -20,
      offsetY: -23,
    });
    // Translate only, same size: +10 / +5 image px.
    expect(frameMap({ width: 100, height: 100 }, { width: 100, height: 100 }, { x: 10, y: 5, scale: 1 })).toEqual({
      scale: 1,
      offsetX: 10,
      offsetY: 5,
    });
    // Frame mismatch (s = 1, offset 50) + 10 px.
    expect(frameMap({ width: 100, height: 100 }, { width: 200, height: 100 }, { x: 10, y: 0, scale: 1 })).toEqual({
      scale: 1,
      offsetX: 60,
      offsetY: 0,
    });
  });

  it("scales about the frame centre", () => {
    const map = frameMap({ width: 100, height: 100 }, { width: 100, height: 100 }, { x: 0, y: 0, scale: 2 });
    expect(docToImage(map, { x: 50, y: 50 })).toEqual({ x: 50, y: 50 });
    expect(docToImage(map, { x: 45, y: 55 })).toEqual({ x: 40, y: 60 });
  });

  it("round-trips through the inverse with placement", () => {
    const map = frameMap({ width: 777, height: 333 }, { width: 1024, height: 1536 }, { x: -13.5, y: 42, scale: 0.37 });
    for (const p of [{ x: 0, y: 0 }, { x: 12.25, y: -40.5 }, { x: 777, y: 333 }]) {
      const back = imageToDoc(map, docToImage(map, p));
      expect(back.x).toBeCloseTo(p.x, 9);
      expect(back.y).toBeCloseTo(p.y, 9);
    }
    const r = { x: -5, y: 7, width: 30, height: 12 };
    const rr = imageRectToDoc(map, docRectToImage(map, r));
    expect(rr.x).toBeCloseTo(r.x, 9);
    expect(rr.width).toBeCloseTo(r.width, 9);
  });

  it("brush size conversion uses the effective scale", () => {
    const map = frameMap({ width: 1000, height: 1000 }, { width: 500, height: 500 }, { x: 0, y: 0, scale: 2 });
    expect(imageLengthToDoc(map, 20)).toBe(20);
  });

  it("layerPlacement composes placement with Python rounding", () => {
    const map = frameMap({ width: 100, height: 100 }, { width: 100, height: 100 }, { x: 10, y: 5, scale: 1 });
    expect(layerPlacement(map, { x: 0, y: 0, width: 100, height: 100 })).toEqual({ x: 10, y: 5, width: 100, height: 100 });
    const scaled = frameMap({ width: 100, height: 100 }, { width: 100, height: 100 }, { x: 0, y: 0, scale: 2 });
    expect(layerPlacement(scaled, { x: 0, y: 0, width: 100, height: 100 })).toEqual({ x: -50, y: -50, width: 200, height: 200 });
  });
});

describe("layerPlacement (matches nodes/composite.py _place_layer)", () => {
  it("rounds half to even like Python round()", () => {
    expect([0.5, 1.5, 2.5, -0.5, -1.5, 2.4, 2.6].map(roundHalfEven)).toEqual([0, 2, 2, 0, -2, 2, 3]);
  });

  it("keeps integer placement at s = 1", () => {
    const map = frameMap({ width: 100, height: 100 }, { width: 200, height: 100 });
    expect(layerPlacement(map, { x: -256, y: 0, width: 612, height: 100 })).toEqual({ x: -206, y: 0, width: 612, height: 100 });
  });

  it("snaps fractional offsets and scaled sizes", () => {
    // s = 1, ox = 0.5 -> Python round(0.5) = 0
    const half = frameMap({ width: 100, height: 100 }, { width: 101, height: 100 });
    expect(layerPlacement(half, { x: 0, y: 0, width: 100, height: 100 })).toEqual({ x: 0, y: 0, width: 100, height: 100 });
    // s = 1/3: 100 * s = 33.33 -> 33
    const third = frameMap({ width: 300, height: 300 }, { width: 100, height: 100 });
    expect(layerPlacement(third, { x: 0, y: 0, width: 100, height: 100 })).toEqual({ x: 0, y: 0, width: 33, height: 33 });
    expect(layerPlacement(third, { x: 0, y: 0, width: 1, height: 1 })).toEqual({ x: 0, y: 0, width: 1, height: 1 });
  });
});

describe("selectAll rect: imageRectToDoc(documentMap(doc, imageSize), frameRect(imageSize))", () => {
  // Helper mirrors SelectionOps.imageRectInDoc() -- pure, no DOM.
  function selectAllRect(
    frame: { width: number; height: number },
    imageSize: { width: number; height: number },
    placement?: { x: number; y: number; scale: number },
  ) {
    const doc = placement ? { frame, placement } : { frame };
    const map = documentMap(doc, imageSize);
    const r = imageRectToDoc(map, { x: 0, y: 0, ...imageSize });
    return { x: Math.floor(r.x), y: Math.floor(r.y), width: Math.ceil(r.x + r.width) - Math.floor(r.x), height: Math.ceil(r.y + r.height) - Math.floor(r.y) };
  }

  it("identity: frame == image -> selects {0,0,W,H}", () => {
    expect(selectAllRect({ width: 512, height: 512 }, { width: 512, height: 512 })).toEqual({ x: 0, y: 0, width: 512, height: 512 });
  });

  it("wider image: image wider than frame -> rect extends beyond frame on both sides", () => {
    // frame 512x512, image 1024x512: s=1, offsetX=256, offsetY=0
    // image rect in doc: x=(0-256)/1=-256, w=1024/1=1024 -> {-256,0,1024,512}
    const r = selectAllRect({ width: 512, height: 512 }, { width: 1024, height: 512 });
    expect(r).toEqual({ x: -256, y: 0, width: 1024, height: 512 });
  });

  it("taller image (different aspect): rect extends above and below frame", () => {
    // frame 512x512, image 512x1024: s=1, offsetX=0, offsetY=256
    // image rect in doc: x=0, y=-256, w=512, h=1024 -> {0,-256,512,1024}
    const r = selectAllRect({ width: 512, height: 512 }, { width: 512, height: 1024 });
    expect(r).toEqual({ x: 0, y: -256, width: 512, height: 1024 });
  });

  it("non-identity placement: Move offset shifts the image rect in doc coords", () => {
    // frame 100x100, image 100x100 (identity base), placement {x:20, y:10, scale:1}
    // s=1, effectiveOffsetX=0+1*(50*(1-1)+20)=20, effectiveOffsetY=0+1*(50*(1-1)+10)=10
    // image rect in doc: x=(0-20)/1=-20, y=(0-10)/1=-10, w=100, h=100 -> {-20,-10,100,100}
    const r = selectAllRect({ width: 100, height: 100 }, { width: 100, height: 100 }, { x: 20, y: 10, scale: 1 });
    expect(r).toEqual({ x: -20, y: -10, width: 100, height: 100 });
  });

  it("placement + different-aspect image: combines both transforms correctly", () => {
    // frame 100x100, image 200x100 (s=1, ox=50), placement {x:10, y:0, scale:1}
    // effectiveOffsetX = 50 + 1*(50*(1-1)+10) = 60, effectiveOffsetY = 0
    // image rect in doc: x=(0-60)/1=-60, y=0, w=200, h=100 -> {-60,0,200,100}
    const r = selectAllRect({ width: 100, height: 100 }, { width: 200, height: 100 }, { x: 10, y: 0, scale: 1 });
    expect(r).toEqual({ x: -60, y: 0, width: 200, height: 100 });
  });

  it("no image (fill): imageSize == doc.frame -> selects exactly the frame", () => {
    // When no image is connected, imageSize == doc.frame (see EditorState.imageSize)
    expect(selectAllRect({ width: 768, height: 432 }, { width: 768, height: 432 })).toEqual({ x: 0, y: 0, width: 768, height: 432 });
  });

  it("scaled placement: scale-down crops the visible area in doc coords", () => {
    // frame 100x100, image 100x100, placement {x:0, y:0, scale:0.5}
    // effectiveScale = 1*0.5 = 0.5
    // effectiveOffsetX = 0 + 1*(50*(1-0.5)+0) = 25, effectiveOffsetY = 25
    // image rect in doc: x=(0-25)/0.5=-50, y=-50, w=100/0.5=200, h=200 -> {-50,-50,200,200}
    const r = selectAllRect({ width: 100, height: 100 }, { width: 100, height: 100 }, { x: 0, y: 0, scale: 0.5 });
    expect(r).toEqual({ x: -50, y: -50, width: 200, height: 200 });
  });
});
