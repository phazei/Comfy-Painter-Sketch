import { describe, expect, it } from "vitest";

import { createEmptyDocument } from "./create";
import { MAX_DOCUMENT_SIDE, parseDocument } from "./parse";
import { stringifyDocument } from "./serialize";

describe("createEmptyDocument", () => {
  it("creates a paint layer + a mask above it, bounds = frame, empty regions", () => {
    const doc = createEmptyDocument({ width: 640, height: 480 }, "abcd1234");
    expect(doc.version).toBe(1);
    expect(doc.docId).toBe("abcd1234");
    expect(doc.bounds).toEqual({ x: 0, y: 0, width: 640, height: 480 });
    expect(doc.regions).toEqual([]);
    expect(doc.layers).toHaveLength(2);
    expect(doc.layers[0]).toMatchObject({ name: "Layer 1", kind: "paint", file: null, opacity: 1, visible: true });
    expect(doc.layers[1]).toEqual({
      id: expect.any(String),
      name: "Mask 1",
      kind: "mask",
      visible: true,
      locked: false,
      opacity: 0.5,
      blendMode: "normal",
      file: null,
      color: "#ff0000",
      subtract: false,
    });
    expect(doc.layers[1]?.id).not.toBe(doc.layers[0]?.id);
    expect(doc.activeLayerId).toBe(doc.layers[0]?.id);
  });
});

describe("parseDocument", () => {
  it("round-trips a document through stringify", () => {
    const doc = createEmptyDocument({ width: 100, height: 50 }, "docid0001");
    const first = doc.layers[0];
    if (first) first.file = "painter-sketch/a.png [input]";
    const mask = doc.layers[1];
    if (mask) {
      mask.file = "painter-sketch/m.png [input]";
      mask.subtract = true;
      mask.color = "#00ff00";
    }
    doc.bounds = { x: -256, y: 0, width: 612, height: 50 };
    const parsed = parseDocument(stringifyDocument(doc));
    expect(parsed).toEqual({ status: "ok", repaired: false, document: doc });
  });

  it("writes a cmask's `subtract` only when true; reads it leniently, mask layers only", () => {
    const doc = createEmptyDocument({ width: 10, height: 10 }, "docid0002");
    const [paint, mask] = doc.layers;
    if (!paint || !mask) throw new Error("layers");
    const plain = JSON.parse(stringifyDocument(doc)) as { layers: Record<string, unknown>[] };
    expect("subtract" in (plain.layers[1] ?? {})).toBe(false);
    mask.subtract = true;
    const saved = JSON.parse(stringifyDocument(doc)) as { layers: Record<string, unknown>[] };
    expect(saved.layers[1]?.["subtract"]).toBe(true);
    const back = parseDocument(saved);
    expect(back.status === "ok" && back.document.layers[1]?.subtract).toBe(true);
    // Non-boolean -> normal; a paint layer never gets the field.
    const odd = { ...saved, layers: [{ ...saved.layers[0], subtract: true }, { ...saved.layers[1], subtract: "yes" }] };
    const lenient = parseDocument(odd);
    if (lenient.status !== "ok") throw new Error("not ok");
    expect("subtract" in (lenient.document.layers[0] ?? {})).toBe(false);
    expect(lenient.document.layers[1]?.subtract).toBe(false);
  });

  it("treats empty and nullish values as empty", () => {
    expect(parseDocument("")).toEqual({ status: "empty" });
    expect(parseDocument("   ")).toEqual({ status: "empty" });
    expect(parseDocument(undefined)).toEqual({ status: "empty" });
  });

  it("rejects bad JSON, unknown versions and broken structure", () => {
    expect(parseDocument("{nope").status).toBe("invalid");
    expect(parseDocument({ version: 2, frame: { width: 1, height: 1 } })).toMatchObject({
      status: "invalid",
      reason: "unsupported document version 2",
    });
    expect(parseDocument({ version: 1, frame: { width: 0, height: 10 }, layers: [] }).status).toBe("invalid");
    expect(parseDocument({ version: 1, frame: { width: 10, height: 10 }, layers: "x" }).status).toBe("invalid");
    expect(parseDocument({ version: 1, frame: { width: 10, height: 10 }, layers: null }).status).toBe("invalid");
    expect(
      parseDocument({
        version: 1,
        frame: { width: 10, height: 10 },
        bounds: { x: 2, y: 0, width: 10, height: 10 },
        layers: [],
      }).status,
    ).toBe("invalid");
  });

  it("skips a malformed layer instead of rejecting the document (as Python)", () => {
    const result = parseDocument({
      version: 1,
      frame: { width: 10, height: 10 },
      layers: [
        { id: "a", kind: "paint", file: "painter-sketch/a.webp [input]" },
        null,
        { id: "b", kind: "sparkles" },
        { kind: "paint" },
        { id: "m", kind: "mask", file: 7 },
      ],
    });
    if (result.status !== "ok") throw new Error("expected ok");
    expect(result.repaired).toBe(true);
    expect(result.skippedLayers).toBe(3);
    expect(result.document.layers.map((l) => [l.id, l.file])).toEqual([
      ["a", "painter-sketch/a.webp [input]"],
      ["m", null],
    ]);
  });

  it("keeps a duplicate-id layer under a fresh id", () => {
    const result = parseDocument({
      version: 1,
      frame: { width: 10, height: 10 },
      layers: [
        { id: "a", kind: "paint", file: "painter-sketch/1.webp [input]" },
        { id: "a", kind: "paint", file: "painter-sketch/2.webp [input]" },
      ],
    });
    if (result.status !== "ok") throw new Error("expected ok");
    expect(result.skippedLayers).toBeUndefined();
    const [first, second] = result.document.layers;
    expect(first?.id).toBe("a");
    expect(second?.id).not.toBe("a");
    expect(second?.file).toBe("painter-sketch/2.webp [input]");
  });

  it("repairs missing optional fields", () => {
    const result = parseDocument({
      version: 1,
      frame: { width: 10, height: 20 },
      layers: [{ id: "l1", kind: "paint", opacity: 7, file: null }],
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.repaired).toBe(true);
    const doc = result.document;
    expect(doc.bounds).toEqual({ x: 0, y: 0, width: 10, height: 20 });
    expect(doc.activeLayerId).toBe("l1");
    expect(doc.regions).toEqual([]);
    expect(doc.docId).toMatch(/^[a-z0-9]{12}$/);
    expect(doc.layers[0]).toMatchObject({ opacity: 1, visible: true, locked: false, blendMode: "normal" });
  });

  it("adds a paint layer when none exists", () => {
    const result = parseDocument({ version: 1, frame: { width: 4, height: 4 }, layers: [] });
    expect(result.status === "ok" && result.document.layers[0]?.kind).toBe("paint");
  });

  it("treats a missing layers key as an empty stack (as Python)", () => {
    const result = parseDocument({ version: 1, frame: { width: 4, height: 4 } });
    if (result.status !== "ok") throw new Error("expected ok");
    expect(result.repaired).toBe(true);
    expect(result.skippedLayers).toBeUndefined();
    expect(result.document.layers.map((l) => l.kind)).toEqual(["paint"]);
  });

  it("repairs an oversized bounds to the frame instead of rejecting", () => {
    const result = parseDocument({
      version: 1,
      frame: { width: 4, height: 4 },
      bounds: { x: 0, y: 0, width: MAX_DOCUMENT_SIDE + 1, height: 4 },
      layers: [],
    });
    if (result.status !== "ok") throw new Error("expected ok");
    expect(result.repaired).toBe(true);
    expect(result.document.bounds).toEqual({ x: 0, y: 0, width: 4, height: 4 });
  });
});
