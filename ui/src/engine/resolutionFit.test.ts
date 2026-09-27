/** Second notice case: the image's shape doesn't fit the maximum paint area; Match fixes it without lowering resolution. */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createEmptyDocument } from "../document/create";
import type { Size } from "../geometry/rect";
import { imageFits, matchGeometry, minimumFrame } from "./drawingResolution";
import { EditorState } from "./editorState";
import { FrameOps } from "./frameOps";
import { documentMap } from "./frameMap";
import { ResolutionOps } from "./resolutionOps";

function fakeCanvas(): object {
  const canvas: Record<string, unknown> = { width: 300, height: 150 };
  const fields: Record<string | symbol, unknown> = {
    canvas, getImageData: (_x: number, _y: number, w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
  };
  const ctx = new Proxy(fields, { get: (target, key) => key in target ? target[key] : () => undefined,
    set: (target, key, value) => { target[key] = value; return true; } });
  canvas.getContext = () => ctx;
  return canvas;
}
beforeAll(() => vi.stubGlobal("document", { createElement: fakeCanvas }));
afterAll(() => vi.unstubAllGlobals());

const square = { width: 1024, height: 1024 };
const tall = { width: 256, height: 1024 };
const bounds = (f: Size) => ({ x: 0, y: 0, ...f });

function setup(frame: Size): { s: EditorState; frames: FrameOps; res: ResolutionOps } {
  const s = new EditorState(createEmptyDocument(frame, "fit1"), "widgets");
  return { s, frames: new FrameOps(s), res: new ResolutionOps(s) };
}
function show(frames: FrameOps, size: Size): void {
  frames.setBackground({ kind: "fill", color: "#fff" }, size);
  frames.handleBackgroundSize(size);
}
function draw(s: EditorState): void {
  const layerId = s.doc.activeLayerId;
  const img = { width: 2, height: 2, data: new Uint8ClampedArray(16) } as ImageData;
  s.history.push({ kind: "patch", layerId, x: 5, y: 5, before: img, after: img, bytes: 16 });
  s.runtime.touch(layerId);
}

describe("imageFits", () => {
  it("a frame from the image fits; 256x1024 on a 1024x1024 frame doesn't", () => {
    expect(imageFits({ frame: minimumFrame(tall), bounds: bounds(minimumFrame(tall)) }, tall)).toBe(true);
    expect(imageFits({ frame: square, bounds: bounds(square) }, tall)).toBe(false);
  });

  it("existing bounds beyond the cap count", () => {
    expect(imageFits({ frame: square, bounds: { x: -1024, y: -2048, width: 3072, height: 5120 } }, tall)).toBe(true);
  });
});

describe("matchGeometry never lowers resolution", () => {
  it("keeps the density when the fresh frame would be coarser", () => {
    const frame = { width: 4096, height: 4096 }; // 0.0625 image px per doc px on 256x1024
    const g = matchGeometry({ frame, bounds: bounds(frame) }, tall);
    expect(g.frame).toEqual({ width: 4096, height: 16384 });
    expect(g.transform.factor).toBeCloseTo(1, 6);
    expect(imageFits({ frame: g.frame, bounds: g.bounds }, tall)).toBe(true);
  });
});

describe("ResolutionOps notice", () => {
  it("empty document: no notice (it adopts the size)", () => {
    const { res, frames } = setup(square);
    show(frames, tall);
    expect(res.notice()).toBeNull();
  });

  it("256x1024 image on a painted 1024x1024 frame: fit notice; Match fixes it", () => {
    const { s, frames, res } = setup(square);
    draw(s);
    show(frames, tall);
    expect(s.doc.frame).toEqual(square);
    expect(res.notice()?.kind).toBe("fit");
    const before = documentMap(s.doc, tall).scale;
    expect(res.match()).toBe(true);
    expect(s.doc.frame).toEqual({ width: 1024, height: 4096 });
    expect(s.doc.placement).toBeUndefined();
    expect(documentMap(s.doc, tall).scale).toBeLessThanOrEqual(before); // doc px per image px not lower
    expect(res.fits()).toBe(true);
    expect(res.notice()).toBeNull();
  });

  it("resolution case wins when both apply", () => {
    const { s, frames, res } = setup({ width: 512, height: 512 });
    draw(s);
    show(frames, { width: 1024, height: 4096 });
    expect(res.fits()).toBe(false);
    expect(res.notice()?.kind).toBe("resolution");
  });
});
