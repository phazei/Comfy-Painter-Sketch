/**
 * The "To mask" / "New mask" target survives the read-only Image / Input Mask
 * row being current (`EditorState.lastCmaskId`, SPEC "Layers" > "cmasks,
 * current mask and Quick Mask"): selecting that row changes the current mask
 * (panel, chip, copy) but never where a selection is sent, where a new mask
 * is inserted, or what `Q` turns on. Canvas fakes: `fakeCanvas.testutil.ts`.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createEmptyDocument } from "../document/create";
import { IMAGE_MASK_ID, INPUT_MASK_NAME } from "../document/imageMask";
import type { Editor as EditorClass } from "./editor";
import { HIDDEN_MASK_NOTE, imageMaskNote } from "./editorTypes";
import { installBlendCanvasFakes, removeCanvasFakes } from "./fakeCanvas.testutil";

let Editor: typeof EditorClass;

beforeAll(async () => {
  installBlendCanvasFakes();
  ({ Editor } = await import("./editor"));
});

afterAll(() => removeCanvasFakes());

const SIZE = { width: 8, height: 8 };
const KEY = "mask:live:filename=a.png&subfolder=&type=input";

/** Mask 1 (from the empty document), Mask 2 added above it, the Input Mask row connected. */
function setup(): { ed: EditorClass; notes: string[]; paintId: string; mask1: string; mask2: string } {
  const ed = new Editor(createEmptyDocument(SIZE), "image");
  const notes: string[] = [];
  ed.events.on("note", (n) => notes.push(n));
  const paintId = ed.doc.activeLayerId;
  const mask1 = ed.doc.layers.find((l) => l.kind === "mask")?.id ?? "";
  const mask2 = ed.layerOps.addMask() ?? "";
  ed.imageMask.setInput(KEY, SIZE, new Uint8Array(64), false);
  return { ed, notes, paintId, mask1, mask2 };
}

/** A paint row click in the panel: active layer + Quick Mask off. */
function clickPaint(ed: EditorClass, id: string): void {
  ed.layerOps.setActiveLayer(id);
  ed.setPaintTarget("paint");
}

/** Alpha of one document pixel of a layer (store bounds = frame here). */
function alpha(ed: EditorClass, layerId: string, x: number, y: number): number {
  const ctx = ed.layerCanvas(layerId).getContext("2d");
  if (!ctx) throw new Error("no context");
  return ctx.getImageData(x, y, 1, 1).data[3] ?? -1;
}

describe("the Input Mask row and the cmask target", () => {
  it("'To mask' adds to the last real cmask after the row was selected, not to the row", () => {
    const { ed, notes, paintId, mask1, mask2 } = setup();
    expect(ed.selectMask(mask1)).toBe(true);
    expect(ed.selectMask(IMAGE_MASK_ID)).toBe(true);
    expect(ed.maskLayer?.id).toBe(IMAGE_MASK_ID);
    expect(ed.cmaskLayer?.id).toBe(mask1);
    clickPaint(ed, paintId);
    expect(ed.paintTarget).toBe("paint");
    ed.selection.selectAll();
    expect(ed.selection.toMask()).toBe(true);
    expect(notes).not.toContain(imageMaskNote(INPUT_MASK_NAME));
    expect(alpha(ed, mask1, 3, 3)).toBe(255);
    expect(alpha(ed, mask2, 3, 3)).toBe(0);
  });

  it("'To mask' while the row itself is current still goes to the last real cmask (the row stays current)", () => {
    const { ed, notes, mask1 } = setup();
    ed.selectMask(mask1);
    ed.selectMask(IMAGE_MASK_ID);
    ed.selection.selectAll();
    expect(ed.selection.toMask()).toBe(true);
    expect(notes).toHaveLength(0);
    expect(alpha(ed, mask1, 0, 0)).toBe(255);
    expect(ed.maskLayer?.id).toBe(IMAGE_MASK_ID);
  });

  it("'To mask' with the Background row selected goes to the target cmask (Background stays selected)", () => {
    const { ed, notes, mask1 } = setup();
    ed.selectMask(mask1);
    ed.selectBackground();
    ed.selection.selectAll();
    expect(ed.selection.toMask()).toBe(true);
    expect(notes).toHaveLength(0);
    expect(alpha(ed, mask1, 0, 0)).toBe(255);
    expect(ed.backgroundSelected).toBe(true);
    // A hidden target cmask is still refused.
    ed.layerOps.setVisible(mask1, false);
    expect(ed.selection.toMask()).toBe(false);
    expect(notes).toEqual([HIDDEN_MASK_NOTE]);
  });

  it("falls back to the top-most cmask when no real cmask was ever selected", () => {
    const { ed, mask2 } = setup();
    ed.imageMask.remove();
    const fresh = new Editor(ed.doc, "image");
    fresh.imageMask.setInput(KEY, SIZE, new Uint8Array(64), false);
    fresh.selectMask(IMAGE_MASK_ID);
    fresh.selection.selectAll();
    expect(fresh.selection.toMask()).toBe(true);
    expect(alpha(fresh, mask2, 0, 0)).toBe(255);
  });

  it("Quick Mask toggle with the row current selects the last real cmask instead", () => {
    const { ed, paintId, mask1 } = setup();
    ed.selectMask(mask1);
    ed.selectMask(IMAGE_MASK_ID);
    ed.togglePaintTarget();
    expect(ed.paintTarget).toBe("mask");
    expect(ed.maskLayer?.id).toBe(mask1);
    // Stale row id with a paint layer active: Q turns Quick Mask on over the real cmask.
    ed.selectMask(IMAGE_MASK_ID);
    clickPaint(ed, paintId);
    expect(ed.paintTarget).toBe("paint");
    ed.togglePaintTarget();
    expect(ed.paintTarget).toBe("mask");
    expect(ed.maskLayer?.id).toBe(mask1);
  });

  it("'New mask' inserts above the last real cmask, and the new mask becomes both current and target", () => {
    const { ed, mask1, mask2 } = setup();
    ed.selectMask(mask1);
    ed.selectMask(IMAGE_MASK_ID);
    const added = ed.layerOps.addMask() ?? "";
    const order = ed.doc.layers.filter((l) => l.kind === "mask").map((l) => l.id);
    expect(order).toEqual([mask1, added, mask2]);
    expect(ed.maskLayer?.id).toBe(added);
    expect(ed.cmaskLayer?.id).toBe(added);
  });

  it("Duplicate of a cmask: pixels, settings and Subtract kept, next palette colour, current + target, paint layer untouched", () => {
    const { ed, paintId, mask1 } = setup();
    ed.selectMask(mask1);
    ed.selection.selectAll();
    ed.selection.toMask();
    ed.layerOps.setMaskSubtract(mask1, true);
    ed.layerOps.setOpacity(mask1, 0.3);
    const copy = ed.layerOps.duplicate(mask1) ?? "";
    const layer = ed.doc.layers.find((l) => l.id === copy);
    expect(layer).toMatchObject({ kind: "mask", name: "Mask 1 copy", subtract: true, opacity: 0.3 });
    expect(layer?.color).not.toBe(ed.doc.layers.find((l) => l.id === mask1)?.color);
    expect(alpha(ed, copy, 2, 2)).toBe(255);
    expect(ed.doc.layers.findIndex((l) => l.id === copy)).toBe(ed.doc.layers.findIndex((l) => l.id === mask1) + 1);
    expect(ed.maskLayer?.id).toBe(copy);
    expect(ed.cmaskLayer?.id).toBe(copy);
    expect(ed.doc.activeLayerId).toBe(paintId);
    ed.undo();
    expect(ed.doc.layers.some((l) => l.id === copy)).toBe(false);
  });

  it("deleting the target cmask moves the target like the current mask; removing the row restores the cmask", () => {
    const { ed, mask1, mask2 } = setup();
    ed.selectMask(mask1);
    ed.selectMask(IMAGE_MASK_ID);
    expect(ed.layerOps.remove(mask1)).toBe(true);
    expect(ed.cmaskLayer?.id).toBe(mask2);
    expect(ed.maskLayer?.id).toBe(IMAGE_MASK_ID);
    ed.imageMask.remove();
    expect(ed.maskLayer?.id).toBe(mask2);
  });
});
