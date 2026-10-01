/**
 * Layer mask interactions (SPEC "Layer masks (lmask)", Carry): whole-layer
 * Move / Free Transform (incl. the mask's kept original) / flip carry the
 * lmask; selection floats follow the target (pixels leave the lmask put, the
 * lmask target lifts the mask's own pixels); Merge Down with an upper /
 * lower lmask; copy / cut on both targets; Apply (invert, outside);
 * Ctrl+click on the row ignores the lmask.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createEmptyDocument } from "../document/create";
import { layerMaskKey } from "../document/layerMask";
import type { Rect } from "../geometry/rect";
import type { Editor as EditorClass } from "./editor";
import type { EditorState } from "./editorState";
import type { BlendCanvas } from "./fakeCanvas.testutil";
import { installBlendCanvasFakes, removeCanvasFakes } from "./fakeCanvas.testutil";
import { LAYER_MASK_APPLIED_NOTE } from "./layerMaskCarry";
import { coverageAt, rectSelection } from "./selection";

let Editor: typeof EditorClass;

beforeAll(async () => {
  installBlendCanvasFakes();
  ({ Editor } = await import("./editor"));
});

afterAll(() => removeCanvasFakes());

// ── Helpers ───────────────────────────────────────────────────────────────────

const RED = "#ff0000";

function select(ed: EditorClass, r: Rect): void {
  ed.selection.apply(rectSelection(r), "replace");
}

/** Fill a rect on the current target, then drop the selection. */
function fill(ed: EditorClass, r: Rect, color = RED): void {
  select(ed, r);
  ed.selection.fillSelected(color);
  ed.selection.deselect();
}

function px(ed: EditorClass, canvas: CanvasImageSource | null, x: number, y: number): number[] {
  const c = canvas as unknown as BlendCanvas;
  const b = ed.bounds;
  if (x < b.x || y < b.y || x >= b.x + b.width || y >= b.y + b.height) return [-1, -1, -1, -1];
  const i = ((y - b.y) * c.width + (x - b.x)) * 4;
  return [...c.px.subarray(i, i + 4)];
}

const layerA = (ed: EditorClass, id: string, x: number, y: number): number => px(ed, ed.layerCanvas(id), x, y)[3] ?? -1;
const maskA = (ed: EditorClass, id: string, x: number, y: number): number => px(ed, ed.layerMask.canvas(id), x, y)[3] ?? -1;

/** Set mask values (alpha = hidden amount) directly; only before the first mask query of a test. */
function setMask(ed: EditorClass, id: string, x: number, y: number, a: number): void {
  const c = ed.layerMask.canvas(id) as unknown as BlendCanvas;
  const b = ed.bounds;
  c.px.set([255, 255, 255, a], ((y - b.y) * c.width + (x - b.x)) * 4);
}

const state = (ed: EditorClass): EditorState => (ed as unknown as { s: EditorState }).s;

/**
 * 32x32 editor, active paint layer red over (4..7, 4..5), then a mask
 * (`outside`) with the pixels targeted.
 */
function setup(outside: "reveal" | "hide" = "reveal"): { ed: EditorClass; id: string; notes: string[] } {
  const ed = new Editor(createEmptyDocument({ width: 32, height: 32 }), "widgets");
  const notes: string[] = [];
  ed.events.on("note", (n) => notes.push(n));
  const id = ed.doc.activeLayerId;
  fill(ed, { x: 4, y: 4, width: 4, height: 2 });
  ed.layerMask.add(id, outside);
  ed.layerMask.setTarget(id, "layer");
  return { ed, id, notes };
}

// ═══════════════════════════════════════════════════════════════════════════

describe("whole-layer Move carries the lmask", () => {
  it("nudges move layer + mask in one merged step; undo / redo both", () => {
    const { ed, id } = setup();
    setMask(ed, id, 4, 4, 200);
    setMask(ed, id, 20, 20, 255); // mask content outside the layer's pixels moves too
    expect(ed.layerMove.nudge(2, 1)).toBe(true);
    expect(ed.layerMove.nudge(1, 0)).toBe(true);
    expect([layerA(ed, id, 7, 5), layerA(ed, id, 4, 4)]).toEqual([255, 0]);
    expect([maskA(ed, id, 7, 5), maskA(ed, id, 23, 21), maskA(ed, id, 4, 4), maskA(ed, id, 20, 20)]).toEqual([200, 255, 0, 0]);
    ed.undo(); // both nudges were one step
    expect([layerA(ed, id, 4, 4), maskA(ed, id, 4, 4), maskA(ed, id, 20, 20), maskA(ed, id, 7, 5)]).toEqual([255, 200, 255, 0]);
    ed.redo();
    expect([maskA(ed, id, 7, 5), maskA(ed, id, 23, 21)]).toEqual([200, 255]);
  });

  it("a hide mask's vacated area turns hidden (white); what lands replaces", () => {
    const { ed, id } = setup("hide");
    setMask(ed, id, 4, 4, 0); // a revealed window over the layer
    setMask(ed, id, 5, 4, 0);
    expect(ed.layerMove.nudge(1, 0)).toBe(true);
    expect([maskA(ed, id, 4, 4), maskA(ed, id, 5, 4), maskA(ed, id, 6, 4), maskA(ed, id, 7, 4)]).toEqual([255, 0, 0, 255]);
    ed.undo();
    expect([maskA(ed, id, 4, 4), maskA(ed, id, 5, 4), maskA(ed, id, 6, 4)]).toEqual([0, 0, 255]);
  });

  it("the drag preview draws the MASKED layer offset; commit moves both", () => {
    const { ed, id } = setup();
    setMask(ed, id, 4, 4, 255);
    expect(ed.layerMove.begin()).toBe(true);
    ed.layerMove.preview(3, 0);
    const [item] = ed.compositeLayers();
    expect(item?.offset).toEqual({ x: 3, y: 0 });
    expect([px(ed, item?.source ?? null, 4, 4)[3], px(ed, item?.source ?? null, 5, 4)[3]]).toEqual([0, 255]); // masked source
    expect(ed.layerMove.commit()).toBe(true);
    expect([maskA(ed, id, 7, 4), maskA(ed, id, 4, 4), layerA(ed, id, 7, 4)]).toEqual([255, 0, 255]);
  });
});

describe("whole-layer Free Transform carries the lmask", () => {
  it("a session nudge + flip lands both with the same matrix in one step; cancel changes nothing", () => {
    const { ed, id } = setup();
    setMask(ed, id, 4, 4, 255);
    setMask(ed, id, 10, 10, 90);
    const t = ed.float.transform;
    expect(t.enter()).toBe(true);
    t.cancel();
    expect([maskA(ed, id, 4, 4), maskA(ed, id, 10, 10)]).toEqual([255, 90]);
    expect(t.enter()).toBe(true);
    t.nudge(4, 0);
    // While floating, the mask shows carried (what the masked composite / Alt view draw); the surface is untouched.
    const shown = state(ed).floatPreview(layerMaskKey(id));
    expect([px(ed, shown, 8, 4)[3], px(ed, shown, 14, 10)[3], px(ed, shown, 4, 4)[3]]).toEqual([255, 90, 0]);
    expect(maskA(ed, id, 4, 4)).toBe(255);
    t.commit();
    expect([layerA(ed, id, 8, 4), layerA(ed, id, 4, 4)]).toEqual([255, 0]);
    expect([maskA(ed, id, 8, 4), maskA(ed, id, 14, 10), maskA(ed, id, 4, 4), maskA(ed, id, 10, 10)]).toEqual([255, 90, 0, 0]);
    ed.undo();
    expect([layerA(ed, id, 4, 4), maskA(ed, id, 4, 4), maskA(ed, id, 10, 10), maskA(ed, id, 8, 4)]).toEqual([255, 255, 90, 0]);
  });

  it("the mask's kept original: 2 x 10 deg equals one 20 deg resample; a mask edit drops it", () => {
    const run = (steps: number[]): EditorClass => {
      const { ed, id } = setup("hide");
      for (let y = 3; y < 8; y++) for (let x = 3; x < 9; x++) setMask(ed, id, x, y, (x * 40 + y * 13) % 256);
      for (const deg of steps) {
        ed.float.transform.enter();
        ed.float.transform.setField("angle", deg);
        ed.float.transform.commit();
      }
      return ed;
    };
    const a = run([10, 20]);
    const b = run([20]);
    const ida = a.doc.activeLayerId;
    const idb = b.doc.activeLayerId;
    expect(a.bounds).toEqual(b.bounds);
    const bytes = (ed: EditorClass, id: string): number[] => [...(ed.layerMask.canvas(id) as unknown as BlendCanvas).px].filter((_, i) => i % 4 === 3);
    expect(bytes(a, ida)).toEqual(bytes(b, idb));
    const s = state(a);
    const key = layerMaskKey(ida);
    expect(s.kept.get(key, s.runtime.revision(key))).not.toBeNull();
    fill(a, { x: 0, y: 0, width: 2, height: 2 }); // layer pixels only: the mask's original stays valid
    expect(s.kept.get(key, s.runtime.revision(key))).not.toBeNull();
    a.layerMask.setTarget(ida, "mask");
    fill(a, { x: 4, y: 4, width: 3, height: 3 }); // a mask edit (hides part of the content) drops it
    expect(s.kept.get(key, s.runtime.revision(key))).toBeNull();
  });
});

describe("whole-layer flip carries the lmask", () => {
  it("mirrors about the layer content centre, same step; the vacated part gets `outside`", () => {
    for (const outside of ["reveal", "hide"] as const) {
      const { ed, id } = setup(outside);
      const out = outside === "hide" ? 255 : 0;
      setMask(ed, id, 4, 4, 100); // layer content x 4..7: mirror x' = 11 - x
      setMask(ed, id, 5, 5, 100);
      if (outside === "hide") setMask(ed, id, 6, 5, 255);
      expect(ed.float.transform.flip("h")).toBe(true);
      expect([maskA(ed, id, 7, 4), maskA(ed, id, 6, 5), maskA(ed, id, 4, 4)]).toEqual([100, 100, out]);
      ed.undo();
      expect([maskA(ed, id, 4, 4), maskA(ed, id, 5, 5), maskA(ed, id, 7, 4)]).toEqual([100, 100, out]);
    }
  });
});

describe("selection floats follow the target", () => {
  it("pixels targeted: the piece lands under the unchanged lmask", () => {
    const { ed, id } = setup();
    setMask(ed, id, 4, 4, 200);
    select(ed, { x: 4, y: 4, width: 2, height: 2 });
    expect(ed.float.lift(false)).toBe(true);
    expect(ed.float.layerId).toBe(id);
    ed.float.nudge(10, 0);
    expect(ed.float.commit()).toBe(true);
    expect([layerA(ed, id, 14, 4), layerA(ed, id, 4, 4)]).toEqual([255, 0]);
    expect([maskA(ed, id, 4, 4), maskA(ed, id, 14, 4)]).toEqual([200, 0]);
  });

  it("lmask targeted: its own pixels move and REPLACE what they land on; layer stays; live view; undo", () => {
    const { ed, id } = setup();
    setMask(ed, id, 3, 3, 255);
    setMask(ed, id, 4, 3, 0);
    setMask(ed, id, 8, 3, 128);
    setMask(ed, id, 9, 3, 255);
    ed.layerMask.toggleView(id); // lmask-only view (targets the mask): shows the float live, grayscale
    select(ed, { x: 3, y: 3, width: 2, height: 1 });
    expect(ed.float.lift(false)).toBe(true);
    expect(ed.float.layerId).toBe(layerMaskKey(id));
    ed.float.nudge(5, 0);
    const view = ed.compositeLayers()[0]?.source ?? null;
    expect([px(ed, view, 8, 3)[0], px(ed, view, 9, 3)[0], px(ed, view, 3, 3)[0]]).toEqual([255, 0, 0]);
    expect(ed.float.commit()).toBe(true);
    ed.layerMask.toggleView(id);
    expect([maskA(ed, id, 8, 3), maskA(ed, id, 9, 3), maskA(ed, id, 3, 3), maskA(ed, id, 4, 3)]).toEqual([255, 0, 0, 0]);
    expect(layerA(ed, id, 4, 4)).toBe(255);
    ed.undo();
    expect([maskA(ed, id, 3, 3), maskA(ed, id, 8, 3), maskA(ed, id, 9, 3)]).toEqual([255, 128, 255]);
    expect(coverageAt(ed.selection.current, 3, 3)).toBe(255);
    // Esc puts everything back.
    ed.float.lift(false);
    ed.float.nudge(1, 0);
    ed.float.cancel();
    expect([maskA(ed, id, 3, 3), maskA(ed, id, 4, 3)]).toEqual([255, 0]);
  });

  it("a selection flip on the lmask target mirrors the mask pixels only", () => {
    const { ed, id } = setup();
    setMask(ed, id, 4, 4, 255);
    ed.layerMask.setTarget(id, "mask");
    select(ed, { x: 4, y: 4, width: 4, height: 1 });
    expect(ed.float.transform.flip("h")).toBe(true);
    ed.float.commit();
    expect([maskA(ed, id, 7, 4), maskA(ed, id, 4, 4), layerA(ed, id, 4, 4)]).toEqual([255, 0, 255]);
  });
});

describe("Merge Down", () => {
  it("applies the upper layer's lmask (note; one undo step brings layer + mask back)", () => {
    const { ed, id: lower } = setup();
    const upper = ed.layerOps.add();
    if (!upper) throw new Error("no layer");
    fill(ed, { x: 10, y: 10, width: 3, height: 1 });
    ed.layerMask.add(upper, "reveal");
    const s = state(ed);
    s.store.write(layerMaskKey(upper), 10, 10, new ImageData(new Uint8ClampedArray([255, 255, 255, 255, 255, 255, 255, 100]), 2, 1));
    s.runtime.touch(layerMaskKey(upper));
    const notes: string[] = [];
    ed.events.on("note", (n) => notes.push(n));
    expect(ed.mergeDown()).toBe(true);
    expect(notes).toEqual([LAYER_MASK_APPLIED_NOTE]);
    expect([layerA(ed, lower, 10, 10), layerA(ed, lower, 11, 10), layerA(ed, lower, 12, 10)]).toEqual([0, 155, 255]);
    ed.undo();
    expect([layerA(ed, lower, 10, 10), maskA(ed, upper, 10, 10), maskA(ed, upper, 11, 10)]).toEqual([0, 255, 100]);
    // Inverted: the shown part flips.
    ed.layerMask.setInvert(upper, true);
    ed.mergeDown();
    expect([layerA(ed, lower, 10, 10), layerA(ed, lower, 11, 10), layerA(ed, lower, 12, 10)]).toEqual([255, 100, 0]);
  });

  it("a lower layer keeps its lmask and settings; the merged pixels go under it", () => {
    const { ed, id: lower } = setup();
    setMask(ed, lower, 10, 10, 255);
    ed.layerMask.setInvert(lower, true);
    const upper = ed.layerOps.add();
    if (!upper) throw new Error("no layer");
    fill(ed, { x: 10, y: 10, width: 1, height: 1 });
    expect(ed.mergeDown()).toBe(true);
    expect(layerA(ed, lower, 10, 10)).toBe(255);
    expect([maskA(ed, lower, 10, 10), ed.layerMask.info(lower)?.invert]).toEqual([255, true]);
  });
});

describe("copy / cut", () => {
  it("pixels targeted: copy = the masked result; cut clears the layer only", () => {
    const { ed, id } = setup();
    setMask(ed, id, 4, 4, 100);
    setMask(ed, id, 5, 4, 255);
    select(ed, { x: 4, y: 4, width: 4, height: 1 });
    const clip = ed.clipboard.copy(false);
    expect(clip?.rect).toEqual({ x: 4, y: 4, width: 4, height: 1 });
    expect([clip?.data.data[3], clip?.data.data[7], clip?.data.data[11]]).toEqual([155, 0, 255]);
    expect(ed.clipboard.cut()).not.toBeNull();
    expect([layerA(ed, id, 4, 4), layerA(ed, id, 7, 4), layerA(ed, id, 4, 5)]).toEqual([0, 0, 255]);
    expect([maskA(ed, id, 4, 4), maskA(ed, id, 5, 4)]).toEqual([100, 255]);
  });

  it("lmask targeted: copy = the mask as grayscale, cut reveals (black); the layer stays", () => {
    const { ed, id } = setup();
    setMask(ed, id, 4, 4, 100);
    setMask(ed, id, 5, 4, 255);
    ed.layerMask.setTarget(id, "mask");
    select(ed, { x: 4, y: 4, width: 3, height: 1 });
    const clip = ed.clipboard.copy(false);
    expect([...(clip?.data.data.subarray(0, 12) ?? [])]).toEqual([100, 100, 100, 255, 255, 255, 255, 255, 0, 0, 0, 255]);
    expect(ed.clipboard.cut()).not.toBeNull();
    expect([maskA(ed, id, 4, 4), maskA(ed, id, 5, 4), layerA(ed, id, 4, 4)]).toEqual([0, 0, 255]);
    ed.undo();
    expect(maskA(ed, id, 5, 4)).toBe(255);
  });
});

describe("Apply", () => {
  it("bakes the mask (invert applied) into the layer alpha and removes it; one undo step", () => {
    for (const invert of [false, true]) {
      const { ed, id } = setup();
      setMask(ed, id, 4, 4, 255);
      setMask(ed, id, 5, 4, 100);
      if (invert) ed.layerMask.setInvert(id, true);
      expect(ed.layerMask.apply(id)).toBe(true);
      expect(ed.layerMask.info(id)).toBeUndefined();
      const expected = invert ? [255, 100, 0] : [0, 155, 255];
      expect([layerA(ed, id, 4, 4), layerA(ed, id, 5, 4), layerA(ed, id, 6, 4)]).toEqual(expected);
      ed.undo();
      expect([ed.layerMask.info(id)?.invert, maskA(ed, id, 4, 4), maskA(ed, id, 5, 4), layerA(ed, id, 4, 4)]).toEqual([invert, 255, 100, 255]);
      ed.redo();
      expect(ed.layerMask.info(id)).toBeUndefined();
    }
  });

  it("a hide-all mask keeps only its revealed part; the bar button applies", async () => {
    const { layerMaskBarDecorator } = await import("../tools/layerMaskBar");
    const { ed, id } = setup("hide");
    setMask(ed, id, 4, 4, 0);
    ed.layerMask.setTarget(id, "mask");
    const bar = layerMaskBarDecorator(ed)(null, { id: "brush" } as Parameters<ReturnType<typeof layerMaskBarDecorator>>[1]);
    expect(bar?.get("layerMaskApply")).toBe(true);
    expect(bar?.set("layerMaskApply", true)).toBe(true);
    expect([layerA(ed, id, 4, 4), layerA(ed, id, 5, 4), layerA(ed, id, 7, 5)]).toEqual([255, 0, 0]);
  });
});

describe("Ctrl+click on the layer row", () => {
  it("selects the layer's own pixels, the lmask ignored", () => {
    const { ed, id } = setup("hide");
    expect(ed.selection.fromLayer(id, "replace")).toBe(true);
    expect([coverageAt(ed.selection.current, 4, 4), coverageAt(ed.selection.current, 7, 5), coverageAt(ed.selection.current, 8, 4)]).toEqual([255, 255, 0]);
  });
});
