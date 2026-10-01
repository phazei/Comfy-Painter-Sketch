/** `PainterSketch Regions` helper: label resolution (pure) and the updater (mock nodes). */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmptyDocument } from "../document/create";
import { createRegion } from "../document/regions";
import { stringifyDocument } from "../document/serialize";
import type { LGraph, LGraphNode, LGraphNodeConstructor } from "../types/comfy";
import { emitDocumentChange } from "./documentEvents";
import { regionOutputLabels, regionSlotLabels } from "./regionLabels";
import { installRegionsNodeHooks, readRegionSource, refreshRegionsNodes, updateRegionsNode } from "./regionsNode";

// ── Fixtures ──────────────────────────────────────────────────────────────────

/** Mockable subset of a node (the full interface has a typed constructor). */
type NodeMock = Partial<Omit<LGraphNode, "constructor">>;

const graph: LGraph = { id: "root" };
const rect = { x: 0, y: 0, width: 4, height: 4 };

function manifest(names: Record<number, string>): string {
  const doc = createEmptyDocument({ width: 8, height: 8 });
  doc.regions = Object.entries(names).map(([slot, name]) => ({ ...createRegion(`r${slot}`, Number(slot), rect), name }));
  return stringifyDocument(doc);
}

function sourceNode(value: string, type = "PainterSketch"): LGraphNode {
  const node: NodeMock = {
    id: "1",
    type,
    graph,
    inputs: [],
    widgets: [{ name: "document", type: "paintersketch", value, options: {} }],
  };
  return node as unknown as LGraphNode;
}

function helperNode(source: LGraphNode | null): LGraphNode {
  const outputs = Array.from({ length: 12 }, (_, i) => ({ name: `${i % 2 ? "MASK" : "IMAGE"} ${(i >> 1) + 1}`, type: "IMAGE" }));
  const node: NodeMock = {
    id: "2",
    type: "PainterSketchRegions",
    graph,
    inputs: [{ name: "regions", type: "PS_REGIONS", link: source ? 1 : null }],
    outputs,
    getInputNode: () => source,
    setDirtyCanvas: vi.fn(),
  };
  return node as unknown as LGraphNode;
}

function labels(node: LGraphNode): (string | undefined)[] {
  return (node.outputs ?? []).map((o) => o.label);
}

// ── Pure labels ───────────────────────────────────────────────────────────────

describe("regionOutputLabels", () => {
  it("filled, empty and unresolvable slots", () => {
    const source = [{ slot: 2, name: "face" }, { slot: 5, name: " " }];
    expect(regionSlotLabels(2, source)).toEqual(["face", "face mask"]);
    expect(regionSlotLabels(5, source)).toEqual(["Region 5", "Region 5 mask"]);
    expect(regionSlotLabels(1, source)).toEqual(["Region 1 (missing)", "Region 1 mask (missing)"]);
    expect(regionSlotLabels(3, null)).toEqual(["Region 3", "Region 3 mask"]);
    expect(regionOutputLabels(null)).toHaveLength(12);
  });
});

describe("readRegionSource", () => {
  it("reads the linked PainterSketch document", () => {
    expect(readRegionSource(helperNode(sourceNode(manifest({ 3: "hand" }))))).toMatchObject([{ slot: 3, name: "hand" }]);
    expect(readRegionSource(helperNode(sourceNode("")))).toEqual([]);
  });

  it("is null for no link, other nodes, bad documents and detached helpers", () => {
    expect(readRegionSource(helperNode(null))).toBeNull();
    expect(readRegionSource(helperNode(sourceNode(manifest({}), "Reroute")))).toBeNull();
    expect(readRegionSource(helperNode(sourceNode("{nope")))).toBeNull();
    const detached = helperNode(sourceNode(""));
    detached.graph = null;
    expect(readRegionSource(detached)).toBeNull();
  });
});

// ── Updater ───────────────────────────────────────────────────────────────────

describe("updateRegionsNode", () => {
  it("sets labels, re-splices outputs once, never changes the socket count", () => {
    const helper = helperNode(sourceNode(manifest({ 1: "face" })));
    const outputs = helper.outputs!;
    const splice = vi.spyOn(outputs, "splice");
    expect(updateRegionsNode(helper)).toBe(true);
    expect(labels(helper).slice(0, 4)).toEqual(["face", "face mask", "Region 2 (missing)", "Region 2 mask (missing)"]);
    expect(helper.outputs).toBe(outputs);
    expect(outputs).toHaveLength(12);
    expect(splice).toHaveBeenCalledTimes(1);
    expect(updateRegionsNode(helper)).toBe(false);
    expect(splice).toHaveBeenCalledTimes(1);
  });
});

describe("installRegionsNodeHooks", () => {
  const helpers: LGraphNode[] = [];
  afterEach(() => {
    for (const helper of helpers) helper.onRemoved?.call(helper);
    helpers.length = 0;
  });

  function installed(source: LGraphNode): LGraphNode {
    const originalAdded = vi.fn();
    const proto: NodeMock = { onAdded: originalAdded };
    const nodeType: LGraphNodeConstructor = { prototype: proto as unknown as LGraphNode };
    installRegionsNodeHooks(nodeType);
    const helper = Object.assign(Object.create(nodeType.prototype) as LGraphNode, helperNode(source));
    helper.onAdded?.call(helper, graph);
    expect(originalAdded).toHaveBeenCalledOnce();
    helpers.push(helper);
    return helper;
  }

  it("labels on add, follows source document events and connection changes", () => {
    const source = sourceNode(manifest({ 1: "face" }));
    const helper = installed(source);
    expect(labels(helper)[0]).toBe("face");
    source.widgets![0]!.value = manifest({ 1: "hand" });
    emitDocumentChange(source);
    expect(labels(helper)[0]).toBe("hand");
    helper.getInputNode = () => null;
    helper.onConnectionsChange?.call(helper, 1, 0, false, null, null);
    expect(labels(helper)[0]).toBe("Region 1");
  });

  it("refreshRegionsNodes relabels live helpers; removed helpers are forgotten", () => {
    const source = sourceNode("");
    const helper = installed(source);
    source.widgets![0]!.value = manifest({ 6: "bg" });
    refreshRegionsNodes();
    expect(labels(helper)[10]).toBe("bg");
    helper.onRemoved?.call(helper);
    source.widgets![0]!.value = manifest({ 6: "sky" });
    refreshRegionsNodes();
    expect(labels(helper)[10]).toBe("bg");
  });
});
