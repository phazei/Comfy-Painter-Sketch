/**
 * M13a Image Mask row in the editor: made from the source's alpha (not an
 * undo step, dirty until uploaded), opaque removes it, every pixel edit is
 * refused with the note, settings are ordinary (undoable) mask settings,
 * Ctrl+click selects its effective coverage, Duplicate makes an editable
 * mask, solo works, Merge Down refuses. Canvas fakes: `fakeCanvas.testutil.ts`.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createEmptyDocument } from "../document/create";
import { IMAGE_MASK_ID } from "../document/imageMask";
import type { Editor as EditorClass } from "./editor";
import { IMAGE_MASK_NOTE } from "./editorTypes";
import { installCanvasFakes, removeCanvasFakes } from "./fakeCanvas.testutil";
import { coverageAt } from "./selection";

let Editor: typeof EditorClass;

beforeAll(async () => {
  installCanvasFakes();
  ({ Editor } = await import("./editor"));
});

afterAll(() => removeCanvasFakes());

const KEY = "filename=a.png&subfolder=&type=input";
const SIZE = { width: 8, height: 8 };

/** `/view?channel=a` pixels: alpha 255 except a transparent 2x2 block at (1, 1). */
function alphaWithHole(): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(SIZE.width * SIZE.height * 4);
  for (let i = 0; i < SIZE.width * SIZE.height; i++) rgba[i * 4 + 3] = 255;
  for (const [x, y] of [[1, 1], [2, 1], [1, 2], [2, 2]] as const) rgba[(y * SIZE.width + x) * 4 + 3] = 0;
  return rgba;
}

function setup(): { ed: EditorClass; notes: string[] } {
  const ed = new Editor(createEmptyDocument(SIZE), "image");
  const notes: string[] = [];
  ed.events.on("note", (n) => notes.push(n));
  expect(ed.imageMask.setFromAlpha(KEY, SIZE, alphaWithHole())).toBe(true);
  return { ed, notes };
}

function depth(ed: EditorClass): number {
  return (ed as unknown as { s: { history: { undoDepth: number } } }).s.history.undoDepth;
}

describe("Image Mask row", () => {
  it("appears from alpha (not an undo step, dirty) and an opaque source removes it", () => {
    const { ed } = setup();
    expect(ed.doc.imageMask).toMatchObject({ id: IMAGE_MASK_ID, sourceKey: KEY, width: 8, height: 8, visible: true, file: null });
    expect(depth(ed)).toBe(0);
    expect(ed.dirty).toBe(true);
    const opaque = new Uint8ClampedArray(8 * 8 * 4).fill(255);
    expect(ed.imageMask.setFromAlpha("other", SIZE, opaque)).toBe(false);
    expect(ed.doc.imageMask).toBeUndefined();
    expect(ed.dirty).toBe(false);
  });

  it("uploads only when the source changes: settings keep it clean, a new source dirties it", () => {
    const { ed } = setup();
    ed.imageMask.markUploaded(ed.imageMask.version, "painter-sketch/ps-x-1.png [input]");
    expect(ed.dirty).toBe(false);
    ed.layerOps.setMaskColor(IMAGE_MASK_ID, "#123456");
    ed.layerOps.setMaskInvert(IMAGE_MASK_ID, true);
    ed.layerOps.setVisible(IMAGE_MASK_ID, false);
    expect(ed.dirty).toBe(false);
    expect(ed.doc.imageMask?.file).toBe("painter-sketch/ps-x-1.png [input]");
    // A new source keeps the settings but needs a new file.
    ed.imageMask.setFromAlpha("filename=b.png&subfolder=&type=input", SIZE, alphaWithHole());
    expect(ed.dirty).toBe(true);
    expect(ed.doc.imageMask).toMatchObject({ color: "#123456", invert: true, visible: false, file: null });
    // An upload of the previous version finishing late does not name the new source's file.
    ed.imageMask.markUploaded(ed.imageMask.version - 1, "painter-sketch/ps-x-1.png [input]");
    expect(ed.doc.imageMask?.file).toBeNull();
  });

  it("restores from its file without becoming dirty", () => {
    const { ed } = setup();
    ed.imageMask.markUploaded(ed.imageMask.version, "painter-sketch/ps-x-1.png [input]");
    const fresh = new Editor(ed.doc as never, "document");
    expect(fresh.imageMask.hasPixels).toBe(false);
    const file = new Uint8ClampedArray(8 * 8 * 4);
    file[(1 * 8 + 1) * 4 + 3] = 255;
    expect(fresh.imageMask.restore(file, { width: 4, height: 4 })).toBe(false);
    expect(fresh.imageMask.restore(file, SIZE)).toBe(true);
    expect(fresh.imageMask.hasPixels).toBe(true);
    expect(fresh.dirty).toBe(false);
  });

  it("colour / invert / opacity are undoable settings; rename and lock are refused", () => {
    const { ed } = setup();
    const before = ed.doc.imageMask?.color;
    expect(ed.layerOps.setMaskColor(IMAGE_MASK_ID, "#abcdef")).toBe(true);
    expect(ed.layerOps.setOpacity(IMAGE_MASK_ID, 0.2)).toBe(true);
    ed.undo();
    expect(ed.doc.imageMask?.opacity).not.toBe(0.2);
    ed.undo();
    expect(ed.doc.imageMask?.color).toBe(before);
    ed.redo();
    expect(ed.doc.imageMask?.color).toBe("#abcdef");
    expect(ed.layerOps.rename(IMAGE_MASK_ID, "Other")).toBe(false);
    ed.layerOps.setLocked(IMAGE_MASK_ID, true);
    expect(ed.doc.imageMask).toMatchObject({ name: "Image Mask", locked: false });
    expect(ed.layerOps.canDelete(IMAGE_MASK_ID)).toBe(false);
    expect(ed.layerOps.remove(IMAGE_MASK_ID)).toBe(false);
  });

  it("can be the current mask, but every pixel edit is refused with the note", () => {
    const { ed, notes } = setup();
    expect(ed.selectMask(IMAGE_MASK_ID)).toBe(true);
    expect(ed.paintTarget).toBe("mask");
    expect(ed.maskLayer?.id).toBe(IMAGE_MASK_ID);
    const steps = depth(ed);
    expect(ed.beginStroke({ color: "#fff", size: 4, hardness: 1, opacity: 1, flow: 1, spacing: 0.25, erase: false } as never, 4)).toBe(false);
    const fill = { point: { x: 1, y: 1 }, tolerance: 0, contiguous: true, antiAlias: false, sample: "layer", opacity: 1, color: "#fff" } as const;
    expect(ed.pixelOps.fill(fill)).toBe(false);
    ed.selection.selectAll();
    expect(ed.selection.fillSelected("#ffffff")).toBe(false);
    expect(ed.selection.clearSelected()).toBe(false);
    expect(ed.mergeDown()).toBe(false);
    expect(ed.canMergeDown()).toBe(false);
    expect(notes.filter((n) => n === IMAGE_MASK_NOTE).length).toBeGreaterThanOrEqual(5);
    expect(depth(ed)).toBe(steps + 1); // only the Select All step
  });

  it("Ctrl+click selects the effective coverage (invert applied, image only)", () => {
    const { ed } = setup();
    expect(ed.selection.fromLayer(IMAGE_MASK_ID, "replace")).toBe(true);
    const cov = (x: number, y: number): number => coverageAt(ed.selection.current, x, y);
    expect([cov(1, 1), cov(2, 2), cov(0, 0), cov(5, 5)]).toEqual([255, 255, 0, 0]);
    ed.layerOps.setMaskInvert(IMAGE_MASK_ID, true);
    ed.selection.fromLayer(IMAGE_MASK_ID, "replace");
    expect([cov(1, 1), cov(0, 0), cov(7, 7), cov(9, 9)]).toEqual([0, 255, 255, 0]);
  });

  it("Duplicate makes an ordinary current mask with the coverage and settings", () => {
    const { ed } = setup();
    ed.layerOps.setMaskInvert(IMAGE_MASK_ID, true);
    const masksBefore = ed.doc.layers.filter((l) => l.kind === "mask").length;
    const id = ed.imageMask.duplicate();
    expect(id).toBeTruthy();
    const copy = ed.doc.layers.find((l) => l.id === id);
    expect(copy).toMatchObject({ kind: "mask", name: "Image Mask copy", invert: true, opacity: ed.doc.imageMask?.opacity });
    expect(ed.doc.layers.filter((l) => l.kind === "mask").length).toBe(masksBefore + 1);
    // Distinct colour: neither the row's nor any existing mask's.
    const others = [ed.doc.imageMask?.color, ...ed.doc.layers.filter((l) => l.kind === "mask" && l.id !== id).map((l) => l.color)];
    expect(others.map((c) => c?.toLowerCase())).not.toContain(copy?.color?.toLowerCase());
    // Bottom of the mask stack, right above the Image Mask row.
    expect(ed.doc.layers.findIndex((l) => l.kind === "mask")).toBe(ed.doc.layers.findIndex((l) => l.id === id));
    expect(ed.maskLayer?.id).toBe(id);
    const px = (ed.layerCanvas(id ?? "") as unknown as { px: Uint8ClampedArray }).px;
    expect(px[(1 * 8 + 1) * 4 + 3]).toBe(255);
    expect(px[3]).toBe(0);
    ed.undo();
    expect(ed.doc.layers.some((l) => l.id === id)).toBe(false);
    expect(ed.doc.imageMask).toBeDefined();
  });

  it("solo works like a mask's and survives layer-list changes; removal ends it", () => {
    const { ed } = setup();
    ed.toggleSolo(IMAGE_MASK_ID);
    expect(ed.solo.mask).toBe(IMAGE_MASK_ID);
    ed.layerOps.add();
    expect(ed.solo.mask).toBe(IMAGE_MASK_ID);
    ed.imageMask.remove();
    expect(ed.solo.mask).toBeNull();
  });
});
