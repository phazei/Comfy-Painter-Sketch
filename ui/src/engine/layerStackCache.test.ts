import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FakeCanvas, FakeContext, installCanvasFakes, removeCanvasFakes } from "./fakeCanvas.testutil";
import { LayerStackCache, sourceId } from "./layerStackCache";
import type { StackItem } from "./layerStackCache";

const SIZE = { width: 4, height: 4 };

function item(source: FakeCanvas, key: string | null, opacity = 1): StackItem {
  return { layer: { source: source as unknown as HTMLCanvasElement, opacity }, key };
}

describe("LayerStackCache", () => {
  beforeEach(() => installCanvasFakes());
  afterEach(() => {
    removeCanvasFakes();
    vi.restoreAllMocks();
  });

  it("flattens runs of two or more cacheable layers; live and lone layers pass through in order", () => {
    const [a, b, live, c, d, lone] = [1, 2, 3, 4, 5, 6].map(() => new FakeCanvas());
    const cache = new LayerStackCache();
    const out = cache.flatten(
      [item(a!, "a"), item(b!, "b"), item(live!, null), item(c!, "c"), item(d!, "d", 0.5), item(lone!, null)],
      SIZE,
    );
    expect(out).toHaveLength(4);
    expect(out[1]?.source).toBe(live);
    expect(out[3]?.source).toBe(lone);
    expect(out[0]?.source).not.toBe(a);
    expect(out[0]?.opacity).toBe(1);
    expect(out[2]?.source).not.toBe(out[0]?.source);
    // A lone cacheable layer between live ones is not copied.
    const single = cache.flatten([item(live!, null), item(a!, "a"), item(lone!, null)], SIZE);
    expect(single.map((l) => l.source)).toEqual([live, a, lone]);
  });

  it("redraws a run only when a member's key changes", () => {
    const draws = vi.spyOn(FakeContext.prototype, "drawImage");
    const [a, b] = [new FakeCanvas(), new FakeCanvas()];
    const cache = new LayerStackCache();
    const first = cache.flatten([item(a, "a1"), item(b, "b1")], SIZE)[0]?.source;
    expect(draws).toHaveBeenCalledTimes(2);
    expect(cache.flatten([item(a, "a1"), item(b, "b1")], SIZE)[0]?.source).toBe(first);
    expect(draws).toHaveBeenCalledTimes(2);
    expect(cache.flatten([item(a, "a2"), item(b, "b1")], SIZE)[0]?.source).toBe(first);
    expect(draws).toHaveBeenCalledTimes(4);
  });

  it("gives each object one stable source id", () => {
    const a = new FakeCanvas() as unknown as HTMLCanvasElement;
    const b = new FakeCanvas() as unknown as HTMLCanvasElement;
    expect(sourceId(a)).toBe(sourceId(a));
    expect(sourceId(a)).not.toBe(sourceId(b));
  });
});
