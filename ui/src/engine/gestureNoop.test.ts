/**
 * Merged gestures that net to no change leave no undo step (SPEC M7a wart:
 * Esc in the mask colour picker). The test environment has no canvas, so a
 * permissive fake (every context method is a no-op) stands in; these tests
 * only touch layer metadata.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createEmptyDocument } from "../document/create";
import { propsEqual } from "../document/layerList";
import type { Editor as EditorClass } from "./editor";
import { sameTextState } from "./textLayer";

// ── Fake canvas ───────────────────────────────────────────────────────────────

function fakeContext(canvas: object): object {
  const fields: Record<string | symbol, unknown> = {
    canvas,
    getImageData: (_x: number, _y: number, w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
  };
  return new Proxy(fields, {
    get: (target, key) => (key in target ? target[key] : () => undefined),
    set: (target, key, value) => {
      target[key] = value;
      return true;
    },
  });
}

function fakeCanvas(): object {
  const canvas: Record<string, unknown> = { width: 300, height: 150 };
  const ctx = fakeContext(canvas);
  canvas.getContext = () => ctx;
  return canvas;
}

let Editor: typeof EditorClass;

beforeAll(async () => {
  (globalThis as { document?: unknown }).document = { createElement: () => fakeCanvas() };
  ({ Editor } = await import("./editor"));
});

afterAll(() => {
  delete (globalThis as { document?: unknown }).document;
});

function setup(): { ed: EditorClass; maskId: string; paintId: string } {
  const ed = new Editor(createEmptyDocument({ width: 64, height: 64 }, "doc00001"), "widgets");
  const maskId = ed.doc.layers.find((l) => l.kind === "mask")?.id ?? "";
  const paintId = ed.doc.layers.find((l) => l.kind === "paint")?.id ?? "";
  return { ed, maskId, paintId };
}

// ── Pure helpers ──────────────────────────────────────────────────────────────

describe("propsEqual", () => {
  it("compares keys and values", () => {
    expect(propsEqual({ color: "#ff0000" }, { color: "#ff0000" })).toBe(true);
    expect(propsEqual({ color: "#ff0000" }, { color: "#00ff00" })).toBe(false);
    expect(propsEqual({ opacity: 0.5 }, { opacity: 0.5, name: "x" })).toBe(false);
    expect(propsEqual({ color: undefined }, {})).toBe(false);
    expect(propsEqual({}, {})).toBe(true);
  });
});

describe("sameTextState", () => {
  it("compares kind, name and text data", () => {
    const td = { text: "a", x: 1, y: 2, font: "f", size: 10, color: "#000000", bold: false, italic: false, align: "left" as const };
    expect(sameTextState({ kind: "text", name: "a", textData: td }, { kind: "text", name: "a", textData: { ...td } })).toBe(true);
    expect(sameTextState({ kind: "text", name: "a", textData: td }, { kind: "text", name: "a", textData: { ...td, x: 2 } })).toBe(false);
    expect(sameTextState({ kind: "text", name: "a", textData: td }, { kind: "paint", name: "a" })).toBe(false);
  });
});

// ── Editor gestures ───────────────────────────────────────────────────────────

describe("gesture that nets to no change", () => {
  it("mask colour picker session ending on the original colour leaves no undo step", () => {
    const { ed, maskId } = setup();
    expect(ed.layerOps.setMaskColor(maskId, "#00ff00", "mask-color:1")).toBe(true);
    ed.layerOps.setMaskColor(maskId, "#0000ff", "mask-color:1");
    expect(ed.canUndo).toBe(true);
    // Esc: picker restores the initial colour through the same gesture.
    ed.layerOps.setMaskColor(maskId, "#ff0000", "mask-color:1");
    expect(ed.doc.layers.find((l) => l.id === maskId)?.color).toBe("#ff0000");
    expect(ed.canUndo).toBe(false);
  });

  it("a session that ends elsewhere is still one undo step back to the start", () => {
    const { ed, maskId } = setup();
    ed.layerOps.setMaskColor(maskId, "#00ff00", "mask-color:2");
    ed.layerOps.setMaskColor(maskId, "#ff0000", "mask-color:2"); // back to start: dropped
    ed.layerOps.setMaskColor(maskId, "#0000ff", "mask-color:2"); // continues: new entry
    ed.undo();
    expect(ed.doc.layers.find((l) => l.id === maskId)?.color).toBe("#ff0000");
    expect(ed.canUndo).toBe(false);
  });

  it("opacity scrub back to the start value leaves no undo step; earlier steps are kept", () => {
    const { ed, paintId } = setup();
    ed.layerOps.rename(paintId, "Base");
    ed.layerOps.setOpacity(paintId, 0.4, "opacity:1");
    ed.layerOps.setOpacity(paintId, 1, "opacity:1");
    expect(ed.canUndo).toBe(true); // the rename
    ed.undo();
    expect(ed.doc.layers.find((l) => l.id === paintId)?.name).toBe("Layer 1");
    expect(ed.canUndo).toBe(false);
  });

  it("different gestures do not cancel each other", () => {
    const { ed, paintId } = setup();
    ed.layerOps.setOpacity(paintId, 0.4, "opacity:2");
    ed.layerOps.setOpacity(paintId, 1, "opacity:3");
    ed.undo();
    expect(ed.doc.layers.find((l) => l.id === paintId)?.opacity).toBe(0.4);
  });
});
