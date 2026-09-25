import { describe, expect, it } from "vitest";

import { groupEntries } from "./editorTypes";
import type { HistoryEntry } from "./editorTypes";
import { HistoryStack } from "./history";
import { rasterizeDecision } from "./rasterize";

describe("rasterizeDecision", () => {
  it("edits non-text layers without asking", () => {
    let asked = 0;
    const confirm = (): boolean => (asked++, true);
    expect(rasterizeDecision({ kind: "paint" }, confirm)).toBe("edit");
    expect(rasterizeDecision({ kind: "mask" }, confirm)).toBe("edit");
    expect(asked).toBe(0);
  });

  it("asks for text layers: OK rasterizes, Cancel aborts", () => {
    expect(rasterizeDecision({ kind: "text" }, () => true)).toBe("rasterize");
    expect(rasterizeDecision({ kind: "text" }, () => false)).toBe("cancel");
  });
});

describe("rasterize + edit = one undo step", () => {
  const text = (layerId: string): HistoryEntry => ({
    kind: "text",
    layerId,
    before: { kind: "text", name: "T" },
    after: { kind: "paint", name: "T" },
    bytes: 1,
  });
  const patch = (layerId: string): HistoryEntry => {
    const data = { width: 1, height: 1, data: new Uint8ClampedArray(4) } as unknown as ImageData;
    return { kind: "patch", layerId, x: 0, y: 0, before: data, after: data, bytes: 8 };
  };
  const layerOf = (e: HistoryEntry): string | null => ("layerId" in e ? e.layerId : null);

  it("joins the next edit of the same layer into the rasterize entry", () => {
    const h = new HistoryStack<HistoryEntry>(1e6, groupEntries);
    h.push(text("a"));
    h.joinNext((e) => layerOf(e) === "a");
    h.push(patch("a"));
    expect(h.undoDepth).toBe(1);
    const step = h.undo();
    expect(step?.kind).toBe("group");
    expect(step?.kind === "group" && step.entries.map((e) => e.kind)).toEqual(["text", "patch"]);
    expect(h.totalBytes).toBe(9);
  });

  it("does not join an edit of another layer (and drops the request)", () => {
    const h = new HistoryStack<HistoryEntry>(1e6, groupEntries);
    h.push(text("a"));
    h.joinNext((e) => layerOf(e) === "a");
    h.push(patch("b"));
    h.push(patch("a"));
    expect(h.undoDepth).toBe(3);
  });
});
