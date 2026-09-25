import { describe, expect, it } from "vitest";

import type { Editor } from "../engine/editor";
import { IDENTITY_MAP } from "../engine/frameMap";
import type { Selection, SelectionMode } from "../engine/selection";
import { MARQUEE_GROUP, createMarqueeTools } from "./marquee";
import type { ToolPointer } from "./types";

/** Minimal editor stand-in recording selection calls. */
function fakeEditor(active: boolean) {
  const calls: Array<{ sel: Selection | null; mode: SelectionMode } | "deselect"> = [];
  const editor = {
    view: { current: { scale: 1, offsetX: 0, offsetY: 0 } },
    frameMap: { ...IDENTITY_MAP },
    selection: {
      active,
      apply: (sel: Selection | null, mode: SelectionMode) => calls.push({ sel, mode }),
      deselect: () => calls.push("deselect"),
    },
  };
  return { editor: editor as unknown as Editor, calls };
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

const tool = () => {
  const t = createMarqueeTools()[0];
  if (!t) throw new Error("no marquee");
  return t;
};

describe("rect marquee", () => {
  it("is in the M group and never an Alt eyedropper", () => {
    const t = tool();
    expect(MARQUEE_GROUP.toolIds).toContain(t.id);
    expect(t.shortcut).toBe("m");
    expect(t.altEyedropper).toBeFalsy();
  });

  it("drag = replace with a snapped rect", () => {
    const { editor, calls } = fakeEditor(false);
    const t = tool();
    t.onPointerDown(editor, [at(1.2, 1.2)]);
    t.onPointerMove(editor, [at(5.6, 3.4)]);
    expect(t.overlay?.()).toEqual({ kind: "selection", shape: { kind: "rect", rect: { x: 1, y: 1, width: 5, height: 2 } } });
    t.onPointerUp(editor, at(5.6, 3.4));
    const call = calls[0];
    expect(call !== "deselect" && call?.mode).toBe("replace");
    expect(call !== "deselect" && call?.sel?.rect).toEqual({ x: 1, y: 1, width: 5, height: 2 });
  });

  it("click without drag deselects; Shift-click adds nothing", () => {
    const a = fakeEditor(true);
    const t = tool();
    t.onPointerDown(a.editor, [at(3, 3)]);
    t.onPointerUp(a.editor, at(3.5, 3));
    expect(a.calls).toEqual(["deselect"]);

    const b = fakeEditor(true);
    const u = tool();
    u.onPointerDown(b.editor, [at(3, 3, true)]);
    u.onPointerUp(b.editor, at(3, 3, true));
    expect(b.calls).toEqual([]);
  });

  it("Alt at pointer-down subtracts; Shift after the start makes a square", () => {
    const { editor, calls } = fakeEditor(true);
    const t = tool();
    t.onPointerDown(editor, [at(0, 0, false, true)]);
    t.onPointerMove(editor, [at(10, 4, false, false)]);
    t.onPointerUp(editor, at(10, 4, true, false));
    const call = calls[0];
    expect(call !== "deselect" && call?.mode).toBe("subtract");
    expect(call !== "deselect" && call?.sel?.rect).toEqual({ x: 0, y: 0, width: 10, height: 10 });
  });

  it("ellipse marquee: second M-group member, AA coverage, Shift = circle", () => {
    const ellipse = createMarqueeTools()[1];
    if (!ellipse) throw new Error("no ellipse marquee");
    expect(MARQUEE_GROUP.toolIds).toEqual(["marquee-rect", "marquee-ellipse"]);
    expect(ellipse.id).toBe("marquee-ellipse");
    expect(ellipse.altEyedropper).toBeFalsy();
    const { editor, calls } = fakeEditor(false);
    ellipse.onPointerDown(editor, [at(0, 0)]);
    ellipse.onPointerMove(editor, [at(20, 8, true)]);
    expect(ellipse.overlay?.()).toEqual({ kind: "selection", shape: { kind: "ellipse", rect: { x: 0, y: 0, width: 20, height: 20 } } });
    ellipse.onPointerUp(editor, at(20, 8, true));
    const call = calls[0];
    const sel = call !== "deselect" ? call?.sel : null;
    expect(sel?.rect).toEqual({ x: 0, y: 0, width: 20, height: 20 });
    const centre = sel ? sel.data[10 * 20 + 10] : 0;
    const edge = sel ? (sel.data[10 * 20] as number) : 0;
    expect(centre).toBe(255);
    expect(edge).toBeGreaterThan(0);
    expect(edge).toBeLessThan(255);
  });

  it("Alt during the drag (no mode key) draws the ellipse from the centre", () => {
    const ellipse = createMarqueeTools()[1];
    if (!ellipse) throw new Error("no ellipse marquee");
    const { editor } = fakeEditor(false);
    ellipse.onPointerDown(editor, [at(10, 10)]);
    ellipse.onPointerMove(editor, [at(14, 12, false, true)]);
    expect(ellipse.overlay?.()).toEqual({ kind: "selection", shape: { kind: "ellipse", rect: { x: 6, y: 8, width: 8, height: 4 } } });
  });

  it("cancel drops the drag", () => {
    const { editor, calls } = fakeEditor(false);
    const t = tool();
    t.onPointerDown(editor, [at(0, 0)]);
    t.onPointerMove(editor, [at(8, 8)]);
    t.onCancel(editor);
    t.onPointerUp(editor, at(8, 8));
    expect(calls).toEqual([]);
    expect(t.overlay?.()).toBeNull();
  });
});
