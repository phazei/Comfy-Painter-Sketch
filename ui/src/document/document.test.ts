import { describe, expect, it } from "vitest";

import { createEmptyDocument } from "./create";
import { parseDocument } from "./parse";
import { stringifyDocument } from "./serialize";

describe("createEmptyDocument", () => {
  it("creates one paint layer, bounds = frame, empty regions", () => {
    const doc = createEmptyDocument({ width: 640, height: 480 }, "abcd1234");
    expect(doc.version).toBe(1);
    expect(doc.docId).toBe("abcd1234");
    expect(doc.bounds).toEqual({ x: 0, y: 0, width: 640, height: 480 });
    expect(doc.regions).toEqual([]);
    expect(doc.layers).toHaveLength(1);
    expect(doc.layers[0]).toMatchObject({ name: "Layer 1", kind: "paint", file: null, opacity: 1, visible: true });
    expect(doc.activeLayerId).toBe(doc.layers[0]?.id);
  });
});

describe("parseDocument", () => {
  it("round-trips a document through stringify", () => {
    const doc = createEmptyDocument({ width: 100, height: 50 }, "docid0001");
    const first = doc.layers[0];
    if (first) first.file = "painter-sketch/a.png [input]";
    doc.bounds = { x: -256, y: 0, width: 612, height: 50 };
    const parsed = parseDocument(stringifyDocument(doc));
    expect(parsed).toEqual({ status: "ok", repaired: false, document: doc });
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
    expect(
      parseDocument({
        version: 1,
        frame: { width: 10, height: 10 },
        bounds: { x: 2, y: 0, width: 10, height: 10 },
        layers: [],
      }).status,
    ).toBe("invalid");
    expect(
      parseDocument({
        version: 1,
        frame: { width: 10, height: 10 },
        layers: [
          { id: "a", kind: "paint" },
          { id: "a", kind: "paint" },
        ],
      }).status,
    ).toBe("invalid");
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
});
