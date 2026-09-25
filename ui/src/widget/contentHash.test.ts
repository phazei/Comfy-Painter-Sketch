import { describe, expect, it } from "vitest";

import { contentHash, layerFileName } from "./contentHash";

describe("contentHash", () => {
  it("is deterministic, 14 hex chars, and content-sensitive", () => {
    const a = contentHash(new Uint8Array([1, 2, 3]));
    expect(a).toMatch(/^[0-9a-f]{14}$/);
    expect(contentHash(new Uint8Array([1, 2, 3]))).toBe(a);
    expect(contentHash(new Uint8Array([1, 2, 4]))).not.toBe(a);
    expect(contentHash(new Uint8Array([]))).toMatch(/^[0-9a-f]{14}$/);
  });
});

describe("layerFileName", () => {
  it("prefixes with a sanitized doc id", () => {
    expect(layerFileName("abcdefghijk", "00ff", "png")).toBe("ps-abcdefgh-00ff.png");
    expect(layerFileName("../..", "00ff", "png")).toBe("ps-doc-00ff.png");
  });

  it("uses the extension of the actual format", () => {
    expect(layerFileName("abc", "00ff", "webp")).toBe("ps-abc-00ff.webp");
  });
});
