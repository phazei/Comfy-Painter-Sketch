import { describe, expect, it } from "vitest";

import type { Layer } from "../document/types";
import { sceneFor } from "./docComposite";
import type { DocCompositeInput } from "./docComposite";
import { sampleTarget } from "./pixelOps";

const layer = { id: "p1", kind: "paint" } as Layer;

const scene: DocCompositeInput = {
  background: { kind: "fill", color: "#123456" },
  imageSize: { width: 8, height: 6 },
  map: { scale: 1, offsetX: 0, offsetY: 0 } as DocCompositeInput["map"],
  bounds: { x: 0, y: 0, width: 8, height: 6 },
  layers: [{ source: {} as HTMLCanvasElement, opacity: 1 }],
};

describe("sampleTarget", () => {
  it("layer reads the layer, falling back to all layers without one", () => {
    expect(sampleTarget("layer", layer)).toEqual({ kind: "layer", layer });
    expect(sampleTarget("layer", null)).toEqual({ kind: "scene", source: "all" });
  });

  it("all / background render the scene", () => {
    expect(sampleTarget("all", layer)).toEqual({ kind: "scene", source: "all" });
    expect(sampleTarget("background", layer)).toEqual({ kind: "scene", source: "background" });
    expect(sampleTarget("background", null)).toEqual({ kind: "scene", source: "background" });
  });
});

describe("sceneFor", () => {
  it("all keeps the paint layers", () => {
    expect(sceneFor(scene, "all")).toBe(scene);
  });

  it("background drops the paint layers but keeps background, placement and size", () => {
    const bg = sceneFor(scene, "background");
    expect(bg.layers).toEqual([]);
    expect(bg.background).toBe(scene.background);
    expect(bg.map).toBe(scene.map);
    expect(bg.imageSize).toEqual(scene.imageSize);
    expect(scene.layers).toHaveLength(1);
  });
});
