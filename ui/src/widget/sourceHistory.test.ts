/**
 * `layer_source` session history: de-duplicated, capped at 10, newest
 * first; executed-output parsing; and the source lookup (upstream first,
 * then our executed preview) with `app` / `api` mocked.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { LGraphNode, NodeExecutionOutput } from "../types/comfy";
import { layerSourceItem, layerSourceKey, SOURCE_HISTORY_SIZE, SourceHistory } from "./sourceHistory";

const appMock = vi.hoisted(() => ({
  app: {
    nodeOutputs: {} as Record<string, unknown>,
    nodePreviewImages: {} as Record<string, unknown>,
    getRandParam: () => "&rand=1",
  },
}));
vi.mock("@comfy/scripts/app.js", () => appMock);
vi.mock("@comfy/scripts/api.js", () => ({ api: { apiURL: (route: string) => `/api${route}` } }));

const { LayerSourceWatch, resolveLayerSource } = await import("./layerSourceWatch");

const e = (key: string) => ({ key, url: `u:${key}` });

describe("SourceHistory", () => {
  it("keeps newest first and moves a repeat to the top", () => {
    const h = new SourceHistory();
    h.add(e("a"));
    h.add(e("b"));
    h.add(e("c"));
    expect(h.entries.map((x) => x.key)).toEqual(["c", "b", "a"]);
    expect(h.add({ key: "a", url: "new" })).toBe(true);
    expect(h.entries.map((x) => x.key)).toEqual(["a", "c", "b"]);
    expect(h.entries[0]?.url).toBe("new");
  });

  it("ignores the current top again (no change event)", () => {
    const h = new SourceHistory();
    const listener = vi.fn();
    h.onChange(listener);
    h.add(e("a"));
    expect(h.add(e("a"))).toBe(false);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(h.entries.length).toBe(1);
  });

  it("caps at 10, dropping the oldest", () => {
    const h = new SourceHistory();
    for (let k = 1; k <= 12; k++) h.add(e(String(k)));
    expect(SOURCE_HISTORY_SIZE).toBe(10);
    expect(h.entries.map((x) => x.key)).toEqual(["12", "11", "10", "9", "8", "7", "6", "5", "4", "3"]);
  });

  it("reports new / seed / moved changes (only new ones auto-open)", () => {
    const h = new SourceHistory();
    const changes: string[] = [];
    h.onChange((c) => changes.push(c));
    h.add(e("a"), false);
    h.add(e("b"));
    h.add(e("a"));
    expect(changes).toEqual(["seed", "new", "moved"]);
  });

  it("instances are independent (per node, no module state)", () => {
    const a = new SourceHistory();
    const b = new SourceHistory();
    a.add(e("x"));
    expect(b.entries.length).toBe(0);
  });
});

describe("executed output", () => {
  it("reads the first layer_source item, not the background images", () => {
    const output: NodeExecutionOutput = {
      images: [{ filename: "bg.png", subfolder: "", type: "temp" }],
      layer_source: [null, { filename: "src.png", subfolder: "", type: "temp", source_id: "abc" }],
    };
    const item = layerSourceItem(output);
    expect(item?.filename).toBe("src.png");
    expect(item && layerSourceKey(item)).toBe("source:abc");
    expect(layerSourceItem({ images: [{ filename: "bg.png" }] })).toBeNull();
    expect(layerSourceKey({ filename: "x.png", subfolder: "", type: "temp" })).toBe("filename=x.png&subfolder=&type=temp");
  });
});

// ── Source lookup ─────────────────────────────────────────────────────────────

function fakeNode(opts: { linked: boolean; upstream?: LGraphNode | null }): LGraphNode {
  const node = {
    id: 7,
    graph: { id: "root", isRootGraph: true },
    inputs: [
      { name: "image", link: null },
      { name: "layer_source", link: opts.linked ? 3 : null },
    ],
    getInputNode: (slot: number) => (slot === 1 ? (opts.upstream ?? null) : null),
  };
  return node as unknown as LGraphNode;
}

function loadImageNode(value: string): LGraphNode {
  return {
    id: 2,
    graph: { id: "root", isRootGraph: true },
    comfyClass: "LoadImage",
    widgets: [{ name: "image", value }],
    inputs: [],
  } as unknown as LGraphNode;
}

describe("resolveLayerSource", () => {
  beforeEach(() => {
    appMock.app.nodeOutputs = {};
    appMock.app.nodePreviewImages = {};
  });

  it("is null while layer_source is unlinked", () => {
    expect(resolveLayerSource(fakeNode({ linked: false, upstream: loadImageNode("a.png") }), null)).toBeNull();
  });

  it("uses the upstream LoadImage on the layer_source slot before any run", () => {
    const entry = resolveLayerSource(fakeNode({ linked: true, upstream: loadImageNode("pics/a.png [input]") }), null);
    expect(entry?.key).toBe("filename=a.png&subfolder=pics&type=input");
    expect(entry?.url).toContain("/api/view?filename=a.png");
    expect(entry?.name).toBe("a");
  });

  it("falls back to our executed layer_source preview (session, then app.nodeOutputs)", () => {
    const upstream = { id: 4, graph: { id: "root", isRootGraph: true }, inputs: [] } as unknown as LGraphNode;
    const node = fakeNode({ linked: true, upstream });
    const executed = { layer_source: [{ filename: "t.png", subfolder: "", type: "temp", source_id: "s1" }] };
    expect(resolveLayerSource(node, executed)?.key).toBe("source:s1");
    expect(resolveLayerSource(node, executed)?.name).toBeUndefined();
    appMock.app.nodeOutputs["7"] = { images: [{ filename: "bg.png" }], layer_source: [{ filename: "t2.png", type: "temp" }] };
    expect(resolveLayerSource(node, null)?.key).toBe("filename=t2.png&subfolder=&type=temp");
  });
});


describe("LayerSourceWatch", () => {
  it("seeds the first source silently, announces later new ones", () => {
    appMock.app.nodeOutputs = {};
    appMock.app.nodePreviewImages = {};
    const upstream = loadImageNode("a.png");
    const watch = new LayerSourceWatch(fakeNode({ linked: true, upstream }));
    const changes: string[] = [];
    watch.history.onChange((c) => changes.push(c));
    watch.refresh();
    (upstream.widgets?.[0] as { value: unknown }).value = "b.png";
    watch.refresh();
    (upstream.widgets?.[0] as { value: unknown }).value = "a.png";
    watch.refresh();
    expect(changes).toEqual(["seed", "new", "moved"]);
  });

  it("announces the first source after arm() (user linked the input)", () => {
    const watch = new LayerSourceWatch(fakeNode({ linked: true, upstream: loadImageNode("a.png") }));
    const changes: string[] = [];
    watch.history.onChange((c) => changes.push(c));
    watch.arm();
    watch.refresh();
    expect(changes).toEqual(["new"]);
  });
});