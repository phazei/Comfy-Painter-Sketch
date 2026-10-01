/**
 * Kept originals (SPEC "Free Transform and flips"): a whole-layer transform commit keeps the
 * pre-transform pixels + cumulative matrix, so repeated transforms resample
 * once from the original (5 x 10 deg == one 50 deg, byte for byte). Any
 * other edit, undo / redo or delete drops it; memory is capped. Same RGBA
 * canvas fake as `transformOps.test.ts`.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createEmptyDocument } from "../document/create";
import type { Rect } from "../geometry/rect";
import type { Editor as EditorClass } from "./editor";
import { KeptOriginals } from "./keptOriginal";
import { rectSelection } from "./selection";
import { translation } from "./transformMath";
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



// ── Tests ─────────────────────────────────────────────────────────────────────

/** One whole-layer session: rotate to `deg` (absolute session angle), commit. */
function rotateTo(ed: EditorClass, deg: number): void {
  const t = ed.float.transform;
  expect(t.enter()).toBe(true);
  expect(t.setField("angle", deg)).toBe(true);
  t.commit();
  expect(t.active).toBe(false);
}

/** Angle a new session starts with (then cancelled). */
function startAngle(ed: EditorClass): number | undefined {
  const t = ed.float.transform;
  if (!t.enter()) return undefined;
  const a = t.field("angle");
  t.cancel();
  return a;
}

/** RGB under alpha 0 is not a pixel (a real canvas stores premultiplied): zero it. */
function visible(px: Uint8ClampedArray): Uint8ClampedArray {
  for (let p = 3; p < px.length; p += 4) if (px[p] === 0) px.fill(0, p - 3, p);
  return px;
}

function shape(ed: EditorClass): void {
  fill(ed, { x: 8, y: 10, width: 12, height: 5 }, "#ff0000");
  fill(ed, { x: 8, y: 15, width: 3, height: 4 }, "#0000ff");
}

describe("kept original", () => {
  it("5 x 10 deg equals one 50 deg resample, byte for byte", () => {
    const a = editor();
    const b = editor();
    shape(a);
    shape(b);
    for (let i = 1; i <= 5; i++) rotateTo(a, i * 10);
    rotateTo(b, 50);
    expect(a.bounds).toEqual(b.bounds);
    expect(visible(pixels(a, a.doc.activeLayerId))).toEqual(visible(pixels(b, b.doc.activeLayerId)));
    expect(startAngle(a)).toBeCloseTo(50); // the box shows the cumulative transform
  });

  it("cancel / identity commit of a kept session restores the layer exactly (no step)", () => {
    const ed = editor();
    const id = ed.doc.activeLayerId;
    shape(ed);
    rotateTo(ed, 10);
    const after = pixels(ed, id);
    const t = ed.float.transform;
    t.enter();
    t.cancel();
    expect(pixels(ed, id)).toEqual(after);
    t.enter();
    expect(t.commit()).toBe(false);
    expect(pixels(ed, id)).toEqual(after);
    ed.undo(); // still the rotate step
    expect(startAngle(ed)).toBeCloseTo(0);
  });

  it("dropped after another edit of the layer", () => {
    const ed = editor();
    shape(ed);
    rotateTo(ed, 10);
    expect(startAngle(ed)).toBeCloseTo(10);
    fill(ed, { x: 1, y: 1, width: 2, height: 2 }, "#00ff00");
    expect(startAngle(ed)).toBeCloseTo(0);
  });

  it("an edit of ANOTHER layer keeps it", () => {
    const ed = editor();
    const id = ed.doc.activeLayerId;
    shape(ed);
    rotateTo(ed, 10);
    ed.layerOps.add();
    fill(ed, { x: 1, y: 1, width: 2, height: 2 }, "#00ff00");
    ed.layerOps.setActiveLayer(id);
    expect(startAngle(ed)).toBeCloseTo(10);
  });

  it("dropped on undo / redo of the commit", () => {
    const ed = editor();
    shape(ed);
    rotateTo(ed, 10);
    ed.undo();
    expect(startAngle(ed)).toBeCloseTo(0);
    ed.redo();
    expect(startAngle(ed)).toBeCloseTo(0);
  });

  it("dropped on layer delete (and not back on undo)", () => {
    const ed = editor();
    const id = ed.doc.activeLayerId;
    ed.layerOps.add();
    ed.layerOps.setActiveLayer(id);
    shape(ed);
    rotateTo(ed, 10);
    const before = ed.bytes;
    expect(ed.layerOps.remove(id)).toBe(true);
    expect(ed.bytes).toBeLessThan(before);
    ed.undo();
    ed.layerOps.setActiveLayer(id);
    expect(startAngle(ed)).toBeCloseTo(0);
  });

  it("memory cap: oldest entries are evicted; oversized entries are not kept", () => {
    const px = (n: number) => new ImageData(new Uint8ClampedArray(n * 4), n, 1);
    const entry = (n: number) => ({ pixels: px(n), area: { x: 0, y: 0, width: n, height: 1 }, m: translation(0, 0), revision: 1 });
    const kept = new KeptOriginals(100);
    kept.keep("a", entry(10)); // 40 bytes
    kept.keep("b", entry(10));
    expect(kept.bytes).toBe(80);
    kept.keep("c", entry(10)); // 120 > 100: "a" goes
    expect(kept.has("a")).toBe(false);
    expect(kept.has("b") && kept.has("c")).toBe(true);
    expect(kept.bytes).toBe(80);
    kept.keep("d", entry(30)); // alone over the cap
    expect(kept.has("d")).toBe(false);
    expect(kept.get("b", 2)).toBeNull(); // stale revision drops it
    expect(kept.bytes).toBe(40);
    kept.prune(new Set());
    expect(kept.size).toBe(0);
  });
});