/**
 * `imageMask` manifest field: round trip, old manifests unchanged,
 * lenient reading, and that a row alone makes the document worth saving.
 */

import { describe, expect, it } from "vitest";

import { hasDocumentContent } from "./content";
import { createEmptyDocument } from "./create";
import { createImageMask, findAnyLayer, IMAGE_MASK_ID } from "./imageMask";
import { findMaskLayer } from "./masks";
import { parseDocument } from "./parse";
import { cloneDocument, stringifyDocument } from "./serialize";
import type { PainterDocument } from "./types";

const KEY = "filename=cat.png&subfolder=&type=input";

function withMask(): PainterDocument {
  const doc = createEmptyDocument({ width: 64, height: 32 }, "abcd1234");
  doc.imageMask = { ...createImageMask(KEY, { width: 640, height: 320 }, { color: "#00ff00", opacity: 0.4 }), file: "painter-sketch/ps-abcd1234-00ff.png [input]", subtract: true };
  return doc;
}

function parsed(raw: unknown): PainterDocument {
  const result = parseDocument(raw);
  if (result.status !== "ok") throw new Error(`not ok: ${result.status}`);
  return result.document;
}

describe("imageMask manifest field", () => {
  it("round-trips its settings, file, source key and size", () => {
    const doc = withMask();
    const text = stringifyDocument(doc);
    const saved = JSON.parse(text) as Record<string, unknown>;
    expect(saved["imageMask"]).toEqual({
      file: "painter-sketch/ps-abcd1234-00ff.png [input]", visible: true, color: "#00ff00", opacity: 0.4,
      subtract: true, sourceKey: KEY, width: 640, height: 320,
    });
    const back = parsed(text);
    expect(back.imageMask).toEqual(doc.imageMask);
    expect(back.imageMask?.id).toBe(IMAGE_MASK_ID);
    expect(stringifyDocument(back)).toBe(text);
  });

  it("writes `subtract` only when true", () => {
    const doc = withMask();
    if (doc.imageMask) doc.imageMask.subtract = false;
    const saved = JSON.parse(stringifyDocument(doc)) as Record<string, Record<string, unknown>>;
    expect("subtract" in (saved["imageMask"] ?? {})).toBe(false);
    expect(parsed(saved).imageMask?.subtract).toBe(false);
  });

  it("old manifests load without a row and stay byte-identical", () => {
    const doc = createEmptyDocument({ width: 64, height: 32 }, "abcd1234");
    const text = stringifyDocument(doc);
    expect(text).not.toContain("imageMask");
    const back = parsed(text);
    expect(back.imageMask).toBeUndefined();
    expect(stringifyDocument(back)).toBe(text);
  });

  it("drops a malformed record (repaired) and reads fields leniently", () => {
    const base = JSON.parse(stringifyDocument(withMask())) as Record<string, Record<string, unknown>>;
    for (const bad of ["x", { ...base["imageMask"], width: 0 }, { ...base["imageMask"], sourceKey: 3 }]) {
      const result = parseDocument({ ...base, imageMask: bad });
      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.document.imageMask).toBeUndefined();
        expect(result.repaired).toBe(true);
        expect(result.document.layers).toHaveLength(2);
      }
    }
    const lenient = parsed({ ...base, imageMask: { ...base["imageMask"], file: " ", visible: "no", subtract: 1, opacity: 7 } });
    expect(lenient.imageMask).toMatchObject({ file: null, visible: true, subtract: false, opacity: 1 });
  });

  it("clones independently", () => {
    const doc = withMask();
    const copy = cloneDocument(doc);
    if (copy.imageMask) copy.imageMask.visible = false;
    expect(doc.imageMask?.visible).toBe(true);
  });

  it("counts as content, resolves by id, and can be the current mask", () => {
    const doc = createEmptyDocument({ width: 8, height: 8 });
    expect(hasDocumentContent(doc)).toBe(false);
    const withRow = withMask();
    expect(hasDocumentContent(withRow)).toBe(true);
    expect(findAnyLayer(withRow, IMAGE_MASK_ID)).toBe(withRow.imageMask);
    expect(findMaskLayer(withRow, IMAGE_MASK_ID)).toBe(withRow.imageMask);
    // Without the row, the current-mask fallback is the top mask as before.
    expect(findMaskLayer(doc, IMAGE_MASK_ID)?.kind).toBe("mask");
    expect(findMaskLayer(doc, IMAGE_MASK_ID)?.id).not.toBe(IMAGE_MASK_ID);
  });
});
