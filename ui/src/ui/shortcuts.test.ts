import { describe, expect, it } from "vitest";

import type { Editor } from "../engine/editor";
import { REGION_TOOL_ID } from "../tools/region";
import type { EditorSession } from "../widget/sessions";
import { handleFloatShortcut, isTransformChord } from "./floatShortcuts";
import { handleOutlineNudge } from "./selectionShortcuts";
import { handleShortcut, stepHardness, stepSize } from "./shortcuts";
import type { ShortcutEffects } from "./shortcuts";

describe("Esc chain, ? and Q", () => {
  const key = (k: string, mods: Partial<KeyboardEvent> = {}): KeyboardEvent =>
    ({ key: k, code: "", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, repeat: false, ...mods }) as KeyboardEvent;

  interface State {
    help: boolean;
    popover: boolean;
    text: boolean;
    float: boolean;
    toolDrag: boolean;
    selection: boolean;
    fullscreen: boolean;
    region: boolean;
  }

  /** A session + effects stub recording what each step did. */
  function setup(initial: Partial<State>): { session: EditorSession; effects: ShortcutEffects; log: string[] } {
    const s: State = { help: false, popover: false, text: false, float: false, toolDrag: false, selection: false, fullscreen: false, region: false, ...initial };
    const log: string[] = [];
    const take = (flag: keyof State, name: string) => (): boolean => {
      if (!s[flag]) return false;
      s[flag] = false;
      log.push(name);
      return true;
    };
    const editor = {
      text: { get editing() { return s.text ? {} : null; }, commit: () => (s.text = false, log.push("text"), true) },
      float: { get active() { return s.float; }, cancel: () => (s.float = false, log.push("float")), transform: { active: false } },
      selection: { get active() { return s.selection; }, deselect: () => (s.selection = false, log.push("deselect")) },
      togglePaintTarget: () => log.push("q"),
    };
    const tools = { active: { id: s.region ? REGION_TOOL_ID : "brush", options: null }, resolve: () => ({}) };
    const effects: ShortcutEffects = {
      optionsChanged: () => undefined,
      viewChanged: () => undefined,
      cancelDrag: () => undefined,
      fullscreen: () => undefined,
      closeHelp: take("help", "help"),
      toggleHelp: () => log.push("toggleHelp"),
      closePopover: take("popover", "popover"),
      cancelToolDrag: take("toolDrag", "toolDrag"),
      exitFullscreen: take("fullscreen", "fullscreen"),
    };
    return { session: { editor, tools } as unknown as EditorSession, effects, log };
  }

  it("runs help, popover, text commit, float, tool drag, deselect, fullscreen -- one per press", () => {
    const all = { help: true, popover: true, text: true, float: true, toolDrag: true, selection: true, fullscreen: true };
    const { session, effects, log } = setup(all);
    for (let i = 0; i < 7; i++) expect(handleShortcut(key("Escape"), session, effects)).toBe(true);
    expect(handleShortcut(key("Escape"), session, effects)).toBe(false);
    expect(log).toEqual(["help", "popover", "text", "float", "toolDrag", "deselect", "fullscreen"]);
  });

  it("does not deselect in region mode", () => {
    const { session, effects, log } = setup({ selection: true, region: true });
    expect(handleShortcut(key("Escape"), session, effects)).toBe(false);
    expect(log).toEqual([]);
  });

  it("? toggles help; Q is ignored in region mode", () => {
    const normal = setup({});
    expect(handleShortcut(key("?", { shiftKey: true }), normal.session, normal.effects)).toBe(true);
    expect(handleShortcut(key("q"), normal.session, normal.effects)).toBe(true);
    expect(normal.log).toEqual(["toggleHelp", "q"]);
    const region = setup({ region: true });
    expect(handleShortcut(key("q"), region.session, region.effects)).toBe(false);
    expect(region.log).toEqual([]);
  });
});

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