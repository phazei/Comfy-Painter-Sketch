/**
 * The Background row selected (`Editor.selectBackground`): session state only
 * (not saved, no history), every pixel edit refused with the note, cleared by
 * any other selection; Duplicate makes "Background copy" at the bottom of the
 * paint stack from what the background shows. Canvas fakes: `fakeCanvas.testutil.ts`.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createEmptyDocument, createMaskLayer, createPaintLayer } from "../document/create";
import { stringifyDocument } from "../document/serialize";
import type { Editor as EditorClass } from "./editor";
import { BACKGROUND_NOTE } from "./editorTypes";
import { installBlendCanvasFakes, removeCanvasFakes } from "./fakeCanvas.testutil";
import { bottomPaintIndex } from "./layerOps";

let Editor: typeof EditorClass;

beforeAll(async () => {
  installBlendCanvasFakes();
  ({ Editor } = await import("./editor"));
});

afterAll(() => removeCanvasFakes());

const SIZE = { width: 8, height: 6 };

function setup(): { ed: EditorClass; notes: string[] } {
  const ed = new Editor(createEmptyDocument(SIZE, "bgsel1"), "widgets");
  ed.setBackground({ kind: "fill", color: "#ff0000" }, SIZE);
  const notes: string[] = [];
  ed.events.on("note", (n) => notes.push(n));
  return { ed, notes };
}

function depth(ed: EditorClass): number {
  return (ed as unknown as { s: { history: { undoDepth: number } } }).s.history.undoDepth;
}

/** RGBA of one document pixel of a layer (store bounds = frame here). */
function pixel(ed: EditorClass, layerId: string, x: number, y: number): number[] {
  const canvas = ed.layerCanvas(layerId);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no context");
  return [...ctx.getImageData(x, y, 1, 1).data];
}

const STROKE = { color: "#fff", size: 4, hardness: 1, opacity: 1, flow: 1, spacing: 0.25, erase: false } as never;

describe("Background row selection", () => {
  it("is session state: Quick Mask off, nothing saved, no history step", () => {
    const { ed } = setup();
    ed.setPaintTarget("mask");
    const saved = stringifyDocument(ed.doc);
    const steps = depth(ed);
    ed.selectBackground();
    expect(ed.backgroundSelected).toBe(true);
    expect(ed.paintTarget).toBe("paint");
    expect(stringifyDocument(ed.doc)).toBe(saved);
    expect(depth(ed)).toBe(steps);
  });

  it("refuses every pixel edit with the note (and the cursor's ban)", () => {
    const { ed, notes } = setup();
    expect(ed.layerOps.add()).toBeTruthy();
    ed.selectBackground();
    const steps = depth(ed);
    expect(ed.editTarget("paint")).toEqual({ mask: false, blocked: true });
    expect(ed.beginStroke(STROKE, 4)).toBe(false);
    const fill = { point: { x: 1, y: 1 }, tolerance: 0, contiguous: true, antiAlias: false, sample: "layer", opacity: 1, color: "#fff" } as const;
    expect(ed.pixelOps.fill(fill)).toBe(false);
    expect(ed.layerMove.begin()).toBe(false);
    expect(ed.layerMove.blocked()).toBe(true);
    expect(ed.canMergeDown()).toBe(false);
    expect(ed.mergeDown()).toBe(false);
    ed.selection.selectAll();
    expect(ed.selection.fillSelected("#ffffff")).toBe(false);
    expect(ed.selection.clearSelected()).toBe(false);
    expect(notes.filter((n) => n === BACKGROUND_NOTE).length).toBeGreaterThanOrEqual(5);
    // Select all is a selection step, not a pixel edit.
    expect(depth(ed)).toBe(steps + 1);
  });

  it("copies what the background shows (reading isn't editing); cut is refused", () => {
    const { ed, notes } = setup();
    ed.selectBackground();
    const clip = ed.clipboard.copy(false);
    expect(clip).not.toBeNull();
    expect(clip?.rect).toEqual({ x: 0, y: 0, width: 8, height: 6 });
    expect([...(clip?.data.data.slice(0, 4) ?? [])]).toEqual([255, 0, 0, 255]);
    expect(ed.backgroundSelected).toBe(true);
    expect(ed.clipboard.cut()).toBeNull();
    expect(notes).toContain(BACKGROUND_NOTE);
  });

  it("ends with any other selection: the active layer again, a mask, the paint target", () => {
    const { ed } = setup();
    ed.selectBackground();
    expect(ed.layerOps.setActiveLayer(ed.doc.activeLayerId)).toBe(false);
    expect(ed.backgroundSelected).toBe(false);
    expect(ed.beginStroke(STROKE, 4)).toBe(true);
    ed.endStroke(null);

    ed.selectBackground();
    const mask = ed.doc.layers.find((l) => l.kind === "mask");
    expect(mask && ed.selectMask(mask.id)).toBe(true);
    expect(ed.backgroundSelected).toBe(false);
    expect(ed.paintTarget).toBe("mask");

    ed.selectBackground();
    ed.setPaintTarget("paint");
    expect(ed.backgroundSelected).toBe(false);
    ed.selectBackground();
    expect(ed.layerOps.add()).toBeTruthy();
    expect(ed.backgroundSelected).toBe(false);
  });
});

describe("Background Duplicate", () => {
  it("copies the fill into 'Background copy' right above the Background, active, one undo step", () => {
    const { ed } = setup();
    expect(ed.layerOps.add()).toBeTruthy();
    ed.selectBackground();
    const steps = depth(ed);
    const id = ed.layerOps.duplicateBackground();
    if (!id) throw new Error("no copy");
    expect(ed.doc.layers[0]?.id).toBe(id);
    expect(ed.doc.layers[0]).toMatchObject({ name: "Background copy", kind: "paint" });
    expect(ed.doc.activeLayerId).toBe(id);
    expect(ed.backgroundSelected).toBe(false);
    expect(depth(ed)).toBe(steps + 1);
    expect(pixel(ed, id, 0, 0)).toEqual([255, 0, 0, 255]);
    expect(pixel(ed, id, 7, 5)).toEqual([255, 0, 0, 255]);
    ed.undo();
    expect(ed.doc.layers.some((l) => l.id === id)).toBe(false);
  });

  it("ignores the background eye and names further copies 'Background copy 2'", () => {
    const { ed } = setup();
    ed.layerOps.setBackgroundVisible(false);
    const first = ed.layerOps.duplicateBackground();
    const second = ed.layerOps.duplicateBackground();
    if (!first || !second) throw new Error("no copy");
    expect(pixel(ed, first, 3, 3)).toEqual([255, 0, 0, 255]);
    expect(ed.doc.layers.find((l) => l.id === second)?.name).toBe("Background copy 2");
    expect(ed.doc.layers[0]?.id).toBe(second);
  });
});

describe("bottomPaintIndex", () => {
  it("is the lowest paint layer's slot (masks sit above paint)", () => {
    const a = createPaintLayer("A");
    const b = createPaintLayer("B");
    const m = createMaskLayer("Mask 1");
    expect(bottomPaintIndex({ layers: [a, b, m], activeLayerId: b.id })).toBe(0);
    expect(bottomPaintIndex({ layers: [m], activeLayerId: "" })).toBe(0);
  });
});
