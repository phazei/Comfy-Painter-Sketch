/** Option normalization and metadata-only persistence decisions. */
import { describe, expect, it } from "vitest";
import { hasDocumentContent, hasOutputMetadata, outputMetadataSignature } from "./content";
import { createEmptyDocument } from "./create";
import { MAX_BORDER_SIZE, cloneOutputOptions, isDefaultOutputOptions, outputOptionsEqual, readOutputOptions } from "./outputOptions";
import { parseDocument } from "./parse";
import { createRegion } from "./regions";
import { cloneDocument } from "./serialize";

describe("output options", () => {
  it("defaults missing/malformed records and validates each field independently", () => {
    for (const value of [undefined, null, [], false, "crop", { applyMask: "invalid", fillColor: "red", cropPadding: Infinity }]) {
      expect(readOutputOptions(value)).toEqual({
        applyMask: "none", fillColor: "#000000", cropPadding: 0,
        borderSize: 64, borderColor: "#ffffff", borderMask: true,
      });
    }
    expect(readOutputOptions({ applyMask: "fill", fillColor: "#Ab12Cd", cropPadding: 3.9 }))
      .toMatchObject({ applyMask: "fill", fillColor: "#ab12cd", cropPadding: 3 });
    expect(readOutputOptions({ applyMask: "crop", cropPadding: -4 }).cropPadding).toBe(0);
    expect(readOutputOptions({ cropPadding: "5" }).cropPadding).toBe(0);
  });

  it("parses border fields with defaults, clamping and validation", () => {
    expect(readOutputOptions({ applyMask: "border", borderSize: 12.7, borderColor: "#00FF80", borderMask: false }))
      .toMatchObject({ applyMask: "border", borderSize: 12, borderColor: "#00ff80", borderMask: false });
    expect(readOutputOptions({ applyMask: "border" }))
      .toMatchObject({ borderSize: 64, borderColor: "#ffffff", borderMask: true });
    expect(readOutputOptions({ borderSize: 0 }).borderSize).toBe(1);
    expect(readOutputOptions({ borderSize: 1e9 }).borderSize).toBe(MAX_BORDER_SIZE);
    expect(MAX_BORDER_SIZE).toBe(4096);
    expect(readOutputOptions({ borderSize: "8", borderColor: "white", borderMask: 1 }))
      .toMatchObject({ borderSize: 64, borderColor: "#ffffff", borderMask: true });
    const legacy = { applyMask: "crop", fillColor: "#000000", cropPadding: 2 } as never;
    expect(cloneOutputOptions(legacy)).toEqual(readOutputOptions(legacy));
    expect(isDefaultOutputOptions({ applyMask: "none", fillColor: "#000000", cropPadding: 0 } as never)).toBe(true);
    expect(outputOptionsEqual(cloneOutputOptions(), { ...cloneOutputOptions(), borderMask: false })).toBe(false);
    expect(isDefaultOutputOptions({ ...cloneOutputOptions(), borderSize: 8 })).toBe(false);
  });

  it("copies defaults independently and counts inactive colour/padding edits", () => {
    const first = cloneOutputOptions();
    first.fillColor = "#ffffff";
    expect(cloneOutputOptions().fillColor).toBe("#000000");
    expect(isDefaultOutputOptions(first)).toBe(false);
    expect(isDefaultOutputOptions({ ...cloneOutputOptions(), cropPadding: 1 })).toBe(false);
    expect(isDefaultOutputOptions()).toBe(true);
  });

  it("accepts pre-M9 documents with no regions/Main processing", () => {
    const doc = createEmptyDocument({ width: 20, height: 30 });
    const { regions: _regions, ...legacy } = doc;
    const parsed = parseDocument(legacy);
    expect(parsed).toEqual({ status: "ok", repaired: false, document: doc });
    expect(hasDocumentContent(doc)).toBe(false);
    expect(hasDocumentContent(doc, true)).toBe(true);
  });

  it("preserves region-only, options-only and missing-file work", () => {
    const doc = createEmptyDocument({ width: 20, height: 30 });
    expect(hasOutputMetadata(doc)).toBe(false);
    doc.regions.push(createRegion("one", 1, { x: 0, y: 0, width: 10, height: 20 }));
    expect(hasDocumentContent(doc)).toBe(true);
    doc.regions = [];
    doc.mainOutput = cloneOutputOptions();
    expect(hasDocumentContent(doc)).toBe(true);
    doc.mainOutput = { ...cloneOutputOptions(), applyMask: "crop" };
    expect(hasDocumentContent(doc)).toBe(true);
    delete doc.mainOutput;
    doc.layers[0]!.file = "painter-sketch/missing.png [input]";
    expect(hasDocumentContent(doc)).toBe(true);
  });

  it("signature covers nested metadata but ignores irrelevant paint/preview details", () => {
    const doc = createEmptyDocument({ width: 20, height: 30 });
    doc.regions.push(createRegion("one", 1, { x: 0, y: 0, width: 10, height: 20 }));
    const copy = cloneDocument(doc);
    copy.frame = { width: 2000, height: 1 };
    copy.mainOutput = cloneOutputOptions();
    copy.layers[0]!.file = "new.png [input]";
    expect(outputMetadataSignature(copy)).toBe(outputMetadataSignature(doc));
    copy.regions[0]!.visible = false;
    expect(outputMetadataSignature(copy)).not.toBe(outputMetadataSignature(doc));
  });
});
