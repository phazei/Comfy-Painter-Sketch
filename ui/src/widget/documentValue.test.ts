import { describe, expect, it } from "vitest";

import { normalizeDocumentValue, serializeDocumentValue } from "./documentValue";

describe("normalizeDocumentValue", () => {
  it("keeps strings verbatim, including empty", () => {
    expect(normalizeDocumentValue('{"version":1}')).toBe('{"version":1}');
    expect(normalizeDocumentValue("")).toBe("");
  });

  it("stringifies objects and maps nullish to empty", () => {
    expect(normalizeDocumentValue({ version: 1 })).toBe('{"version":1}');
    expect(normalizeDocumentValue(null)).toBe("");
    expect(normalizeDocumentValue(undefined)).toBe("");
  });

  it("does not throw on circular objects", () => {
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    expect(normalizeDocumentValue(circular)).toBe("");
  });
});

describe("serializeDocumentValue", () => {
  it("round-trips the stored string in M0", async () => {
    await expect(serializeDocumentValue('{"a":1}')).resolves.toBe('{"a":1}');
  });
});
