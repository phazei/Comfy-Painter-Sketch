import { describe, expect, it } from "vitest";

import { createEmptyDocument, createMaskLayer, createPaintLayer } from "./create";
import { activeEditLayer, ensureMaskLayer, findMaskLayer, findPaintLayer, maskDisplayColor, targetLayer } from "./masks";
import type { PainterDocument } from "./types";

/** A pre-M2 document: paint layers only. */
function paintOnlyDoc(): PainterDocument {
  const doc = createEmptyDocument({ width: 8, height: 8 }, "doc00001");
  doc.layers = doc.layers.filter((l) => l.kind === "paint");
  return doc;
}

describe("targetLayer", () => {
  it("resolves paint and mask targets on a new document", () => {
    const doc = createEmptyDocument({ width: 8, height: 8 }, "doc00001");
    expect(targetLayer(doc, "paint")?.kind).toBe("paint");
    expect(targetLayer(doc, "paint")?.id).toBe(doc.activeLayerId);
    expect(targetLayer(doc, "mask")?.kind).toBe("mask");
  });

  it("prefers the active layer when it has the requested kind", () => {
    const doc = createEmptyDocument({ width: 8, height: 8 }, "doc00001");
    const second = createMaskLayer("Mask 2");
    doc.layers.push(second);
    expect(findMaskLayer(doc)?.id).toBe(doc.layers[1]?.id);
    doc.activeLayerId = second.id;
    expect(findMaskLayer(doc)?.id).toBe(second.id);
  });

  it("falls back to the top-most paint layer when a mask is active", () => {
    const doc = createEmptyDocument({ width: 8, height: 8 }, "doc00001");
    const top = createPaintLayer("Layer 2");
    doc.layers.push(top);
    doc.activeLayerId = doc.layers[1]?.id ?? "";
    expect(findPaintLayer(doc)?.id).toBe(top.id);
  });

  it("returns undefined when no layer of the kind exists", () => {
    expect(targetLayer(paintOnlyDoc(), "mask")).toBeUndefined();
  });
});

describe("ensureMaskLayer", () => {
  it("adds a default mask on top of a document without one", () => {
    const doc = paintOnlyDoc();
    const activeBefore = doc.activeLayerId;
    const { layer, created } = ensureMaskLayer(doc);
    expect(created).toBe(true);
    expect(doc.layers[doc.layers.length - 1]).toBe(layer);
    expect(layer).toMatchObject({ kind: "mask", name: "Mask", color: "#ff0000", opacity: 0.5, invert: false, file: null });
    expect(doc.activeLayerId).toBe(activeBefore);
  });

  it("returns the existing mask without changing the document", () => {
    const doc = createEmptyDocument({ width: 8, height: 8 }, "doc00001");
    const before = JSON.stringify(doc);
    const { layer, created } = ensureMaskLayer(doc);
    expect(created).toBe(false);
    expect(layer.id).toBe(doc.layers[1]?.id);
    expect(JSON.stringify(doc)).toBe(before);
  });
});

describe("activeEditLayer", () => {
  it("picks the mask under Quick Mask, else the active paint-like layer", () => {
    const doc = createEmptyDocument({ width: 8, height: 8 }, "doc00001");
    expect(activeEditLayer(doc, "mask")?.kind).toBe("mask");
    expect(activeEditLayer(doc, "paint")?.id).toBe(doc.activeLayerId);
    const text = { ...createPaintLayer("T"), kind: "text" as const };
    doc.layers.push(text);
    doc.activeLayerId = text.id;
    expect(activeEditLayer(doc, "paint")?.id).toBe(text.id);
    expect(activeEditLayer(paintOnlyDoc(), "mask")).toBeUndefined();
  });
});

describe("maskDisplayColor", () => {
  it("accepts hex colours and falls back to red otherwise", () => {
    expect(maskDisplayColor({ color: "#00ff00" })).toBe("#00ff00");
    expect(maskDisplayColor({ color: "#0F0" })).toBe("#0F0");
    expect(maskDisplayColor({})).toBe("#ff0000");
    expect(maskDisplayColor({ color: "red; x" })).toBe("#ff0000");
  });
});
