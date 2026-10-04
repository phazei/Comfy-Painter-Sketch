/**
 * Layer masks in the engine, in the ComfyUI polarity (white / alpha 255
 * = hidden, black / alpha 0 = shown): add modes, target switching, the
 * black / white mask swatches (X / D, swap), brush + bucket paint the
 * foreground swatch, eraser reveals, Delete / Alt+Backspace like mask
 * layers, selection clip, other tools refuse, the options bar, compositor
 * cache invalidation, bounds growth with `outside`, and undo of add /
 * delete / invert / strokes. Uses the compositing canvas fake
 * (`fakeCanvas.testutil.ts`), so pixel values are real.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createEmptyDocument } from "../document/create";
import type { Dab } from "./brush";
import type { Editor as EditorClass } from "./editor";
import type { BlendCanvas } from "./fakeCanvas.testutil";
import { installBlendCanvasFakes, removeCanvasFakes } from "./fakeCanvas.testutil";
import { LAYER_MASK_TOOL_NOTE } from "./layerMask";
import type { LayerMaskState } from "./layerMask";
import { rectSelection } from "./selection";
import type { StrokeStyle } from "./stroke";

let Editor: typeof EditorClass;

beforeAll(async () => {
  installBlendCanvasFakes();
  ({ Editor } = await import("./editor"));
});

afterAll(() => removeCanvasFakes());

// ── Helpers ───────────────────────────────────────────────────────────────────

const BRUSH: StrokeStyle = { mode: "paint", opacity: 1, hardness: 1, color: "#ff0000" };
const ERASER: StrokeStyle = { mode: "erase", opacity: 1, hardness: 1, color: "#ff0000" };

function setup(): { ed: EditorClass; id: string; notes: string[] } {
  const ed = new Editor(createEmptyDocument({ width: 16, height: 16 }), "widgets");
  const notes: string[] = [];
  ed.events.on("note", (n) => notes.push(n));
  return { ed, id: ed.doc.activeLayerId, notes };
}

function depth(ed: EditorClass): number {
  return (ed as unknown as { s: { history: { undoDepth: number } } }).s.history.undoDepth;
}

function state(ed: EditorClass): LayerMaskState {
  return (ed as unknown as { s: { layerMasks: LayerMaskState } }).s.layerMasks;
}

/** A pixel of a bounds-sized canvas (document coords). */
function px(ed: EditorClass, canvas: HTMLCanvasElement | null, x: number, y: number): number[] {
  const c = canvas as unknown as BlendCanvas;
  const b = ed.bounds;
  const i = ((y - b.y) * c.width + (x - b.x)) * 4;
  return [...c.px.subarray(i, i + 4)];
}

const maskA = (ed: EditorClass, id: string, x: number, y: number): number => px(ed, ed.layerMask.canvas(id), x, y)[3] ?? -1;

/** Opaque red over the whole layer. */
function fillLayer(ed: EditorClass, id: string): void {
  const c = ed.layerCanvas(id) as unknown as BlendCanvas;
  for (let i = 0; i < c.px.length; i += 4) c.px.set([255, 0, 0, 255], i);
}

function stroke(ed: EditorClass, style: StrokeStyle, points: readonly [number, number][], size = 4): boolean {
  if (!ed.beginStroke(style, size)) return false;
  const dabs: Dab[] = points.map(([x, y]) => ({ x, y, size, alpha: 1, cap: 1 }));
  ed.addDabs(dabs);
  ed.endStroke(null);
  return true;
}

// ═══════════════════════════════════════════════════════════════════════════

describe("adding a layer mask", () => {
  it("reveal all / hide all / selection, one undo step each, targets the mask", () => {
    const { ed, id } = setup();
    const steps = depth(ed);
    expect(ed.layerMask.add(id, "reveal")).toBe(true);
    expect(depth(ed)).toBe(steps + 1);
    expect(ed.layerMask.info(id)).toEqual({ file: null, enabled: true, invert: false, outside: "reveal" });
    expect(maskA(ed, id, 3, 3)).toBe(0); // reveal all = all black
    expect(ed.layerMask.target(id)).toBe("mask");
    expect(ed.layerMask.targeted).toBe(id);
    expect(ed.layerMask.add(id, "reveal")).toBe(false); // one mask per layer

    const b = setup();
    b.ed.layerMask.add(b.id, "hide");
    expect(b.ed.layerMask.info(b.id)?.outside).toBe("hide");
    expect(maskA(b.ed, b.id, 3, 3)).toBe(255); // hide all = all white

    const c = setup();
    c.ed.selection.apply(rectSelection({ x: 2, y: 2, width: 4, height: 4 }), "replace");
    c.ed.layerMask.add(c.id, "selection");
    expect([maskA(c.ed, c.id, 3, 3), maskA(c.ed, c.id, 10, 10)]).toEqual([0, 255]); // only the selection shown
    expect(c.ed.layerMask.info(c.id)?.outside).toBe("hide");
  });

  it("paint layers only (not masks)", () => {
    const { ed } = setup();
    const mask = ed.doc.layers.find((l) => l.kind === "mask");
    expect(mask && ed.layerMask.canAdd(mask.id)).toBe(false);
    expect(mask && ed.layerMask.add(mask.id, "reveal")).toBe(false);
  });
});

describe("target", () => {
  it("switches per layer; Quick Mask wins while on", () => {
    const { ed, id } = setup();
    ed.layerMask.add(id, "reveal");
    ed.layerMask.setTarget(id, "layer");
    expect(ed.layerMask.targeted).toBeNull();
    ed.layerMask.setTarget(id, "mask");
    expect(ed.layerMask.targeted).toBe(id);
    ed.setPaintTarget("mask");
    expect(ed.layerMask.targeted).toBeNull();
    ed.setPaintTarget("paint");
    const other = ed.layerOps.add();
    expect(other && ed.layerMask.target(other)).toBe("layer");
    expect(ed.layerMask.targeted).toBeNull();
    ed.layerOps.setActiveLayer(id);
    expect(ed.layerMask.targeted).toBe(id); // kept per layer
  });

  it("mask swatches: X swaps and D resets only while a mask is targeted; the real colours stay", () => {
    const { ed, id } = setup();
    expect(ed.layerMask.swapSwatches()).toBe(false);
    expect(ed.layerMask.resetSwatches()).toBe(false);
    ed.layerMask.add(id, "reveal");
    expect(ed.layerMask.foregroundHides).toBe(true); // default: foreground white = hide
    expect(ed.layerMask.swatches).toEqual({ fg: "#ffffff", bg: "#000000" });
    const colors = ed.colors.current;
    expect(ed.layerMask.swapSwatches()).toBe(true);
    expect(ed.layerMask.swatches).toEqual({ fg: "#000000", bg: "#ffffff" });
    expect(ed.layerMask.foregroundHides).toBe(false);
    expect(ed.layerMask.resetSwatches()).toBe(true);
    expect(ed.layerMask.foregroundHides).toBe(true);
    expect(ed.colors.current).toEqual(colors);
    ed.layerMask.swapSwatches();
    ed.layerMask.setTarget(id, "layer");
    ed.layerMask.setTarget(id, "mask");
    expect(ed.layerMask.foregroundHides).toBe(false); // per editor, kept for the session
  });
});

describe("X / D keys and options bar", () => {
  const key = (k: string): KeyboardEvent =>
    ({ key: k, code: `Key${k.toUpperCase()}`, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, repeat: false }) as KeyboardEvent;
  const effects = { optionsChanged: () => undefined, viewChanged: () => undefined, cancelDrag: () => undefined, fullscreen: () => undefined, closePopover: () => false, exitFullscreen: () => false, closeHelp: () => false, toggleHelp: () => undefined };

  it("X / D act on the colours normally and on the mask swatches with a mask targeted", async () => {
    const { handleShortcut } = await import("../ui/shortcuts");
    const { ed, id } = setup();
    const tools = { resolve: () => ({}), active: { options: null }, cycleShortcut: () => undefined, byShortcut: () => undefined };
    const session = { editor: ed, tools } as unknown as Parameters<typeof handleShortcut>[1];
    const fg = ed.colors.fg;
    expect(handleShortcut(key("x"), session, effects)).toBe(true);
    expect(ed.colors.fg).not.toBe(fg);
    ed.layerMask.add(id, "reveal");
    const now = ed.colors.current;
    handleShortcut(key("x"), session, effects);
    expect(ed.colors.current).toEqual(now);
    expect(ed.layerMask.foregroundHides).toBe(false);
    handleShortcut(key("d"), session, effects);
    expect(ed.colors.current).toEqual(now);
    expect(ed.layerMask.foregroundHides).toBe(true);
    ed.layerMask.setTarget(id, "layer");
    handleShortcut(key("x"), session, effects);
    expect(ed.colors.fg).not.toBe(now.fg);
    expect(ed.layerMask.foregroundHides).toBe(true);
  });

  it("Invert and Delete (the bottom bar's lmask options) act on the targeted mask", () => {
    const { ed, id } = setup();
    expect(ed.layerMask.targeted).toBeNull();
    ed.layerMask.add(id, "reveal");
    expect(ed.layerMask.targeted).toBe(id);
    expect(ed.layerMask.setInvert(id, true)).toBe(true);
    expect(ed.layerMask.info(id)?.invert).toBe(true);
    expect(ed.layerMask.remove(id)).toBe(true);
    expect(ed.layerMask.info(id)).toBeUndefined();
    expect(ed.layerMask.targeted).toBeNull();
  });
});

describe("painting the mask", () => {
  it("the brush paints the foreground swatch (white hides, black reveals); colour ignored; layer untouched", () => {
    const { ed, id } = setup();
    fillLayer(ed, id);
    ed.layerMask.add(id, "reveal");
    expect(stroke(ed, BRUSH, [[8, 8]])).toBe(true);
    expect(px(ed, ed.layerMask.canvas(id), 8, 8)).toEqual([255, 255, 255, 255]); // white = hidden
    expect(maskA(ed, id, 1, 1)).toBe(0);
    expect(px(ed, ed.layerCanvas(id), 8, 8)).toEqual([255, 0, 0, 255]);
    ed.layerMask.swapSwatches(); // foreground black
    stroke(ed, { ...BRUSH, color: "#00ff00" }, [[8, 8]]);
    expect(maskA(ed, id, 8, 8)).toBe(0);
  });

  it("opacity applies once per stroke (half hide)", () => {
    const { ed, id } = setup();
    ed.layerMask.add(id, "reveal");
    stroke(ed, { ...BRUSH, opacity: 0.5 }, [[8, 8], [8.5, 8]]);
    expect(Math.abs(maskA(ed, id, 8, 8) - 128)).toBeLessThanOrEqual(1);
  });

  it("the eraser always reveals, whatever the swatches", () => {
    const { ed, id } = setup();
    ed.layerMask.add(id, "hide");
    stroke(ed, ERASER, [[8, 8]]);
    expect(maskA(ed, id, 8, 8)).toBe(0);
    ed.layerMask.swapSwatches();
    stroke(ed, ERASER, [[4, 4]]);
    expect(maskA(ed, id, 4, 4)).toBe(0);
    expect(maskA(ed, id, 12, 12)).toBe(255);
  });

  it("selections clip mask strokes", () => {
    const { ed, id } = setup();
    ed.layerMask.add(id, "reveal");
    ed.selection.apply(rectSelection({ x: 0, y: 0, width: 8, height: 16 }), "replace");
    stroke(ed, BRUSH, [[4, 8], [12, 8]]);
    expect([maskA(ed, id, 4, 8), maskA(ed, id, 12, 8)]).toEqual([255, 0]);
  });

  it("the bucket paints the foreground swatch into the selection or the whole mask", () => {
    const { ed, id } = setup();
    ed.layerMask.add(id, "reveal");
    const fill = { point: { x: 3, y: 3 }, tolerance: 32, contiguous: true, antiAlias: false, sample: "layer" as const, opacity: 1, color: "#123456" };
    ed.selection.apply(rectSelection({ x: 0, y: 0, width: 4, height: 4 }), "replace");
    expect(ed.pixelOps.fill(fill)).toBe(true);
    expect([maskA(ed, id, 1, 1), maskA(ed, id, 10, 10)]).toEqual([255, 0]);
    ed.layerMask.swapSwatches(); // black reveals
    expect(ed.pixelOps.fill({ ...fill, opacity: 0.5 })).toBe(true);
    expect(Math.abs(maskA(ed, id, 1, 1) - 128)).toBeLessThanOrEqual(1);
    ed.layerMask.resetSwatches();
    ed.selection.deselect();
    ed.pixelOps.fill(fill);
    expect(maskA(ed, id, 15, 0)).toBe(255);
    expect(px(ed, ed.layerCanvas(id), 3, 3)[3]).toBe(0); // layer pixels never filled
  });

  it("Delete reveals; Alt / Ctrl+Backspace fill the selection with the FG / BG mask swatch", () => {
    const { ed, id, notes } = setup();
    const maskLayer = ed.doc.layers.find((l) => l.kind === "mask");
    if (!maskLayer) throw new Error("no mask layer");
    ed.layerMask.add(id, "reveal");
    expect(ed.selection.clearSelected()).toBe(false); // needs a selection, like mask layers
    expect(ed.selection.fillSelected("#123456", "fg")).toBe(false);
    expect(notes.length).toBe(2);
    ed.selection.apply(rectSelection({ x: 8, y: 8, width: 4, height: 4 }), "replace");
    // Default swatches: FG white, BG black. Ctrl+Backspace (BG) reveals: already revealed.
    expect(ed.selection.fillSelected("#123456", "bg")).toBe(false);
    expect(ed.selection.fillSelected("#123456", "fg")).toBe(true); // Alt+Backspace hides
    expect([maskA(ed, id, 10, 10), maskA(ed, id, 1, 1)]).toEqual([255, 0]);
    ed.selection.apply(rectSelection({ x: 8, y: 8, width: 2, height: 4 }), "replace");
    expect(ed.selection.fillSelected("#123456", "bg")).toBe(true); // BG black reveals
    expect([maskA(ed, id, 8, 10), maskA(ed, id, 10, 10)]).toEqual([0, 255]);
    // Swapped (FG black, BG white): the keys swap roles, the colour is never used.
    ed.layerMask.swapSwatches();
    expect(ed.selection.fillSelected("#ffffff", "bg")).toBe(true);
    expect(maskA(ed, id, 8, 10)).toBe(255);
    ed.selection.apply(rectSelection({ x: 8, y: 8, width: 4, height: 4 }), "replace");
    expect(ed.selection.fillSelected("#ffffff", "fg")).toBe(true);
    expect(maskA(ed, id, 10, 10)).toBe(0);
    ed.selection.fillSelected("#000000", "bg");
    expect(maskA(ed, id, 10, 10)).toBe(255);
    expect(ed.selection.clearSelected()).toBe(true); // Delete reveals whatever the swatches
    expect(maskA(ed, id, 10, 10)).toBe(0);
    // The same keys on the mask layer (Quick Mask): add / clear coverage.
    ed.setPaintTarget("mask");
    const maskPx = (): number => px(ed, ed.layerCanvas(maskLayer.id), 10, 10)[3] ?? -1;
    expect(ed.selection.fillSelected("#123456")).toBe(true);
    expect(maskPx()).toBe(255);
    expect(ed.selection.clearSelected()).toBe(true);
    expect(maskPx()).toBe(0);
    expect(maskA(ed, id, 10, 10)).toBe(0); // the layer mask is not the target then
  });

  it("other pixel tools refuse with a note", () => {
    const { ed, id, notes } = setup();
    ed.layerMask.add(id, "reveal");
    expect(ed.beginStroke({ ...BRUSH, shape: true }, 1)).toBe(false);
    expect(notes).toContain(LAYER_MASK_TOOL_NOTE);
    // Text is not blocked by a targeted lmask: it makes a new text layer, never paints the lmask.
    const style = { font: "Arial", size: 12, color: "#000000", bold: false, italic: false, align: "left" as const };
    const textId = ed.text.create({ x: 4, y: 8 }, style);
    expect(textId).not.toBeNull();
    expect(ed.doc.layers.find((l) => l.id === textId)?.kind).toBe("text");
    ed.text.commit(); // empty: dropped again
    expect(ed.doc.layers.find((l) => l.id === id)?.layerMask).toBeDefined();
    ed.layerOps.setActiveLayer(id);
    ed.layerMask.setTarget(id, "layer");
    expect(ed.beginStroke({ ...BRUSH, shape: true }, 1)).toBe(true);
    ed.cancelStroke();
  });
});

describe("compositor", () => {
  it("masked layer = layer x mask; cache rebuilt only on layer / mask / invert changes", () => {
    const { ed, id } = setup();
    fillLayer(ed, id);
    const raw = ed.layerCanvas(id);
    expect(ed.compositeLayers()[0]?.source).toBe(raw); // no mask: plain path
    ed.layerMask.add(id, "reveal");
    stroke(ed, BRUSH, [[8, 8]]);
    const cache = state(ed).cache(id);
    const first = ed.compositeLayers()[0]?.source as HTMLCanvasElement;
    expect(first).not.toBe(raw);
    expect([px(ed, first, 8, 8)[3], px(ed, first, 1, 1)[3]]).toEqual([0, 255]);
    const n = cache.rebuilds;
    ed.compositeLayers();
    expect(cache.rebuilds).toBe(n); // unchanged inputs: no rebuild
    ed.layerMask.setInvert(id, true);
    const inverted = ed.compositeLayers()[0]?.source as HTMLCanvasElement;
    expect(cache.rebuilds).toBe(n + 1);
    expect([px(ed, inverted, 8, 8)[3], px(ed, inverted, 1, 1)[3]]).toEqual([255, 0]);
    ed.layerMask.setTarget(id, "layer");
    stroke(ed, ERASER, [[1, 1]]);
    ed.compositeLayers();
    expect(cache.rebuilds).toBe(n + 2);
    ed.layerMask.setEnabled(id, false);
    expect(ed.compositeLayers()[0]?.source).toBe(ed.layerCanvas(id)); // disabled: unmasked
  });

  it("live preview shows the masked layer during a mask stroke", () => {
    const { ed, id } = setup();
    fillLayer(ed, id);
    ed.layerMask.add(id, "reveal");
    ed.compositeLayers();
    expect(ed.beginStroke(BRUSH, 4)).toBe(true);
    ed.addDabs([{ x: 8, y: 8, size: 4, alpha: 1, cap: 1 }]);
    const live = ed.compositeLayers()[0]?.source as HTMLCanvasElement;
    expect(px(ed, live, 8, 8)[3]).toBe(0);
    ed.cancelStroke();
    expect(px(ed, ed.compositeLayers()[0]?.source as HTMLCanvasElement, 8, 8)[3]).toBe(255);
  });
});

describe("bounds growth", () => {
  it("the mask grows with its `outside` value", () => {
    for (const fill of ["reveal", "hide"] as const) {
      const { ed, id } = setup();
      ed.layerMask.add(id, fill);
      ed.layerMask.setTarget(id, "layer");
      // Growth as from a move / paste (strokes stay inside the image area).
      (ed as unknown as { s: { ensureBounds: (r: { x: number; y: number; width: number; height: number }, c: boolean) => void } }).s.ensureBounds({ x: -8, y: 8, width: 1, height: 1 }, true);
      expect(ed.bounds.x).toBeLessThan(0);
      expect(maskA(ed, id, -8, 8)).toBe(fill === "hide" ? 255 : 0);
      expect(maskA(ed, id, 8, 8)).toBe(fill === "hide" ? 255 : 0);
    }
  });
});

describe("undo", () => {
  it("add / invert / strokes / delete undo and redo", () => {
    const { ed, id } = setup();
    ed.layerMask.add(id, "reveal");
    stroke(ed, BRUSH, [[8, 8]]);
    ed.layerMask.setInvert(id, true);
    ed.undo();
    expect(ed.layerMask.info(id)?.invert).toBe(false);
    ed.undo();
    expect(maskA(ed, id, 8, 8)).toBe(0);
    ed.redo();
    expect(maskA(ed, id, 8, 8)).toBe(255);
    ed.undo();
    ed.undo();
    expect(ed.layerMask.info(id)).toBeUndefined();
    expect(ed.layerMask.canvas(id)).toBeNull();
    ed.redo();
    ed.redo();
    expect(ed.layerMask.info(id)?.outside).toBe("reveal");
    expect(maskA(ed, id, 8, 8)).toBe(255);
    expect(ed.layerMask.remove(id)).toBe(true);
    expect(ed.layerMask.info(id)).toBeUndefined();
    ed.undo();
    expect(maskA(ed, id, 8, 8)).toBe(255);
    expect(maskA(ed, id, 1, 1)).toBe(0);
  });

  it("enabled is not an undo step (like the eye)", () => {
    const { ed, id } = setup();
    ed.layerMask.add(id, "reveal");
    const steps = depth(ed);
    ed.layerMask.setEnabled(id, false);
    expect(depth(ed)).toBe(steps);
    expect(ed.layerMask.info(id)?.enabled).toBe(false);
  });
});
