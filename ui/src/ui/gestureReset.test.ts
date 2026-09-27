import { describe, expect, it, vi } from "vitest";

import type { Editor } from "../engine/editor";
import { createMoveLayerTool } from "../tools/moveLayer";
import type { ToolPointer } from "../tools/types";
import type { EditorSession } from "../widget/sessions";
import { StageInput } from "./stageInput";

function pointer(): ToolPointer {
  return { x: 5, y: 5, pressure: 1, pointerType: "mouse", shiftKey: false, altKey: false, ctrlKey: false };
}

/** Editor stand-in: a selection hit whose lift check returns `check`. */
function fakeEditor(check: "ok" | "blocked" | "confirm") {
  const log: string[] = [];
  const float = {
    active: false,
    check: () => (log.push("check"), check),
    prepareLift: () => log.push("confirm"),
    lift: () => (log.push("lift"), (float.active = true)),
    beginDrag: () => (log.push("beginDrag"), true),
    dragTo: (dx: number, dy: number) => log.push(`drag:${dx},${dy}`),
    endDrag: () => log.push("endDrag"),
    cancelDrag: () => log.push("cancelDrag"),
  };
  const editor = {
    float,
    selection: { active: true },
    selectionMove: { hit: () => true },
    layerMove: { begin: () => (log.push("layerMove"), true), preview: () => undefined, commit: () => undefined, cancel: () => undefined },
    frameMap: { scale: 1, offsetX: 0, offsetY: 0 },
    view: { current: { scale: 1, offsetX: 0, offsetY: 0 } },
  } as unknown as Editor;
  return { editor, log };
}

describe("Move tool: refused / deferred presses", () => {
  it("text layer: no lift, no layer move; the confirm is handed out once", () => {
    const { editor, log } = fakeEditor("confirm");
    const tool = createMoveLayerTool();
    tool.onPointerDown(editor, [pointer()]);
    expect(log).toEqual(["check"]);
    const action = tool.takeDeferred();
    expect(action).not.toBeNull();
    expect(tool.takeDeferred()).toBeNull();
    tool.onPointerMove(editor, [{ ...pointer(), x: 40 }]);
    tool.onPointerUp(editor, { ...pointer(), x: 40 });
    action?.();
    expect(log).toEqual(["check", "confirm"]);
  });

  it("empty / blocked lift inside the selection never falls into a layer move", () => {
    const { editor, log } = fakeEditor("blocked");
    const tool = createMoveLayerTool();
    tool.onPointerDown(editor, [pointer()]);
    tool.onPointerUp(editor, { ...pointer(), x: 40 });
    expect(log).toEqual(["check"]);
    expect(tool.takeDeferred()).toBeNull();
  });
});

// ── StageInput gesture reset ───────────────────────────────────────────────

class FakeStage {
  readonly listeners = new Map<string, (e: unknown) => void>();
  captured = new Set<number>();
  clientWidth = 100;
  clientHeight = 100;
  classList = { add: () => undefined, remove: () => undefined };
  addEventListener(type: string, fn: (e: unknown) => void): void {
    this.listeners.set(type, fn);
  }
  getBoundingClientRect() {
    return { left: 0, top: 0, width: 100, height: 100 };
  }
  setPointerCapture(id: number): void {
    this.captured.add(id);
  }
  hasPointerCapture(id: number): boolean {
    return this.captured.has(id);
  }
  releasePointerCapture(id: number): void {
    this.captured.delete(id);
  }
  fire(type: string, extra: Record<string, unknown> = {}): void {
    const e = { type, pointerId: 1, pointerType: "mouse", button: 0, buttons: 1, clientX: 5, clientY: 5, pressure: 0.5, isPrimary: true, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, preventDefault: () => undefined, stopPropagation: () => undefined, ...extra };
    this.listeners.get(type)?.(e);
  }
}

describe("StageInput: deferred press", () => {
  it("ends the gesture (capture released, not dragging) before the action; later events are ignored", () => {
    vi.stubGlobal("window", { addEventListener: () => undefined, removeEventListener: () => undefined });
    const { editor, log } = fakeEditor("confirm");
    const tool = createMoveLayerTool();
    const stage = new FakeStage();
    const dragging: boolean[] = [];
    let capturedAtConfirm: boolean | null = null;
    const original = editor.float.prepareLift.bind(editor.float);
    editor.float.prepareLift = () => {
      capturedAtConfirm = stage.hasPointerCapture(1);
      original();
    };
    const session = { editor, tools: { resolve: () => tool, active: tool } } as unknown as EditorSession;
    const input = new StageInput(stage as unknown as HTMLElement, {
      session: () => session,
      isSpaceDown: () => false,
      setDragging: (d) => dragging.push(d),
      setHover: () => undefined,
      viewChanged: () => undefined,
    });
    stage.fire("pointerdown");
    expect(capturedAtConfirm).toBe(false);
    expect(input.activeTool).toBeNull();
    expect(dragging.at(-1)).toBe(false);
    stage.fire("pointermove", { clientX: 50 });
    stage.fire("pointerup", { clientX: 60, buttons: 0 });
    expect(log).toEqual(["check", "confirm"]);
    vi.unstubAllGlobals();
  });
});
