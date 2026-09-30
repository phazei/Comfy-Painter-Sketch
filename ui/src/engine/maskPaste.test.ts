/**
 * Paste into the lmask-only view (M14b): the image lands on the viewed lmask
 * as an lmask float (luminance x alpha; our own lmask copy round-trips
 * exactly) at the normal placement; move / commit / cancel / undo like other
 * lmask floats; oversized pastes open Free Transform on the lmask. Outside
 * the view a paste still makes a new paint layer.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createEmptyDocument } from "../document/create";
import { layerMaskKey } from "../document/layerMask";
import type { Rect } from "../geometry/rect";
import { imageToMaskGray } from "./clipboardMath";
import { PASTE_TRANSFORM_NOTE } from "./clipboardOps";
import type { Editor as EditorClass } from "./editor";
import type { EditorState } from "./editorState";
import type { BlendCanvas } from "./fakeCanvas.testutil";
import { installBlendCanvasFakes, removeCanvasFakes } from "./fakeCanvas.testutil";
import { pasteContext, pasteTopLeft } from "./pastePlacement";
import { coverageAt, rectSelection } from "./selection";

let Editor: typeof EditorClass;

beforeAll(async () => {
  installBlendCanvasFakes();
  ({ Editor } = await import("./editor"));
});

afterAll(() => removeCanvasFakes());

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Source canvas holding `rgba` rows. */
function image(w: number, h: number, rgba: (x: number, y: number) => number[]): CanvasImageSource {
  const c = document.createElement("canvas") as unknown as BlendCanvas;
  c.width = w;
  c.height = h;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) c.px.set(rgba(x, y), (y * w + x) * 4);
  return c as unknown as CanvasImageSource;
}

function maskA(ed: EditorClass, id: string, x: number, y: number): number {
  const c = ed.layerMask.canvas(id) as unknown as BlendCanvas;
  const b = ed.bounds;
  return c.px[((y - b.y) * c.width + (x - b.x)) * 4 + 3] ?? -1;
}

/** Red (value 54) paste source. */
const red = (w: number, h: number): CanvasImageSource => image(w, h, () => [255, 0, 0, 255]);

/** 32x32 editor, a reveal lmask on the active layer, lmask-only view on. */
function setup(size = 32): { ed: EditorClass; id: string; notes: string[] } {
  const ed = new Editor(createEmptyDocument({ width: size, height: size }), "widgets");
  const notes: string[] = [];
  ed.events.on("note", (n) => notes.push(n));
  const id = ed.doc.activeLayerId;
  ed.layerMask.add(id, "reveal");
  ed.layerMask.toggleView(id);
  return { ed, id, notes };
}

function paste(ed: EditorClass, src: CanvasImageSource, w: number, h: number, topLeft: { x: number; y: number }) {
  return ed.clipboard.paste(src, { width: w, height: h }, 1, { topLeft });
}

// ═══════════════════════════════════════════════════════════════════════════

describe("conversion", () => {
  it("Rec.709 luminance x alpha; transparent = black (shown); coverage 255", () => {
    const px = new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 128, 255, 255, 255, 0, 0, 0, 255, 255]);
    imageToMaskGray(px);
    expect([...px]).toEqual([54, 54, 54, 255, 92, 92, 92, 255, 0, 0, 0, 255, 18, 18, 18, 255]);
  });

  it("opaque grayscale (our lmask copy) keeps every value exactly", () => {
    const px = new Uint8ClampedArray(256 * 4);
    for (let v = 0; v < 256; v++) px.set([v, v, v, 255], v * 4);
    imageToMaskGray(px);
    for (let v = 0; v < 256; v++) expect(px[v * 4]).toBe(v);
  });
});

describe("routing", () => {
  it("only the lmask-only view pastes into the lmask; otherwise a new layer", () => {
    const { ed, id } = setup();
    const count = ed.doc.layers.length;
    const result = paste(ed, red(2, 1), 2, 1, { x: 4, y: 4 });
    expect(result?.intoMask).toBe(true);
    expect(ed.doc.layers.length).toBe(count);
    expect(ed.float.layerId).toBe(layerMaskKey(id));
    ed.float.commit();
    expect([maskA(ed, id, 4, 4), maskA(ed, id, 5, 4), maskA(ed, id, 6, 4)]).toEqual([54, 54, 0]);
    // Mask targeted but the view off: a normal paste.
    ed.layerMask.endView();
    const plain = paste(ed, red(2, 1), 2, 1, { x: 10, y: 10 });
    expect(plain?.intoMask).toBeUndefined();
    expect(ed.doc.layers.length).toBe(count + 1);
    expect(maskA(ed, id, 10, 10)).toBe(0);
  });

  it("a locked layer refuses (note), nothing floats", () => {
    const { ed, id, notes } = setup();
    ed.layerOps.setLocked(id, true);
    expect(paste(ed, red(2, 1), 2, 1, { x: 4, y: 4 })).toBeNull();
    expect(ed.float.active).toBe(false);
    expect(notes.length).toBe(1);
  });
});

describe("float on the lmask", () => {
  it("our lmask copy pastes back exactly (in place and elsewhere)", () => {
    const { ed, id } = setup();
    const s = (ed as unknown as { s: EditorState }).s;
    s.store.write(layerMaskKey(id), 4, 4, new ImageData(new Uint8ClampedArray([255, 255, 255, 255, 255, 255, 255, 77, 255, 255, 255, 255]), 3, 1));
    s.runtime.touch(layerMaskKey(id));
    ed.selection.apply(rectSelection({ x: 4, y: 4, width: 3, height: 1 }), "replace");
    const clip = ed.clipboard.copy(false);
    ed.selection.deselect();
    expect(clip).not.toBeNull();
    const { data, rect } = clip!;
    const src = image(data.width, data.height, (x, y) => [...data.data.subarray((y * data.width + x) * 4, (y * data.width + x) * 4 + 4)]);
    paste(ed, src, data.width, data.height, { x: rect.x, y: rect.y + 10 });
    ed.float.commit();
    expect([maskA(ed, id, 4, 14), maskA(ed, id, 5, 14), maskA(ed, id, 6, 14), maskA(ed, id, 7, 14)]).toEqual([255, 77, 255, 0]);
    paste(ed, src, data.width, data.height, { x: rect.x, y: rect.y });
    ed.float.commit();
    expect([maskA(ed, id, 4, 4), maskA(ed, id, 5, 4), maskA(ed, id, 6, 4)]).toEqual([255, 77, 255]);
  });

  it("placement: centred on the selection; the selection drops in the commit's step", () => {
    const { ed, id } = setup();
    const selRect: Rect = { x: 10, y: 10, width: 6, height: 4 };
    ed.selection.apply(rectSelection(selRect), "replace");
    const ctx = pasteContext({ selection: ed.selection.current, view: ed.view.current, stage: ed.view.stageSize, map: ed.frameMap, imageSize: ed.imageSize }, null);
    const at = pasteTopLeft({ width: 2, height: 2 }, ctx);
    expect(at).toEqual({ x: 12, y: 11 });
    paste(ed, red(2, 2), 2, 2, at);
    expect(ed.selection.current).toBeNull();
    expect(ed.float.commit()).toBe(true);
    expect([maskA(ed, id, 12, 11), maskA(ed, id, 13, 12), maskA(ed, id, 14, 11)]).toEqual([54, 54, 0]);
    ed.undo(); // one step: mask + selection back
    expect(maskA(ed, id, 12, 11)).toBe(0);
    expect(coverageAt(ed.selection.current, 10, 10)).toBe(255);
    ed.redo();
    expect([maskA(ed, id, 12, 11), ed.selection.current]).toEqual([54, null]);
  });

  it("moves before commit, shows live in the view, replaces what it lands on", () => {
    const { ed, id } = setup();
    paste(ed, image(1, 1, () => [255, 255, 255, 255]), 1, 1, { x: 4, y: 4 });
    ed.float.commit(); // a hidden pixel at (4, 4)
    paste(ed, image(2, 1, () => [0, 0, 0, 0]), 2, 1, { x: 0, y: 4 }); // transparent = black
    ed.float.nudge(4, 0);
    const view = ed.compositeLayers()[0]?.source as unknown as BlendCanvas;
    const b = ed.bounds;
    expect(view.px[((4 - b.y) * view.width + (4 - b.x)) * 4]).toBe(0); // the float covers it, black
    expect(maskA(ed, id, 4, 4)).toBe(255); // the surface is untouched while floating
    ed.float.commit();
    expect(maskA(ed, id, 4, 4)).toBe(0);
    ed.undo();
    expect(maskA(ed, id, 4, 4)).toBe(255);
  });

  it("cancel / Ctrl+Z while floating: nothing happened, the selection is back", () => {
    const { ed, id } = setup();
    ed.selection.apply(rectSelection({ x: 2, y: 2, width: 4, height: 4 }), "replace");
    const sel = ed.selection.current;
    for (const end of [() => ed.float.cancel(), () => ed.undo()]) {
      paste(ed, red(2, 2), 2, 2, { x: 3, y: 3 });
      expect(ed.float.active).toBe(true);
      end();
      expect([ed.float.active, maskA(ed, id, 3, 3), ed.canRedo]).toEqual([false, 0, false]);
      expect(ed.selection.current).toBe(sel);
    }
  });
});

describe("oversized paste into the lmask", () => {
  // Frame 4 x 4: cap = 12 x 12 at (-4, -4).
  it("opens Free Transform on the lmask (note); commit crops = one step; cancel = nothing", () => {
    const { ed, id, notes } = setup(4);
    const count = ed.doc.layers.length;
    const result = paste(ed, red(20, 4), 20, 4, { x: -8, y: 0 });
    expect(result).toMatchObject({ transform: true, intoMask: true });
    expect(notes).toEqual([PASTE_TRANSFORM_NOTE]);
    expect(ed.float.transform.active).toBe(true);
    expect(ed.float.layerId).toBe(layerMaskKey(id));
    expect(ed.float.transform.params).toEqual({ cx: 2, cy: 2, sx: 1, sy: 1, angle: 0 });
    expect(ed.doc.layers.length).toBe(count);
    ed.float.transform.commit();
    expect(ed.float.active).toBe(false);
    expect([maskA(ed, id, -4, 0), maskA(ed, id, 7, 3), maskA(ed, id, 0, 3)]).toEqual([54, 54, 54]);
    ed.undo();
    expect([maskA(ed, id, 0, 0), maskA(ed, id, 7, 3)]).toEqual([0, 0]);
    paste(ed, red(20, 4), 20, 4, { x: -8, y: 0 });
    ed.float.cancel();
    expect([ed.float.transform.active, maskA(ed, id, 0, 0), ed.canRedo]).toEqual([false, 0, true]);
  });
});
