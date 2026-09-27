/** Background eye -> widget value (what Python receives), and the Merge Down button predicate. */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { hasDocumentContent } from "../document/content";
import { createEmptyDocument } from "../document/create";
import { parseDocument } from "../document/parse";
import { stringifyDocument } from "../document/serialize";
import type { Editor as EditorClass } from "./editor";

function fakeCanvas(): object {
  const canvas: Record<string, unknown> = { width: 300, height: 150 };
  const fields: Record<string | symbol, unknown> = {
    canvas,
    getImageData: (_x: number, _y: number, w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
  };
  const ctx = new Proxy(fields, { get: (target, key) => key in target ? target[key] : () => undefined,
    set: (target, key, value) => { target[key] = value; return true; } });
  canvas.getContext = () => ctx;
  return canvas;
}
let Editor: typeof EditorClass;
beforeAll(async () => {
  vi.stubGlobal("document", { createElement: fakeCanvas });
  ({ Editor } = await import("./editor"));
});
afterAll(() => vi.unstubAllGlobals());

function setup(): EditorClass {
  return new Editor(createEmptyDocument({ width: 40, height: 30 }, "bgeye1"), "widgets");
}

describe("background eye reaches the widget value", () => {
  it("toggling emits change and the serialized manifest carries backgroundVisible:false", () => {
    const ed = setup();
    const onChange = vi.fn();
    ed.events.on("change", onChange);
    ed.layerOps.setBackgroundVisible(false);
    expect(onChange).toHaveBeenCalled();
    // The controller's syncValue: untouched documents serialize to "".
    expect(hasDocumentContent(ed.doc, ed.hasPaint)).toBe(true);
    const value = stringifyDocument(ed.doc);
    expect((JSON.parse(value) as Record<string, unknown>)["backgroundVisible"]).toBe(false);
    const parsed = parseDocument(value);
    expect(parsed.status === "ok" && parsed.document.backgroundVisible).toBe(false);

    ed.layerOps.setBackgroundVisible(true);
    expect(stringifyDocument(ed.doc)).not.toContain("backgroundVisible");
  });
});

describe("canMergeDown", () => {
  it("follows the Ctrl+E checks", () => {
    const ed = setup();
    expect(ed.canMergeDown()).toBe(false);
    expect(ed.layerOps.add()).toBeTruthy();
    expect(ed.canMergeDown()).toBe(true);
    const lower = ed.doc.layers[0]!;
    ed.layerOps.setLocked(lower.id, true);
    expect(ed.canMergeDown()).toBe(false);
    ed.layerOps.setLocked(lower.id, false);
    ed.layerOps.setVisible(lower.id, false);
    expect(ed.canMergeDown()).toBe(false);
  });
});
