/**
 * Image-source insertion: new layer in Free Transform; commit = ONE
 * undo step (layer add + transform), cancel = no layer and no step; large
 * sources start fitted to the image area, small ones at native size.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createEmptyDocument } from "../document/create";
import type { Editor as EditorClass } from "./editor";
import { FakeCanvas, installCanvasFakes, removeCanvasFakes } from "./fakeCanvas.testutil";
import { rectSelection } from "./selection";
import { fitScale, insertParams } from "./sourceInsert";

let Editor: typeof EditorClass;

beforeAll(async () => {
  installCanvasFakes();
  ({ Editor } = await import("./editor"));
});

afterAll(() => removeCanvasFakes());

function editor(): EditorClass {
  return new Editor(createEmptyDocument({ width: 32, height: 32 }), "widgets");
}

function solid(w: number, h: number): ImageData {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < data.length; i += 4) data.set([255, 0, 0, 255], i);
  return new ImageData(data, w, h);
}

function rgbaAt(ed: EditorClass, id: string, x: number, y: number): number[] {
  const c = ed.layerCanvas(id) as unknown as FakeCanvas;
  const b = ed.bounds;
  const i = ((y - b.y) * c.width + (x - b.x)) * 4;
  return Array.from(c.px.subarray(i, i + 4));
}

const NO_SEL = { selection: null, view: null };

describe("fit scaling", () => {
  it("small sources keep native size; large ones fit (aspect kept)", () => {
    expect(fitScale({ width: 10, height: 10 }, { width: 32, height: 32 })).toBe(1);
    expect(fitScale({ width: 64, height: 32 }, { width: 32, height: 32 })).toBe(0.5);
    expect(fitScale({ width: 32, height: 128 }, { width: 64, height: 64 })).toBe(0.5);
    expect(fitScale({ width: 0, height: 5 }, { width: 32, height: 32 })).toBe(1);
  });

  it("native size snaps to whole document px; fitted sizes centre exactly", () => {
    const area = { x: 0, y: 0, width: 32, height: 32 };
    expect(insertParams({ width: 7, height: 4 }, area, 1, NO_SEL)).toEqual({ cx: 16.5, cy: 16, sx: 1, sy: 1, angle: 0 });
    expect(insertParams({ width: 64, height: 16 }, area, 1, NO_SEL)).toEqual({ cx: 16, cy: 16, sx: 0.5, sy: 0.5, angle: 0 });
    // Frame at half the image resolution: 1 image px = 0.5 document px.
    expect(insertParams({ width: 16, height: 16 }, { x: 0, y: 0, width: 32, height: 32 }, 0.5, NO_SEL).sx).toBe(0.5);
  });
});

describe("insert", () => {
  it("starts a transform session on a new layer", () => {
    const ed = editor();
    const count = ed.doc.layers.length;
    expect(ed.insert.insert(solid(8, 4))).toBe(true);
    expect(ed.doc.layers.length).toBe(count + 1);
    expect(ed.float.transform.active).toBe(true);
    expect(ed.float.transform.params).toEqual({ cx: 16, cy: 16, sx: 1, sy: 1, angle: 0 });
  });

  it("commit at native size = one undo step; undo removes the layer, redo restores the pixels", () => {
    const ed = editor();
    const count = ed.doc.layers.length;
    ed.insert.insert(solid(8, 4));
    const id = ed.doc.activeLayerId;
    expect(ed.float.transform.commit()).toBe(true);
    expect(rgbaAt(ed, id, 12, 14)).toEqual([255, 0, 0, 255]);
    expect(rgbaAt(ed, id, 11, 14)[3]).toBe(0);
    ed.undo();
    expect(ed.doc.layers.length).toBe(count);
    expect(ed.canUndo).toBe(false);
    ed.redo();
    expect(ed.doc.layers.length).toBe(count + 1);
    expect(rgbaAt(ed, id, 19, 17)).toEqual([255, 0, 0, 255]);
  });

  it("commit after a change (moved + fitted) is still one step", () => {
    const ed = editor();
    ed.insert.insert(solid(64, 32));
    expect(ed.float.transform.params?.sx).toBe(0.5);
    ed.float.transform.nudge(2, 0);
    ed.float.commit();
    expect(ed.float.transform.active).toBe(false);
    ed.undo();
    expect(ed.canUndo).toBe(false);
  });

  it("cancel leaves no layer and no step (Esc / x)", () => {
    const ed = editor();
    const count = ed.doc.layers.length;
    const active = ed.doc.activeLayerId;
    ed.insert.insert(solid(8, 4));
    ed.float.cancel();
    expect(ed.doc.layers.length).toBe(count);
    expect(ed.doc.activeLayerId).toBe(active);
    expect(ed.float.transform.active).toBe(false);
    expect(ed.canUndo).toBe(false);
    expect(ed.canRedo).toBe(false);
  });

  it("Ctrl+Z cancels too and restores the previous selection; earlier steps untouched", () => {
    const ed = editor();
    ed.selection.apply(rectSelection({ x: 2, y: 2, width: 4, height: 4 }), "replace");
    const sel = ed.selection.current;
    const count = ed.doc.layers.length;
    ed.insert.insert(solid(8, 4));
    expect(ed.selection.current).toBeNull();
    ed.undo();
    expect(ed.doc.layers.length).toBe(count);
    expect(ed.selection.current).toBe(sel);
    expect(ed.canRedo).toBe(false);
    ed.undo(); // the selection step made before the insert
    expect(ed.selection.current).toBeNull();
  });
});
