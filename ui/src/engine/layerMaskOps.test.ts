/**
 * Layer masks, the rest of the surface (SPEC "Layer masks (lmask)"): the
 * pixel operations work on a masked layer, Ctrl+click soft selection of the
 * shown part (+ round trip), the lmask-only view (follow / end rules) and
 * its editing gate, restore / upload bookkeeping, layer delete / duplicate /
 * Clear / fork carrying the mask, and the manifest (round trip, old
 * documents, lenient reading, cleanup references).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { extractReferences } from "../cleanup/references";
import { createEmptyDocument } from "../document/create";
import { IMAGE_MASK_ID } from "../document/imageMask";
import { parseDocument } from "../document/parse";
import { stringifyDocument } from "../document/serialize";
import type { PainterDocument } from "../document/types";
import type { Editor as EditorClass } from "./editor";
import { HIDDEN_LAYER_NOTE, LOCKED_LAYER_NOTE } from "./editorTypes";
import type { BlendCanvas } from "./fakeCanvas.testutil";
import { installBlendCanvasFakes, removeCanvasFakes } from "./fakeCanvas.testutil";
import { LAYER_MASK_TOOL_NOTE } from "./layerMask";
import { coverageAt, rectSelection } from "./selection";
import type { Selection } from "./selection";

let Editor: typeof EditorClass;

beforeAll(async () => {
  installBlendCanvasFakes();
  ({ Editor } = await import("./editor"));
});

afterAll(() => removeCanvasFakes());

// ── Helpers ───────────────────────────────────────────────────────────────────

const MASK_FILE = "painter-sketch/ps-abcd1234-0123456789abcd.png [input]";

function setup(doc: PainterDocument = createEmptyDocument({ width: 16, height: 16 })): { ed: EditorClass; id: string; notes: string[] } {
  const ed = new Editor(doc, "widgets");
  const notes: string[] = [];
  ed.events.on("note", (n) => notes.push(n));
  return { ed, id: ed.doc.activeLayerId, notes };
}

function px(ed: EditorClass, canvas: HTMLCanvasElement | null, x: number, y: number): number[] {
  const c = canvas as unknown as BlendCanvas;
  const b = ed.bounds;
  const i = ((y - b.y) * c.width + (x - b.x)) * 4;
  return [...c.px.subarray(i, i + 4)];
}

const maskA = (ed: EditorClass, id: string, x: number, y: number): number => px(ed, ed.layerMask.canvas(id), x, y)[3] ?? -1;

function setPx(ed: EditorClass, canvas: HTMLCanvasElement | null, x: number, y: number, rgba: number[]): void {
  const c = canvas as unknown as BlendCanvas;
  const b = ed.bounds;
  c.px.set(rgba, ((y - b.y) * c.width + (x - b.x)) * 4);
}

/** A 16x16 editor whose active paint layer has pixels and a reveal-all mask. */
function masked(): { ed: EditorClass; id: string; notes: string[] } {
  const r = setup();
  setPx(r.ed, r.ed.layerCanvas(r.id), 3, 3, [255, 0, 0, 255]);
  r.ed.layerMask.add(r.id, "reveal");
  return r;
}

// ═══════════════════════════════════════════════════════════════════════════

describe("pixel operations on a masked layer", () => {
  /** A masked layer that holds real (recorded) pixels. */
  function painted(): { ed: EditorClass; id: string; notes: string[] } {
    const r = setup();
    r.ed.selection.apply(rectSelection({ x: 2, y: 2, width: 4, height: 4 }), "replace");
    r.ed.selection.fillSelected("#ff0000");
    r.ed.selection.deselect();
    r.ed.layerMask.add(r.id, "reveal");
    return r;
  }

  it("move, transform, flip, lift, copy / cut work on a masked layer, without a note", () => {
    const { ed, notes } = painted();
    expect(ed.layerMove.nudge(1, 0)).toBe(true);
    expect(ed.layerMove.begin()).toBe(true);
    ed.layerMove.cancel();
    expect(ed.float.transform.enter()).toBe(true);
    ed.float.transform.cancel();
    expect(ed.float.transform.flip("h")).toBe(true);
    ed.layerMask.setTarget(ed.doc.activeLayerId, "layer");
    expect(ed.clipboard.copy(false)).not.toBeNull();
    ed.selection.apply(rectSelection({ x: 0, y: 0, width: 8, height: 8 }), "replace");
    expect(ed.float.lift(false)).toBe(true);
    ed.float.cancel();
    expect(ed.clipboard.cut()).not.toBeNull();
    expect(notes).toEqual([]);
  });

  it("Merge Down works in both directions", () => {
    const { ed, id } = painted();
    const upper = ed.layerOps.add();
    if (!upper) throw new Error("no layer");
    expect(ed.canMergeDown()).toBe(true); // the lower layer has a mask
    ed.layerMask.remove(id);
    ed.layerMask.add(upper, "reveal");
    expect(ed.canMergeDown()).toBe(true); // the upper layer has a mask
    expect(ed.mergeDown()).toBe(true);
  });

  it("the same operations still work on unmasked layers", () => {
    const { ed } = setup();
    expect(ed.beginStroke({ mode: "paint", opacity: 1, hardness: 1, color: "#ff0000" }, 4)).toBe(true);
    ed.addDabs([{ x: 8, y: 8, size: 4, alpha: 1, cap: 1 }]);
    ed.endStroke(null);
    expect(ed.layerMove.nudge(1, 0)).toBe(true);
    expect(ed.clipboard.copy(false)).not.toBeNull();
  });
});

describe("selection from the mask (Ctrl+click): the SHOWN (black) part", () => {
  it("loads soft 255 - value, invert applied, the `outside` value beyond the bounds", () => {
    const { ed, id } = masked();
    setPx(ed, ed.layerMask.canvas(id), 2, 2, [255, 255, 255, 100]);
    expect(ed.layerMask.toSelection(id, "replace")).toBe(true);
    const sel = ed.selection.current;
    expect([coverageAt(sel, 2, 2), coverageAt(sel, 5, 5)]).toEqual([155, 255]);
    expect(coverageAt(sel, -4, 5)).toBe(255); // beyond the bounds: outside shown = selected (inside the paint-area limit)
    ed.layerMask.setInvert(id, true);
    ed.layerMask.toSelection(id, "replace");
    expect([coverageAt(ed.selection.current, 2, 2), coverageAt(ed.selection.current, 5, 5)]).toEqual([100, 0]);
    expect(coverageAt(ed.selection.current, -4, 5)).toBe(0); // inverted: outside hidden = not selected
  });

  it("a hide-all mask selects nothing (note); inverted it selects everything, also beyond the bounds", () => {
    const { ed, id, notes } = setup();
    ed.layerMask.add(id, "hide");
    expect(ed.layerMask.toSelection(id, "replace")).toBe(false);
    expect(notes).toContain("The layer mask shows nothing.");
    ed.layerMask.setInvert(id, true);
    expect(ed.layerMask.toSelection(id, "replace")).toBe(true);
    expect([coverageAt(ed.selection.current, 5, 5), coverageAt(ed.selection.current, -4, 5)]).toEqual([255, 255]);
  });

  it("Shift adds, Alt subtracts, Shift+Alt intersects the same coverage", () => {
    const { ed, id } = setup();
    ed.layerMask.add(id, "hide");
    for (let x = 0; x < 4; x++) setPx(ed, ed.layerMask.canvas(id), x, 1, [255, 255, 255, 0]); // shown: (0..3, 1)
    const box = rectSelection({ x: 2, y: 0, width: 4, height: 4 }); // (2..5, 0..3)
    const at = (x: number, y: number): number => coverageAt(ed.selection.current, x, y);
    ed.selection.apply(box, "replace");
    ed.layerMask.toSelection(id, "add");
    expect([at(0, 1), at(4, 3), at(0, 2)]).toEqual([255, 255, 0]);
    ed.selection.apply(box, "replace");
    ed.layerMask.toSelection(id, "subtract");
    expect([at(2, 1), at(4, 1), at(2, 2), at(0, 1)]).toEqual([0, 255, 255, 0]);
    ed.selection.apply(box, "replace");
    ed.layerMask.toSelection(id, "intersect");
    expect([at(2, 1), at(3, 1), at(4, 1), at(0, 1), at(2, 2)]).toEqual([255, 255, 0, 0, 0]);
  });

  it("round trip: selection -> add mask -> deselect -> Ctrl+click = the same coverage (hard, soft, inverted)", () => {
    const soft = (): Selection => {
      const data = new Uint8Array(6 * 5);
      for (let i = 0; i < data.length; i++) data[i] = (i * 37) % 256;
      return { rect: { x: 3, y: 4, width: 6, height: 5 }, data, outside: 0 };
    };
    const hard = rectSelection({ x: 2, y: 3, width: 5, height: 7 });
    const inverted = hard && { ...hard, outside: 255 as const, data: new Uint8Array(hard.data.length) };
    for (const original of [hard, soft(), inverted]) {
      if (!original) throw new Error("no selection");
      const { ed, id } = setup();
      ed.selection.apply(original, "replace");
      const before = ed.selection.current;
      ed.layerMask.add(id, "selection");
      ed.selection.deselect();
      expect(ed.layerMask.toSelection(id, "replace")).toBe(true);
      const after = ed.selection.current;
      // Inverted selections are clipped to the paint-area limit (beyond the bounds); the mask grows to cover it.
      for (let y = -40; y < 56; y++) for (let x = -40; x < 56; x++) expect(coverageAt(after, x, y)).toBe(coverageAt(before, x, y));
    }
  });
});

describe("lmask-only view (Alt+click)", () => {
  /** A (masked), B (masked, target pixels), C (no mask), T (text); the doc's cmask M. Active: A, target its mask. */
  function views(): { ed: EditorClass; a: string; b: string; c: string; t: string; m: string } {
    const doc = createEmptyDocument({ width: 16, height: 16 });
    const td = { text: "T", x: 2, y: 2, font: "Arial", size: 12, color: "#000000", bold: false, italic: false, align: "left" as const };
    doc.layers.push({ id: "tt", name: "T", kind: "text", visible: true, locked: false, opacity: 1, blendMode: "normal", file: null, textData: td });
    const { ed, id: a } = setup(doc);
    const b = ed.layerOps.add();
    const c = ed.layerOps.add();
    const m = ed.doc.layers.find((l) => l.kind === "mask")?.id;
    if (!b || !c || !m) throw new Error("no layers");
    ed.layerMask.add(b, "reveal");
    ed.layerMask.setTarget(b, "layer");
    ed.layerMask.add(a, "reveal");
    ed.layerMask.setTarget(a, "mask");
    return { ed, a, b, c, t: "tt", m };
  }
  /** The layers panel's plain row click (`layersPanel.ts` `select`). */
  const clickRow = (ed: EditorClass, id: string): void => {
    if (ed.selectMask(id)) return;
    ed.layerOps.setActiveLayer(id);
    ed.setPaintTarget("paint");
  };

  it("shows the mask alone (grayscale, white = hidden); Alt+click again ends it", () => {
    const { ed, id } = masked();
    setPx(ed, ed.layerMask.canvas(id), 5, 5, [255, 255, 255, 255]);
    ed.layerMask.setTarget(id, "layer");
    ed.layerMask.toggleView(id);
    expect(ed.layerMask.target(id)).toBe("mask"); // Alt+click also edits the mask
    const list = ed.compositeLayers();
    expect(list).toHaveLength(1);
    expect(px(ed, list[0]?.source as HTMLCanvasElement, 5, 5)).toEqual([255, 255, 255, 255]);
    expect(px(ed, list[0]?.source as HTMLCanvasElement, 6, 6)).toEqual([0, 0, 0, 255]);
    expect(ed.maskOverlays()).toEqual([]);
    ed.layerMask.setTarget(id, "mask"); // clicking its own mask thumbnail keeps it
    expect(ed.layerMask.viewing).toBe(id);
    ed.layerMask.toggleView(id);
    expect(ed.layerMask.viewing).toBeNull();
  });

  it("stays on and follows: another lmask thumbnail (Alt+click / click), a row targeting its mask", () => {
    const { ed, a, b } = views();
    ed.layerMask.toggleView(a);
    ed.layerMask.toggleView(b); // Alt+click B's lmask (B was on its pixels)
    expect([ed.layerMask.viewing, ed.doc.activeLayerId, ed.layerMask.target(b)]).toEqual([b, b, "mask"]);
    ed.layerMask.setTarget(a, "mask"); // plain click on A's lmask thumbnail
    expect([ed.layerMask.viewing, ed.doc.activeLayerId]).toEqual([a, a]);
    clickRow(ed, b); // B's target is its mask now
    expect(ed.layerMask.viewing).toBe(b);
    clickRow(ed, a);
    expect(ed.layerMask.viewing).toBe(a);
  });

  it("ends on: a pixel thumbnail, a row targeting its pixels, no lmask, a text layer, cmask / Image Mask rows", () => {
    const { ed, a, b, c, t, m } = views();
    const again = (): void => {
      ed.layerMask.toggleView(a);
      expect(ed.layerMask.viewing).toBe(a);
    };
    again();
    ed.layerMask.setTarget(a, "layer"); // A's pixel thumbnail
    expect(ed.layerMask.viewing).toBeNull();
    again();
    ed.layerMask.setTarget(b, "layer");
    clickRow(ed, b); // B targets its pixels
    expect(ed.layerMask.viewing).toBeNull();
    for (const id of [c, t, m]) {
      again();
      clickRow(ed, id);
      expect(ed.layerMask.viewing).toBeNull();
    }
    again();
    ed.layerMask.endView(); // the Background row click (`layersPanel.ts` `select`)
    expect(ed.layerMask.viewing).toBeNull();
    // The Image Mask row (a cmask row too).
    ed.setPaintTarget("paint");
    again();
    expect(ed.imageMask.setFromAlpha("k", { width: 16, height: 16 }, new Uint8ClampedArray(16 * 16 * 4))).toBe(true);
    expect(ed.layerMask.viewing).toBe(a);
    clickRow(ed, IMAGE_MASK_ID);
    expect(ed.layerMask.viewing).toBeNull();
  });
});

describe("editing gate in the lmask-only view", () => {
  const BRUSH = { mode: "paint" as const, opacity: 1, hardness: 1, color: "#ff0000" };
  const tryStroke = (ed: EditorClass): boolean => {
    if (!ed.beginStroke(BRUSH, 4)) return false;
    ed.addDabs([{ x: 8, y: 8, size: 4, alpha: 1, cap: 1 }]);
    ed.endStroke(null);
    return true;
  };

  it("a hidden layer's lmask is editable in the view only; lock still refuses", () => {
    const { ed, id, notes } = masked();
    ed.layerOps.setVisible(id, false);
    expect(tryStroke(ed)).toBe(false); // outside the view: refused like its pixels
    expect(notes).toEqual([HIDDEN_LAYER_NOTE]);
    ed.layerMask.toggleView(id);
    expect(tryStroke(ed)).toBe(true);
    expect(maskA(ed, id, 8, 8)).toBe(255);
    ed.selection.apply(rectSelection({ x: 0, y: 0, width: 2, height: 2 }), "replace");
    expect(ed.selection.fillSelected("#123456")).toBe(true); // Alt+Backspace hides
    expect(maskA(ed, id, 1, 1)).toBe(255);
    ed.layerOps.setLocked(id, true);
    expect(tryStroke(ed)).toBe(false);
    expect(notes.at(-1)).toBe(LOCKED_LAYER_NOTE);
    ed.layerOps.setLocked(id, false);
    ed.layerMask.toggleView(id); // view off: refused again
    expect(tryStroke(ed)).toBe(false);
    expect(notes.at(-1)).toBe(HIDDEN_LAYER_NOTE);
  });

  it("only the viewed layer's mask: other layers and the pixels stay refused", () => {
    const { ed, id, notes } = masked();
    const other = ed.layerOps.add();
    if (!other) throw new Error("no layer");
    ed.layerMask.add(other, "reveal");
    ed.layerOps.setVisible(id, false);
    ed.layerMask.toggleView(other); // viewing another layer's mask
    ed.layerOps.setVisible(other, false);
    expect(tryStroke(ed)).toBe(true);
    ed.layerMask.toggleView(other);
    ed.layerMask.setTarget(id, "mask");
    expect(tryStroke(ed)).toBe(false); // id is hidden and not in the view
    expect(notes.at(-1)).toBe(HIDDEN_LAYER_NOTE);
  });

  it("text: allowed with an lmask targeted (normal view); creating and editing refused in the view", () => {
    const doc = createEmptyDocument({ width: 16, height: 16 });
    const td = { text: "T", x: 2, y: 2, font: "Arial", size: 12, color: "#000000", bold: false, italic: false, align: "left" as const };
    doc.layers.push({ id: "tt", name: "T", kind: "text", visible: true, locked: false, opacity: 1, blendMode: "normal", file: null, textData: td });
    const { ed, id, notes } = setup(doc);
    ed.layerMask.add(id, "reveal"); // targets the lmask
    const style = { font: "Arial", size: 12, color: "#000000", bold: false, italic: false, align: "left" as const };
    expect(ed.text.create({ x: 4, y: 8 }, style)).not.toBeNull();
    ed.text.commit(); // empty: the new layer is dropped again
    expect(ed.text.edit("tt")).toBe(true);
    ed.text.commit();
    expect(notes).toEqual([]);
    // Back on the masked layer, lmask targeted, lmask-only view on: text layers aren't visible.
    ed.layerOps.setActiveLayer(id);
    ed.layerMask.setTarget(id, "mask");
    ed.layerMask.toggleView(id);
    expect(ed.layerMask.viewing).toBe(id);
    expect(ed.text.create({ x: 4, y: 8 }, style)).toBeNull();
    expect(notes.at(-1)).toBe(LAYER_MASK_TOOL_NOTE);
    expect(ed.text.edit("tt")).toBe(false);
    expect(ed.text.editing).toBeNull();
    expect(notes).toHaveLength(2);
    expect(ed.layerMask.viewing).toBe(id); // the refusals never end the view
    ed.layerMask.toggleView(id);
    expect(ed.text.edit("tt")).toBe(true);
    ed.text.commit();
  });
});

describe("'To mask' with an lmask targeted", () => {
  const soft: Selection = { rect: { x: 2, y: 2, width: 2, height: 1 }, data: new Uint8Array([255, 128]), outside: 0 };

  it("hides the selection on the lmask (soft coverage kept), one undo step, no cmask added", () => {
    const { ed, id } = masked();
    ed.selection.apply(soft, "replace");
    const layers = ed.doc.layers.length;
    expect(ed.selection.toMask()).toBe(true);
    expect(maskA(ed, id, 2, 2)).toBe(255);
    expect(maskA(ed, id, 3, 2)).toBe(128);
    expect(maskA(ed, id, 4, 2)).toBe(0);
    expect(ed.doc.layers.length).toBe(layers);
    const cmask = ed.maskLayer?.id;
    if (cmask) expect(px(ed, ed.layerCanvas(cmask), 2, 2)[3]).toBe(0);
    ed.undo();
    expect(maskA(ed, id, 2, 2)).toBe(0);
    expect(maskA(ed, id, 3, 2)).toBe(0);
  });

  it("goes through the edit gate: hidden layer refused outside the lmask-only view, allowed in it", () => {
    const { ed, id, notes } = masked();
    ed.selection.apply(soft, "replace");
    ed.layerOps.setVisible(id, false);
    expect(ed.selection.toMask()).toBe(false);
    expect(notes.at(-1)).toBe(HIDDEN_LAYER_NOTE);
    ed.layerMask.toggleView(id);
    expect(ed.selection.toMask()).toBe(true);
    expect(maskA(ed, id, 2, 2)).toBe(255);
  });

  it("pixels targeted: adds to the cmask as before (lmask untouched)", () => {
    const { ed, id } = masked();
    ed.layerMask.setTarget(id, "layer");
    ed.selection.apply(soft, "replace");
    expect(ed.selection.toMask()).toBe(true);
    const cmask = ed.maskLayer?.id ?? "";
    expect(px(ed, ed.layerCanvas(cmask), 2, 2)[3]).toBe(255);
    expect(px(ed, ed.layerCanvas(cmask), 3, 2)[3]).toBe(128);
    expect(maskA(ed, id, 2, 2)).toBe(0);
  });
});

describe("persistence bookkeeping", () => {
  it("dirty masks upload; a finished upload records the file", () => {
    const { ed, id } = masked();
    const jobs = ed.layerMask.uploads();
    expect(jobs.map((j) => j.layerId)).toEqual([id]);
    ed.layerMask.markUploaded(id, jobs[0]?.version ?? -1, MASK_FILE);
    expect(ed.layerMask.info(id)?.file).toBe(MASK_FILE);
    expect(ed.layerMask.uploads()).toEqual([]);
  });

  it("a loaded document: file -> unmasked until restored, restore keeps `outside` beyond a small file", () => {
    const doc = createEmptyDocument({ width: 8, height: 8 });
    const layer = doc.layers[0];
    if (!layer) throw new Error("no layer");
    layer.layerMask = { file: MASK_FILE, enabled: true, invert: false, outside: "hide" };
    const { ed, id } = setup(doc);
    expect([maskA(ed, id, 1, 1), maskA(ed, id, 6, 6)]).toEqual([0, 0]); // shown until it loads
    expect(ed.layerRuntime(id)).toBeTruthy();
    expect(ed.dirty).toBe(false);
    const image = document.createElement("canvas") as unknown as BlendCanvas;
    image.width = 4;
    image.height = 4;
    ed.layerMask.restore(id, image as unknown as HTMLCanvasElement);
    expect([maskA(ed, id, 1, 1), maskA(ed, id, 6, 6)]).toEqual([0, 255]); // outside = hide beyond the file
    ed.layerMask.restoreFailed(id);
    expect([maskA(ed, id, 1, 1), maskA(ed, id, 6, 6)]).toEqual([0, 0]); // unreadable: unmasked, like Python
    expect(ed.layerMask.info(id)?.file).toBe(MASK_FILE);

    for (const outside of ["reveal", "hide"] as const) {
      const none = createEmptyDocument({ width: 8, height: 8 });
      const l2 = none.layers[0];
      if (l2) l2.layerMask = { file: null, enabled: true, invert: false, outside };
      const b = setup(none);
      expect(maskA(b.ed, b.id, 1, 1)).toBe(0); // no file = every stored pixel 0 = shown
    }
  });
});

describe("the mask travels with its layer", () => {
  it("layer delete / undo, duplicate, Clear / undo, fork", () => {
    const { ed, id } = masked();
    setPx(ed, ed.layerMask.canvas(id), 2, 2, [255, 255, 255, 60]);
    const other = ed.layerOps.add();
    if (!other) throw new Error("no layer");
    expect(ed.layerOps.remove(id)).toBe(true);
    expect(ed.layerMask.canvas(id)).toBeNull();
    ed.undo();
    expect(maskA(ed, id, 2, 2)).toBe(60);
    const copy = ed.layerOps.duplicate(id);
    if (!copy) throw new Error("no copy");
    expect(ed.layerMask.info(copy)?.outside).toBe("reveal");
    expect(maskA(ed, copy, 2, 2)).toBe(60);
    ed.clear();
    expect(ed.layerMask.info(id)).toBeUndefined();
    ed.undo();
    expect(maskA(ed, id, 2, 2)).toBe(60);
    const fork = ed.fork("forkid01");
    expect(maskA(fork, id, 2, 2)).toBe(60);
  });
});

describe("manifest", () => {
  it("round-trips `layerMask`; old documents stay unchanged", () => {
    const doc = createEmptyDocument({ width: 10, height: 10 }, "docid0001");
    const old = stringifyDocument(doc);
    expect(old).not.toContain("layerMask");
    expect(parseDocument(old)).toEqual({ status: "ok", repaired: false, document: doc });
    const layer = doc.layers[0];
    if (!layer) throw new Error("no layer");
    layer.layerMask = { file: MASK_FILE, enabled: false, invert: true, outside: "hide" };
    expect(parseDocument(stringifyDocument(doc))).toEqual({ status: "ok", repaired: false, document: doc });
  });

  it("reads leniently; paint layers only", () => {
    const doc = createEmptyDocument({ width: 10, height: 10 }, "docid0001");
    const raw = JSON.parse(stringifyDocument(doc)) as { layers: Record<string, unknown>[] };
    const [paint, mask] = raw.layers;
    if (!paint || !mask) throw new Error("no layers");
    paint["layerMask"] = { file: 3, enabled: "no", outside: "sideways" };
    mask["layerMask"] = { file: MASK_FILE, enabled: true, invert: false, outside: "reveal" };
    const parsed = parseDocument(JSON.stringify(raw));
    if (parsed.status !== "ok") throw new Error("not parsed");
    expect(parsed.document.layers[0]?.layerMask).toEqual({ file: null, enabled: true, invert: false, outside: "reveal" });
    expect(parsed.document.layers[1]?.layerMask).toBeUndefined();
  });

  it("cleanup finds the mask file of a serialized document", () => {
    const doc = createEmptyDocument({ width: 8, height: 8 }, "abcd1234");
    const layer = doc.layers[0];
    if (layer) layer.layerMask = { file: MASK_FILE, enabled: true, invert: false, outside: "reveal" };
    const workflow = JSON.stringify({ nodes: [{ widgets_values: [stringifyDocument(doc)] }] });
    expect([...extractReferences(workflow)]).toEqual(["ps-abcd1234-0123456789abcd.png"]);
  });
});
