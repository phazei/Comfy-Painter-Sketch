import { describe, expect, it } from "vitest";

import type { Editor } from "../engine/editor";
import { createBrushTool } from "./brush";
import { createEyedropperTool } from "./eyedropper";
import { createFillTool } from "./fill";
import { createMoveLayerTool } from "./moveLayer";
import type { MoveLayerTool } from "./moveLayer";
import { ToolRegistry, ctrlMoves } from "./registry";
import type { Tool, ToolPointer } from "./types";

/** Minimal stand-in for tools that opt out / are hidden (Text, Move drawing). */
function stubTool(id: string, extra: Partial<Tool> = {}): Tool {
  return {
    id,
    label: id,
    shortcut: "",
    icon: id,
    options: null,
    onPointerDown: () => undefined,
    onPointerMove: () => undefined,
    onPointerUp: () => undefined,
    onCancel: () => undefined,
    cursor: () => ({ kind: "icon", icon: "crosshair" }),
    ...extra,
  };
}

function registry(): { tools: ToolRegistry; move: MoveLayerTool } {
  const eyedropper = createEyedropperTool();
  const move = createMoveLayerTool();
  const tools = new ToolRegistry([
    createBrushTool(),
    createFillTool(),
    eyedropper,
    stubTool("text", { ctrlMove: false }),
    stubTool("move", { rail: false }),
    stubTool("lasso", { pending: () => true }),
    move,
  ]);
  tools.setAltTool(eyedropper.temporary);
  tools.setCtrlTool(move);
  return { tools, move };
}

describe("Ctrl = temporary layer Move", () => {
  it("resolves to the Move tool for rail tools while Ctrl is held", () => {
    const { tools, move } = registry();
    expect(tools.resolve(false, false).id).toBe("brush");
    expect(tools.resolve(false, true)).toBe(move);
    tools.setActive("eyedropper");
    expect(tools.resolve(false, true)).toBe(move);
  });

  it("Ctrl beats Alt; Alt alone still gives the eyedropper", () => {
    const { tools, move } = registry();
    expect(tools.resolve(true, true)).toBe(move);
    expect(tools.resolve(true, false).id).toBe("eyedropper");
  });

  it("opted-out, hidden and pending tools keep Ctrl; the Move tool keeps itself", () => {
    const { tools, move } = registry();
    for (const id of ["text", "move", "lasso"]) {
      tools.setActive(id);
      expect(tools.resolve(false, true).id).toBe(id);
    }
    tools.setActive("move-layer");
    expect(tools.resolve(true, true)).toBe(move);
    expect(ctrlMoves(move)).toBe(false);
  });
});

function pointer(ctrlKey: boolean): ToolPointer {
  return { x: 5.5, y: 7.2, pressure: 1, pointerType: "mouse", shiftKey: false, altKey: false, ctrlKey };
}

function fakeEditor(hit: string | null, target: "paint" | "mask" = "paint") {
  const log: string[] = [];
  const editor = {
    paintTarget: target,
    setPaintTarget: (t: string) => log.push(`target:${t}`),
    layerOps: {
      pickAt: (x: number, y: number) => (log.push(`pick:${x},${y}`), hit),
      setActiveLayer: (id: string) => (log.push(`active:${id}`), true),
    },
    layerMove: {
      begin: () => (log.push("begin"), true),
      preview: () => undefined,
      commit: () => (log.push("commit"), true),
      cancel: () => undefined,
    },
  } as unknown as Editor;
  return { editor, log };
}

describe("Move layer auto-select", () => {
  it("without Ctrl and option off, moves the active layer without picking", () => {
    const { editor, log } = fakeEditor("b");
    createMoveLayerTool().onPointerDown(editor, [pointer(false)]);
    expect(log).toEqual(["begin"]);
  });

  it("Ctrl picks the layer under the pointer, activates it, then moves it", () => {
    const { editor, log } = fakeEditor("b", "mask");
    const tool = createMoveLayerTool();
    tool.onPointerDown(editor, [pointer(true)]);
    tool.onPointerUp(editor, pointer(true));
    expect(log).toEqual(["pick:5.5,7.2", "target:paint", "active:b", "begin", "commit"]);
  });

  it("the Auto-select option picks without Ctrl", () => {
    const { editor, log } = fakeEditor("c");
    const tool = createMoveLayerTool();
    expect(tool.options.get("autoSelect")).toBe(false);
    expect(tool.options.set("autoSelect", true)).toBe(true);
    tool.onPointerDown(editor, [pointer(false)]);
    expect(log).toEqual(["pick:5.5,7.2", "active:c", "begin"]);
  });

  it("nothing hit: no activation, nothing moves", () => {
    const { editor, log } = fakeEditor(null, "mask");
    const tool = createMoveLayerTool();
    tool.onPointerDown(editor, [pointer(true)]);
    tool.onPointerUp(editor, pointer(true));
    expect(log).toEqual(["pick:5.5,7.2"]);
  });
});
