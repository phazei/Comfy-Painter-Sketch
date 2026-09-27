/** Background row eye (manifest field) and background solo. */
import { describe, expect, it } from "vitest";
import { backgroundShown, BACKGROUND_SOLO_ID, pruneSolo, shownOnStage, toggleSolo } from "../engine/solo";
import { hasDocumentContent, outputMetadataSignature } from "./content";
import { createEmptyDocument } from "./create";
import { parseDocument } from "./parse";
import { cloneDocument, stringifyDocument } from "./serialize";
import type { PainterDocument } from "./types";

function parsed(raw: string): { doc: PainterDocument; repaired: boolean } {
  const result = parseDocument(raw);
  if (result.status !== "ok") throw new Error("parse failed");
  return { doc: result.document, repaired: result.repaired };
}

describe("backgroundVisible manifest field", () => {
  it("is saved only when false and round-trips", () => {
    const doc = createEmptyDocument({ width: 20, height: 30 });
    expect(stringifyDocument(doc)).not.toContain("backgroundVisible");
    doc.backgroundVisible = false;
    const text = stringifyDocument(doc);
    expect(JSON.parse(text).backgroundVisible).toBe(false);
    expect(parsed(text).doc.backgroundVisible).toBe(false);
  });

  it("missing = visible; non-boolean is repaired to visible", () => {
    const base = JSON.parse(stringifyDocument(createEmptyDocument({ width: 20, height: 30 }))) as Record<string, unknown>;
    expect(parsed(JSON.stringify(base)).doc.backgroundVisible).toBeUndefined();
    expect(parsed(JSON.stringify({ ...base, backgroundVisible: true })).repaired).toBe(false);
    for (const bad of ["false", 0, null, {}]) {
      const r = parsed(JSON.stringify({ ...base, backgroundVisible: bad }));
      expect(r.doc.backgroundVisible).toBeUndefined();
      expect(r.repaired).toBe(true);
    }
  });

  it("a hidden background alone counts as content and changes the metadata signature", () => {
    const doc = createEmptyDocument({ width: 20, height: 30 });
    expect(hasDocumentContent(doc)).toBe(false);
    const copy = cloneDocument(doc);
    copy.backgroundVisible = false;
    expect(hasDocumentContent(copy)).toBe(true);
    expect(outputMetadataSignature(copy)).not.toBe(outputMetadataSignature(doc));
  });
});

describe("background solo", () => {
  const p1 = { id: "p1", kind: "paint" as const, visible: true };
  const m1 = { id: "m1", kind: "mask" as const, visible: true };
  const bg = { id: BACKGROUND_SOLO_ID, kind: "paint" as const };

  it("is the paint-group solo: hides paint, masks per solo rules, shows a hidden background", () => {
    const solo = toggleSolo({ paint: "p1", mask: null }, bg);
    expect(solo).toEqual({ paint: BACKGROUND_SOLO_ID, mask: null });
    expect(shownOnStage(p1, solo)).toBe(false);
    expect(shownOnStage(m1, solo)).toBe(false);
    expect(shownOnStage(m1, { ...solo, mask: "m1" })).toBe(true);
    expect(backgroundShown(false, solo)).toBe(true);
    expect(toggleSolo(solo, bg)).toEqual({ paint: null, mask: null });
  });

  it("follows the eye otherwise and survives pruning", () => {
    expect(backgroundShown(false, { paint: null, mask: null })).toBe(false);
    expect(backgroundShown(true, { paint: "p1", mask: null })).toBe(true);
    expect(pruneSolo({ paint: BACKGROUND_SOLO_ID, mask: null }, [p1])).toEqual({ paint: BACKGROUND_SOLO_ID, mask: null });
  });
});
