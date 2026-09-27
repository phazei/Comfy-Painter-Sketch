/**
 * Strokes under a selection: bounds grow only where the selection can let
 * paint through, and a stroke that changes no pixel is no undo step and
 * leaves the layer clean. The test environment has no canvas: a minimal fake
 * stores RGBA bytes (drawImage copies 1:1), `ImageData` is polyfilled.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createEmptyDocument } from "../document/create";
import type { Dab } from "./brush";
import type { Editor as EditorClass } from "./editor";
import { invertSelection, rectSelection } from "./selection";
import type { Selection } from "./selection";

// ── Fakes ─────────────────────────────────────────────────────────────────────

class FakeImageData {
  readonly data: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
  constructor(a: Uint8ClampedArray | number, b: number, c?: number) {
    this.data = typeof a === "number" ? new Uint8ClampedArray(a * b * 4) : a;
    this.width = typeof a === "number" ? a : b;
    this.height = typeof a === "number" ? b : (c ?? a.length / 4 / b);
  }
}

class FakeContext {
  globalAlpha = 1;
  globalCompositeOperation = "source-over";
  constructor(readonly canvas: FakeCanvas) {}
  save(): void {}
  restore(): void {}
  setTransform(): void {}
  beginPath(): void {}
  rect(): void {}
  clip(): void {}
  fillRect(): void {}
  clearRect(): void {
    this.canvas.px.fill(0);
  }
  createImageData(w: number, h: number): FakeImageData {
    return new FakeImageData(w, h);
  }
  getImageData(x: number, y: number, w: number, h: number): FakeImageData {
    const c = this.canvas;
    const out = new Uint8ClampedArray(w * h * 4);
    for (let yy = 0; yy < h; yy++) {
      for (let xx = 0; xx < w; xx++) {
        const sx = x + xx;
        const sy = y + yy;
        if (sx >= 0 && sy >= 0 && sx < c.width && sy < c.height) out.set(c.px.subarray((sy * c.width + sx) * 4, (sy * c.width + sx) * 4 + 4), (yy * w + xx) * 4);
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
        if (dx >= 0 && dy >= 0 && dx < c.width && dy < c.height) c.px.set(img.data.subarray((yy * img.width + xx) * 4, (yy * img.width + xx) * 4 + 4), (dy * c.width + dx) * 4);
      }
    }
  }
  drawImage(src: FakeCanvas): void {
    // Source-over of opaque-ish source pixels, 1:1 (enough for "did anything change").
    const n = Math.min(src.px.length, this.canvas.px.length);
    for (let p = 0; p < n; p += 4) if (src.px[p + 3]) this.canvas.px.set(src.px.subarray(p, p + 4), p);
  }
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

const STYLE = { mode: "paint", opacity: 1, hardness: 1, color: "#ff0000" } as const;

/** Undo depth through the internal state (the facade only exposes `canUndo`). */
function depth(ed: EditorClass): number {
  return (ed as unknown as { s: { history: { undoDepth: number } } }).s.history.undoDepth;
}

/** One stroke of full-flow dabs. */
function stroke(ed: EditorClass, points: readonly [number, number][]): void {
  expect(ed.beginStroke(STYLE, 10)).toBe(true);
  const dabs: Dab[] = points.map(([x, y]) => ({ x, y, size: 10, alpha: 1, cap: 1 }));
  ed.addDabs(dabs);
  ed.endStroke(null);
}

/** 64 x 64 editor with a selection, all layers clean. */
function setup(sel: Selection | null): EditorClass {
  const ed = new Editor(createEmptyDocument({ width: 64, height: 64 }), "widgets");
  ed.selection.apply(sel, "replace");
  return ed;
}

// ═══════════════════════════════════════════════════════════════════════════

describe("strokes clipped by a selection", () => {
  it("fully outside: no growth, no undo step, layer not dirty", () => {
    const ed = setup(rectSelection({ x: 0, y: 0, width: 64, height: 64 }));
    const bounds = ed.bounds;
    const steps = depth(ed);
    stroke(ed, [[-100, 32], [-80, 32]]);
    stroke(ed, [[32, 200]]);
    expect(ed.bounds).toEqual(bounds);
    expect(depth(ed)).toBe(steps);
    expect(ed.dirty).toBe(false);
  });

  it("partly inside: growth limited to the selection extent", () => {
    const ed = setup(rectSelection({ x: 0, y: 0, width: 100, height: 64 }));
    const steps = depth(ed);
    stroke(ed, [[90, 32], [600, 32], [-400, 32]]);
    const b = ed.bounds;
    expect(b.x).toBe(0);
    expect(b.x + b.width).toBeGreaterThanOrEqual(100);
    expect(b.x + b.width).toBeLessThan(600);
    expect(depth(ed)).toBe(steps + 1);
  });

  it("inverted selection: everything outside its rect is paintable, so bounds grow there", () => {
    const ed = setup(invertSelection(rectSelection({ x: 0, y: 0, width: 64, height: 64 })));
    // (The 3x-frame cap limits growth to x = -64.)
    stroke(ed, [[-40, 32]]);
    expect(ed.bounds.x).toBeLessThanOrEqual(-45);
  });
});
