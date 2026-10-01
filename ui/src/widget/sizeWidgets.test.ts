/**
 * width/height visibility follows the `image` link, and the
 * inserted-source layer naming helpers.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@comfy/scripts/app.js", () => ({ app: { nodeOutputs: {}, nodePreviewImages: {} } }));
vi.mock("@comfy/scripts/api.js", () => ({ api: { apiURL: (route: string) => route } }));

import { imageLayerName } from "../engine/clipboardMath";
import type { IBaseWidget, LGraphNode } from "../types/comfy";
import { fileStem } from "./imageSource";
import { syncSizeWidgets } from "./sizeWidgets";

function node(linked: boolean, height = 300): LGraphNode & { widgets: IBaseWidget[] } {
  const widget = (name: string): IBaseWidget => ({ name, type: "number", value: 1024, options: {} });
  const n = {
    inputs: [{ name: "image", type: "IMAGE", link: linked ? 1 : null }],
    widgets: [widget("document"), widget("width"), widget("height"), widget("background")],
    size: [500, height] as [number, number],
    setSize(size: [number, number]) {
      n.size = size;
    },
    computeSize: (): [number, number] => [400, 400],
  };
  return n as unknown as LGraphNode & { widgets: IBaseWidget[] };
}

describe("syncSizeWidgets", () => {
  it("hides only width/height while image is linked, order and values kept", () => {
    const n = node(true);
    expect(syncSizeWidgets(n)).toBe(true);
    expect(n.widgets.map((w) => [w.name, w.hidden ?? false])).toEqual([
      ["document", false], ["width", true], ["height", true], ["background", false],
    ]);
    expect(n.size).toEqual([500, 300]);
    expect(syncSizeWidgets(n)).toBe(false);
  });

  it("shows them on unlink and grows a too-short node", () => {
    const n = node(true);
    syncSizeWidgets(n);
    n.inputs[0]!.link = null;
    expect(syncSizeWidgets(n)).toBe(true);
    expect(n.widgets[1]?.hidden).toBe(false);
    expect(n.size).toEqual([500, 400]);
  });
});

describe("source layer names", () => {
  it("strips the extension", () => {
    expect(fileStem("cat.final.png")).toBe("cat.final");
    expect(fileStem("noext")).toBe("noext");
    expect(fileStem(".hidden")).toBe(".hidden");
  });

  it("numbers Image N with the lowest free N", () => {
    expect(imageLayerName([])).toBe("Image 1");
    expect(imageLayerName([{ name: "Image 1" }, { name: "Image 3" }])).toBe("Image 2");
  });
});
