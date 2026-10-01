/**
 * Input Mask row in the editor (`ImageMaskOps.setInput`): name switch,
 * settings carried over both ways, never dirty (no upload, no file), a saved
 * file is not restored onto it, the waiting hint state, edit refusal with its
 * own name, Ctrl+click / Duplicate / solo like the Image Mask; coverage
 * conversions (gray preview, resize to the image). Canvas fakes: `fakeCanvas.testutil.ts`.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createEmptyDocument } from "../document/create";
import { IMAGE_MASK_ID, IMAGE_MASK_NAME, INPUT_MASK_NAME } from "../document/imageMask";
import { parseDocument } from "../document/parse";
import { stringifyDocument } from "../document/serialize";
import type { Editor as EditorClass } from "./editor";
import { imageMaskNote } from "./editorTypes";
import { installCanvasFakes, removeCanvasFakes } from "./fakeCanvas.testutil";
import { coverageFromGray, resampleCoverage } from "./imageMask";
import { coverageAt } from "./selection";

let Editor: typeof EditorClass;

beforeAll(async () => {
  installCanvasFakes();
  ({ Editor } = await import("./editor"));
});

afterAll(() => removeCanvasFakes());

const SIZE = { width: 8, height: 8 };
const KEY = "mask:live:filename=a.png&subfolder=&type=input";

/** Coverage 255 in a 2x2 block at (1, 1). */
function block(): Uint8Array {
  const c = new Uint8Array(64);
  for (const [x, y] of [[1, 1], [2, 1], [1, 2], [2, 2]] as const) c[y * 8 + x] = 255;
  return c;
}

function alphaOpaqueWithHole(): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(64 * 4);
  for (let i = 0; i < 64; i++) rgba[i * 4 + 3] = 255;
  rgba[3] = 0;
  return rgba;
}

function setup(): { ed: EditorClass; notes: string[] } {
  const ed = new Editor(createEmptyDocument(SIZE), "image");
  const notes: string[] = [];
  ed.events.on("note", (n) => notes.push(n));
  return { ed, notes };
}

describe("Input Mask row", () => {
  it("is named Input Mask while connected and Image Mask again after; settings survive both ways", () => {
    const { ed } = setup();
    ed.imageMask.setFromAlpha("filename=a.png&subfolder=&type=input", SIZE, alphaOpaqueWithHole());
    ed.layerOps.setMaskInvert(IMAGE_MASK_ID, true);
    ed.layerOps.setMaskColor(IMAGE_MASK_ID, "#123456");
    ed.imageMask.setInput(KEY, SIZE, block(), false);
    expect(ed.doc.imageMask).toMatchObject({ name: INPUT_MASK_NAME, invert: true, color: "#123456", file: null, sourceKey: KEY });
    expect(ed.imageMask.isInput).toBe(true);
    ed.layerOps.setVisible(IMAGE_MASK_ID, false);
    // Disconnect: the image alpha comes back with the settings.
    ed.imageMask.setFromAlpha("filename=a.png&subfolder=&type=input", SIZE, alphaOpaqueWithHole());
    expect(ed.doc.imageMask).toMatchObject({ name: IMAGE_MASK_NAME, invert: true, visible: false, color: "#123456" });
    expect(ed.imageMask.isInput).toBe(false);
  });

  it("is never dirty (no upload) and saves settings without a file; the name follows the key on reload", () => {
    const { ed } = setup();
    ed.imageMask.setInput(KEY, SIZE, block(), false);
    expect(ed.dirty).toBe(false);
    expect(ed.imageMask.dirty).toBe(false);
    const saved = JSON.parse(stringifyDocument(ed.doc)) as Record<string, unknown>;
    expect(saved["imageMask"]).toMatchObject({ file: null, sourceKey: KEY, width: 8, height: 8 });
    const back = parseDocument(saved);
    expect(back.status === "ok" && back.document.imageMask?.name).toBe(INPUT_MASK_NAME);
    // A late restore of an old Image Mask file is not applied to the Input Mask.
    const file = new Uint8ClampedArray(64 * 4);
    expect(ed.imageMask.restore(file, SIZE)).toBe(false);
  });

  it("an empty row can wait for a run", () => {
    const { ed } = setup();
    ed.imageMask.setInput("mask:wait:5#1", SIZE, null, true);
    expect(ed.doc.imageMask?.name).toBe(INPUT_MASK_NAME);
    expect(ed.imageMask.hasPixels).toBe(false);
    expect(ed.imageMask.waiting).toBe(true);
    expect(ed.selection.fromLayer(IMAGE_MASK_ID, "replace")).toBe(false);
    ed.imageMask.setInput("mask:preview:abc", SIZE, block(), false);
    expect(ed.imageMask.waiting).toBe(false);
    expect(ed.imageMask.hasPixels).toBe(true);
  });

  it("refuses pixel edits with its own name; Ctrl+click, Duplicate and solo work", () => {
    const { ed, notes } = setup();
    ed.imageMask.setInput(KEY, SIZE, block(), false);
    expect(ed.selectMask(IMAGE_MASK_ID)).toBe(true);
    ed.selection.selectAll();
    expect(ed.selection.fillSelected("#ffffff")).toBe(false);
    expect(ed.mergeDown()).toBe(false);
    expect(notes).toContain(imageMaskNote(INPUT_MASK_NAME));
    expect(ed.selection.fromLayer(IMAGE_MASK_ID, "replace")).toBe(true);
    expect([coverageAt(ed.selection.current, 1, 1), coverageAt(ed.selection.current, 5, 5)]).toEqual([255, 0]);
    const id = ed.imageMask.duplicate();
    expect(ed.doc.layers.find((l) => l.id === id)).toMatchObject({ kind: "mask", name: "Input Mask copy" });
    ed.toggleSolo(IMAGE_MASK_ID);
    expect(ed.solo.mask).toBe(IMAGE_MASK_ID);
    ed.imageMask.setInput("mask:preview:abc", SIZE, block(), false);
    expect(ed.solo.mask).toBe(IMAGE_MASK_ID);
  });
});

describe("Input Mask coverage conversions", () => {
  it("gray preview value = coverage", () => {
    const rgba = new Uint8ClampedArray([10, 10, 10, 255, 200, 200, 200, 255]);
    expect([...coverageFromGray(rgba)]).toEqual([10, 200]);
  });

  it("resamples to the image size (same size: the plane itself)", () => {
    const plane = new Uint8Array([255, 0]);
    expect(resampleCoverage(plane, { width: 2, height: 1 }, { width: 2, height: 1 })).toBe(plane);
    const wide = resampleCoverage(plane, { width: 2, height: 1 }, { width: 4, height: 2 });
    expect(wide.length).toBe(8);
    expect([...wide.slice(0, 4)]).toEqual([255, 191, 64, 0]);
    expect([...wide.slice(4)]).toEqual([...wide.slice(0, 4)]);
  });
});
