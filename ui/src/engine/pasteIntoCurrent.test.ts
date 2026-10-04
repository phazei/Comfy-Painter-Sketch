/**
 * Paste into the current layer (`into: "current"`, the Paste menu toggle /
 * Simple mode): the image floats on the current edit surface -- a paint
 * layer's pixels (composited over on commit), or under Quick Mask the
 * current mask (gray, replacing) -- never a new layer. Oversized pastes
 * start in Free Transform on that surface; refused targets only note.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createEmptyDocument } from "../document/create";
import { NO_PASTE_LAYER_NOTE, PASTE_TRANSFORM_NOTE } from "./clipboardOps";
import type { Editor as EditorClass } from "./editor";
import { BACKGROUND_NOTE, LOCKED_LAYER_NOTE } from "./editorTypes";
import type { BlendCanvas } from "./fakeCanvas.testutil";
import { installBlendCanvasFakes, removeCanvasFakes } from "./fakeCanvas.testutil";
import { coverageAt, rectSelection } from "./selection";

let Editor: typeof EditorClass;

beforeAll(async () => {
  installBlendCanvasFakes();
  ({ Editor } = await import("./editor"));
});

afterAll(() => removeCanvasFakes());

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Solid source canvas. */
function solid(w: number, h: number, rgba: number[]): CanvasImageSource {
  const c = document.createElement("canvas") as unknown as BlendCanvas;
  c.width = w;
  c.height = h;
  for (let i = 0; i < w * h; i++) c.px.set(rgba, i * 4);
  return c as unknown as CanvasImageSource;
}

/** RGBA of a layer at a document point. */
function pixel(ed: EditorClass, id: string, x: number, y: number): number[] {
  const c = ed.layerCanvas(id) as unknown as BlendCanvas;
  const b = ed.bounds;
  const p = ((y - b.y) * c.width + (x - b.x)) * 4;
  return [...c.px.subarray(p, p + 4)];
}

/** 32x32 editor whose active paint layer is blue at (4, 4) (empty when tiny). */
function setup(size = 32): { ed: EditorClass; id: string; notes: string[] } {
  const ed = new Editor(createEmptyDocument({ width: size, height: size }), "widgets");
  const notes: string[] = [];
  ed.events.on("note", (n) => notes.push(n));
  const id = ed.doc.activeLayerId;
  const c = ed.layerCanvas(id) as unknown as BlendCanvas;
  const b = ed.bounds;
  if (size > 4) c.px.set([0, 0, 255, 255], ((4 - b.y) * c.width + (4 - b.x)) * 4);
  return { ed, id, notes };
}

function paste(ed: EditorClass, src: CanvasImageSource, w: number, h: number, topLeft: { x: number; y: number }) {
  return ed.clipboard.paste(src, { width: w, height: h }, 1, { topLeft }, "current");
}

// ═══════════════════════════════════════════════════════════════════════════

describe("paint layer", () => {
  it("floats on the layer (no new layer), untouched until commit, one undo step", () => {
    const { ed, id } = setup();
    const count = ed.doc.layers.length;
    const result = paste(ed, solid(2, 1, [255, 0, 0, 255]), 2, 1, { x: 3, y: 4 });
    expect(result).toMatchObject({ layerId: id, floating: true, transform: false });
    expect(ed.doc.layers.length).toBe(count);
    expect(ed.float.layerId).toBe(id);
    expect(pixel(ed, id, 4, 4)).toEqual([0, 0, 255, 255]);
    ed.float.nudge(1, 0); // (4..5, 4): covers the blue pixel
    expect(ed.float.commit()).toBe(true);
    expect([pixel(ed, id, 3, 4), pixel(ed, id, 4, 4), pixel(ed, id, 5, 4)]).toEqual([[0, 0, 0, 0], [255, 0, 0, 255], [255, 0, 0, 255]]);
    ed.undo();
    expect([pixel(ed, id, 4, 4), pixel(ed, id, 5, 4)]).toEqual([[0, 0, 255, 255], [0, 0, 0, 0]]);
    expect(ed.doc.layers.length).toBe(count);
  });

  it("its outline is the selection while floating (moves with it); commit drops it in the same step", () => {
    const { ed } = setup();
    const before = rectSelection({ x: 20, y: 20, width: 4, height: 4 });
    ed.selection.apply(before, "replace");
    const prior = ed.selection.current;
    paste(ed, solid(2, 1, [255, 0, 0, 255]), 2, 1, { x: 3, y: 4 });
    const sel = (): number[] => [3, 4, 5, 20].map((x) => coverageAt(ed.selection.current, x, x === 20 ? 20 : 4));
    expect(sel()).toEqual([255, 255, 0, 0]);
    ed.float.nudge(1, 0);
    expect(sel()).toEqual([0, 255, 255, 0]);
    ed.float.commit();
    expect(ed.selection.current).toBeNull();
    ed.undo(); // pixels and the old selection, one step
    expect(ed.selection.current).toBe(prior);
  });

  it("composites over: transparent parts keep the layer", () => {
    const { ed, id } = setup();
    paste(ed, solid(1, 1, [255, 0, 0, 0]), 1, 1, { x: 4, y: 4 });
    ed.float.commit();
    expect(pixel(ed, id, 4, 4)).toEqual([0, 0, 255, 255]);
  });

  it("cancel: nothing happened, the selection is back", () => {
    const { ed, id } = setup();
    ed.selection.apply(rectSelection({ x: 2, y: 2, width: 4, height: 4 }), "replace");
    paste(ed, solid(2, 2, [255, 0, 0, 255]), 2, 2, { x: 4, y: 4 });
    expect(coverageAt(ed.selection.current, 3, 3)).toBe(0); // the paste's outline, not the old selection
    ed.float.cancel();
    expect([ed.float.active, pixel(ed, id, 4, 4), ed.canRedo]).toEqual([false, [0, 0, 255, 255], false]);
    expect(coverageAt(ed.selection.current, 3, 3)).toBe(255);
  });

  it("oversized: Free Transform on the current layer (note), no new layer", () => {
    const { ed, id, notes } = setup(4);
    const count = ed.doc.layers.length;
    const result = paste(ed, solid(20, 4, [255, 0, 0, 255]), 20, 4, { x: -8, y: 0 });
    expect(result).toMatchObject({ layerId: id, floating: true, transform: true });
    expect(notes).toEqual([PASTE_TRANSFORM_NOTE]);
    expect([ed.float.transform.active, ed.float.layerId, ed.doc.layers.length]).toEqual([true, id, count]);
    ed.float.cancel();
    expect([ed.float.active, ed.doc.layers.length]).toEqual([false, count]);
  });

  it("an image-source insert follows it: Free Transform on the current layer, no note, commit lands", () => {
    const { ed, id, notes } = setup();
    const count = ed.doc.layers.length;
    const px = new ImageData(new Uint8ClampedArray([255, 0, 0, 255, 255, 0, 0, 255]), 2, 1);
    expect(ed.insert.insert(px, "Source", "current")).toBe(true);
    expect([ed.float.transform.active, ed.float.layerId, ed.doc.layers.length, notes]).toEqual([true, id, count, []]);
    const p = ed.float.transform.params;
    expect(p).toMatchObject({ sx: 1, sy: 1, angle: 0 }); // native size (it fits)
    ed.float.transform.commit();
    expect(ed.float.active).toBe(false);
    expect(ed.doc.layers.length).toBe(count);
    expect(pixel(ed, id, 4, 4)).toEqual([0, 0, 255, 255]); // the layer keeps its pixels
    expect(pixel(ed, id, p!.cx - 1, p!.cy - 0.5)).toEqual([255, 0, 0, 255]);
  });

  it("the default (new) still makes a layer", () => {
    const { ed } = setup();
    const count = ed.doc.layers.length;
    ed.clipboard.paste(solid(1, 1, [255, 0, 0, 255]), { width: 1, height: 1 }, 1, { topLeft: { x: 4, y: 4 } });
    expect(ed.doc.layers.length).toBe(count + 1);
  });
});

describe("refused", () => {
  it("locked layer / Background: the gate's note, no float, no layer", () => {
    const { ed, id, notes } = setup();
    const count = ed.doc.layers.length;
    ed.layerOps.setLocked(id, true);
    expect(paste(ed, solid(1, 1, [255, 0, 0, 255]), 1, 1, { x: 4, y: 4 })).toBeNull();
    ed.layerOps.setLocked(id, false);
    ed.selectBackground();
    expect(paste(ed, solid(1, 1, [255, 0, 0, 255]), 1, 1, { x: 4, y: 4 })).toBeNull();
    expect(notes).toEqual([LOCKED_LAYER_NOTE, BACKGROUND_NOTE]);
    expect([ed.float.active, ed.doc.layers.length]).toEqual([false, count]);
  });

  it("no paint layer at all: a note", () => {
    const { ed, id, notes } = setup();
    ed.layerOps.remove(id);
    if (ed.doc.layers.some((l) => l.kind === "paint")) return; // a document always keeps one: nothing to check
    expect(paste(ed, solid(1, 1, [255, 0, 0, 255]), 1, 1, { x: 4, y: 4 })).toBeNull();
    expect(notes).toContain(NO_PASTE_LAYER_NOTE);
  });
});

describe("Quick Mask", () => {
  it("floats on the current mask as gray, replacing; Quick Mask stays on", () => {
    const { ed } = setup();
    ed.setPaintTarget("mask");
    const count = ed.doc.layers.length;
    // Red = luminance 54.
    const result = paste(ed, solid(2, 1, [255, 0, 0, 255]), 2, 1, { x: 6, y: 6 });
    const mask = ed.doc.layers.find((l) => l.id === result?.layerId);
    expect(mask?.kind).toBe("mask");
    expect(result?.floating).toBe(true);
    expect(ed.float.layerId).toBe(mask!.id);
    ed.float.commit();
    expect([pixel(ed, mask!.id, 6, 6)[3], pixel(ed, mask!.id, 7, 6)[3], pixel(ed, mask!.id, 8, 6)[3]]).toEqual([54, 54, 0]);
    expect([ed.paintTarget, ed.doc.layers.length]).toEqual(["mask", count]);
  });
});
