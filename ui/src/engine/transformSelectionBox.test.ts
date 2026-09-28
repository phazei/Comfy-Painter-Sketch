/**
 * Free Transform / float over a selection larger than the painted content:
 * the box is the selection bbox and the selection keeps its exact shape
 * (the original coverage carried through the matrix, never pixel alpha).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createEmptyDocument } from "../document/create";
import type { Rect } from "../geometry/rect";
import type { Editor as EditorClass } from "./editor";
import { coverageFor, rectSelection, selectionFromCoverage } from "./selection";
import type { Selection } from "./selection";
import { offsetSelection } from "./floatMath";
import { transformSelection } from "./transformResample";
import { paramsMatrix } from "./transformMath";

// ── Fakes ─────────────────────────────────────────────────────────────────────

class FakeImageData {
  readonly data: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
  /** (data, w, h?) or (w, h), like the DOM constructor. */
  constructor(a: Uint8ClampedArray | number, b: number, c?: number) {
    if (typeof a === "number") {
      this.width = a;
      this.height = b;
      this.data = new Uint8ClampedArray(a * b * 4);
    } else {
      this.width = b;
      this.height = c ?? a.length / 4 / b;
      this.data = a;
    }
  }
}

class FakeContext {
  globalAlpha = 1;
  globalCompositeOperation = "source-over";
  constructor(readonly canvas: FakeCanvas) {}
  save(): void {}
  restore(): void {}
  setTransform(): void {}
  clearRect(x: number, y: number, w: number, h: number): void {
    const c = this.canvas;
    for (let yy = Math.max(0, y); yy < Math.min(c.height, y + h); yy++) {
      for (let xx = Math.max(0, x); xx < Math.min(c.width, x + w); xx++) c.px.fill(0, (yy * c.width + xx) * 4, (yy * c.width + xx) * 4 + 4);
    }
  }
  getImageData(x: number, y: number, w: number, h: number): FakeImageData {
    const c = this.canvas;
    const out = new Uint8ClampedArray(w * h * 4);
    for (let yy = 0; yy < h; yy++) {
      for (let xx = 0; xx < w; xx++) {
        const sx = x + xx;
        const sy = y + yy;
        if (sx < 0 || sy < 0 || sx >= c.width || sy >= c.height) continue;
        out.set(c.px.subarray((sy * c.width + sx) * 4, (sy * c.width + sx) * 4 + 4), (yy * w + xx) * 4);
      }
    }
    return new FakeImageData(out, w, h);
  }
  putImageData(img: FakeImageData, x: number, y: number): void {
    const c = this.canvas;
    for (let yy = 0; yy < img.height; yy++) {
      for (let xx = 0; xx < img.width; xx++) {
        const dx = x + xx;
        const dy = y + yy;
        if (dx < 0 || dy < 0 || dx >= c.width || dy >= c.height) continue;
        c.px.set(img.data.subarray((yy * img.width + xx) * 4, (yy * img.width + xx) * 4 + 4), (dy * c.width + dx) * 4);
      }
    }
  }
  createImageData(w: number, h: number): FakeImageData {
    return new FakeImageData(new Uint8ClampedArray(w * h * 4), w, h);
  }
  /** `(src, dx, dy)` only: copies non-transparent pixels (enough for rebase / preview). */
  drawImage(src: FakeCanvas, dx = 0, dy = 0): void {
    const img = src.ctx.getImageData(0, 0, src.width, src.height);
    for (let p = 3; p < img.data.length; p += 4) if (img.data[p] === 0) img.data.fill(0, p - 3, p);
    const c = this.canvas;
    for (let yy = 0; yy < img.height; yy++) {
      for (let xx = 0; xx < img.width; xx++) {
        const s = (yy * img.width + xx) * 4;
        if (img.data[s + 3] === 0) continue;
        const tx = dx + xx;
        const ty = dy + yy;
        if (tx < 0 || ty < 0 || tx >= c.width || ty >= c.height) continue;
        c.px.set(img.data.subarray(s, s + 4), (ty * c.width + tx) * 4);
      }
    }
  }
  beginPath(): void {}
  rect(): void {}
  clip(): void {}
  fillRect(): void {}
}

class FakeCanvas {
  private w = 300;
  private h = 150;
  px = new Uint8ClampedArray(300 * 150 * 4);
  readonly ctx: FakeContext = new FakeContext(this);
  get width(): number { return this.w; }
  set width(v: number) { this.w = v; this.px = new Uint8ClampedArray(this.w * this.h * 4); }
  get height(): number { return this.h; }
  set height(v: number) { this.h = v; this.px = new Uint8ClampedArray(this.w * this.h * 4); }
  getContext(): FakeContext { return this.ctx; }
}

let Editor: typeof EditorClass;

beforeAll(async () => {
  (globalThis as { document?: unknown }).document = { createElement: () => new FakeCanvas() };
  (globalThis as { ImageData?: unknown }).ImageData = FakeImageData;
  ({ Editor } = await import("./editor"));
});

afterAll(() => {
  delete (globalThis as { document?: unknown }).document;
  delete (globalThis as { ImageData?: unknown }).ImageData;
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function editor(): EditorClass {
  return new Editor(createEmptyDocument({ width: 32, height: 32 }), "widgets");
}

function select(ed: EditorClass, rect: Rect): void {
  ed.selection.apply(rectSelection(rect), "replace");
}

/** Fill a rect on the active layer, then drop the selection. */
function fill(ed: EditorClass, rect: Rect, color: string): void {
  select(ed, rect);
  ed.selection.fillSelected(color);
  ed.selection.deselect();
}



/** Lasso-like selection: a diamond over (2..17, 2..17), soft edge values included. */
function lasso(): Selection {
  const rect = { x: 2, y: 2, width: 16, height: 16 };
  const data = new Uint8Array(rect.width * rect.height);
  for (let y = 0; y < rect.height; y++) {
    for (let x = 0; x < rect.width; x++) {
      const d = Math.abs(x - 7.5) + Math.abs(y - 7.5);
      data[y * rect.width + x] = d <= 7 ? 255 : d <= 8 ? 128 : 0;
    }
  }
  return selectionFromCoverage(data, rect) as Selection;
}

function setup(): { ed: EditorClass; sel: Selection; historyEvents: () => number } {
  const ed = editor();
  fill(ed, { x: 8, y: 8, width: 3, height: 2 }, "#ff0000");
  const sel = lasso();
  ed.selection.apply(sel, "replace");
  let n = 0;
  ed.events.on("history", () => n++);
  return { ed, sel: ed.selection.current as Selection, historyEvents: () => n };
}

describe("selection bigger than its content", () => {
  it("the transform box is the selection bbox, not the content bbox", () => {
    const { ed, sel } = setup();
    const t = ed.float.transform;
    expect(t.enter()).toBe(true);
    const box = t.box();
    expect(box).not.toBeNull();
    expect({ x: box?.m.e, y: box?.m.f, width: box?.w, height: box?.h }).toEqual(sel.rect);
    expect(t.params).toMatchObject({ cx: sel.rect.x + sel.rect.width / 2, cy: sel.rect.y + sel.rect.height / 2 });
    expect(ed.selection.current).toBe(sel);
  });

  it("pointer-down without a move changes nothing (selection object, history)", () => {
    const { ed, sel, historyEvents } = setup();
    const t = ed.float.transform;
    t.enter();
    const events = historyEvents();
    const canUndo = ed.canUndo;
    expect(t.beginDrag({ kind: "rotate" }, { x: 20, y: 2 })).toBe(true);
    expect(ed.selection.current).toBe(sel);
    t.dragTo({ x: 20, y: 2 }, { shift: false, alt: false });
    expect(ed.selection.current).toBe(sel);
    t.endDrag();
    expect(ed.selection.current).toBe(sel);
    expect(t.commit()).toBe(false);
    expect(ed.selection.current).toBe(sel);
    expect(historyEvents()).toBe(events);
    expect(ed.canUndo).toBe(canUndo);
  });

  it("rotate 30 deg: the selection is the ORIGINAL coverage transformed, before and after the commit", () => {
    const { ed, sel } = setup();
    const t = ed.float.transform;
    t.enter();
    t.setField("angle", 30);
    const p = t.params;
    if (!p) throw new Error("no session");
    const m = paramsMatrix(p, sel.rect.width, sel.rect.height);
    const expected = transformSelection(sel, sel.rect, m);
    expect(Array.from(ed.selection.current?.data ?? [])).toEqual(Array.from(expected?.data ?? [1]));
    expect(ed.selection.current?.rect).toEqual(expected?.rect);
    t.commit();
    expect(ed.float.commit()).toBe(true);
    expect(ed.selection.current?.rect).toEqual(expected?.rect);
    expect(Array.from(ed.selection.current?.data ?? [])).toEqual(Array.from(expected?.data ?? [1]));
  });

  it("M10 float (Move tool): the selection moves exactly, shape kept", () => {
    const { ed, sel } = setup();
    expect(ed.float.lift(false)).toBe(true);
    expect(ed.float.state?.area).toEqual(sel.rect);
    ed.float.nudge(3, 2);
    const want = offsetSelection(sel, 3, 2);
    expect(ed.selection.current?.rect).toEqual(want.rect);
    expect(coverageFor(ed.selection.current as Selection, want.rect)).toEqual(coverageFor(want, want.rect));
    expect(ed.float.commit()).toBe(true);
    expect(coverageFor(ed.selection.current as Selection, want.rect)).toEqual(coverageFor(want, want.rect));
  });

  it("whole-layer sessions keep the content bbox", () => {
    const ed = editor();
    fill(ed, { x: 8, y: 8, width: 3, height: 2 }, "#ff0000");
    const t = ed.float.transform;
    t.enter();
    expect({ x: t.box()?.m.e, y: t.box()?.m.f, w: t.box()?.w, h: t.box()?.h }).toEqual({ x: 8, y: 8, w: 3, h: 2 });
  });
});
