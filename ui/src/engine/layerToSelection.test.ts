/**
 * Ctrl+click on a layer row: `SelectionOps.fromLayer` loads every pixel with
 * alpha > 0 as a full-strength selection (so moves leave no residue), combines by mode, notes on an
 * empty layer, is one history step and leaves the current layer alone.
 * Canvas fakes as in `strokeSelectionClip.test.ts`.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createEmptyDocument } from "../document/create";
import type { Editor as EditorClass } from "./editor";
import { coverageAt, rectSelection } from "./selection";
import { layerSelectMode } from "../ui/moveCursors";

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

function depth(ed: EditorClass): number {
  return (ed as unknown as { s: { history: { undoDepth: number } } }).s.history.undoDepth;
}

/** Set one pixel's alpha of a layer (document coords). */
function setAlpha(ed: EditorClass, id: string, x: number, y: number, a: number): void {
  const c = ed.layerCanvas(id) as unknown as FakeCanvas;
  const b = ed.bounds;
  const i = ((y - b.y) * c.width + (x - b.x)) * 4;
  c.px.set([255, 255, 255, a], i);
}

/** Fill a rect of a layer at alpha. */
function paintRect(ed: EditorClass, id: string, x0: number, y0: number, w: number, h: number, a = 255): void {
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) setAlpha(ed, id, x, y, a);
}

function setup(): { ed: EditorClass; id: string; notes: string[] } {
  const ed = new Editor(createEmptyDocument({ width: 32, height: 32 }), "widgets");
  const notes: string[] = [];
  ed.events.on("note", (n) => notes.push(n));
  return { ed, id: ed.doc.activeLayerId, notes };
}

const cov = (ed: EditorClass, x: number, y: number): number => coverageAt(ed.selection.current, x, y);

// ═══════════════════════════════════════════════════════════════════════════

describe("layer -> selection (Ctrl+click)", () => {
  it("loads alpha as coverage (partial kept), one history step, current layer unchanged", () => {
    const { ed, id } = setup();
    const other = ed.layerOps.add();
    expect(other).toBeTruthy();
    const active = ed.doc.activeLayerId;
    paintRect(ed, id, 2, 2, 4, 4);
    setAlpha(ed, id, 6, 2, 100);
    const steps = depth(ed);
    expect(ed.selection.fromLayer(id, "replace")).toBe(true);
    expect(depth(ed)).toBe(steps + 1);
    expect(cov(ed, 3, 3)).toBe(255);
    expect(cov(ed, 6, 2)).toBe(255); // partial alpha loads at full strength
    expect(cov(ed, 10, 10)).toBe(0);
    expect(ed.doc.activeLayerId).toBe(active);
    expect(ed.paintTarget).toBe("paint");
  });

  it("add / subtract / intersect combine with the current selection", () => {
    const { ed, id } = setup();
    paintRect(ed, id, 0, 0, 4, 4);
    const base = rectSelection({ x: 2, y: 0, width: 4, height: 4 });
    ed.selection.apply(base, "replace");
    ed.selection.fromLayer(id, "add");
    expect([cov(ed, 0, 0), cov(ed, 5, 0)]).toEqual([255, 255]);
    ed.selection.apply(base, "replace");
    ed.selection.fromLayer(id, "subtract");
    expect([cov(ed, 3, 0), cov(ed, 5, 0)]).toEqual([0, 255]);
    ed.selection.apply(base, "replace");
    ed.selection.fromLayer(id, "intersect");
    expect([cov(ed, 1, 0), cov(ed, 3, 0), cov(ed, 5, 0)]).toEqual([0, 255, 0]);
  });

  it("empty layer: note, selection and history unchanged", () => {
    const { ed, id, notes } = setup();
    ed.selection.apply(rectSelection({ x: 1, y: 1, width: 3, height: 3 }), "replace");
    const before = ed.selection.current;
    const steps = depth(ed);
    expect(ed.selection.fromLayer(id, "replace")).toBe(false);
    expect(notes).toContain("The layer has no pixels.");
    expect(ed.selection.current).toBe(before);
    expect(depth(ed)).toBe(steps);
  });

  it("inverted mask loads its effective coverage", () => {
    const { ed } = setup();
    const mask = ed.layerOps.addMask();
    expect(mask).toBeTruthy();
    if (!mask) return;
    paintRect(ed, mask, 0, 0, 2, 2);
    ed.layerOps.setMaskInvert(mask, true);
    ed.selection.fromLayer(mask, "replace");
    expect(cov(ed, 0, 0)).toBe(0);
    expect(cov(ed, 10, 10)).toBe(255);
  });

  it("mask row: soft mask pixels load at full strength", () => {
    const { ed } = setup();
    const mask = ed.layerOps.addMask();
    if (!mask) throw new Error("no mask");
    setAlpha(ed, mask, 3, 3, 40);
    ed.selection.fromLayer(mask, "replace");
    expect([cov(ed, 3, 3), cov(ed, 4, 3)]).toEqual([255, 0]);
    ed.layerOps.setMaskInvert(mask, true);
    ed.selection.fromLayer(mask, "replace");
    expect([cov(ed, 3, 3), cov(ed, 4, 3)]).toEqual([255, 255]); // effective 215 > 0
  });
});

// ── Soft strokes lift whole ───────────────────────────────────────────────────

/** A soft 5-px stroke: alpha ramps 40..255..40. */
const SOFT = [40, 128, 255, 128, 40];

function softStroke(ed: EditorClass, id: string): void {
  SOFT.forEach((a, i) => setAlpha(ed, id, 4 + i, 4, a));
}

function alphas(ed: EditorClass, id: string, x0: number): number[] {
  const c = ed.layerCanvas(id) as unknown as FakeCanvas;
  const b = ed.bounds;
  return SOFT.map((_, i) => c.px[((4 - b.y) * c.width + (x0 + i - b.x)) * 4 + 3] as number);
}

describe("layer -> selection -> move leaves no residue", () => {
  it("soft stroke loads as coverage 255 wherever alpha > 0", () => {
    const { ed, id } = setup();
    softStroke(ed, id);
    ed.selection.fromLayer(id, "replace");
    expect(SOFT.map((_, i) => cov(ed, 4 + i, 4))).toEqual([255, 255, 255, 255, 255]);
    expect(cov(ed, 3, 4)).toBe(0);
  });

  it("float move by (10,0): origin transparent, moved alpha exact", () => {
    const { ed, id } = setup();
    softStroke(ed, id);
    ed.selection.fromLayer(id, "replace");
    expect(ed.float.lift(false)).toBe(true);
    ed.float.nudge(10, 0);
    expect(ed.float.commit()).toBe(true);
    expect(alphas(ed, id, 4)).toEqual([0, 0, 0, 0, 0]);
    expect(alphas(ed, id, 14)).toEqual(SOFT);
  });

  it("transform move by (10,0): origin transparent, moved alpha exact", () => {
    const { ed, id } = setup();
    softStroke(ed, id);
    ed.selection.fromLayer(id, "replace");
    const t = ed.float.transform;
    expect(t.enter()).toBe(true);
    expect(t.nudge(10, 0)).toBe(true);
    t.commit();
    ed.float.commit();
    expect(alphas(ed, id, 4)).toEqual([0, 0, 0, 0, 0]);
    expect(alphas(ed, id, 14)).toEqual(SOFT);
  });

  it("add / subtract with a soft layer use full strength", () => {
    const { ed, id } = setup();
    softStroke(ed, id);
    ed.selection.apply(rectSelection({ x: 0, y: 0, width: 2, height: 2 }), "replace");
    ed.selection.fromLayer(id, "add");
    expect([cov(ed, 0, 0), cov(ed, 4, 4)]).toEqual([255, 255]);
    ed.selection.apply(rectSelection({ x: 0, y: 0, width: 16, height: 16 }), "replace");
    ed.selection.fromLayer(id, "subtract");
    expect([cov(ed, 0, 0), cov(ed, 4, 4), cov(ed, 6, 4)]).toEqual([255, 0, 0]);
  });
});

describe("layer row cursor mode", () => {
  it("maps modifiers to the selection mode", () => {
    expect(layerSelectMode({ ctrl: false, shift: true, alt: true })).toBeNull();
    expect(layerSelectMode({ ctrl: true, shift: false, alt: false })).toBe("replace");
    expect(layerSelectMode({ ctrl: true, shift: true, alt: false })).toBe("add");
    expect(layerSelectMode({ ctrl: true, shift: false, alt: true })).toBe("subtract");
    expect(layerSelectMode({ ctrl: true, shift: true, alt: true })).toBe("intersect");
  });
});
