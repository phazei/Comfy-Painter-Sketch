/** Region metadata integration: real history/apply paths, with instrumented canvas boundaries. Tool gestures: `tools/region.test.ts`. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyDocument } from "../document/create";
import type { Editor as EditorClass } from "./editor";
import { EditorState } from "./editorState";
import { FrameOps } from "./frameOps";
import { PaintOps } from "./paintOps";
import { RegionOps } from "./regionOps";

const reads = vi.fn((w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }));
const writes = vi.fn();
function fakeCanvas(): object {
  const canvas: Record<string, unknown> = { width: 300, height: 150 };
  const fields: Record<string | symbol, unknown> = {
    canvas, getImageData: (_x: number, _y: number, w: number, h: number) => reads(w, h), putImageData: writes,
  };
  const ctx = new Proxy(fields, { get: (target, key) => key in target ? target[key] : () => undefined,
    set: (target, key, value) => { target[key] = value; return true; } });
  canvas.getContext = () => ctx;
  return canvas;
}
let Editor: typeof EditorClass;
beforeAll(async () => {
  vi.stubGlobal("document", { createElement: fakeCanvas });
  ({ Editor } = await import("./editor"));
});
afterAll(() => vi.unstubAllGlobals());
beforeEach(() => { reads.mockClear(); writes.mockClear(); });
const box = { x: 10, y: 12, width: 20, height: 24 };
function setup(): EditorClass { return new Editor(createEmptyDocument({ width: 100, height: 80 }, "regions1"), "widgets"); }

describe("region metadata/history", () => {
  it("caps at six, preserves stable slots and reuses the lowest hole with a new identity", () => {
    const ed = setup(), ops = ed.regionOps;
    const ids = Array.from({ length: 6 }, () => ops.add(box));
    expect(ed.doc.regions.map((r) => r.slot)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(ops.add(box)).toBeNull();
    ops.remove(ids[1]!);
    const replacement = ops.add(box);
    expect(replacement).not.toBe(ids[1]);
    expect(ed.doc.regions.find((r) => r.id === replacement)?.slot).toBe(2);
    ed.undo();
    ed.undo();
    expect(ed.doc.regions.map((r) => r.id)).toEqual(ids);
    ed.redo();
    ed.redo();
    expect(ed.doc.regions.find((r) => r.slot === 2)?.id).toBe(replacement);
  });

  it("names, options and overlay visibility are independent undoable metadata", () => {
    const ed = setup(), ops = ed.regionOps, id = ops.add(box)!;
    const changes = vi.fn(), layers = vi.fn(), renders = vi.fn();
    ed.events.on("change", changes);
    ed.events.on("layers", layers);
    ed.events.on("render", renders);
    ops.rename(id, "Face");
    ops.setVisible(id, false);
    ops.setOptions(id, { applyMask: "crop", cropPadding: 4 });
    ops.setOptions(null, { applyMask: "fill", fillColor: "#123456" });
    expect(ops.options(id).applyMask).toBe("crop");
    ed.undo();
    expect(ed.doc.mainOutput).toBeUndefined();
    ed.undo();
    expect(ops.options(id).applyMask).toBe("none");
    ed.undo();
    expect(ed.doc.regions[0]?.visible).toBe(true);
    ed.undo();
    expect(ed.doc.regions[0]?.name).toBe("Region 1");
    expect(changes).toHaveBeenCalled();
    expect(layers).not.toHaveBeenCalled();
    expect(renders).toHaveBeenCalled();
    expect(reads).not.toHaveBeenCalled();
    expect(ed.dirty).toBe(false);
  });

  it("one scrub/picker session is one step; cancel/no-op preserves redo and missing Main", () => {
    const ed = setup(), ops = ed.regionOps;
    ops.begin();
    for (let i = 1; i <= 30; i++) ops.setOptions(null, { cropPadding: i });
    ops.commit();
    ed.undo();
    expect(ed.doc.mainOutput).toBeUndefined();
    expect(ed.canUndo).toBe(false);
    expect(ed.canRedo).toBe(true);
    ops.begin();
    ops.setOptions(null, { fillColor: "#ffffff" });
    ops.cancel();
    expect(ed.doc.mainOutput).toBeUndefined();
    expect(ed.canRedo).toBe(true);
    ops.begin();
    ops.setOptions(null, { fillColor: "#ffffff" });
    ops.setOptions(null, { fillColor: "#000000" });
    expect(ops.commit()).toBe(false);
    expect(ed.doc.mainOutput).toBeUndefined();
    expect(ed.canRedo).toBe(true);
    ed.redo();
    expect(ops.options(null).cropPadding).toBe(30);
  });

  it("border options: each change is one step, a width scrub is one step", () => {
    const ed = setup(), ops = ed.regionOps;
    ops.setOptions(null, { applyMask: "border" });
    ops.setOptions(null, { borderMask: false });
    ops.begin();
    for (let i = 1; i <= 20; i++) ops.setOptions(null, { borderSize: i * 10 });
    ops.commit();
    expect(ops.options(null)).toMatchObject({ applyMask: "border", borderMask: false, borderSize: 200 });
    ed.undo();
    expect(ops.options(null)).toMatchObject({ borderMask: false, borderSize: 64 });
    ed.undo();
    expect(ops.options(null).borderMask).toBe(true);
    ed.undo();
    expect(ed.doc.mainOutput).toBeUndefined();
    ops.setOptions(null, { borderSize: 99999 });
    expect(ops.options(null).borderSize).toBe(4096);
  });

  it("metadata cost stays small on a huge image and never reads layer pixels", () => {
    const ed = setup();
    ed.setBackground({ kind: "fill", color: "#fff" }, { width: 8000, height: 8000 });
    const initialBytes = ed.bytes;
    ed.regionOps.add({ x: 1, y: 1, width: 7999, height: 7999 });
    ed.regionOps.setOptions(null, { applyMask: "crop" });
    expect(ed.bytes - initialBytes).toBeLessThan(10000);
    expect(reads).not.toHaveBeenCalled();
  });

  it("never rescales regions when the image size changes", () => {
    const ed = setup();
    const ops = ed.regionOps;
    ed.setBackground({ kind: "fill", color: "#fff" }, { width: 301, height: 179 });
    const id = ops.add(box)!;
    ed.setBackground({ kind: "fill", color: "#fff" }, { width: 110, height: 333 });
    ed.handleBackgroundSize({ width: 110, height: 333 });
    expect(ops.imageRect(id)).toEqual(box);
    const before = ops.imageRect(id)!;
    ops.begin();
    ops.setRect(id, { ...before, x: before.x + 5 });
    ops.setRect(id, before);
    expect(ops.commit()).toBe(false);
    ed.undo();
    expect(ed.doc.regions).toEqual([]);
    ed.redo();
    expect(ops.imageRect(id)).toEqual(box);
  });

  it("Clear resets regions/reference/Main in one step and undo restores independent records", () => {
    const ed = setup(), ops = ed.regionOps, id = ops.add(box)!;
    ops.setOptions(null, { applyMask: "crop", cropPadding: 10 });
    ops.setOptions(id, { applyMask: "fill", fillColor: "#abcdef" });
    const original = JSON.stringify(ed.doc.regions);
    ed.clear();
    expect(ed.doc.regions).toEqual([]);
    expect(ed.doc.mainOutput).toBeUndefined();
    ed.undo();
    expect(JSON.stringify(ed.doc.regions)).toBe(original);
    expect(ed.doc.mainOutput?.cropPadding).toBe(10);
    ed.redo();
    expect(ed.doc.regions).toEqual([]);
    ed.undo();
    ops.setOptions(id, { fillColor: "#000000" });
    ed.undo();
    expect(JSON.stringify(ed.doc.regions)).toBe(original);
  });

  it("pixel patches keep document coordinates and regions keep image px across resize and Clear undo", () => {
    const s = new EditorState(createEmptyDocument({ width: 100, height: 80 }, "history1"), "widgets");
    const frames = new FrameOps(s), paint = new PaintOps(s, frames), ops = new RegionOps(s);
    const layerId = s.doc.activeLayerId;
    const before = { width: 2, height: 3, data: new Uint8ClampedArray(24) } as ImageData;
    const after = { ...before, data: new Uint8ClampedArray(24).fill(255) } as ImageData;
    s.history.push({ kind: "patch", layerId, x: 20, y: 30, before, after, bytes: 48 });
    ops.add(box);
    frames.setBackground({ kind: "fill", color: "#fff" }, { width: 600, height: 300 });
    frames.handleBackgroundSize({ width: 600, height: 300 });
    expect(s.doc.frame).toEqual({ width: 100, height: 80 });
    frames.clear();
    paint.undo();
    paint.undo();
    paint.undo();
    expect(writes).toHaveBeenLastCalledWith(before, 20, 30);
    paint.redo();
    expect(writes).toHaveBeenLastCalledWith(after, 20, 30);
    paint.redo();
    expect(ops.imageRect(s.doc.regions[0]!.id)).toEqual(box);
  });
});

describe("region slots and selection events", () => {
  it("selecting a region or Main is a view event, never a document change", () => {
    const ed = setup(), ops = ed.regionOps, id = ops.add(box)!;
    const changes = vi.fn(), outputs = vi.fn(), layers = vi.fn();
    ed.events.on("change", changes);
    ed.events.on("outputs", outputs);
    ed.events.on("layers", layers);
    ops.select(null);
    ops.select(id);
    ops.select(id);
    expect(outputs).toHaveBeenCalledTimes(2);
    expect(changes).not.toHaveBeenCalled();
    expect(layers).not.toHaveBeenCalled();
    expect(ed.canRedo).toBe(false);
    expect(ed.canUndo).toBe(true);
  });

  it("+ Region N fills that exact slot with the default rect; delete empties it (undoable)", () => {
    const ed = setup(), ops = ed.regionOps;
    const id = ops.addDefault(4)!;
    expect(ops.inSlot(4)?.rect).toEqual({ x: 25, y: 20, width: 50, height: 40 });
    expect(ops.inSlot(4)?.name).toBe("Region 4");
    expect(ops.selectedId).toBe(id);
    expect(ops.addDefault(4)).toBeNull();
    expect(ops.add(box)).not.toBeNull();
    expect(ops.inSlot(1)).toBeDefined();
    ops.remove(id);
    expect(ops.inSlot(4)).toBeUndefined();
    expect(ops.selectedId).toBe(ed.doc.regions[0]!.id);
    ed.undo();
    expect(ops.inSlot(4)?.id).toBe(id);
  });

  it("clamps rects to the paint area (one image beyond each edge), not the image", () => {
    const ed = setup(), ops = ed.regionOps;
    const id = ops.add({ x: -30, y: 70, width: 60, height: 40 })!;
    expect(ops.imageRect(id)).toEqual({ x: -30, y: 70, width: 60, height: 40 });
    ops.setRect(id, { x: -500, y: -500, width: 2000, height: 2000 });
    expect(ops.imageRect(id)).toEqual({ x: -100, y: -80, width: 300, height: 240 });
  });

  it("an image size change refreshes output cards without rescaling", () => {
    const ed = setup(), outputs = vi.fn(), id = ed.regionOps.add(box)!;
    ed.events.on("outputs", outputs);
    ed.setBackground({ kind: "fill", color: "#fff" }, { width: 100, height: 80 });
    expect(outputs).not.toHaveBeenCalled();
    ed.setBackground({ kind: "fill", color: "#fff" }, { width: 300, height: 80 });
    expect(outputs).toHaveBeenCalledTimes(1);
    expect(ed.regionOps.imageRect(id)).toEqual(box);
  });
});
