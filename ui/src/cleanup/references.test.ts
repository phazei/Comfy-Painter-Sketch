import { describe, expect, it } from "vitest";

import pythonCleanup from "../../../nodes/cleanup.py?raw";
import { confirmText, extractReferences, formatBytes, isCleanupResponse, isStatsResponse, REFERENCE_SOURCE } from "./references";

const A = "ps-abcd1234-0123456789abcd.webp";
const B = "ps-abcd1234-00000000000001.png";
const C = "ps-zz99-ff.webp";

const STAT = { all: { count: 5, bytes: 1024 }, old: { count: 3, bytes: 512 } };

describe("REFERENCE_SOURCE", () => {
  it("equals the server's REFERENCE_RE", () => {
    const match = /REFERENCE_RE = re\.compile\(\s*r"([^"]+)"/.exec(pythonCleanup);
    expect(match?.[1]).toBe(REFERENCE_SOURCE);
  });
});

describe("extractReferences", () => {
  it("finds names in double-encoded manifests", () => {
    const manifest = JSON.stringify({ layers: [{ file: `painter-sketch/${A} [input]` }] });
    const workflow = JSON.stringify({ nodes: [{ widgets_values: [manifest] }] });
    expect([...extractReferences(workflow)]).toEqual([A]);
  });

  it("accepts escaped / encoded separators and any case", () => {
    const text = `painter-sketch\\/${A} painter-sketch\\\\${B} PAINTER-SKETCH%2F${C.toUpperCase()}`;
    expect([...extractReferences(text)].sort()).toEqual([A, B, C].sort());
  });

  it("ignores names without the subfolder or with other extensions", () => {
    expect(extractReferences(`${A} other/${B} painter-sketch/ps-x-y.webp painter-sketch/ps-a-1.jpg`).size).toBe(0);
  });
});

describe("texts", () => {
  it("formats sizes", () => {
    expect(formatBytes(820)).toBe("820 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });

  it("confirmText returns null when count is 0", () => {
    expect(confirmText({ count: 0, bytes: 0, ...STAT })).toBeNull();
  });

  it("confirmText describes deletable files with old-file context", () => {
    const text = confirmText({ count: 2, bytes: 2048, all: { count: 5, bytes: 5000 }, old: { count: 3, bytes: 3000 } });
    expect(text).toMatch(/^2 of the 3 files older than 24 h \(2\.0 KB\) are unused/);
    expect(text).toContain("This affects all workflows.");
  });

  it("confirmText appends scan warning when errors present", () => {
    const text = confirmText({ count: 3, bytes: 0, ...STAT, errors: ["x"] });
    expect(text).toContain("Warning: 1 file in the workflows folders");
  });
});

describe("isStatsResponse", () => {
  it("narrows stats responses", () => {
    expect(isStatsResponse({ all: { count: 1, bytes: 2 }, old: { count: 0, bytes: 0 } })).toBe(true);
    expect(isStatsResponse({ all: { count: "1", bytes: 2 }, old: { count: 0, bytes: 0 } })).toBe(false);
    expect(isStatsResponse({ all: { count: 1, bytes: 2 } })).toBe(false);
    expect(isStatsResponse(null)).toBe(false);
  });
});

describe("isCleanupResponse", () => {
  it("narrows server responses", () => {
    expect(isCleanupResponse({ count: 1, bytes: 2, deleted: ["a"], ...STAT })).toBe(true);
    expect(isCleanupResponse({ count: "1", bytes: 2, ...STAT })).toBe(false);
    expect(isCleanupResponse({ count: 1, bytes: 2, errors: [3], ...STAT })).toBe(false);
    expect(isCleanupResponse({ count: 1, bytes: 2 })).toBe(false);
    expect(isCleanupResponse(null)).toBe(false);
  });
});
