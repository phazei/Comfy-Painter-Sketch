import { describe, expect, it } from "vitest";

import type { Editor } from "../engine/editor";
import { handleFloatShortcut, isTransformChord } from "./floatShortcuts";
import { handleOutlineNudge } from "./selectionShortcuts";
import { stepHardness, stepSize } from "./shortcuts";

describe("bracket steps", () => {
  it("steps size finer for small brushes and clamps", () => {
    expect(stepSize(5, true)).toBe(6);
    expect(stepSize(10, true)).toBe(15);
    expect(stepSize(15, false)).toBe(10);
    expect(stepSize(10, false)).toBe(9);
    expect(stepSize(1, false)).toBe(1);
    expect(stepSize(1000, true)).toBe(1000);
    // Shape widths: same steps, capped at 500.
    expect(stepSize(480, true, 500)).toBe(500);
    expect(stepSize(500, false, 500)).toBe(450);
  });

  it("steps hardness by 25%", () => {
    expect(stepHardness(0.8, true)).toBe(1);
    expect(stepHardness(0.5, false)).toBe(0.25);
    expect(stepHardness(0, false)).toBe(0);
  });
});

describe("free transform chord", () => {
  const key = (k: string, mods: Partial<KeyboardEvent>): KeyboardEvent =>
    ({ key: k, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods }) as KeyboardEvent;

  it("is Ctrl+Alt+T only (Ctrl+T reaches the browser; AltGr characters never match)", () => {
    expect(isTransformChord(key("t", { ctrlKey: true, altKey: true }))).toBe(true);
    expect(isTransformChord(key("T", { ctrlKey: true, altKey: true }))).toBe(true);
    expect(isTransformChord(key("t", { ctrlKey: true }))).toBe(false);
    expect(isTransformChord(key("t", { ctrlKey: true, altKey: true, shiftKey: true }))).toBe(false);
    expect(isTransformChord(key("ţ", { ctrlKey: true, altKey: true }))).toBe(false);
  });
});

describe("float arrow nudge (any tool)", () => {
  const key = (k: string, mods: Partial<KeyboardEvent> = {}): KeyboardEvent =>
    ({ key: k, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, repeat: false, ...mods }) as KeyboardEvent;

  /** Minimal editor: a float (optional), a transform session flag, a 1:1 frame map. */
  function stub(floating: boolean, transforming = false): { editor: Editor; nudges: [number, number][] } {
    const nudges: [number, number][] = [];
    const editor = {
      frameMap: { scale: 1 },
      float: {
        active: floating,
        nudge: (dx: number, dy: number) => (nudges.push([dx, dy]), floating),
        transform: { active: transforming },
      },
    } as unknown as Editor;
    return { editor, nudges };
  }
  const effects = { cancelDrag: () => undefined };

  it("nudges an existing float 1 px, Shift 10 px", () => {
    const { editor, nudges } = stub(true);
    expect(handleFloatShortcut(key("ArrowLeft"), editor, effects)).toBe(true);
    expect(handleFloatShortcut(key("ArrowDown", { shiftKey: true }), editor, effects)).toBe(true);
    expect(nudges).toEqual([[-1, 0], [0, 10]]);
  });

  it("leaves arrows alone without a float, during a transform session, or with Ctrl / Alt", () => {
    const none = stub(false);
    expect(handleFloatShortcut(key("ArrowUp"), none.editor, effects)).toBe(false);
    const session = stub(true, true);
    expect(handleFloatShortcut(key("ArrowUp"), session.editor, effects)).toBe(false);
    const float = stub(true);
    expect(handleFloatShortcut(key("ArrowUp", { altKey: true }), float.editor, effects)).toBe(false);
    expect(handleFloatShortcut(key("ArrowUp", { ctrlKey: true }), float.editor, effects)).toBe(false);
    expect([...none.nudges, ...session.nudges, ...float.nudges]).toEqual([]);
  });
});

describe("selection outline arrow nudge (selection tools)", () => {
  const key = (k: string, mods: Partial<KeyboardEvent> = {}): KeyboardEvent =>
    ({ key: k, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, repeat: false, ...mods }) as KeyboardEvent;

  function stub(selected: boolean): { editor: Editor; nudges: [number, number][] } {
    const nudges: [number, number][] = [];
    const editor = {
      frameMap: { scale: 1 },
      selection: { active: selected },
      selectionMove: { nudge: (dx: number, dy: number) => (nudges.push([dx, dy]), true) },
    } as unknown as Editor;
    return { editor, nudges };
  }

  it("nudges the outline 1 px (Shift 10) with a selection tool and a selection; the key counts as used", () => {
    const { editor, nudges } = stub(true);
    const marquee = { combinesSelection: true };
    expect(handleOutlineNudge(key("ArrowRight"), marquee, editor)).toBe(true);
    expect(handleOutlineNudge(key("ArrowUp", { shiftKey: true }), marquee, editor)).toBe(true);
    expect(nudges).toEqual([[1, 0], [0, -10]]);
  });

  it("not without a selection, with another tool, or while a lasso polygon is pending", () => {
    const none = stub(false);
    expect(handleOutlineNudge(key("ArrowRight"), { combinesSelection: true }, none.editor)).toBe(false);
    const sel = stub(true);
    expect(handleOutlineNudge(key("ArrowRight"), {}, sel.editor)).toBe(false);
    expect(handleOutlineNudge(key("ArrowRight"), { combinesSelection: true, pending: () => true }, sel.editor)).toBe(false);
    expect(handleOutlineNudge(key("a"), { combinesSelection: true }, sel.editor)).toBe(false);
    expect([...none.nudges, ...sel.nudges]).toEqual([]);
  });

  it("while a tool press is in progress the key is swallowed but the outline does not move", () => {
    const sel = stub(true);
    expect(handleOutlineNudge(key("ArrowRight"), { combinesSelection: true }, sel.editor, true)).toBe(true);
    expect(sel.nudges).toEqual([]);
  });
});