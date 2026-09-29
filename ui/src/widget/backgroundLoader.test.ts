/**
 * Background source rule end to end through {@link BackgroundLoader}
 * (`backgroundRule.ts`): the user repro (empty Preview Image after a
 * LoadImage must stay blank), executed previews bound to the upstream link,
 * and the status that drives the Image Mask row. The graph, `Image` and
 * `app`/`api` are faked.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { IBaseWidget, INodeInputSlot, LGraph, LGraphNode, LLinkInfo, NodeExecutionOutput } from "../types/comfy";
import { BackgroundLoader } from "./backgroundLoader";

const appMock = vi.hoisted(() => ({
  app: {
    nodeOutputs: {} as Record<string, unknown>,
    nodePreviewImages: {} as Record<string, unknown>,
    getRandParam: () => "&rand=1",
  },
}));
vi.mock("@comfy/scripts/app.js", () => appMock);
vi.mock("@comfy/scripts/api.js", () => ({ api: { apiURL: (route: string) => route } }));

// ── Fakes ─────────────────────────────────────────────────────────────────────

/** Loads succeed in a microtask unless the URL contains `broken`. */
class FakeImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  decoding = "";
  naturalWidth = 0;
  naturalHeight = 0;
  set src(url: string) {
    queueMicrotask(() => {
      if (url.includes("broken")) {
        this.onerror?.();
        return;
      }
      this.naturalWidth = 64;
      this.naturalHeight = 32;
      this.onload?.();
    });
  }
}

beforeAll(() => {
  (globalThis as Record<string, unknown>)["Image"] = FakeImage;
});
afterAll(() => {
  delete (globalThis as Record<string, unknown>)["Image"];
});
beforeEach(() => {
  appMock.app.nodeOutputs = {};
  appMock.app.nodePreviewImages = {};
});

const graph: LGraph = { id: "root", isRootGraph: true };

function fakeNode(id: string, comfyClass: string, widgets: IBaseWidget[] = [], inputs: INodeInputSlot[] = []): LGraphNode {
  return { id, comfyClass, graph, inputs, widgets, size: [0, 0], constructor: {} } as unknown as LGraphNode;
}

/** Our node with an `image` input that can be (re)linked. */
function ourNode(): { node: LGraphNode; connect: (upstream: LGraphNode | null, originSlot?: number) => void } {
  const node = fakeNode("1", "PainterSketch", [], [{ name: "image", type: "IMAGE", link: null }]);
  let upstream: LGraphNode | null = null;
  let link: LLinkInfo | null = null;
  let nextLink = 1;
  node.getInputNode = () => upstream;
  node.getInputLink = () => link;
  return {
    node,
    connect: (next, originSlot = 0) => {
      upstream = next;
      link = next ? { origin_id: next.id, origin_slot: originSlot } : null;
      (node.inputs[0] as INodeInputSlot).link = next ? nextLink++ : null;
    },
  };
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function executed(filename: string): NodeExecutionOutput {
  return { images: [{ filename, subfolder: "", type: "temp" }] } as NodeExecutionOutput;
}

/** A node refresh as the controller does it (after startup). */
async function refresh(loader: BackgroundLoader, node: LGraphNode): Promise<void> {
  loader.refresh(node.inputs[0]?.link != null);
  await flush();
  loader.refresh(node.inputs[0]?.link != null);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("BackgroundLoader source rule", () => {
  it("user repro: an empty Preview Image never shows the previous LoadImage's image", async () => {
    const { node, connect } = ourNode();
    const loader = new BackgroundLoader(node, () => undefined);
    const preview = fakeNode("3", "PreviewImage", [], [{ name: "images", type: "IMAGE", link: null }]);
    const loadImage = fakeNode("2", "LoadImage", [{ name: "image", value: "cat.png" } as IBaseWidget]);

    connect(preview);
    await refresh(loader, node);
    expect(loader.background).toBeNull();
    expect(loader.status.kind).toBe("none");

    connect(null);
    await refresh(loader, node);
    connect(loadImage);
    await refresh(loader, node);
    expect(loader.background?.key).toBe("filename=cat.png&subfolder=&type=input");

    connect(null);
    await refresh(loader, node);
    expect(loader.status.kind).toBe("none");

    connect(preview);
    await refresh(loader, node);
    expect(loader.background).toBeNull();
    expect(loader.status.kind).toBe("none");
    expect(loader.awaitingImage).toBe(false);

    // Reconnecting the same LoadImage shows its image again (cached, no reload wait).
    connect(loadImage);
    loader.refresh(true);
    expect(loader.background?.key).toBe("filename=cat.png&subfolder=&type=input");
  });

  it("uses our executed preview only with the link it was made with; a link change drops it", async () => {
    const { node, connect } = ourNode();
    const loader = new BackgroundLoader(node, () => undefined);
    const decode = fakeNode("4", "VAEDecode");
    const other = fakeNode("5", "VAEDecode");
    connect(decode);
    loader.setExecuted(executed("run1.png"));
    appMock.app.nodeOutputs["1"] = executed("run1.png");
    await refresh(loader, node);
    expect(loader.background?.origin).toBe("executed");

    // Disconnect + reconnect the same node/slot keeps it.
    connect(null);
    await refresh(loader, node);
    connect(decode);
    await refresh(loader, node);
    expect(loader.background?.origin).toBe("executed");

    // Same node, other output slot: dropped (also the app.nodeOutputs fallback).
    connect(decode, 1);
    await refresh(loader, node);
    expect(loader.background).toBeNull();
    expect(loader.lastExecuted).toBeNull();
    connect(decode);
    await refresh(loader, node);
    expect(loader.background).toBeNull();

    // A new run with another node binds to that node.
    connect(other);
    loader.setExecuted(executed("run2.png"));
    await refresh(loader, node);
    expect(loader.background?.key).toBe("filename=run2.png&subfolder=&type=temp");
  });

  it("an executed preview of unknown provenance (never seen by onExecuted) is not used", async () => {
    const { node, connect } = ourNode();
    const loader = new BackgroundLoader(node, () => undefined);
    appMock.app.nodeOutputs["1"] = executed("elsewhere.png");
    connect(fakeNode("4", "VAEDecode"));
    await refresh(loader, node);
    expect(loader.background).toBeNull();
  });

  it("a handed-off background stays marked until the source is lost after startup", async () => {
    const { node, connect } = ourNode();
    const loader = new BackgroundLoader(node, () => undefined);
    const loadImage = fakeNode("2", "LoadImage", [{ name: "image", value: "cat.png" } as IBaseWidget]);
    connect(loadImage);
    await refresh(loader, node);
    const bg = loader.background;
    if (!bg) throw new Error("expected a background");

    const successor = new BackgroundLoader(node, () => undefined);
    successor.adopt(bg, null);
    successor.refresh(true, false);
    successor.refresh(true);
    expect(successor.background).toBe(bg);
    expect(successor.isHandedOff(bg)).toBe(true);

    connect(null);
    successor.refresh(false);
    connect(loadImage);
    successor.refresh(true);
    expect(successor.background).toBe(bg);
    expect(successor.isHandedOff(bg)).toBe(false);
  });

  it("status: unresolved before startup settles, loading, failed load = none", async () => {
    const { node, connect } = ourNode();
    const loader = new BackgroundLoader(node, () => undefined);
    const preview = fakeNode("3", "PreviewImage");
    connect(preview);
    loader.refresh(true, false);
    expect(loader.status.kind).toBe("unresolved");
    expect(loader.awaitingImage).toBe(true);

    const broken = fakeNode("6", "LoadImage", [{ name: "image", value: "broken.png" } as IBaseWidget]);
    connect(broken);
    loader.refresh(true);
    expect(loader.status).toMatchObject({ kind: "loading", key: "filename=broken.png&subfolder=&type=input" });
    const spy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await flush();
    spy.mockRestore();
    loader.refresh(true);
    expect(loader.status.kind).toBe("none");
    expect(loader.background).toBeNull();
  });
});
