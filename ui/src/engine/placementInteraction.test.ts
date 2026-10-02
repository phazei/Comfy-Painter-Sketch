/**
 * Align-drawing placement through the editor core: image-size changes never
 * touch it, Reset is identity, interactions from a violating state don't jump.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createEmptyDocument } from "../document/create";
import type { Editor as EditorClass } from "./editor";

function fakeCanvas(): object {
  const canvas: Record<string, unknown> = { width: 300, height: 150 };
  const fields: Record<string | symbol, unknown> = {
    canvas,
    getImageData: (_x: number, _y: number, w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
  };
  const ctx = new Proxy(fields, { get: (target, key) => key in target ? target[key] : () => undefined,
    set: (target, key, value) => { target[key] = value; return true; } });
  canvas.getContext = () => ctx;
  return canvas;
}
let Editor: typeof EditorClass;
beforeAll(async () => {
  vi.stubGlobal("document", { createElement: fakeCanvas });
  ({ Editor } = await import("./editor"));
});
afterAll(() => vi.unstubAllGlobals());

const fill = { kind: "fill", color: "#fff" } as const;

/** Frame 1024 x 1024 (256 x 256 widgets, boosted), shown at `w` x `h`. */
function setup(w = 256, h = 256): EditorClass {
  const ed = new Editor(createEmptyDocument({ width: 1024, height: 1024 }, "place01"), "widgets");
  ed.setBackground(fill, { width: w, height: h });
  return ed;
}

describe("placement is the user's setting", () => {
  it("image size change leaves it untouched (256 -> 1024x256 -> 1024x1024)", () => {
    const ed = setup();
    const onChange = vi.fn();
    ed.events.on("change", onChange);
    for (const size of [{ width: 1024, height: 256 }, { width: 1024, height: 1024 }]) {
      ed.setBackground(fill, size);
      expect(ed.doc.placement).toBeUndefined();
    }
    ed.placement.set({ x: 10, y: -5, scale: 1.5 });
    onChange.mockClear();
    ed.setBackground(fill, { width: 1024, height: 256 });
    expect(ed.doc.placement).toEqual({ x: 10, y: -5, scale: 1.5 });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("Reset position = identity, even when identity violates the margin rule", () => {
    const ed = setup(1024, 256);
    ed.placement.set({ x: 0, y: 0, scale: 3 });
    ed.placement.reset();
    expect(ed.doc.placement).toBeUndefined();
  });

  it("drag / nudge from a violating state doesn't jump", () => {
    const ed = setup(1024, 256); // identity violates both horizontal edges
    ed.placement.translateImage(100, 0); // would worsen the left edge: blocked
    expect(ed.placement.current.scale).toBe(1);
    expect(ed.placement.current.x).toBeCloseTo(0, 9);
    ed.placement.translateImage(0, 20); // vertical is free
    expect(ed.placement.imageOffset.y).toBeCloseTo(20, 9);
    expect(ed.placement.current.scale).toBe(1);
  });
});