/** Region mode gestures, registry wiring and overlay decisions (canvas boundary instrumented). */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createEmptyDocument } from "../document/create";
import type { Editor as EditorClass } from "../engine/editor";
import { imageToDoc } from "../engine/frameMap";
import type { Point } from "../geometry/rect";
import { drawRegionOverlay, highlightMainBorder, regionOutlineStyle } from "../ui/regionOverlay";
import { LAYERS_TAB, OUTPUTS_TAB, tabForTool, toolForTab } from "../ui/regionMode";
import { REGION_TOOL_ID, createRegionTool } from "./region";
import { createDefaultTools } from "./registry";
import type { ToolPointer } from "./types";

// ── Fixtures ──────────────────────────────────────────────────────────────────

function fakeCanvas(): object {
  const canvas: Record<string, unknown> = { width: 300, height: 150 };
  const fields: Record<string | symbol, unknown> = {
    canvas,
    getImageData: (_x: number, _y: number, w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
  };
  const ctx = new Proxy(fields, {
    get: (target, key) => (key in target ? target[key] : () => undefined),
    set: (target, key, value) => {
      target[key] = value;
      return true;
    },
  });
  canvas["getContext"] = () => ctx;
  return canvas;
}

let Editor: typeof EditorClass;
beforeAll(async () => {
  vi.stubGlobal("document", { createElement: fakeCanvas });
  ({ Editor } = await import("../engine/editor"));
});
afterAll(() => vi.unstubAllGlobals());

const box = { x: 10, y: 12, width: 20, height: 24 };

function setup(width = 100, height = 80): EditorClass {
  return new Editor(createEmptyDocument({ width, height }, "regiontl"), "widgets");
}

function sample(ed: EditorClass, p: Point, shiftKey = false): ToolPointer {
  return { ...imageToDoc(ed.frameMap, p), pressure: 1, pointerType: "mouse", shiftKey, altKey: false, ctrlKey: false };
}

/** Press at `from`, move to `to`, release there. */
function drag(ed: EditorClass, tool: ReturnType<typeof createRegionTool>, from: Point, to: Point, shift = false): void {
  tool.onPointerDown(ed, [sample(ed, from, shift)]);
  tool.onPointerMove(ed, [sample(ed, to, shift)]);
  tool.onPointerUp(ed, sample(ed, to, shift));
}

// ── Gestures ──────────────────────────────────────────────────────────────────

describe("region mode gestures", () => {
  it("draws, moves and resizes through the document map (Move placement included), one undo step each", () => {
    const doc = createEmptyDocument({ width: 64, height: 64 }, "placed01");
    doc.placement = { x: 31, y: -22, scale: 2.5 };
    const ed = new Editor(doc, "widgets");
    const tool = createRegionTool();
    ed.setBackground({ kind: "fill", color: "#fff" }, { width: 200, height: 100 });
    drag(ed, tool, { x: 60, y: 20 }, { x: 100, y: 50 });
    const id = ed.doc.regions[0]!.id;
    expect(ed.regionOps.imageRect(id)).toEqual({ x: 60, y: 20, width: 40, height: 30 });
    drag(ed, tool, { x: 80, y: 35 }, { x: 85, y: 40 });
    expect(ed.regionOps.imageRect(id)).toEqual({ x: 65, y: 25, width: 40, height: 30 });
    // Bottom-right handle; the paint area ends one image size beyond the image.
    drag(ed, tool, { x: 105, y: 55 }, { x: 900, y: 900 });
    expect(ed.regionOps.imageRect(id)).toEqual({ x: 65, y: 25, width: 335, height: 175 });
    ed.undo();
    ed.undo();
    ed.undo();
    expect(ed.doc.regions).toEqual([]);
  });

  it("draws outside the image, clamped to the paint area", () => {
    const ed = setup();
    const tool = createRegionTool();
    drag(ed, tool, { x: -50, y: -40 }, { x: -500, y: -500 });
    expect(ed.doc.regions[0]!.rect).toEqual({ x: -100, y: -80, width: 50, height: 40 });
  });

  it("a click on empty canvas selects Main: no region, no history, no document change", () => {
    const ed = setup();
    const tool = createRegionTool();
    const id = ed.regionOps.add(box)!;
    const changes = vi.fn();
    const outputs = vi.fn();
    ed.events.on("change", changes);
    ed.events.on("outputs", outputs);
    tool.onPointerDown(ed, [sample(ed, { x: 80, y: 70 })]);
    expect(ed.regionOps.selectedId).toBe(id); // no blink on press
    tool.onPointerUp(ed, sample(ed, { x: 80, y: 70 }));
    expect(ed.regionOps.selectedId).toBeNull();
    expect(ed.doc.regions).toHaveLength(1);
    expect(changes).not.toHaveBeenCalled();
    expect(outputs).toHaveBeenCalledTimes(1);
    ed.undo();
    expect(ed.doc.regions).toEqual([]);
  });

  it("a click on a region selects it without an edit; the next empty click still selects Main", () => {
    const ed = setup();
    const tool = createRegionTool();
    const first = ed.regionOps.add(box)!;
    ed.regionOps.add({ x: 50, y: 50, width: 10, height: 10 });
    const changes = vi.fn();
    ed.events.on("change", changes);
    tool.onPointerDown(ed, [sample(ed, { x: 15, y: 15 })]);
    tool.onPointerUp(ed, sample(ed, { x: 15, y: 15 }));
    expect(ed.regionOps.selectedId).toBe(first);
    tool.onPointerDown(ed, [sample(ed, { x: 90, y: 5 })]);
    tool.onPointerUp(ed, sample(ed, { x: 90, y: 5 }));
    expect(ed.regionOps.selectedId).toBeNull();
    expect(changes).not.toHaveBeenCalled();
  });

  it("Shift-drag inside a region draws a new one into the lowest empty slot", () => {
    const ed = setup();
    const tool = createRegionTool();
    ed.regionOps.addDefault(1);
    ed.regionOps.addDefault(3);
    drag(ed, tool, { x: 40, y: 30 }, { x: 60, y: 50 }, true);
    expect(ed.regionOps.inSlot(2)?.rect).toEqual({ x: 40, y: 30, width: 20, height: 20 });
    expect(ed.regionOps.inSlot(1)?.rect).toEqual({ x: 25, y: 20, width: 50, height: 40 });
  });

  it("with all six slots filled a draw adds nothing and shows a note", () => {
    const ed = setup();
    const tool = createRegionTool();
    for (let slot = 1; slot <= 6; slot++) ed.regionOps.add({ x: slot, y: 0, width: 1, height: 1 });
    const notes = vi.fn();
    ed.events.on("note", notes);
    drag(ed, tool, { x: 50, y: 50 }, { x: 70, y: 70 });
    expect(ed.doc.regions).toHaveLength(6);
    expect(notes).toHaveBeenCalledTimes(1);
  });

  it("a full-slots draw never commits: an unrelated open transaction (colour picker) stays open", () => {
    const ed = setup();
    const tool = createRegionTool();
    for (let slot = 1; slot <= 6; slot++) ed.regionOps.add({ x: slot, y: 0, width: 1, height: 1 });
    const ops = ed.regionOps;
    const commit = vi.spyOn(ops, "commit");
    const cancel = vi.spyOn(ops, "cancel");
    expect(ops.begin()).toBe(true);
    const before = ops.options(null).fillColor;
    ops.setOptions(null, { fillColor: before === "#123456" ? "#654321" : "#123456" });
    drag(ed, tool, { x: 50, y: 50 }, { x: 70, y: 70 });
    tool.onPointerDown(ed, [sample(ed, { x: 50, y: 50 })]);
    tool.onPointerMove(ed, [sample(ed, { x: 70, y: 70 })]);
    tool.onCancel(ed);
    expect(commit).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
    expect(ops.active).toBe(true);
    expect(ed.doc.regions).toHaveLength(6);
    ops.cancel();
    expect(ops.options(null).fillColor).toBe(before);
  });

  it("cancel reverts a drag without consuming history; a zero move leaves no step", () => {
    const ed = setup();
    const tool = createRegionTool();
    const id = ed.regionOps.add(box)!;
    tool.onPointerDown(ed, [sample(ed, { x: 20, y: 24 })]);
    tool.onPointerMove(ed, [sample(ed, { x: 70, y: 50 })]);
    tool.onCancel(ed);
    expect(ed.regionOps.imageRect(id)).toEqual(box);
    drag(ed, tool, { x: 20, y: 24 }, { x: 60, y: 24 });
    tool.onPointerDown(ed, [sample(ed, { x: 60, y: 24 })]);
    tool.onPointerMove(ed, [sample(ed, { x: 90, y: 24 })]);
    tool.onPointerUp(ed, sample(ed, { x: 60, y: 24 }));
    expect(ed.regionOps.imageRect(id)).toEqual({ ...box, x: 50 });
    ed.undo();
    expect(ed.regionOps.imageRect(id)).toEqual(box);
  });
});

// ── Registry / mode ───────────────────────────────────────────────────────────

describe("region mode switching", () => {
  it("the region tool is hidden: not on the rail, no shortcut, no Ctrl Move / Alt eyedropper", () => {
    const ed = setup();
    const tools = createDefaultTools(ed);
    expect(tools.railTools().some((tool) => tool.id === REGION_TOOL_ID)).toBe(false);
    tools.setActive(REGION_TOOL_ID);
    expect(tools.resolve(false, true).id).toBe(REGION_TOOL_ID);
    expect(tools.resolve(true, false).id).toBe(REGION_TOOL_ID);
    expect(tools.byShortcut("o")).toBeUndefined();
  });

  it("Outputs tab <-> region tool", () => {
    expect(tabForTool(REGION_TOOL_ID)).toBe(OUTPUTS_TAB);
    expect(tabForTool("brush")).toBe(LAYERS_TAB);
    expect(tabForTool("move")).toBe(LAYERS_TAB);
    expect(toolForTab(OUTPUTS_TAB, "brush", "brush")).toBe(REGION_TOOL_ID);
    expect(toolForTab(OUTPUTS_TAB, REGION_TOOL_ID, "brush")).toBeNull();
    expect(toolForTab(LAYERS_TAB, REGION_TOOL_ID, "lasso")).toBe("lasso");
    expect(toolForTab(LAYERS_TAB, "eraser", "eraser")).toBeNull();
  });
});

// ── Overlay ───────────────────────────────────────────────────────────────────

describe("region overlay", () => {
  it("is subdued outside region mode regardless of selection", () => {
    for (const selected of [true, false]) {
      const style = regionOutlineStyle(false, selected);
      expect(style.dash.length).toBeGreaterThan(0);
      expect(style.alpha).toBeLessThan(1);
      expect(style.handles).toBe(false);
      expect(style.badge).toBe(false);
      expect(style.lineWidth).toBe(1);
    }
    expect(regionOutlineStyle(true, true).handles).toBe(true);
    expect(regionOutlineStyle(true, false).handles).toBe(false);
    expect(regionOutlineStyle(true, true).color).not.toBe(regionOutlineStyle(true, false).color);
    expect(highlightMainBorder(true, null)).toBe(true);
    expect(highlightMainBorder(true, "r1")).toBe(false);
    expect(highlightMainBorder(false, null)).toBe(false);
  });

  it("draws image-fixed outlines, handles only for the selected region in region mode", () => {
    const ed = setup();
    ed.view.setStage({ width: 500, height: 400 }, 0.25);
    const id = ed.regionOps.add(box)!;
    const strokeRect = vi.fn();
    const ctx = {
      save: () => {},
      restore: () => {},
      setLineDash: () => {},
      strokeRect,
      fillRect: () => {},
      fillText: () => {},
      strokeText: () => {},
    } as unknown as CanvasRenderingContext2D;
    drawRegionOverlay(ctx, ed, 2, true);
    const view = ed.view.current;
    expect(strokeRect).toHaveBeenNthCalledWith(2, (view.offsetX + box.x * view.scale) * 2,
      (view.offsetY + box.y * view.scale) * 2, box.width * view.scale * 2, box.height * view.scale * 2);
    expect(strokeRect).toHaveBeenCalledTimes(10); // halo + outline + eight handles
    strokeRect.mockClear();
    drawRegionOverlay(ctx, ed, 2, false);
    expect(strokeRect).toHaveBeenCalledTimes(2); // subdued: dark + light dashes, no handles
    strokeRect.mockClear();
    ed.regionOps.select(null);
    drawRegionOverlay(ctx, ed, 2, true);
    expect(strokeRect).toHaveBeenCalledTimes(4); // image border (halo + line) + region
    ed.regionOps.setVisible(id, false);
    strokeRect.mockClear();
    drawRegionOverlay(ctx, ed, 2, false);
    expect(strokeRect).not.toHaveBeenCalled();
  });
});
