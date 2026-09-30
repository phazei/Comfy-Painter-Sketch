import { describe, expect, it } from "vitest";

import type { Editor } from "../engine/editor";
import { createBrushTool } from "./brush";
import { createEraserTool } from "./eraser";
import { createEyedropperTool } from "./eyedropper";
import { createFillTool } from "./fill";
import { ToolRegistry } from "./registry";
import type { ToolPointer } from "./types";

function registry(): ToolRegistry {
  const eyedropper = createEyedropperTool();
  const tools = new ToolRegistry([createBrushTool(), createEraserTool(), createFillTool(), eyedropper]);
  tools.setAltTool(eyedropper.temporary);
  return tools;
}

describe("Alt = temporary eyedropper", () => {
  it("resolves to the eyedropper only for opted-in tools while Alt is held", () => {
    const tools = registry();
    expect(tools.resolve(false).id).toBe("brush");
    expect(tools.resolve(true).id).toBe("eyedropper");
    tools.setActive("bucket");
    expect(tools.resolve(true).id).toBe("eyedropper");
    tools.setActive("eraser");
    expect(tools.resolve(true).id).toBe("eraser");
    tools.setActive("eyedropper");
    expect(tools.resolve(true)).toBe(tools.active);
  });

  it("Alt+click in the eyedropper picks BG; the temporary variant always picks FG", () => {
    const set: Array<[string, string]> = [];
    const editor = {
      colors: { fg: "#000000", bg: "#ffffff", set: (slot: string, hex: string) => set.push([slot, hex]) },
      pixelOps: { sampleColor: () => "#123456" },
      layerMask: { targeted: null },
    } as unknown as Editor;
    const alt: ToolPointer = { x: 1, y: 1, pressure: 1, pointerType: "mouse", shiftKey: false, altKey: true, ctrlKey: false };
    const eyedropper = createEyedropperTool();
    eyedropper.onPointerDown(editor, [alt]);
    expect(eyedropper.overlay()).toEqual({ kind: "loupe", color: "#123456", previous: "#ffffff" });
    eyedropper.onPointerUp(editor, alt);
    expect(eyedropper.overlay()).toBeNull();
    eyedropper.temporary.onPointerDown(editor, [alt]);
    expect(set[0]).toEqual(["bg", "#123456"]);
    expect(set[set.length - 1]).toEqual(["fg", "#123456"]);
  });

  it("is refused with a note while a layer mask is targeted (M14)", () => {
    const set: Array<[string, string]> = [];
    const notes: string[] = [];
    const editor = {
      colors: { fg: "#000000", bg: "#ffffff", set: (slot: string, hex: string) => set.push([slot, hex]) },
      pixelOps: { sampleColor: () => "#123456" },
      layerMask: { targeted: "layer1" },
      events: { emit: (_kind: string, text: string) => notes.push(text) },
    } as unknown as Editor;
    const click: ToolPointer = { x: 1, y: 1, pressure: 1, pointerType: "mouse", shiftKey: false, altKey: false, ctrlKey: false };
    const eyedropper = createEyedropperTool();
    eyedropper.temporary.onPointerDown(editor, [click]);
    eyedropper.temporary.onPointerUp(editor, click);
    expect(set).toEqual([]);
    expect(eyedropper.temporary.overlay()).toBeNull();
    expect(notes).toHaveLength(1);
  });
});
