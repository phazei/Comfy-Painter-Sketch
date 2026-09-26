import { describe, expect, it } from "vitest";

import { MASK_PALETTE, nextMaskStyle } from "../defaults/maskDefaults";
import { createEmptyDocument, createMaskLayer, createPaintLayer } from "./create";
import {
  canAddMask,
  canDeleteLayer,
  canDuplicateLayer,
  MAX_MASKS,
  maskInsertIndex,
  maskLayerCount,
  nextMaskName,
  resolveMove,
} from "./layerList";
import { parseDocument } from "./parse";
import { stringifyDocument } from "./serialize";
import type { Layer, PainterDocument } from "./types";

/** Paint A, B + masks M1, M2, M3 (bottom -> top). */
function multiMaskDoc(): PainterDocument {
  const doc = createEmptyDocument({ width: 8, height: 8 }, "doc00001");
  const paint = ["A", "B"].map((id) => ({ ...createPaintLayer(id), id }));
  const masks = ["M1", "M2", "M3"].map((id, i) => ({ ...createMaskLayer(`Mask ${i + 1}`), id }));
  doc.layers = [...paint, ...masks];
  doc.activeLayerId = "A";
  return doc;
}

const mask = (name: string): Pick<Layer, "name" | "kind"> => ({ name, kind: "mask" });

describe("nextMaskName", () => {
  it("uses the lowest free number among masks", () => {
    expect(nextMaskName([])).toBe("Mask 1");
    expect(nextMaskName([mask("Mask 1"), mask("Mask 3")])).toBe("Mask 2");
    expect(nextMaskName([mask("Mask 2")])).toBe("Mask 1");
    expect(nextMaskName([mask("Mask"), mask("Sky")])).toBe("Mask 2");
    // Paint layers named "Mask N" don't count.
    expect(nextMaskName([{ name: "Mask 1", kind: "paint" }])).toBe("Mask 1");
  });
});

describe("mask limits", () => {
  it("allows up to MAX_MASKS masks", () => {
    const doc = multiMaskDoc();
    expect(maskLayerCount(doc.layers)).toBe(3);
    expect(canAddMask(doc.layers)).toBe(true);
    while (maskLayerCount(doc.layers) < MAX_MASKS) doc.layers.push(createMaskLayer("x"));
    expect(MAX_MASKS).toBe(7);
    expect(canAddMask(doc.layers)).toBe(false);
  });

  it("deletes masks but never the last one, and never duplicates them", () => {
    const doc = multiMaskDoc();
    expect(canDeleteLayer(doc.layers, "M2")).toBe(true);
    expect(canDuplicateLayer(doc.layers, "M2")).toBe(false);
    doc.layers = doc.layers.filter((l) => l.id !== "M1" && l.id !== "M2");
    expect(canDeleteLayer(doc.layers, "M3")).toBe(false);
  });

  it("inserts a new mask above the current mask, else on top", () => {
    const doc = multiMaskDoc();
    expect(maskInsertIndex(doc.layers, "M1")).toBe(3);
    expect(maskInsertIndex(doc.layers, "M3")).toBe(5);
    expect(maskInsertIndex(doc.layers, null)).toBe(5);
    expect(maskInsertIndex(doc.layers, "A")).toBe(5);
  });
});

describe("resolveMove with masks", () => {
  it("reorders masks among masks only", () => {
    const doc = multiMaskDoc();
    expect(resolveMove(doc.layers, "M1", "M3", true)).toEqual({ from: 2, to: 4 });
    expect(resolveMove(doc.layers, "M3", "M1", false)).toEqual({ from: 4, to: 2 });
    expect(resolveMove(doc.layers, "M1", "B", true)).toBeNull();
    expect(resolveMove(doc.layers, "B", "M1", false)).toBeNull();
  });
});

describe("nextMaskStyle", () => {
  const first = { color: "#123456", opacity: 0.4 };

  it("gives the first mask the settings style", () => {
    expect(nextMaskStyle([], first)).toEqual(first);
  });

  it("takes the first unused palette colour at the default opacity", () => {
    expect(nextMaskStyle(["#123456"], first)).toEqual({ color: "#0000ff", opacity: 0.4 });
    expect(nextMaskStyle(["#ff0000", "#0000FF"], first).color).toBe("#00ff00");
    // A first mask that already uses a palette colour skips it.
    expect(nextMaskStyle(["#00f"], first).color).toBe("#00ff00");
    expect(nextMaskStyle(["#ff0000", undefined, "#00ff00"], first).color).toBe("#0000ff");
  });

  it("cycles when every palette colour is taken", () => {
    const used = ["#ff0000", ...MASK_PALETTE];
    expect(MASK_PALETTE).toHaveLength(6);
    expect(MASK_PALETTE).toContain(nextMaskStyle(used, first).color);
  });
});

describe("saved documents with several masks", () => {
  it("round-trip every mask", () => {
    const doc = multiMaskDoc();
    doc.layers[3]!.file = "painter-sketch/ps-doc00001-m2.png [input]";
    doc.layers[4]!.invert = true;
    doc.layers[4]!.visible = false;
    const parsed = parseDocument(stringifyDocument(doc));
    if (parsed.status !== "ok") throw new Error("parse failed");
    expect(parsed.repaired).toBe(false);
    const masks = parsed.document.layers.filter((l) => l.kind === "mask");
    expect(masks.map((l) => l.id)).toEqual(["M1", "M2", "M3"]);
    expect(masks[1]?.file).toBe("painter-sketch/ps-doc00001-m2.png [input]");
    expect(masks[2]).toMatchObject({ invert: true, visible: false });
  });

  it("moves masks saved below paint layers back on top", () => {
    const doc = multiMaskDoc();
    const [a, b, m1, m2, m3] = doc.layers;
    doc.layers = [m1!, a!, m2!, b!, m3!];
    const parsed = parseDocument(stringifyDocument(doc));
    if (parsed.status !== "ok") throw new Error("parse failed");
    expect(parsed.repaired).toBe(true);
    expect(parsed.document.layers.map((l) => l.id)).toEqual(["A", "B", "M1", "M2", "M3"]);
  });
});
