import { describe, expect, it } from "vitest";

import type { Editor } from "../engine/editor";
import type { WandRequest } from "../engine/pixelOps";
import type { Selection, SelectionMode } from "../engine/selection";
import { createMagicWandTool } from "./magicWand";
import type { Tool, ToolPointer } from "./types";

const PICKED: Selection = { rect: { x: 0, y: 0, width: 1, height: 1 }, data: new Uint8Array([255]), outside: 0 };

function fakeEditor(active: boolean) {
  const requests: WandRequest[] = [];
  const calls: Array<{ sel: Selection | null; mode: SelectionMode }> = [];
  const editor = {
    loading: false,
    pixelOps: { wandSelection: (req: WandRequest) => (requests.push(req), PICKED) },
    selection: { active, apply: (sel: Selection | null, mode: SelectionMode) => calls.push({ sel, mode }) },
  };
  return { editor: editor as unknown as Editor, requests, calls };
}

const at = (x: number, y: number, shiftKey = false, altKey = false): ToolPointer => ({
  x,
  y,
  pressure: 1,
  pointerType: "mouse",
  shiftKey,
  altKey,
  ctrlKey: false,
});

describe("magic wand", () => {
  it("defaults like the bucket and is never an Alt eyedropper", () => {
    const t = createMagicWandTool();
    expect(t.shortcut).toBe("w");
    expect((t as Tool).altEyedropper).toBeFalsy();
    expect(t.values).toEqual({ tolerance: 32, contiguous: true, antiAlias: true, sample: "all" });
  });

  it("click applies the wand coverage with the modifier mode", () => {
    const t = createMagicWandTool();
    const a = fakeEditor(false);
    t.onPointerDown(a.editor, [at(3.5, 4.5, true)]);
    expect(a.requests[0]).toEqual({ point: { x: 3.5, y: 4.5 }, tolerance: 32, contiguous: true, antiAlias: true, sample: "all" });
    expect(a.calls).toEqual([{ sel: PICKED, mode: "replace" }]);

    const b = fakeEditor(true);
    t.values.sample = "layer";
    t.onPointerDown(b.editor, [at(1, 1, false, true)]);
    expect(b.requests[0]?.sample).toBe("layer");
    expect(b.calls[0]?.mode).toBe("subtract");
    t.onPointerDown(b.editor, [at(1, 1, true, true)]);
    expect(b.calls[1]?.mode).toBe("intersect");
  });
});
