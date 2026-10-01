/**
 * Shapes straight into Free Transform (`shapeFloat.ts`): an untouched commit
 * is byte-identical to the old direct rasterization and ONE undo step; cancel
 * leaves nothing (no history); the selection clips the shape and is never
 * changed; a press outside the box with the shape tool commits and starts
 * the next shape in the same gesture (`transformTool.ts`).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createEmptyDocument } from "../document/create";
import type { Editor as EditorClass } from "./editor";
import type { BlendCanvas } from "./fakeCanvas.testutil";
import { installBlendCanvasFakes, removeCanvasFakes } from "./fakeCanvas.testutil";
import { rectSelection } from "./selection";
import type { ShapeSpec } from "./shapes";
import type { ToolPointer } from "../tools/types";
import type { BoxShapeTool } from "../tools/boxShapeTool";
import type { TransformTool } from "../tools/transformTool";

let Editor: typeof EditorClass;
let createRectangleTool: () => BoxShapeTool;
let TransformToolClass: new (editor: EditorClass) => TransformTool;

beforeAll(async () => {
  installBlendCanvasFakes();
  ({ Editor } = await import("./editor"));
  ({ createRectangleTool } = await import("../tools/boxShapeTool"));
  ({ TransformTool: TransformToolClass } = await import("../tools/transformTool"));
});

afterAll(() => removeCanvasFakes());

// ── Helpers ───────────────────────────────────────────────────────────────────

const STYLE = { mode: "paint", opacity: 0.5, hardness: 1, color: "#ff0000", shape: true } as const;

function box(x: number, y: number, width: number, height: number): ShapeSpec {
  return { kind: "rect", rect: { x, y, width, height }, paint: "fill", strokeWidth: 0, strokeColor: "#ff0000", fillColor: "#ff0000" };
}

function setup(size = 32): EditorClass {
  return new Editor(createEmptyDocument({ width: size, height: size }), "widgets");
}

function pixels(ed: EditorClass, id = ed.doc.activeLayerId): number[] {
  return [...(ed.layerCanvas(id) as unknown as BlendCanvas).px];
}

function alphaAt(ed: EditorClass, x: number, y: number, id = ed.doc.activeLayerId): number {
  const c = ed.layerCanvas(id) as unknown as BlendCanvas;
  const b = ed.bounds;
  return c.px[((y - b.y) * c.width + (x - b.x)) * 4 + 3] ?? -1;
}

function depth(ed: EditorClass): number {
  return (ed as unknown as { s: { history: { undoDepth: number } } }).s.history.undoDepth;
}

/** Draw one shape; `direct` = the old path (endStroke), else endShape. */
function draw(ed: EditorClass, shape: ShapeSpec, direct: boolean): boolean {
  expect(ed.beginStroke(STYLE, 1)).toBe(true);
  ed.drawShape(shape);
  if (!direct) return ed.endShape();
  ed.endStroke(null);
  return true;
}

function pointer(x: number, y: number): ToolPointer {
  return { x, y, pressure: 0.5, pointerType: "mouse", shiftKey: false, altKey: false, ctrlKey: false, metaKey: false } as ToolPointer;
}

// ═══════════════════════════════════════════════════════════════════════════

describe("a shape ends in a Free Transform session", () => {
  it("floats on the current layer (no new layer, layer untouched while floating)", () => {
    const ed = setup();
    const layers = ed.doc.layers.length;
    const blank = pixels(ed);
    expect(draw(ed, box(4, 4, 6, 5), false)).toBe(true);
    expect(ed.float.transform.active).toBe(true);
    expect(ed.float.shape).toBe(true);
    expect(ed.float.layerId).toBe(ed.doc.activeLayerId);
    expect(ed.doc.layers.length).toBe(layers);
    expect(pixels(ed)).toEqual(blank);
    expect(ed.float.transform.box()).toMatchObject({ w: 6, h: 5 });
  });

  it("an untouched commit is byte-identical to the direct commit and ONE undo step", () => {
    const direct = setup();
    draw(direct, box(4, 4, 6, 5), true);
    const ed = setup();
    const steps = depth(ed);
    draw(ed, box(4, 4, 6, 5), false);
    ed.float.transform.commit();
    expect(ed.float.active).toBe(false);
    expect(pixels(ed)).toEqual(pixels(direct));
    expect(alphaAt(ed, 5, 5)).toBe(128);
    expect(depth(ed)).toBe(steps + 1);
    ed.undo();
    expect(alphaAt(ed, 5, 5)).toBe(0);
  });

  it("a nudged commit lands the shape moved", () => {
    const ed = setup();
    draw(ed, box(4, 4, 6, 5), false);
    ed.float.transform.nudge(3, 0);
    ed.float.transform.commit();
    expect(alphaAt(ed, 4, 5)).toBe(0);
    expect(alphaAt(ed, 12, 5)).toBe(128);
  });

  it("cancel / Ctrl+Z: the shape goes away, no history", () => {
    const ed = setup();
    const blank = pixels(ed);
    const steps = depth(ed);
    draw(ed, box(4, 4, 6, 5), false);
    ed.undo(); // Ctrl+Z while transforming cancels
    expect(ed.float.active).toBe(false);
    expect(ed.float.transform.active).toBe(false);
    expect(pixels(ed)).toEqual(blank);
    expect(depth(ed)).toBe(steps);
    draw(ed, box(4, 4, 6, 5), false);
    ed.float.cancel(); // Esc
    expect(pixels(ed)).toEqual(blank);
    expect(depth(ed)).toBe(steps);
  });

  it("any other edit settles it (one step)", () => {
    const ed = setup();
    const steps = depth(ed);
    draw(ed, box(4, 4, 6, 5), false);
    ed.settle();
    expect(ed.float.active).toBe(false);
    expect(alphaAt(ed, 5, 5)).toBe(128);
    expect(depth(ed)).toBe(steps + 1);
  });

  it("selection: the shape is clipped as before; commit and cancel never change the selection", () => {
    const sel = rectSelection({ x: 0, y: 0, width: 7, height: 32 });
    const direct = setup();
    direct.selection.apply(sel, "replace");
    draw(direct, box(4, 4, 6, 5), true);
    const ed = setup();
    ed.selection.apply(sel, "replace");
    const current = ed.selection.current;
    const steps = depth(ed);
    draw(ed, box(4, 4, 6, 5), false);
    expect(ed.selection.current).toBe(current);
    ed.float.transform.commit();
    expect(pixels(ed)).toEqual(pixels(direct));
    expect(alphaAt(ed, 8, 5)).toBe(0);
    expect(ed.selection.current).toBe(current);
    expect(depth(ed)).toBe(steps + 1);
    ed.undo();
    expect(ed.selection.current).toBe(current);
    draw(ed, box(4, 4, 6, 5), false);
    ed.float.cancel();
    expect(ed.selection.current).toBe(current);
  });

  it("Quick Mask: a float of white coverage on the cmask", () => {
    const ed = setup();
    ed.setPaintTarget("mask");
    const mask = ed.maskLayer?.id ?? "";
    draw(ed, box(4, 4, 6, 5), false);
    expect(ed.float.layerId).toBe(mask);
    ed.float.transform.commit();
    expect(alphaAt(ed, 5, 5, mask)).toBe(128);
    expect(pixels(ed).some((v) => v !== 0)).toBe(false);
  });

  it("a layer mask target refuses shapes as before", () => {
    const ed = setup();
    ed.layerMask.add(ed.doc.activeLayerId, "reveal");
    expect(ed.beginStroke(STYLE, 1)).toBe(false);
  });
});

describe("shape after shape (transform tool + shape tool)", () => {
  it("a press outside the box commits and draws the next shape in the same gesture", () => {
    const ed = setup(64);
    const rect = createRectangleTool();
    rect.options.set("paint", "fill");
    const t = new TransformToolClass(ed).withActive(rect);
    rect.onPointerDown(ed, [pointer(2, 2)]);
    rect.onPointerUp(ed, pointer(6, 6));
    expect(ed.float.transform.active).toBe(true);
    const steps = depth(ed);
    // Outside the box and its rotate zone (16 screen px past a corner): commit + new shape.
    t.onPointerDown(ed, [pointer(30, 30)]);
    expect(ed.float.active).toBe(false);
    expect(depth(ed)).toBe(steps + 1);
    t.onPointerMove(ed, [pointer(36, 36)]);
    t.onPointerUp(ed, pointer(36, 36));
    expect(ed.float.transform.active).toBe(true);
    expect(ed.float.transform.box()).toMatchObject({ w: 6, h: 6 });
    // Inside the box: a transform drag, nothing committed.
    t.onPointerDown(ed, [pointer(33, 33)]);
    t.onPointerMove(ed, [pointer(34, 33)]);
    t.onPointerUp(ed, pointer(34, 33));
    expect(ed.float.transform.active).toBe(true);
    expect(depth(ed)).toBe(steps + 1);
  });

  it("Alt outside the box runs the temporary eyedropper; the session stays open and untouched", () => {
    const ed = setup(64);
    const rect = createRectangleTool();
    rect.options.set("paint", "fill");
    const calls: string[] = [];
    const dropper = {
      ...rect, id: "eyedropper", onPointerDown: () => calls.push("down"), onPointerMove: () => calls.push("move"),
      onPointerUp: () => calls.push("up"), onCancel: () => calls.push("cancel"),
    } as unknown as typeof rect;
    const t = new TransformToolClass(ed).withActive(rect, dropper);
    rect.onPointerDown(ed, [pointer(2, 2)]);
    rect.onPointerUp(ed, pointer(6, 6));
    const steps = depth(ed);
    const alt = { ...pointer(30, 30), altKey: true };
    t.onPointerDown(ed, [alt]);
    t.onPointerMove(ed, [{ ...pointer(31, 31), altKey: true }]);
    t.onPointerUp(ed, { ...pointer(31, 31), altKey: true });
    expect(calls).toEqual(["down", "move", "up"]);
    expect(ed.float.transform.active).toBe(true);
    expect(ed.float.transform.box()).toMatchObject({ w: 4, h: 4 });
    expect(depth(ed)).toBe(steps);
    // Without the Alt substitute (tool without altEyedropper) the old shape-after-shape rule applies.
    t.withActive(rect, null);
    t.onPointerDown(ed, [alt]);
    t.onPointerUp(ed, alt);
    expect(depth(ed)).toBe(steps + 1);
  });

  it("another tool active: an outside press does nothing (no commit)", () => {
    const ed = setup();
    draw(ed, box(4, 4, 6, 5), false);
    const t = new TransformToolClass(ed);
    t.onPointerDown(ed, [pointer(28, 28)]);
    t.onPointerUp(ed, pointer(28, 28));
    expect(ed.float.transform.active).toBe(true);
  });
});
