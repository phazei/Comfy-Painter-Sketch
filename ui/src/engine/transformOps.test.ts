/**
 * Free Transform sessions and flips through the editor core: one
 * patch + one undo step per commit, exact cancel, identity = no step,
 * selection follow, exact flips. The test environment has no canvas: the
 * same small fake as `floatOps.test.ts` stores real RGBA bytes, and the
 * commit resample is pure typed-array code, so results compare byte for byte.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createEmptyDocument } from "../document/create";
import type { Rect } from "../geometry/rect";
import type { Editor as EditorClass } from "./editor";
import { EMPTY_LAYER_NOTE } from "./layerFlip";
import { rectSelection } from "./selection";

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

function pixels(ed: EditorClass, id: string): Uint8ClampedArray {
  return new Uint8ClampedArray((ed.layerCanvas(id) as unknown as FakeCanvas).px);
}

function rgbaAt(ed: EditorClass, id: string, x: number, y: number): number[] {
  const c = ed.layerCanvas(id) as unknown as FakeCanvas;
  const b = ed.bounds;
  const i = ((y - b.y) * c.width + (x - b.x)) * 4;
  return Array.from(c.px.subarray(i, i + 4));
}

const RED = [255, 0, 0, 255];

function alphaAt(ed: EditorClass, id: string, x: number, y: number): number {
  return rgbaAt(ed, id, x, y)[3] ?? -1;
}

// ── Sessions ──────────────────────────────────────────────────────────────────

describe("free transform sessions", () => {
  it("whole layer: the hole is live; commit is ONE undo step; undo restores bytes", () => {
    const ed = editor();
    const id = ed.doc.activeLayerId;
    fill(ed, { x: 4, y: 4, width: 4, height: 2 }, "#ff0000");
    const before = pixels(ed, id);
    const t = ed.float.transform;
    expect(t.enter()).toBe(true);
    expect(t.active).toBe(true);
    expect(t.params).toEqual({ cx: 6, cy: 5, sx: 1, sy: 1, angle: 0 });
    expect(alphaAt(ed, id, 5, 5)).toBe(0); // hole = whole content until commit
    expect(t.setField("w", 2)).toBe(true); // proportional lock on: H follows
    expect(t.params?.sy).toBe(2);
    expect(t.commit()).toBe(true);
    expect(t.active).toBe(false);
    expect(ed.float.active).toBe(false);
    // 4 x 2 at centre (6, 5) scaled 2x -> 8 x 4 from (2, 3).
    expect(rgbaAt(ed, id, 3, 4)).toEqual(RED);
    expect(rgbaAt(ed, id, 8, 5)).toEqual(RED);
    expect(alphaAt(ed, id, 9, 6)).toBeGreaterThan(0); // bilinear edge: soft, not cut
    expect(alphaAt(ed, id, 1, 4)).toBe(0);
    expect(alphaAt(ed, id, 10, 4)).toBe(0);
    ed.undo();
    expect(pixels(ed, id)).toEqual(before);
    ed.redo();
    expect(rgbaAt(ed, id, 3, 4)).toEqual(RED);
    ed.undo();
    // The next step is the helper's deselect: the transform was exactly one step.
    expect(ed.selection.current).toBeNull();
    ed.undo();
    expect(ed.selection.current).not.toBeNull();
    expect(pixels(ed, id)).toEqual(before);
  });

  it("cancel (Esc / x / Ctrl+Z) restores the bytes exactly", () => {
    const ed = editor();
    const id = ed.doc.activeLayerId;
    fill(ed, { x: 4, y: 4, width: 4, height: 2 }, "#ff0000");
    const before = pixels(ed, id);
    const t = ed.float.transform;
    t.enter();
    t.setField("angle", 30);
    t.nudge(3, 1);
    t.cancel();
    expect(t.active).toBe(false);
    expect(pixels(ed, id)).toEqual(before);
    t.enter();
    t.flip("h");
    ed.undo(); // Ctrl+Z while transforming cancels the session only
    expect(pixels(ed, id)).toEqual(before);
    expect(ed.canUndo).toBe(true);
  });

  it("an identity commit is a cancel: no undo step", () => {
    const ed = editor();
    const id = ed.doc.activeLayerId;
    fill(ed, { x: 4, y: 4, width: 4, height: 2 }, "#ff0000");
    const t = ed.float.transform;
    t.enter();
    t.flip("h");
    t.flip("h");
    expect(t.commit()).toBe(false);
    expect(rgbaAt(ed, id, 5, 5)).toEqual(RED);
    ed.undo(); // undoes the helper's deselect, not a transform step
    expect(ed.selection.current).not.toBeNull();
    expect(rgbaAt(ed, id, 5, 5)).toEqual(RED);
  });

  it("with a selection: lifts it, flips in the session, and the selection follows", () => {
    const ed = editor();
    const id = ed.doc.activeLayerId;
    fill(ed, { x: 4, y: 4, width: 2, height: 1 }, "#ff0000");
    fill(ed, { x: 6, y: 4, width: 2, height: 1 }, "#0000ff");
    select(ed, { x: 4, y: 4, width: 4, height: 1 });
    const t = ed.float.transform;
    expect(t.enter()).toBe(true);
    t.flip("h");
    t.nudge(10, 0);
    expect(t.commit()).toBe(false); // session ends, the float stays
    expect(t.active).toBe(false);
    expect(ed.float.active).toBe(true);
    expect(alphaAt(ed, id, 14, 4)).toBe(0); // not in the layer yet
    expect(ed.selection.current?.rect).toEqual({ x: 14, y: 4, width: 4, height: 1 });
    expect(ed.float.commit()).toBe(true);
    // Mirrored exactly (blue left, red right), 10 px to the right.
    expect(rgbaAt(ed, id, 14, 4)).toEqual([0, 0, 255, 255]);
    expect(rgbaAt(ed, id, 17, 4)).toEqual(RED);
    expect(alphaAt(ed, id, 4, 4)).toBe(0);
    expect(ed.selection.current?.rect).toEqual({ x: 14, y: 4, width: 4, height: 1 });
  });

  it("selection float after a transform: moves leave no hole, final commit is ONE step", () => {
    const ed = editor();
    const id = ed.doc.activeLayerId;
    fill(ed, { x: 4, y: 4, width: 2, height: 1 }, "#ff0000");
    fill(ed, { x: 6, y: 4, width: 2, height: 1 }, "#0000ff");
    select(ed, { x: 4, y: 4, width: 4, height: 1 });
    const before = pixels(ed, id);
    const t = ed.float.transform;
    t.enter();
    t.flip("h");
    t.nudge(10, 0);
    t.commit();
    expect(ed.float.nudge(0, 5)).toBe(true); // Move tool on the float
    expect(ed.selection.current?.rect).toEqual({ x: 14, y: 9, width: 4, height: 1 });
    expect(ed.float.commit()).toBe(true);
    expect(rgbaAt(ed, id, 14, 9)).toEqual([0, 0, 255, 255]);
    expect(rgbaAt(ed, id, 17, 9)).toEqual(RED);
    expect(alphaAt(ed, id, 14, 4)).toBe(0); // the transform position left nothing behind
    expect(alphaAt(ed, id, 4, 4)).toBe(0); // only the lift hole
    ed.undo();
    expect(pixels(ed, id)).toEqual(before);
    expect(ed.selection.current?.rect).toEqual({ x: 4, y: 4, width: 4, height: 1 });
  });

  it("a second transform starts from the ORIGINAL pixels (no accumulated resampling)", () => {
    const ed = editor();
    const id = ed.doc.activeLayerId;
    fill(ed, { x: 4, y: 4, width: 4, height: 4 }, "#ff0000");
    fill(ed, { x: 5, y: 5, width: 1, height: 1 }, "#0000ff");
    select(ed, { x: 4, y: 4, width: 4, height: 4 });
    const t = ed.float.transform;
    t.enter();
    t.setField("angle", 33);
    t.setField("w", 0.5);
    t.commit();
    expect(ed.float.active).toBe(true);
    expect(t.enter()).toBe(true);
    expect(t.field("angle")).toBeCloseTo(33);
    expect(t.field("w")).toBeCloseTo(0.5);
    t.setField("w", 1);
    t.setField("angle", 0);
    t.commit();
    ed.float.nudge(10, 0);
    expect(ed.float.commit()).toBe(true);
    expect(rgbaAt(ed, id, 15, 5)).toEqual([0, 0, 255, 255]); // crisp: resampled once, at identity
    expect(rgbaAt(ed, id, 14, 4)).toEqual(RED);
    expect(rgbaAt(ed, id, 17, 7)).toEqual(RED);
    expect(alphaAt(ed, id, 18, 4)).toBe(0);
  });

  it("Esc / Ctrl+Z on the float after a transform cancels back to before the lift", () => {
    const ed = editor();
    const id = ed.doc.activeLayerId;
    fill(ed, { x: 4, y: 4, width: 4, height: 2 }, "#ff0000");
    select(ed, { x: 4, y: 4, width: 4, height: 2 });
    const before = pixels(ed, id);
    const t = ed.float.transform;
    t.enter();
    t.setField("angle", 45);
    t.commit();
    ed.undo();
    expect(ed.float.active).toBe(false);
    expect(pixels(ed, id)).toEqual(before);
    expect(ed.selection.current?.rect).toEqual({ x: 4, y: 4, width: 4, height: 2 });
    t.enter();
    t.setField("w", 2);
    t.commit();
    ed.float.cancel();
    expect(pixels(ed, id)).toEqual(before);
  });

  it("drags: move rounds to whole px; the ants hide during a drag and come back", () => {
    const ed = editor();
    fill(ed, { x: 4, y: 4, width: 4, height: 4 }, "#ff0000");
    select(ed, { x: 4, y: 4, width: 4, height: 4 });
    const t = ed.float.transform;
    t.enter();
    expect(t.beginDrag({ kind: "move" }, { x: 6, y: 6 })).toBe(true);
    t.dragTo({ x: 8.4, y: 6.6 }, { shift: false, alt: false });
    expect(t.params).toMatchObject({ cx: 8, cy: 7 });
    expect(ed.selection.current).toBeNull();
    t.endDrag();
    expect(ed.selection.current?.rect).toEqual({ x: 6, y: 5, width: 4, height: 4 });
  });

  it("refuses hidden and empty layers with a note", () => {
    const ed = editor();
    const notes: string[] = [];
    ed.events.on("note", (n) => notes.push(n));
    expect(ed.float.transform.enter()).toBe(false);
    expect(notes).toEqual([EMPTY_LAYER_NOTE]);
    fill(ed, { x: 4, y: 4, width: 4, height: 4 }, "#ff0000");
    ed.layerOps.setVisible(ed.doc.activeLayerId, false);
    expect(ed.float.transform.enter()).toBe(false);
    expect(notes.length).toBe(2);
  });
});

// ── Flips without a session ───────────────────────────────────────────────────

describe("flips", () => {
  it("no selection: exact mirror of the whole layer about its content centre, one undo step", () => {
    const ed = editor();
    const id = ed.doc.activeLayerId;
    fill(ed, { x: 4, y: 4, width: 1, height: 2 }, "#ff0000");
    fill(ed, { x: 5, y: 4, width: 2, height: 2 }, "#0000ff");
    const before = pixels(ed, id);
    expect(ed.float.transform.flip("h")).toBe(true);
    expect(ed.float.active).toBe(false);
    expect(rgbaAt(ed, id, 6, 5)).toEqual(RED);
    expect(rgbaAt(ed, id, 4, 5)).toEqual([0, 0, 255, 255]);
    ed.undo();
    expect(pixels(ed, id)).toEqual(before);
  });

  it("with a selection: lifts and flips into a float that stays until committed", () => {
    const ed = editor();
    const id = ed.doc.activeLayerId;
    fill(ed, { x: 4, y: 4, width: 1, height: 2 }, "#ff0000");
    fill(ed, { x: 5, y: 4, width: 1, height: 2 }, "#0000ff");
    select(ed, { x: 4, y: 4, width: 2, height: 2 });
    expect(ed.float.transform.flip("v")).toBe(true);
    expect(ed.float.active).toBe(true);
    expect(ed.float.transform.active).toBe(false);
    ed.float.transform.flip("h");
    expect(ed.float.commit()).toBe(true);
    expect(rgbaAt(ed, id, 4, 4)).toEqual([0, 0, 255, 255]);
    expect(rgbaAt(ed, id, 5, 5)).toEqual(RED);
  });
});
