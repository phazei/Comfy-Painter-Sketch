import { describe, expect, it } from "vitest";

import { createPaintLayer } from "../document/create";
import type { LayerChange } from "../document/layerList";
import type { LayerPixels } from "./editorTypes";
import { changesBytes, LAYERS_ENTRY_BASE_BYTES } from "./layerHistory";
import { LayerRuntimeTable } from "./layerRuntime";

const pixels = (bytes: number): LayerPixels => ({
  x: 0,
  y: 0,
  data: { data: new Uint8ClampedArray(bytes), width: 1, height: bytes / 4 } as unknown as ImageData,
});

describe("changesBytes", () => {
  it("counts kept pixels plus a fixed metadata cost", () => {
    const layer = createPaintLayer("L");
    const changes: LayerChange<LayerPixels>[] = [
      { op: "remove", index: 0, layer, pixels: pixels(400) },
      { op: "insert", index: 0, layer, pixels: null },
      { op: "props", id: layer.id, before: { name: "a" }, after: { name: "b" } },
    ];
    expect(changesBytes(changes)).toBe(LAYERS_ENTRY_BASE_BYTES + 400);
    expect(changesBytes([])).toBe(LAYERS_ENTRY_BASE_BYTES);
  });
});

describe("LayerRuntimeTable remove / reinstate", () => {
  it("drops removed layers from dirty/hasPaint and continues versions on restore", () => {
    const t = new LayerRuntimeTable();
    t.reset("a", false);
    t.touch("a");
    t.touch("a");
    expect(t.get("a")?.version).toBe(2);
    const revision = t.revision("a");
    t.remove("a");
    expect(t.get("a")).toBeUndefined();
    expect(t.dirty).toBe(false);
    expect(t.hasPaint).toBe(false);
    t.reinstate("a", true);
    expect(t.get("a")).toEqual({ dirty: true, version: 3, hasContent: true });
    expect(t.revision("a")).toBeGreaterThan(revision);
    t.reinstate("new", false);
    expect(t.get("new")).toEqual({ dirty: false, version: 1, hasContent: false });
  });
});
