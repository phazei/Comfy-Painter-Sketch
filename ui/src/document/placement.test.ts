import { describe, expect, it } from "vitest";

import { createEmptyDocument } from "./create";
import { parseDocument } from "./parse";
import { isIdentityPlacement, readPlacement } from "./placement";
import { cloneDocument, stringifyDocument } from "./serialize";

describe("readPlacement (lenient, mirrors nodes/document.py)", () => {
  it("treats missing as identity without repair", () => {
    expect(readPlacement(undefined)).toEqual({ placement: undefined, repaired: false });
  });

  it("keeps valid values", () => {
    expect(readPlacement({ x: 10.5, y: -5, scale: 1.5 })).toEqual({ placement: { x: 10.5, y: -5, scale: 1.5 }, repaired: false });
  });

  it("clamps scale to [0.05, 20] and replaces non-finite / wrong-typed fields", () => {
    expect(readPlacement({ x: 0, y: 0, scale: 100 }).placement?.scale).toBe(20);
    expect(readPlacement({ x: 1, y: 0, scale: 0 }).placement?.scale).toBe(0.05);
    expect(readPlacement({ x: "3", y: Number.NaN, scale: 2 })).toEqual({ placement: { x: 0, y: 0, scale: 2 }, repaired: true });
    expect(readPlacement({ x: 0, y: 0, scale: null })).toEqual({ placement: undefined, repaired: true });
  });

  it("ignores non-objects", () => {
    expect(readPlacement([1, 2])).toEqual({ placement: undefined, repaired: true });
    expect(readPlacement("x")).toEqual({ placement: undefined, repaired: true });
  });

  it("identity check", () => {
    expect(isIdentityPlacement(undefined)).toBe(true);
    expect(isIdentityPlacement({ x: 0, y: 0, scale: 1 })).toBe(true);
    expect(isIdentityPlacement({ x: 0, y: 1, scale: 1 })).toBe(false);
  });
});

describe("placement in the manifest", () => {
  it("is omitted when identity (pre-M5 manifests stay byte-identical)", () => {
    const doc = createEmptyDocument({ width: 100, height: 50 }, "docid0001");
    const before = stringifyDocument(doc);
    expect(before).not.toContain("placement");
    doc.placement = { x: 0, y: 0, scale: 1 };
    expect(stringifyDocument(doc)).toBe(before);
  });

  it("round-trips a non-identity placement", () => {
    const doc = createEmptyDocument({ width: 100, height: 50 }, "docid0001");
    doc.placement = { x: 12.5, y: -3, scale: 0.75 };
    const text = stringifyDocument(doc);
    expect(text).toContain('"placement":{"x":12.5,"y":-3,"scale":0.75}');
    expect(parseDocument(text)).toEqual({ status: "ok", repaired: false, document: doc });
  });

  it("parses a present identity placement to no placement", () => {
    const doc = createEmptyDocument({ width: 10, height: 10 }, "docid0001");
    const result = parseDocument({ ...JSON.parse(stringifyDocument(doc)), placement: { x: 0, y: 0, scale: 1 } });
    expect(result.status === "ok" && result.document.placement).toBeUndefined();
  });

  it("clones deeply", () => {
    const doc = createEmptyDocument({ width: 10, height: 10 }, "docid0001");
    doc.placement = { x: 1, y: 2, scale: 3 };
    const copy = cloneDocument(doc);
    expect(copy.placement).toEqual(doc.placement);
    expect(copy.placement).not.toBe(doc.placement);
  });
});
