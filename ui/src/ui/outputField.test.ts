/** Input lifecycle regression tests using native EventTarget and a minimal focus/pointer DOM boundary. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyDocument } from "../document/create";
import { EditorState } from "../engine/editorState";
import { FrameOps } from "../engine/frameOps";
import { PaintOps } from "../engine/paintOps";
import { RegionOps } from "../engine/regionOps";
import { outputField } from "./outputField";

let focused: TestElement | null = null;
class TestElement extends EventTarget {
  children: TestElement[] = [];
  value = "";
  className = "";
  textContent = "";
  private captured = new Set<number>();
  get valueAsNumber(): number { return Number(this.value); }
  append(...elements: TestElement[]): void { this.children.push(...elements); }
  setAttribute(): void {}
  focus(): void { if (focused === this) return; focused?.blur(); focused = this; this.dispatchEvent(new Event("focus")); }
  blur(): void { if (focused !== this) return; focused = null; this.dispatchEvent(new Event("blur")); }
  setPointerCapture(id: number): void { this.captured.add(id); }
  hasPointerCapture(id: number): boolean { return this.captured.has(id); }
  releasePointerCapture(id: number): void { this.captured.delete(id); }
  getContext(): object {
    const values: Record<string | symbol, unknown> = { canvas: this };
    return new Proxy(values, { get: (t, k) => k in t ? t[k] : () => undefined,
      set: (t, k, v) => { t[k] = v; return true; } });
  }
}
beforeEach(() => { focused = null; vi.stubGlobal("document", { createElement: () => new TestElement() }); });
afterEach(() => vi.unstubAllGlobals());

function setup() {
  const s = new EditorState(createEmptyDocument({ width: 100, height: 100 }, "fields01"), "widgets");
  const ops = new RegionOps(s), paint = new PaintOps(s, new FrameOps(s));
  const field = outputField({ label: "Padding", ops, beforeEdit: () => {}, releaseFocus: () => {},
    bounds: () => ({ min: 0, max: 100 }), read: () => ops.options(null).cropPadding,
    write: (value) => ops.setOptions(null, { cropPadding: Number(value) }) });
  s.events.on("outputs", () => field.refresh());
  return { s, ops, paint, field };
}
function event(type: string, values: Record<string, unknown>): Event {
  return Object.assign(new Event(type, { cancelable: true }), values);
}

describe("output input sessions", () => {
  it("keeps focused text and DOM through live refresh, then commits one undo step on Enter", () => {
    const { s, ops, paint, field } = setup();
    const input = field.input;
    input.focus();
    for (const text of ["1", "12", "012"]) {
      input.value = text;
      input.dispatchEvent(new Event("input"));
      field.refresh();
      expect(input.value).toBe(text);
      expect(field.input).toBe(input);
    }
    expect(ops.options(null).cropPadding).toBe(12);
    expect(s.history.undoDepth).toBe(0);
    input.dispatchEvent(event("keydown", { key: "Enter" }));
    expect(input.value).toBe("12");
    expect(s.history.undoDepth).toBe(1);
    paint.undo();
    expect(s.doc.mainOutput).toBeUndefined();
  });

  it("Escape rolls back typed values and preserves redo; empty/invalid fields add no step", () => {
    const { s, ops, paint, field } = setup();
    ops.setOptions(null, { cropPadding: 4 });
    paint.undo();
    field.input.focus();
    field.input.value = "15";
    field.input.dispatchEvent(new Event("input"));
    field.input.dispatchEvent(event("keydown", { key: "Escape" }));
    expect(ops.options(null).cropPadding).toBe(0);
    expect(s.history.canRedo).toBe(true);
    expect(ops.active).toBe(false);
    field.input.focus();
    for (const text of ["", "invalid"]) { field.input.value = text; field.input.dispatchEvent(new Event("input")); }
    field.input.blur();
    expect(s.history.undoDepth).toBe(0);
    expect(field.input.value).toBe("0");
  });

  it("label scrub groups pointer samples and Escape stops further captured movement", () => {
    const { s, ops, paint, field } = setup();
    const label = field.element.children[0]!;
    label.dispatchEvent(event("pointerdown", { button: 0, pointerId: 1, clientX: 100 }));
    for (const x of [110, 120, 130]) label.dispatchEvent(event("pointermove", { pointerId: 1, clientX: x, shiftKey: false }));
    expect(ops.options(null).cropPadding).toBe(15);
    expect(s.history.undoDepth).toBe(0);
    label.dispatchEvent(event("pointerup", { pointerId: 1 }));
    expect(s.history.undoDepth).toBe(1);
    paint.undo();
    label.dispatchEvent(event("pointerdown", { button: 0, pointerId: 2, clientX: 100 }));
    label.dispatchEvent(event("pointermove", { pointerId: 2, clientX: 120, shiftKey: false }));
    field.input.dispatchEvent(event("keydown", { key: "Escape" }));
    label.dispatchEvent(event("pointermove", { pointerId: 2, clientX: 140, shiftKey: false }));
    label.dispatchEvent(event("pointerup", { pointerId: 2 }));
    expect(ops.options(null).cropPadding).toBe(0);
    expect(s.history.canRedo).toBe(true);
    expect(s.history.undoDepth).toBe(0);
  });

  it("dispose(false) commits a typed session as one step; a label-less field has no scrub handle", () => {
    const { s, ops, field } = setup();
    field.input.focus();
    field.input.value = "21";
    field.input.dispatchEvent(new Event("input"));
    field.dispose(false);
    expect(ops.options(null).cropPadding).toBe(21);
    expect(s.history.undoDepth).toBe(1);
    expect(ops.active).toBe(false);

    const bare = outputField({ label: "", suffix: "px", ops, beforeEdit: () => {}, releaseFocus: () => {},
      bounds: () => ({ min: 0, max: 100 }), read: () => 4, write: () => {} });
    expect(Array.from(bare.element.children, (c) => c.className)).toEqual(["", "cps-output-suffix"]);
    expect(bare.element.children[0]).toBe(bare.input);
    expect(bare.element.children[1]!.textContent).toBe("px");
  });

  it("pointer cancellation and row disposal roll back open edits", () => {
    const { s, ops, field } = setup();
    const label = field.element.children[0]!;
    label.dispatchEvent(event("pointerdown", { button: 0, pointerId: 1, clientX: 0 }));
    label.dispatchEvent(event("pointermove", { pointerId: 1, clientX: 20, shiftKey: false }));
    label.dispatchEvent(event("pointercancel", { pointerId: 1 }));
    expect(ops.active).toBe(false);
    expect(s.doc.mainOutput).toBeUndefined();
    field.input.focus();
    field.input.value = "33";
    field.input.dispatchEvent(new Event("input"));
    field.dispose();
    expect(s.doc.mainOutput).toBeUndefined();
    expect(s.history.undoDepth).toBe(0);
  });
});
