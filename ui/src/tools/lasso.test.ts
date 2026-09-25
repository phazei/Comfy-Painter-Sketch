import { describe, expect, it } from "vitest";

import type { Editor } from "../engine/editor";
import { IDENTITY_MAP } from "../engine/frameMap";
import type { Selection, SelectionMode } from "../engine/selection";
import { LassoTool, appendDecimated } from "./lasso";
import type { Tool, ToolPointer } from "./types";

type Call = { sel: Selection | null; mode: SelectionMode } | "deselect";

/** Minimal editor stand-in recording selection calls (identity map, 1:1 view). */
function fakeEditor(active: boolean) {
  const calls: Call[] = [];
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

const at = (x: number, y: number, altKey = false, shiftKey = false): ToolPointer => ({
  x,
  y,
  pressure: 1,
  pointerType: "mouse",
  shiftKey,
  altKey,
  ctrlKey: false,
});

/** Press + release at one point. */
function click(tool: LassoTool, editor: Editor, p: ToolPointer): void {
  tool.onPointerDown(editor, [p]);
  tool.onPointerUp(editor, p);
}

function overlayPoints(tool: LassoTool) {
  const o = tool.overlay();
  return o?.kind === "selection" && o.shape.kind === "polygon" ? o.shape.points : null;
}

function applied(call: Call | undefined) {
  if (!call || call === "deselect") throw new Error("expected apply");
  return call;
}

describe("appendDecimated", () => {
  it("drops points closer than the distance", () => {
    const pts = [{ x: 0, y: 0 }];
    expect(appendDecimated(pts, { x: 0.5, y: 0.5 }, 1)).toBe(false);
    expect(appendDecimated(pts, { x: 1, y: 0 }, 1)).toBe(true);
    expect(pts).toEqual([
      { x: 0, y: 0 },
      { x: 1, y: 0 },
    ]);
  });
});

describe("lasso", () => {
  it("is L and never an Alt eyedropper", () => {
    const t: Tool = new LassoTool();
    expect(t.shortcut).toBe("l");
    expect(t.altEyedropper).toBeFalsy();
  });

  it("freehand: decimates samples and closes on release", () => {
    const { editor, calls } = fakeEditor(false);
    const t = new LassoTool();
    t.onPointerDown(editor, [at(0, 0)]);
    t.onPointerMove(editor, [at(0.3, 0.2), at(10, 0), at(10.4, 0.1), at(10, 10)]);
    expect(overlayPoints(t)).toEqual([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
    ]);
    t.onPointerUp(editor, at(0, 10));
    const call = applied(calls[0]);
    expect(call.mode).toBe("replace");
    expect(call.sel?.rect).toEqual({ x: 0, y: 0, width: 10, height: 10 });
    expect(t.pending()).toBe(false);
    expect(t.overlay()).toBeNull();
  });

  it("a click without a drag deselects", () => {
    const { editor, calls } = fakeEditor(true);
    const t = new LassoTool();
    click(t, editor, at(3, 3));
    expect(calls).toEqual(["deselect"]);
  });

  it("Alt-click (no selection) builds a polygon; clicking near the start closes", () => {
    const { editor, calls } = fakeEditor(false);
    const t = new LassoTool();
    click(t, editor, at(0, 0, true));
    expect(t.pending()).toBe(true);
    t.onHover(editor, at(10, 0, true));
    expect(overlayPoints(t)?.at(-1)).toEqual({ x: 10, y: 0 });
    click(t, editor, at(10, 0, true));
    click(t, editor, at(10, 10, true));
    expect(calls).toEqual([]);
    t.onPointerDown(editor, [at(1, 1, true)]);
    expect(t.pending()).toBe(false);
    const call = applied(calls[0]);
    expect(call.mode).toBe("replace");
    expect(call.sel?.rect).toEqual({ x: 0, y: 0, width: 10, height: 10 });
  });

  it("releasing Alt with the button up closes the polygon", () => {
    const { editor, calls } = fakeEditor(false);
    const t = new LassoTool();
    click(t, editor, at(0, 0, true));
    click(t, editor, at(8, 0, true));
    click(t, editor, at(8, 8, true));
    t.onHover(editor, at(8, 8, false));
    expect(t.pending()).toBe(false);
    expect(applied(calls[0]).sel?.rect).toEqual({ x: 0, y: 0, width: 8, height: 8 });
  });

  it("a double-click closes the polygon", () => {
    let now = 0;
    const { editor, calls } = fakeEditor(false);
    const t = new LassoTool(() => now);
    click(t, editor, at(0, 0, true));
    now = 1000;
    click(t, editor, at(8, 0, true));
    now = 2000;
    click(t, editor, at(8, 8, true));
    now = 2200;
    t.onPointerDown(editor, [at(8.5, 8, true)]);
    expect(t.pending()).toBe(false);
    expect(calls.length).toBe(1);
  });

  it("Alt at pointer-down with a selection subtracts; Alt pressed again mid-drag draws straight", () => {
    const { editor, calls } = fakeEditor(true);
    const t = new LassoTool();
    t.onPointerDown(editor, [at(0, 0, true)]);
    // Alt still held from the mode press: freehand.
    t.onPointerMove(editor, [at(5, 0, true), at(10, 0, false)]);
    // Alt pressed again: rubber band only, no samples added.
    t.onPointerMove(editor, [at(12, 3, true), at(10, 10, true)]);
    expect(overlayPoints(t)).toEqual([
      { x: 0, y: 0 },
      { x: 5, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
    ]);
    // Alt released mid-drag: the straight segment ends at the cursor, freehand resumes.
    t.onPointerMove(editor, [at(10, 10, false), at(0, 10, false)]);
    t.onPointerUp(editor, at(0, 10, false));
    const call = applied(calls[0]);
    expect(call.mode).toBe("subtract");
    expect(call.sel?.rect).toEqual({ x: 0, y: 0, width: 10, height: 10 });
  });

  it("cancel drops a pending polygon", () => {
    const { editor, calls } = fakeEditor(false);
    const t = new LassoTool();
    click(t, editor, at(0, 0, true));
    click(t, editor, at(8, 0, true));
    t.onCancel();
    expect(t.pending()).toBe(false);
    expect(t.overlay()).toBeNull();
    expect(calls).toEqual([]);
  });
});
