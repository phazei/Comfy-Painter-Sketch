import { describe, expect, it } from "vitest";

import { HistoryStack } from "./history";

const entry = (name: string, bytes: number) => ({ name, bytes });

describe("HistoryStack", () => {
  it("undoes and redoes in LIFO order", () => {
    const h = new HistoryStack<ReturnType<typeof entry>>(1000);
    h.push(entry("a", 1));
    h.push(entry("b", 1));
    expect(h.undo()?.name).toBe("b");
    expect(h.undo()?.name).toBe("a");
    expect(h.undo()).toBeNull();
    expect(h.redo()?.name).toBe("a");
    expect(h.canUndo && h.canRedo).toBe(true);
  });

  it("clears redo on push and releases its bytes", () => {
    const h = new HistoryStack<ReturnType<typeof entry>>(1000);
    h.push(entry("a", 10));
    h.push(entry("b", 20));
    h.undo();
    expect(h.totalBytes).toBe(30);
    h.push(entry("c", 5));
    expect(h.canRedo).toBe(false);
    expect(h.totalBytes).toBe(15);
  });

  it("evicts oldest entries beyond the cap but keeps the newest", () => {
    const h = new HistoryStack<ReturnType<typeof entry>>(100);
    h.push(entry("a", 60));
    const evicted = h.push(entry("b", 60));
    expect(evicted.map((e) => e.name)).toEqual(["a"]);
    expect(h.undoDepth).toBe(1);
    expect(h.push(entry("huge", 500)).map((e) => e.name)).toEqual(["b"]);
    expect(h.undoDepth).toBe(1);
    expect(h.totalBytes).toBe(500);
  });

  it("offers the newest entry for merging only while nothing is redoable", () => {
    const h = new HistoryStack<ReturnType<typeof entry>>(1000);
    expect(h.mergeTarget()).toBeUndefined();
    h.push(entry("a", 1));
    h.push(entry("b", 1));
    expect(h.mergeTarget()?.name).toBe("b");
    h.undo();
    expect(h.mergeTarget()).toBeUndefined();
    h.redo();
    expect(h.mergeTarget()?.name).toBe("b");
  });

  it("counts redo entries toward the cap", () => {
    const h = new HistoryStack<ReturnType<typeof entry>>(100);
    h.push(entry("a", 40));
    h.push(entry("b", 40));
    h.undo();
    expect(h.totalBytes).toBe(80);
    h.clear();
    expect(h.totalBytes).toBe(0);
    expect(h.canUndo || h.canRedo).toBe(false);
  });
});
