import { describe, expect, it } from "vitest";

import { createEmptyDocument, createPaintLayer } from "./create";
import {
  activeAfterRemoval,
  applyLayerChange,
  canDeleteLayer,
  canDuplicateLayer,
  nextLayerName,
  paintInsertIndex,
  propsDiffer,
  readProps,
  resolveMove,
} from "./layerList";
import type { LayerChange } from "./layerList";
import type { PainterDocument } from "./types";

/** Paint layers A, B, C (bottom -> top) + the default mask on top. */
function threeLayerDoc(): PainterDocument {
  const doc = createEmptyDocument({ width: 8, height: 8 }, "doc00001");
  const mask = doc.layers.find((l) => l.kind === "mask");
  if (!mask) throw new Error("no mask");
  const [a, b, c] = ["A", "B", "C"].map((name) => ({ ...createPaintLayer(name), id: name }));
  doc.layers = [a!, b!, c!, mask];
  doc.activeLayerId = "B";
  return doc;
}

const ids = (doc: PainterDocument): string[] => doc.layers.map((l) => (l.kind === "mask" ? "M" : l.id));

describe("nextLayerName", () => {
  it("numbers one above the highest 'Layer N'", () => {
    expect(nextLayerName([])).toBe("Layer 1");
    expect(nextLayerName([{ name: "Layer 1" }, { name: "Mask" }])).toBe("Layer 2");
    expect(nextLayerName([{ name: "Layer 7" }, { name: "Layer 2" }, { name: "Sky" }])).toBe("Layer 8");
    expect(nextLayerName([{ name: "Layer 3 copy" }, { name: "Layer x" }])).toBe("Layer 1");
  });
});

describe("paintInsertIndex", () => {
  it("inserts directly above the active paint layer", () => {
    const doc = threeLayerDoc();
    expect(paintInsertIndex(doc)).toBe(2);
    doc.activeLayerId = "C";
    expect(paintInsertIndex(doc)).toBe(3);
  });

  it("falls back to above the top paint layer, below masks", () => {
    const doc = threeLayerDoc();
    doc.activeLayerId = "missing";
    expect(paintInsertIndex(doc)).toBe(3);
    doc.layers = doc.layers.filter((l) => l.kind === "mask");
    expect(paintInsertIndex(doc)).toBe(0);
  });
});

describe("delete / duplicate constraints", () => {
  it("never deletes the last paint layer or a mask", () => {
    const doc = threeLayerDoc();
    const maskId = doc.layers[3]!.id;
    expect(canDeleteLayer(doc.layers, "A")).toBe(true);
    expect(canDeleteLayer(doc.layers, maskId)).toBe(false);
    expect(canDuplicateLayer(doc.layers, maskId)).toBe(false);
    expect(canDuplicateLayer(doc.layers, "C")).toBe(true);
    doc.layers = doc.layers.filter((l) => l.id === "A" || l.kind === "mask");
    expect(canDeleteLayer(doc.layers, "A")).toBe(false);
    expect(canDeleteLayer(doc.layers, "nope")).toBe(false);
  });

  it("activates the layer below a deleted one, else above", () => {
    const doc = threeLayerDoc();
    doc.layers.splice(1, 1); // remove B
    expect(activeAfterRemoval(doc.layers, 1)).toBe("A");
    doc.layers.splice(0, 1); // remove A (index 0): nothing below
    expect(activeAfterRemoval(doc.layers, 0)).toBe("C");
  });
});

describe("resolveMove", () => {
  it("moves paint layers among paint layers", () => {
    const doc = threeLayerDoc();
    expect(resolveMove(doc.layers, "A", "C", true)).toEqual({ from: 0, to: 2 });
    expect(resolveMove(doc.layers, "C", "A", false)).toEqual({ from: 2, to: 0 });
    expect(resolveMove(doc.layers, "A", "C", false)).toEqual({ from: 0, to: 1 });
  });

  it("rejects no-ops, masks and unknown ids", () => {
    const doc = threeLayerDoc();
    const maskId = doc.layers[3]!.id;
    expect(resolveMove(doc.layers, "A", "B", false)).toBeNull();
    expect(resolveMove(doc.layers, "B", "B", true)).toBeNull();
    expect(resolveMove(doc.layers, "A", maskId, true)).toBeNull();
    expect(resolveMove(doc.layers, maskId, "A", false)).toBeNull();
    expect(resolveMove(doc.layers, "zzz", "A", false)).toBeNull();
  });
});

describe("applyLayerChange", () => {
  it("inserts and removes in both directions without aliasing the record", () => {
    const doc = threeLayerDoc();
    const layer = { ...createPaintLayer("New"), id: "N" };
    const change: LayerChange<string> = { op: "insert", index: 2, layer, pixels: null };
    expect(applyLayerChange(doc.layers, change, true)).toBe(true);
    expect(ids(doc)).toEqual(["A", "B", "N", "C", "M"]);
    doc.layers[2]!.visible = false;
    expect(applyLayerChange(doc.layers, change, false)).toBe(true);
    expect(ids(doc)).toEqual(["A", "B", "C", "M"]);
    // Removal kept the non-undoable visibility for the redo.
    expect(applyLayerChange(doc.layers, change, true)).toBe(true);
    expect(doc.layers[2]?.visible).toBe(false);
    expect(doc.layers[2]).not.toBe(change.layer);
    expect(applyLayerChange(doc.layers, change, true)).toBe(false);
  });

  it("reverses a remove (undo delete) at its original index", () => {
    const doc = threeLayerDoc();
    const [removed] = doc.layers.splice(0, 1);
    const change: LayerChange<string> = { op: "remove", index: 0, layer: { ...removed! }, pixels: "px" };
    expect(applyLayerChange(doc.layers, change, false)).toBe(true);
    expect(ids(doc)).toEqual(["A", "B", "C", "M"]);
    expect(applyLayerChange(doc.layers, change, true)).toBe(true);
    expect(ids(doc)).toEqual(["B", "C", "M"]);
  });

  it("moves and moves back; refuses a mismatched list", () => {
    const doc = threeLayerDoc();
    const move = resolveMove(doc.layers, "A", "C", true)!;
    const change: LayerChange<string> = { op: "move", id: "A", ...move };
    applyLayerChange(doc.layers, change, true);
    expect(ids(doc)).toEqual(["B", "C", "A", "M"]);
    expect(applyLayerChange(doc.layers, change, true)).toBe(false);
    applyLayerChange(doc.layers, change, false);
    expect(ids(doc)).toEqual(["A", "B", "C", "M"]);
  });

  it("applies and reverts props, removing optional fields that were absent", () => {
    const doc = threeLayerDoc();
    const layer = doc.layers[0]!;
    const after = { name: "Sky", invert: true };
    const before = readProps(layer, after);
    expect(before).toEqual({ name: "A", invert: undefined });
    expect(propsDiffer(layer, after)).toBe(true);
    const change: LayerChange<string> = { op: "props", id: "A", before, after };
    applyLayerChange(doc.layers, change, true);
    expect(layer.name).toBe("Sky");
    expect(layer.invert).toBe(true);
    expect(propsDiffer(layer, after)).toBe(false);
    applyLayerChange(doc.layers, change, false);
    expect(layer.name).toBe("A");
    expect("invert" in layer).toBe(false);
  });
});
