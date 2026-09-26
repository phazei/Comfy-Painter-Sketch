import { describe, expect, it } from "vitest";

import { PICK_ALPHA_THRESHOLD, pickLayer, pickMask } from "./layerPick";
import type { PickCandidate } from "./layerPick";

function layer(id: string, extra: Partial<PickCandidate> = {}): PickCandidate {
  return { id, kind: "paint", visible: true, locked: false, ...extra };
}

describe("pickLayer (Move auto-select)", () => {
  it("picks the topmost layer with alpha above the threshold", () => {
    const layers = [layer("a"), layer("b"), layer("c")];
    const alpha: Record<string, number> = { a: 255, b: 200, c: 0 };
    expect(pickLayer(layers, (id) => alpha[id] ?? 0)).toBe("b");
  });

  it("ignores near-transparent pixels (alpha <= threshold)", () => {
    const layers = [layer("a"), layer("b")];
    const alpha: Record<string, number> = { a: 50, b: PICK_ALPHA_THRESHOLD };
    expect(pickLayer(layers, (id) => alpha[id] ?? 0)).toBe("a");
    expect(pickLayer(layers, () => PICK_ALPHA_THRESHOLD)).toBeNull();
  });

  it("skips hidden, locked and mask layers without sampling them", () => {
    const sampled: string[] = [];
    const layers = [
      layer("base"),
      layer("hidden", { visible: false }),
      layer("locked", { locked: true }),
      layer("mask", { kind: "mask" }),
    ];
    const picked = pickLayer(layers, (id) => (sampled.push(id), 255));
    expect(picked).toBe("base");
    expect(sampled).toEqual(["base"]);
  });

  it("text layers are pickable by their pixel alpha", () => {
    const layers = [layer("paint"), layer("text", { kind: "text" })];
    expect(pickLayer(layers, (id) => (id === "text" ? 255 : 255))).toBe("text");
    expect(pickLayer(layers, (id) => (id === "text" ? 0 : 255))).toBe("paint");
  });

  it("returns null when nothing is hit or there are no layers", () => {
    expect(pickLayer([layer("a")], () => 0)).toBeNull();
    expect(pickLayer([], () => 255)).toBeNull();
  });
});

describe("pickMask (Quick Mask auto-select)", () => {
  const mask = (id: string, extra: Partial<PickCandidate> = {}): PickCandidate => layer(id, { kind: "mask", ...extra });

  it("picks the topmost mask with coverage above the threshold", () => {
    const layers = [mask("m1"), mask("m2"), mask("m3")];
    const cov: Record<string, number> = { m1: 255, m2: 128, m3: PICK_ALPHA_THRESHOLD };
    expect(pickMask(layers, (id) => cov[id] ?? 0)).toBe("m2");
  });

  it("skips paint/text, hidden and locked layers without sampling them", () => {
    const sampled: string[] = [];
    const layers = [
      mask("m1"),
      layer("paint"),
      layer("text", { kind: "text" }),
      mask("hidden", { visible: false }),
      mask("locked", { locked: true }),
    ];
    expect(pickMask(layers, (id) => (sampled.push(id), 255))).toBe("m1");
    expect(sampled).toEqual(["m1"]);
  });

  it("returns null when no mask has coverage", () => {
    expect(pickMask([mask("m1"), layer("p")], (id) => (id === "p" ? 255 : 0))).toBeNull();
    expect(pickMask([], () => 255)).toBeNull();
  });
});
