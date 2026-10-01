/** Frame adoption after Clear: an emptied document behaves like a fresh one; Clear undo/redo survive re-adoption. */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createEmptyDocument } from "../document/create";
import type { Size } from "../geometry/rect";
import { minimumFrame } from "./drawingResolution";
import { EditorState } from "./editorState";
import { FrameOps } from "./frameOps";
import { PaintOps } from "./paintOps";

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

function setup(): { s: EditorState; frames: FrameOps; paint: PaintOps } {
  const s = new EditorState(createEmptyDocument({ width: 100, height: 80 }, "adopt1"), "widgets");
  const frames = new FrameOps(s);
  return { s, frames, paint: new PaintOps(s, frames) };
}
function resize(frames: FrameOps, size: Size): void {
  frames.setBackground({ kind: "fill", color: "#fff" }, size);
  frames.handleBackgroundSize(size);
}
function draw(s: EditorState): void {
  const layerId = s.doc.activeLayerId;
  const img = { width: 2, height: 2, data: new Uint8ClampedArray(16) } as ImageData;
  s.history.push({ kind: "patch", layerId, x: 5, y: 5, before: img, after: img, bytes: 16 });
  s.runtime.touch(layerId);
}

describe("frame adoption after Clear", () => {
  it("a fresh document adopts every size change", () => {
    const { s, frames } = setup();
    for (const size of [{ width: 600, height: 300 }, { width: 2000, height: 3000 }]) {
      resize(frames, size);
      expect(s.doc.frame).toEqual(minimumFrame(size));
    }
  });

  it("draw -> Clear -> several size changes are each adopted; undo restores the drawing frame; redo the last adopted", () => {
    const { s, frames, paint } = setup();
    resize(frames, { width: 600, height: 300 });
    const drawnFrame = { ...s.doc.frame }, drawnBounds = { ...s.doc.bounds };
    draw(s);
    resize(frames, { width: 700, height: 700 });
    expect(s.doc.frame).toEqual(drawnFrame); // content: display mapping only
    frames.clear();
    expect(s.doc.frame).toEqual(minimumFrame({ width: 700, height: 700 }));
    for (const size of [{ width: 800, height: 400 }, { width: 2048, height: 1024 }, { width: 3000, height: 5000 }]) {
      resize(frames, size);
      expect(s.doc.frame).toEqual(minimumFrame(size));
      expect(s.doc.bounds).toEqual({ x: 0, y: 0, ...minimumFrame(size) });
    }
    expect(s.history.canUndo).toBe(true);
    paint.undo();
    expect(s.doc.frame).toEqual(drawnFrame);
    expect(s.doc.bounds).toEqual(drawnBounds);
    expect(s.runtime.hasPaint).toBe(true);
    resize(frames, { width: 900, height: 900 });
    expect(s.doc.frame).toEqual(drawnFrame); // restored content blocks adoption
    paint.redo();
    expect(s.doc.frame).toEqual(minimumFrame({ width: 3000, height: 5000 }));
    resize(frames, { width: 640, height: 640 });
    expect(s.doc.frame).toEqual(minimumFrame({ width: 640, height: 640 }));
  });

  it("Clear keeps earlier steps: paint A, paint B, Clear, adopt x2, undo x3 -> before A; redo x3 -> cleared doc", () => {
    const { s, frames, paint } = setup();
    resize(frames, { width: 600, height: 300 });
    const startFrame = { ...s.doc.frame };
    draw(s); // A
    draw(s); // B
    frames.clear();
    expect(s.history.undoDepth).toBe(3);
    resize(frames, { width: 800, height: 400 });
    resize(frames, { width: 300, height: 1200 });
    const lastFrame = minimumFrame({ width: 300, height: 1200 });
    expect(s.doc.frame).toEqual(lastFrame);
    expect(s.history.undoDepth).toBe(3); // adoption never drops pre-Clear steps
    paint.undo(); // Clear
    expect(s.doc.frame).toEqual(startFrame);
    paint.undo(); // B
    paint.undo(); // A
    expect(s.history.canUndo).toBe(false);
    expect(s.doc.frame).toEqual(startFrame);
    paint.redo();
    paint.redo();
    paint.redo();
    expect(s.history.canRedo).toBe(false);
    expect(s.doc.frame).toEqual(lastFrame);
    expect(s.doc.bounds).toEqual({ x: 0, y: 0, ...lastFrame });
    expect(s.isEmpty).toBe(true);
  });

  it("adoption after Clear drops only selection steps after it and keeps Clear newest", () => {
    const { s, frames } = setup();
    draw(s);
    frames.clear();
    s.history.push({ kind: "selection", before: null, after: null, bytes: 0 });
    resize(frames, { width: 700, height: 500 });
    expect(s.history.undoDepth).toBe(2);
    expect(s.history.mergeTarget()?.kind).toBe("clear");
  });

  it("Clear drops the selection in the same step; undo brings it back, redo drops it again", () => {
    const { s, frames, paint } = setup();
    draw(s);
    const sel = { rect: { x: 2, y: 3, width: 4, height: 5 }, data: new Uint8Array(20).fill(255), outside: 0 as const };
    s.selection.set(sel);
    const depth = s.history.undoDepth;
    frames.clear();
    expect(s.selection.current).toBeNull();
    expect(s.history.undoDepth).toBe(depth + 1);
    paint.undo();
    expect(s.selection.current).toBe(sel);
    paint.redo();
    expect(s.selection.current).toBeNull();
  });

  it("drawing after Clear blocks adoption again", () => {
    const { s, frames } = setup();
    draw(s);
    frames.clear();
    draw(s);
    const frame = { ...s.doc.frame };
    resize(frames, { width: 1500, height: 900 });
    expect(s.doc.frame).toEqual(frame);
  });
});
