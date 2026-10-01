/**
 * Free Transform of text layers through the editor core: uniform
 * scale -> `textData.size`, rotation -> `textData.rotation`, ONE text undo
 * step, the layer stays text; non-uniform scale / flip -> the rasterize
 * prompt (No = stay text, Yes = rasterized as its own step + a pixel
 * session). Canvas fake as in `textMove.test.ts` (fillText anchors only).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createEmptyDocument } from "../document/create";
import type { TextData } from "../document/textData";
import type { Point } from "../geometry/rect";
import { rectSelection } from "./selection";
import type { Editor as EditorClass } from "./editor";
import { apply } from "./transformMath";
import { textLayout } from "./textRender";

// ── Fake canvas ───────────────────────────────────────────────────────────────

class FakeContext {
  marks: Point[] = [];
  font = "";
  fillStyle = "";
  globalAlpha = 1;
  globalCompositeOperation = "source-over";
  textAlign = "left";
  textBaseline = "alphabetic";
  constructor(readonly canvas: FakeCanvas) {}
  save(): void {}
  restore(): void {}
  setTransform(): void {}
  clearRect(x: number, y: number, w: number, h: number): void {
    this.marks = this.marks.filter((m) => !(m.x >= x && m.x < x + w && m.y >= y && m.y < y + h));
  }
  fillText(_text: string, x: number, y: number): void {
    this.marks.push({ x, y });
  }
  measureText(line: string) {
    const width = line.length * 10;
    return {
      width,
      actualBoundingBoxLeft: 0,
      actualBoundingBoxRight: width,
      actualBoundingBoxAscent: 8,
      actualBoundingBoxDescent: 2,
      fontBoundingBoxAscent: 9,
      fontBoundingBoxDescent: 3,
    };
  }
  /** `(src, dx, dy)` or `(src, sx, sy, sw, sh, dx, dy, dw, dh)`, no scaling. */
  drawImage(src: FakeCanvas, ...a: number[]): void {
    const [sx, sy, sw, sh, dx, dy] = a.length >= 8 ? a : [0, 0, src.width, src.height, a[0] ?? 0, a[1] ?? 0];
    for (const m of src.ctx.marks) {
      if (m.x < sx! || m.y < sy! || m.x >= sx! + sw! || m.y >= sy! + sh!) continue;
      const p = { x: m.x - sx! + dx!, y: m.y - sy! + dy! };
      if (p.x >= 0 && p.y >= 0 && p.x < this.canvas.width && p.y < this.canvas.height) this.marks.push(p);
    }
  }
  getImageData(_x: number, _y: number, w: number, h: number) {
    // Opaque everywhere: a rasterized text layer has content to lift.
    return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4).fill(255) };
  }
  putImageData(): void {}
}

class FakeCanvas {
  width = 300;
  height = 150;
  readonly ctx: FakeContext = new FakeContext(this);
  getContext(): FakeContext {
    return this.ctx;
  }
}

let Editor: typeof EditorClass;

beforeAll(async () => {
  (globalThis as { document?: unknown }).document = { createElement: () => new FakeCanvas() };
  ({ Editor } = await import("./editor"));
});

afterAll(() => {
  delete (globalThis as { document?: unknown }).document;
});
(globalThis as { ImageData?: unknown }).ImageData ??= class {
  constructor(
    readonly data: Uint8ClampedArray,
    readonly width: number,
    readonly height = data.length / 4 / width,
  ) {}
};

// ── Helpers ───────────────────────────────────────────────────────────────────

const STYLE = { font: "sans-serif", size: 20, color: "#000000", bold: false, italic: false, align: "left" as const };

function setup(): { ed: EditorClass; id: string } {
  const ed = new Editor(createEmptyDocument({ width: 512, height: 512 }), "widgets");
  const id = ed.text.create({ x: 100, y: 200 }, STYLE);
  if (!id) throw new Error("text layer not created");
  ed.text.update({ text: "Hello" });
  ed.text.commit();
  return { ed, id };
}

function textOf(ed: EditorClass, id: string): TextData {
  const td = ed.doc.layers.find((l) => l.id === id)?.textData;
  if (!td) throw new Error("no text data");
  return td;
}

function kindOf(ed: EditorClass, id: string): string | undefined {
  return ed.doc.layers.find((l) => l.id === id)?.kind;
}

/** Drag the bottom-right corner handle by (dx, dy). */
function dragCorner(ed: EditorClass, dx: number, dy: number, shift: boolean): void {
  const t = ed.float.transform;
  const box = t.box();
  if (!box) throw new Error("no session");
  const corner: Point = apply(box.m, { x: box.w, y: box.h });
  expect(t.beginDrag(t.hit(corner, 4, 8), corner)).toBe(true);
  t.dragTo({ x: corner.x + dx, y: corner.y + dy }, { shift, alt: false });
  t.endDrag();
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("text transform", () => {
  it("uniform scale -> size, angle -> rotation, box centre kept; ONE text step; still text", () => {
    const { ed, id } = setup();
    ed.selection.apply(rectSelection({ x: 0, y: 0, width: 10, height: 10 }), "replace");
    const start = textOf(ed, id);
    const c = textLayout(start).centre;
    const t = ed.float.transform;
    expect(t.enter()).toBe(true);
    expect(t.textActive).toBe(true);
    expect(ed.float.active).toBe(false); // the selection is ignored: the whole text layer
    expect(t.setField("w", 2)).toBe(true);
    expect(t.field("h")).toBeCloseTo(2); // always linked for text
    expect(t.setField("angle", 30)).toBe(true);
    const live = textOf(ed, id);
    expect(live.size).toBe(40);
    expect(live.rotation).toBeCloseTo(30);
    expect(live.x).toBeCloseTo(c.x + 2 * (start.x - c.x));
    expect(live.y).toBeCloseTo(c.y + 2 * (start.y - c.y));
    expect(t.commit()).toBe(true);
    expect(t.active).toBe(false);
    expect(kindOf(ed, id)).toBe("text");
    ed.undo();
    expect(textOf(ed, id)).toEqual(start);
    ed.redo();
    expect(textOf(ed, id).size).toBe(40);
  });

  it("a move is an anchor shift; Esc / Ctrl+Z cancel restores the text", () => {
    const { ed, id } = setup();
    const start = textOf(ed, id);
    const t = ed.float.transform;
    t.enter();
    t.nudge(5, -3);
    expect(textOf(ed, id)).toMatchObject({ x: start.x + 5, y: start.y - 3, size: start.size });
    ed.undo(); // cancels the session, no history change
    expect(t.active).toBe(false);
    expect(textOf(ed, id)).toEqual(start);
  });

  it("re-entering starts from the stored rotation", () => {
    const { ed, id } = setup();
    const t = ed.float.transform;
    t.enter();
    t.setField("angle", 20);
    t.commit();
    t.enter();
    expect(t.field("angle")).toBeCloseTo(20);
    t.setField("angle", -170);
    t.commit();
    expect(textOf(ed, id).rotation).toBeCloseTo(-170);
  });

  it("non-uniform drag -> prompt after the press; No keeps the text session unchanged", () => {
    const { ed, id } = setup();
    let asked = 0;
    ed.text.setConfirmRasterize(() => (asked++, false));
    const start = textOf(ed, id);
    const t = ed.float.transform;
    t.enter();
    dragCorner(ed, 30, 0, true); // Shift = free scale
    expect(asked).toBe(0); // never during the gesture
    expect(t.pending).toBe(true);
    expect(textOf(ed, id)).toEqual(start); // the non-uniform change was never shown
    expect(t.resolvePending()).toBe(false);
    expect(asked).toBe(1);
    expect(t.textActive).toBe(true);
    expect(kindOf(ed, id)).toBe("text");
    // Flip asks too (a button click), No = nothing.
    expect(t.flip("h")).toBe(false);
    expect(asked).toBe(2);
    expect(t.textActive).toBe(true);
    // A proportional drag still works.
    dragCorner(ed, 30, 0, false);
    expect(t.pending).toBe(false);
    expect(textOf(ed, id).size).toBeGreaterThan(start.size);
  });

  it("fields: linked stays uniform; unlinked previews linked, prompts only after the field session", () => {
    const { ed, id } = setup();
    let asked = 0;
    ed.text.setConfirmRasterize(() => (asked++, false));
    const t = ed.float.transform;
    t.enter();
    // Link on: uniform, no prompt.
    expect(t.setField("w", 1.5)).toBe(true);
    expect(t.field("h")).toBeCloseTo(1.5);
    expect(t.endField()).toBe(false);
    expect(textOf(ed, id).size).toBe(30);
    // Link off: a scrub previews uniformly, no prompt mid-scrub.
    t.proportional = false;
    t.setField("w", 1.8);
    t.setField("w", 2);
    expect(t.field("h")).toBeCloseTo(2);
    expect(textOf(ed, id).size).toBe(40);
    expect(asked).toBe(0);
    expect(t.pending).toBe(false);
    // Release: reverted to the field-session start, prompt pending.
    expect(t.endField()).toBe(true);
    expect(t.pending).toBe(true);
    expect(t.field("w")).toBeCloseTo(1.5);
    expect(t.field("h")).toBeCloseTo(1.5);
    // No: stays reverted, still a text session.
    expect(t.resolvePending()).toBe(false);
    expect(asked).toBe(1);
    expect(t.textActive).toBe(true);
    expect(textOf(ed, id).size).toBe(30);
    // An unlinked edit that ends uniform keeps its value, no prompt.
    t.setField("h", 1.5);
    expect(t.endField()).toBe(false);
  });

  it("unlinked field Yes: text step + rasterize step, pixel session with the requested W / H", () => {
    const { ed, id } = setup();
    ed.text.setConfirmRasterize(() => true);
    const t = ed.float.transform;
    t.enter();
    t.proportional = false;
    t.setField("h", 3); // typed value, then Enter
    expect(t.endField()).toBe(true);
    expect(t.resolvePending()).toBe(true);
    expect(kindOf(ed, id)).toBe("paint");
    expect(t.textActive).toBe(false);
    expect(t.field("w")).toBeCloseTo(1);
    expect(t.field("h")).toBeCloseTo(3);
    t.cancel();
    ed.undo(); // rasterize step
    expect(kindOf(ed, id)).toBe("text");
  });

  it("Yes rasterizes as its own step and continues as a pixel session", () => {
    const { ed, id } = setup();
    ed.text.setConfirmRasterize(() => true);
    const start = textOf(ed, id);
    const t = ed.float.transform;
    t.enter();
    t.setField("angle", 10);
    expect(t.flip("v")).toBe(true);
    expect(kindOf(ed, id)).toBe("paint");
    expect(t.active).toBe(true);
    expect(t.textActive).toBe(false);
    expect(ed.float.active).toBe(true);
    t.cancel(); // the pixel session only
    expect(kindOf(ed, id)).toBe("paint");
    ed.undo(); // rasterize step
    expect(kindOf(ed, id)).toBe("text");
    expect(textOf(ed, id).rotation).toBeCloseTo(10);
    ed.undo(); // the text transform step
    expect(textOf(ed, id)).toEqual(start);
  });
});