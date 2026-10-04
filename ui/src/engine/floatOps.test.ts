/**
 * Floating selections, selection-follows-move and Merge Down (SPEC "Floating selections") through
 * the editor core. The test environment has no canvas: a small fake stores
 * real RGBA bytes (get/putImageData, clearRect, drawImage as a copy), and
 * `ImageData` is polyfilled, so pixel results can be compared byte for byte.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createEmptyDocument } from "../document/create";
import type { Rect } from "../geometry/rect";
import type { Editor as EditorClass } from "./editor";
import { compositeOver, liftPixels, mergeMaskCoverage, offsetSelection, selectionHit } from "./floatMath";
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

function fill(ed: EditorClass, rect: Rect, color: string): void {
  select(ed, rect);
  ed.selection.fillSelected(color);
}

function pixels(ed: EditorClass, id: string): Uint8ClampedArray {
  return new Uint8ClampedArray((ed.layerCanvas(id) as unknown as FakeCanvas).px);
}

function alphaAt(ed: EditorClass, id: string, x: number, y: number): number {
  const c = ed.layerCanvas(id) as unknown as FakeCanvas;
  const b = ed.bounds;
  return c.px[((y - b.y) * c.width + (x - b.x)) * 4 + 3] ?? -1;
}

function paintId(ed: EditorClass): string {
  return ed.doc.activeLayerId;
}

// ── Pure math ─────────────────────────────────────────────────────────────────

describe("floatMath", () => {
  it("lifts coverage-weighted: partial coverage lifts partially, the rest stays", () => {
    const src = new Uint8ClampedArray([10, 20, 30, 200, 10, 20, 30, 200, 10, 20, 30, 200]);
    const { float, rest } = liftPixels(src, new Uint8Array([255, 128, 0]), true);
    expect([float[3], float[7], float[11]]).toEqual([200, 100, 0]);
    expect([rest[3], rest[7], rest[11]]).toEqual([0, 100, 200]);
    expect(Array.from(float.subarray(8, 11))).toEqual([0, 0, 0]);
    const copy = liftPixels(src, new Uint8Array([255, 128, 0]), false);
    expect(Array.from(copy.rest)).toEqual(Array.from(src));
  });

  it("composites source-over with opacity at an offset", () => {
    const dst = new Uint8ClampedArray([0, 0, 255, 255, 0, 0, 0, 0]);
    compositeOver(dst, 2, 1, new Uint8ClampedArray([255, 0, 0, 255]), 1, 1, 0, 0, 0.5);
    expect(Array.from(dst.subarray(0, 4))).toEqual([128, 0, 128, 255]);
    compositeOver(dst, 2, 1, new Uint8ClampedArray([255, 0, 0, 255]), 1, 1, 1, 0);
    expect(Array.from(dst.subarray(4))).toEqual([255, 0, 0, 255]);
    compositeOver(dst, 2, 1, new Uint8ClampedArray([9, 9, 9, 255]), 1, 1, 5, 0);
    expect(Array.from(dst.subarray(4))).toEqual([255, 0, 0, 255]);
  });

  it("merges mask coverage as the union of effective coverage under the lower invert", () => {
    const px = (a: number) => new Uint8ClampedArray([255, 255, 255, a]);
    const lower = px(50);
    mergeMaskCoverage(px(200), false, lower, false);
    expect(lower[3]).toBe(200);
    const inv = px(50); // effective 205
    mergeMaskCoverage(px(200), false, inv, true);
    expect(inv[3]).toBe(50); // union 205 stored inverted
    const upInv = px(100);
    mergeMaskCoverage(px(0), true, upInv, false); // upper effective 255
    expect(upInv[3]).toBe(255);
  });

  it("offsets selections and hit-tests at 50 % coverage", () => {
    const sel = rectSelection({ x: 2, y: 2, width: 2, height: 2 });
    expect(sel).not.toBeNull();
    if (!sel) return;
    const moved = offsetSelection(sel, 3, -1);
    expect(moved.rect).toEqual({ x: 5, y: 1, width: 2, height: 2 });
    expect(moved.data).toBe(sel.data);
    expect(selectionHit(moved, 5.5, 1.5)).toBe(true);
    expect(selectionHit(moved, 2.5, 2.5)).toBe(false);
    const soft = { rect: { x: 0, y: 0, width: 2, height: 1 }, data: new Uint8Array([127, 128]), outside: 0 as const };
    expect(selectionHit(soft, 0.5, 0.5)).toBe(false);
    expect(selectionHit(soft, 1.5, 0.5)).toBe(true);
  });
});

// ── Floats ────────────────────────────────────────────────────────────────────

describe("floating selection", () => {
  it("cut + move + commit is one undo step (patch + selection) and undo restores bytes", () => {
    const ed = editor();
    const id = paintId(ed);
    fill(ed, { x: 4, y: 4, width: 4, height: 4 }, "#ff0000");
    const before = pixels(ed, id);
    const selBefore = ed.selection.current;
    expect(ed.float.lift(false)).toBe(true);
    expect(alphaAt(ed, id, 5, 5)).toBe(0); // live hole
    ed.float.nudge(10, 2);
    expect(ed.selection.current?.rect).toEqual({ x: 14, y: 6, width: 4, height: 4 });
    expect(ed.float.commit()).toBe(true);
    expect(alphaAt(ed, id, 5, 5)).toBe(0);
    expect(alphaAt(ed, id, 15, 7)).toBe(255);
    ed.undo();
    expect(pixels(ed, id)).toEqual(before);
    expect(ed.selection.current).toBe(selBefore);
    ed.redo();
    expect(alphaAt(ed, id, 15, 7)).toBe(255);
    expect(ed.selection.current?.rect.x).toBe(14);
    ed.undo();
    ed.undo(); // the fill
    expect(alphaAt(ed, id, 5, 5)).toBe(0);
  });

  it("cancel (Esc / Ctrl+Z) restores pixels and selection exactly, with no history", () => {
    const ed = editor();
    const id = paintId(ed);
    fill(ed, { x: 4, y: 4, width: 4, height: 4 }, "#00ff00");
    const before = pixels(ed, id);
    const sel = ed.selection.current;
    ed.float.lift(false);
    ed.float.nudge(3, 3);
    ed.undo(); // Ctrl+Z while floating = cancel
    expect(ed.float.active).toBe(false);
    expect(pixels(ed, id)).toEqual(before);
    expect(ed.selection.current).toBe(sel);
    ed.undo(); // now undoes the fill
    expect(alphaAt(ed, id, 5, 5)).toBe(0);
  });

  it("copy leaves the source; redo is ignored while floating", () => {
    const ed = editor();
    const id = paintId(ed);
    fill(ed, { x: 4, y: 4, width: 4, height: 4 }, "#0000ff");
    ed.float.lift(true);
    expect(alphaAt(ed, id, 5, 5)).toBe(255);
    ed.float.nudge(8, 0);
    ed.redo();
    expect(ed.float.active).toBe(true);
    ed.float.commit();
    expect(alphaAt(ed, id, 5, 5)).toBe(255);
    expect(alphaAt(ed, id, 13, 5)).toBe(255);
  });

  it("any other edit commits the float first (central hook)", () => {
    const ed = editor();
    const id = paintId(ed);
    fill(ed, { x: 4, y: 4, width: 4, height: 4 }, "#ff0000");
    ed.float.lift(false);
    ed.float.nudge(10, 0);
    ed.layerOps.add();
    expect(ed.float.active).toBe(false);
    expect(alphaAt(ed, id, 15, 5)).toBe(255);
    ed.undo(); // the add
    ed.undo(); // the float
    expect(alphaAt(ed, id, 5, 5)).toBe(255);
  });

  it("view changes keep the float unless they hide its own layer", () => {
    const ed = editor();
    const id = paintId(ed);
    const other = ed.layerOps.add();
    if (!other) throw new Error("no layer");
    ed.layerMask.add(other, "reveal");
    ed.layerOps.setActiveLayer(id);
    fill(ed, { x: 4, y: 4, width: 4, height: 4 }, "#ff0000");
    ed.float.lift(false);
    ed.float.nudge(10, 0);
    // Another row's eye, the Background eye, its lmask on/off, soloing the float's own layer.
    ed.layerOps.setVisible(other, false);
    ed.layerOps.setVisible(other, true);
    ed.layerOps.setBackgroundVisible(false);
    ed.layerOps.setBackgroundVisible(true);
    ed.layerMask.setEnabled(other, false);
    ed.toggleSolo(id);
    ed.toggleSolo(id);
    expect(ed.float.active).toBe(true);
    expect(alphaAt(ed, id, 15, 5)).toBe(0); // still floating, nothing landed
    ed.toggleSolo(other); // hides the float's layer: commits
    expect(ed.float.active).toBe(false);
    expect(alphaAt(ed, id, 15, 5)).toBe(255);
    ed.toggleSolo(other);
    ed.float.lift(false);
    ed.float.nudge(2, 0);
    ed.layerOps.setVisible(id, false); // its own eye: commits
    expect(ed.float.active).toBe(false);
  });

  it("a float left where it was lifted commits as a no-op", () => {
    const ed = editor();
    fill(ed, { x: 4, y: 4, width: 4, height: 4 }, "#ff0000");
    const id = paintId(ed);
    const before = pixels(ed, id);
    ed.float.lift(false);
    expect(ed.float.commit()).toBe(false);
    expect(pixels(ed, id)).toEqual(before);
  });

  it("an empty selection area lifts nothing", () => {
    const ed = editor();
    select(ed, { x: 1, y: 1, width: 2, height: 2 });
    expect(ed.float.lift(false)).toBe(false);
  });

  it("saving while floating sees the pre-lift pixels", () => {
    const ed = editor();
    const id = paintId(ed);
    fill(ed, { x: 4, y: 4, width: 4, height: 4 }, "#ff0000");
    ed.float.lift(false);
    ed.float.nudge(5, 0);
    const saved = ed.savedLayerCanvas(id) as unknown as FakeCanvas;
    expect(saved.px[(5 * saved.width + 5) * 4 + 3]).toBe(255);
    expect(alphaAt(ed, id, 5, 5)).toBe(0);
  });
});

// ── Selection follows layer moves ─────────────────────────────────────────────

describe("selection follows layer moves", () => {
  it("a layer drag moves the selection in the same undo step; nudges merge", () => {
    const ed = editor();
    fill(ed, { x: 4, y: 4, width: 4, height: 4 }, "#ff0000");
    select(ed, { x: 20, y: 20, width: 2, height: 2 });
    const sel = ed.selection.current;
    ed.layerMove.begin();
    ed.layerMove.preview(3, 0);
    expect(ed.selection.current?.rect.x).toBe(23); // live
    ed.layerMove.commit();
    expect(ed.selection.current?.rect.x).toBe(23);
    ed.undo();
    expect(ed.selection.current).toBe(sel);
    ed.layerMove.nudge(1, 0);
    ed.layerMove.nudge(1, 0);
    expect(ed.selection.current?.rect.x).toBe(22);
    ed.undo();
    expect(ed.selection.current).toBe(sel);
  });

  it("outline drag is one selection entry", () => {
    const ed = editor();
    select(ed, { x: 2, y: 2, width: 3, height: 3 });
    const sel = ed.selection.current;
    expect(ed.selectionMove.hit(3, 3)).toBe(true);
    ed.selectionMove.begin();
    ed.selectionMove.preview(4, 4);
    ed.selectionMove.preview(5, 5);
    ed.selectionMove.commit();
    expect(ed.selection.current?.rect).toEqual({ x: 7, y: 7, width: 3, height: 3 });
    ed.undo();
    expect(ed.selection.current).toBe(sel);
  });

  it("outline nudges merge into one selection entry; pixels stay; back to start = no step", () => {
    const ed = editor();
    fill(ed, { x: 2, y: 2, width: 3, height: 3 }, "#ff0000");
    const layer = paintId(ed);
    const px = pixels(ed, layer);
    select(ed, { x: 2, y: 2, width: 3, height: 3 });
    const sel = ed.selection.current;
    const depth = undoDepth(ed);
    expect(ed.selectionMove.nudge(1, 0)).toBe(true);
    expect(ed.selectionMove.nudge(10, 0)).toBe(true);
    expect(ed.selectionMove.nudge(0, 1)).toBe(true);
    expect(ed.selection.current?.rect).toEqual({ x: 13, y: 3, width: 3, height: 3 });
    expect(pixels(ed, layer)).toEqual(px);
    expect(undoDepth(ed)).toBe(depth + 1);
    ed.undo();
    expect(ed.selection.current).toBe(sel);
    ed.selectionMove.nudge(1, 0);
    ed.selectionMove.nudge(-1, 0);
    expect(undoDepth(ed)).toBe(depth);
    ed.selection.deselect();
    expect(ed.selectionMove.nudge(1, 0)).toBe(false);
  });
});

/** Undo depth through the internal state (the facade only exposes `canUndo`). */
function undoDepth(ed: EditorClass): number {
  return (ed as unknown as { s: { history: { undoDepth: number } } }).s.history.undoDepth;
}

// ── Merge Down ────────────────────────────────────────────────────────────────

describe("merge down", () => {
  it("bakes the upper opacity into the lower layer; one undo step", () => {
    const ed = editor();
    const lower = paintId(ed);
    fill(ed, { x: 0, y: 0, width: 4, height: 4 }, "#0000ff");
    const upper = ed.layerOps.add();
    if (!upper) throw new Error("no layer");
    fill(ed, { x: 2, y: 0, width: 4, height: 4 }, "#ff0000");
    ed.layerOps.setOpacity(upper, 0.5);
    const before = pixels(ed, lower);
    expect(ed.mergeDown()).toBe(true);
    expect(ed.doc.layers.some((l) => l.id === upper)).toBe(false);
    expect(ed.doc.activeLayerId).toBe(lower);
    const px = pixels(ed, lower);
    expect(Array.from(px.subarray((0 * 32 + 3) * 4, (0 * 32 + 3) * 4 + 4))).toEqual([128, 0, 128, 255]);
    expect(Array.from(px.subarray(5 * 4, 5 * 4 + 4))).toEqual([255, 0, 0, 128]);
    ed.undo();
    expect(ed.doc.layers.some((l) => l.id === upper)).toBe(true);
    expect(pixels(ed, lower)).toEqual(before);
  });

  it("refuses hidden rows and a bottom row with a note", () => {
    const ed = editor();
    const notes: string[] = [];
    ed.events.on("note", (n) => notes.push(n));
    expect(ed.mergeDown()).toBe(false); // nothing below Layer 1
    const upper = ed.layerOps.add();
    if (!upper) throw new Error("no layer");
    ed.layerOps.setVisible(upper, false);
    expect(ed.mergeDown()).toBe(false);
    expect(notes.length).toBe(2);
  });

  it("merges masks as a union under the lower mask's invert", () => {
    const ed = editor();
    ed.setPaintTarget("mask");
    const lowerMask = ed.maskLayer?.id ?? "";
    fill(ed, { x: 0, y: 0, width: 2, height: 1 }, "#ffffff");
    const upperMask = ed.layerOps.addMask();
    if (!upperMask) throw new Error("no mask");
    fill(ed, { x: 4, y: 0, width: 2, height: 1 }, "#ffffff");
    ed.layerOps.setMaskInvert(lowerMask, true);
    expect(ed.mergeDown()).toBe(true);
    // Lower (inverted) effective: 0 at x 0-1, 255 elsewhere; union with the upper's x 4-5,
    // stored inverted: 255 at x 0-1, 0 elsewhere.
    expect(alphaAt(ed, lowerMask, 0, 0)).toBe(255);
    expect(alphaAt(ed, lowerMask, 4, 0)).toBe(0);
    expect(alphaAt(ed, lowerMask, 2, 0)).toBe(0);
    expect(ed.maskLayer?.id).toBe(lowerMask);
  });
});
