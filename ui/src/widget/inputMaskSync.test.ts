/**
 * M13b widget side (`inputMaskSync.ts`) with a real editor: the row is named
 * "Input Mask" while `mask` is connected; live `channel=a` read from any
 * MASK output of a node showing a `/view` file (LoadImageMask only on
 * alpha); a node without one waits for a run;
 * our executed preview replaces the live read; nothing is uploaded; a
 * disconnect gives the row back to the image-alpha sync, which reads the
 * image's alpha again. Graph, `app` / `api`, `fetch` and bitmaps are faked.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createEmptyDocument } from "../document/create";
import { IMAGE_MASK_NAME, INPUT_MASK_NAME } from "../document/imageMask";
import type { Editor as EditorClass } from "../engine/editor";
import { FakeCanvas, installCanvasFakes, removeCanvasFakes } from "../engine/fakeCanvas.testutil";
import type { IBaseWidget, INodeInputSlot, INodeOutputSlot, LGraph, LGraphNode, LLinkInfo, NodeExecutionOutput } from "../types/comfy";
import type { BackgroundStatus } from "./backgroundRule";
import type { LoadedBackground } from "./handoff";
import { imageMaskReady, syncImageMask } from "./imageMaskSync";
import { InputMaskWatch } from "./inputMaskSync";
import type { EditorSession } from "./sessions";
import { withAlphaChannel } from "./viewUrl";

const appMock = vi.hoisted(() => ({
  app: { nodeOutputs: {} as Record<string, unknown>, nodePreviewImages: {} as Record<string, unknown>, getRandParam: () => "&rand=1" },
}));
vi.mock("@comfy/scripts/app.js", () => appMock);
vi.mock("@comfy/scripts/api.js", () => ({ api: { apiURL: (route: string) => route } }));

const SIZE = { width: 2, height: 1 };
/** RGBA per URL fragment: `channel=a` reads alpha, previews are gray. */
const pixels = (url: string): number[] => (url.includes("channel=a") ? [0, 0, 0, 0, 0, 0, 0, 255] : [100, 100, 100, 255, 7, 7, 7, 255]);
const fetchMock = vi.fn(async (url: string) => ({ ok: true, status: 200, statusText: "", blob: async () => ({ url }) }));

let Editor: typeof EditorClass;

beforeAll(async () => {
  installCanvasFakes();
  const g = globalThis as Record<string, unknown>;
  g["fetch"] = fetchMock;
  g["createImageBitmap"] = async (blob: { url: string }) => {
    const bitmap = Object.assign(new FakeCanvas(), { close: () => undefined });
    bitmap.width = SIZE.width;
    bitmap.height = SIZE.height;
    bitmap.px.set(pixels(blob.url));
    return bitmap;
  };
  ({ Editor } = await import("../engine/editor"));
});

afterAll(() => {
  removeCanvasFakes();
  const g = globalThis as Record<string, unknown>;
  delete g["fetch"];
  delete g["createImageBitmap"];
});

beforeEach(() => {
  fetchMock.mockClear();
  appMock.app.nodeOutputs = {};
});

// ── Fakes ─────────────────────────────────────────────────────────────────────

const graph: LGraph = { id: "root", isRootGraph: true };

function loadImage(id: string, file = "a.png"): LGraphNode {
  const widgets = [{ name: "image", value: file }] as IBaseWidget[];
  const outputs: INodeOutputSlot[] = [{ name: "IMAGE", type: "IMAGE" }, { name: "MASK", type: "MASK" }];
  return { id, comfyClass: "LoadImage", graph, inputs: [], outputs, widgets, size: [0, 0], constructor: {} } as unknown as LGraphNode;
}

/** Core "Load Image (as Mask)": one MASK output, `channel` widget. */
function loadImageMask(id: string, channel: string): LGraphNode {
  const widgets = [{ name: "image", value: "m.png" }, { name: "channel", value: channel }] as IBaseWidget[];
  const outputs: INodeOutputSlot[] = [{ name: "MASK", type: "MASK" }];
  return { id, comfyClass: "LoadImageMask", graph, inputs: [], outputs, widgets, size: [0, 0], constructor: {} } as unknown as LGraphNode;
}

/** A node with a MASK output that shows no `/view` file (no widget file, no previews). */
function maskNode(id: string): LGraphNode {
  const outputs: INodeOutputSlot[] = [{ name: "MASK", type: "MASK" }];
  return { id, comfyClass: "SolidMask", graph, inputs: [], outputs, widgets: [], size: [0, 0], constructor: {} } as unknown as LGraphNode;
}

/** Our node with image / mask / layer_source inputs; `link(slot, node, originSlot)` (re)links one. */
function ourNode(): { node: LGraphNode; link: (slot: number, upstream: LGraphNode | null, originSlot?: number) => void } {
  const inputs: INodeInputSlot[] = ["image", "mask", "layer_source"].map((name) => ({ name, type: "*", link: null }));
  const node = { id: "1", comfyClass: "PainterSketch", graph, inputs, widgets: [], size: [0, 0], constructor: {} } as unknown as LGraphNode;
  const ups: (LGraphNode | null)[] = [null, null, null];
  const links: (LLinkInfo | null)[] = [null, null, null];
  let next = 1;
  node.getInputNode = (slot) => ups[slot] ?? null;
  node.getInputLink = (slot) => links[slot] ?? null;
  return {
    node,
    link: (slot, upstream, originSlot = 0) => {
      ups[slot] = upstream;
      links[slot] = upstream ? { origin_id: upstream.id, origin_slot: originSlot } : null;
      (inputs[slot] as INodeInputSlot).link = upstream ? next++ : null;
    },
  };
}

function session(): EditorSession {
  return { alive: true, ready: Promise.resolve(), editor: new Editor(createEmptyDocument({ width: 64, height: 32 }), "image") } as unknown as EditorSession;
}

function background(key: string): BackgroundStatus {
  const url = `/view?filename=${key}&type=input&rand=1`;
  const bg: LoadedBackground = { key, image: {} as HTMLImageElement, size: SIZE, origin: "upstream", alphaUrl: withAlphaChannel(url) };
  return { kind: "loaded", background: bg };
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function maskOutput(id: string): NodeExecutionOutput {
  return { images: [{ filename: "bg.png", type: "temp" }], input_mask: [{ filename: `${id}.png`, subfolder: "", type: "temp", mask_id: id }] };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("InputMaskWatch", () => {
  it("does nothing while mask is disconnected", () => {
    const { node } = ourNode();
    expect(new InputMaskWatch(node).sync(session(), SIZE, true)).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("same LoadImage + MASK slot -> live channel=a; named Input Mask; nothing to upload", async () => {
    const { node, link } = ourNode();
    const load = loadImage("5");
    link(0, load, 0);
    link(1, load, 1);
    const s = session();
    expect(new InputMaskWatch(node).sync(s, SIZE, true)).toBe(true);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/view?filename=a.png&subfolder=&type=input&rand=1&channel=a");
    const mask = s.editor.imageMask;
    expect(mask.info?.name).toBe(INPUT_MASK_NAME);
    expect(mask.hasPixels).toBe(true);
    expect(alphaOf(s)).toEqual([255, 0]); // 255 - alpha
    expect(s.editor.dirty).toBe(false);
    expect(mask.info?.file).toBeNull();
  });

  it("a separate LoadImage feeding only mask is read live (its own file)", async () => {
    const { node, link } = ourNode();
    link(1, loadImage("6", "b.png"), 1);
    const s = watchOnce(node);
    await flush();
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual(["/view?filename=b.png&subfolder=&type=input&rand=1&channel=a"]);
    expect(alphaOf(s)).toEqual([255, 0]);
    expect(s.editor.imageMask.waiting).toBe(false);
  });

  it("LoadImageMask: channel alpha is read live (255 - alpha), red waits for a run", async () => {
    const alpha = ourNode();
    alpha.link(1, loadImageMask("7", "alpha"), 0);
    const s = watchOnce(alpha.node);
    await flush();
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual(["/view?filename=m.png&subfolder=&type=input&rand=1&channel=a"]);
    expect(alphaOf(s)).toEqual([255, 0]);
    fetchMock.mockClear();
    const red = ourNode();
    red.link(1, loadImageMask("8", "red"), 0);
    const r = watchOnce(red.node);
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(r.editor.imageMask.waiting).toBe(true);
  });

  it("a node without a /view file waits for a run; the executed preview then wins", async () => {
    const { node, link } = ourNode();
    link(0, loadImage("5"), 0);
    link(1, maskNode("6"), 0);
    const s = session();
    const watch = new InputMaskWatch(node);
    watch.sync(s, SIZE, true);
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(s.editor.imageMask.info?.name).toBe(INPUT_MASK_NAME);
    expect(s.editor.imageMask.waiting).toBe(true);
    watch.setExecuted(maskOutput("m1"));
    watch.sync(s, SIZE, true);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toContain("filename=m1.png");
    expect(s.editor.imageMask.waiting).toBe(false);
    expect(s.editor.imageMask.hasPixels).toBe(true);
    // Unchanged: no refetch.
    watch.sync(s, SIZE, true);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("after a run the preview replaces the live read", async () => {
    const { node, link } = ourNode();
    const load = loadImage("5");
    link(0, load, 0);
    link(1, load, 1);
    const s = session();
    const watch = new InputMaskWatch(node);
    watch.sync(s, SIZE, true);
    await flush();
    watch.setExecuted(maskOutput("m2"));
    watch.sync(s, SIZE, true);
    await flush();
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([expect.stringContaining("channel=a"), expect.stringContaining("filename=m2.png")]);
    expect(s.editor.imageMask.info?.sourceKey).toBe("mask:preview:m2");
    expect(alphaOf(s)).toEqual([100, 7]); // gray = coverage
  });

  it("a MASK from another node's IMAGE-typed slot is not read live", async () => {
    const { node, link } = ourNode();
    const load = loadImage("5");
    link(0, load, 0);
    link(1, load, 0);
    watchOnce(node);
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("disconnect: the image-alpha sync takes the row back and reads the alpha again", async () => {
    const { node, link } = ourNode();
    const load = loadImage("5");
    link(0, load, 0);
    const s = session();
    const watch = new InputMaskWatch(node);
    syncImageMask(s, background("a.png"));
    await imageMaskReady(s);
    expect(s.editor.imageMask.info?.name).toBe(IMAGE_MASK_NAME);
    link(1, maskNode("6"), 0);
    watch.sync(s, SIZE, true);
    expect(s.editor.imageMask.info?.name).toBe(INPUT_MASK_NAME);
    link(1, null);
    expect(watch.sync(s, SIZE, true)).toBe(false);
    fetchMock.mockClear();
    syncImageMask(s, background("a.png"));
    await imageMaskReady(s);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(s.editor.imageMask.info?.name).toBe(IMAGE_MASK_NAME);
  });
});

/** Coverage of the row (its display canvas alpha). */
function alphaOf(s: EditorSession): number[] {
  const px = (s.editor.imageMask.canvas() as unknown as FakeCanvas).px;
  return [px[3] ?? -1, px[7] ?? -1];
}

function watchOnce(node: LGraphNode): EditorSession {
  const s = session();
  new InputMaskWatch(node).sync(s, SIZE, true);
  return s;
}
