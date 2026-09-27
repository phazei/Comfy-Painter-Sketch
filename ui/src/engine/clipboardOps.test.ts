/**
 * Paste placement, paste-drops-selection and copy merged under Quick Mask
 * through the editor core (M10b). The test environment has no canvas: a
 * small fake stores real RGBA bytes (drawImage copies 1:1, ignoring a
 * destination size), and `ImageData` is polyfilled.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createEmptyDocument } from "../document/create";
import type { Rect } from "../geometry/rect";
import { imageCentreDoc, unionMaskCoverage } from "./clipboardMath";
import type { Editor as EditorClass } from "./editor";
import { docToImage } from "./frameMap";
import { HIDDEN_LAYER_NOTE, LOCKED_LAYER_NOTE, SOLO_HIDDEN_NOTE } from "./editorTypes";
import { rectSelection } from "./selection";

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
  constructor(readonly canvas: FakeCanvas) {}
  save(): void {}
  restore(): void {}
  setTransform(): void {}
  fillRect(): void {}
  clearRect(): void {
    this.canvas.px.fill(0);
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
  drawImage(src: FakeCanvas, dx = 0, dy = 0): void {
    const img = src.ctx.getImageData(0, 0, src.width, src.height);
    for (let p = 0; p < img.data.length; p += 4) if (img.data[p + 3] === 0) img.data.fill(0, p, p + 4);
    const keep = this.getImageData(0, 0, this.canvas.width, this.canvas.height);
    this.putImageData(img, Math.round(dx), Math.round(dy));
    // Transparent source pixels must not erase: restore them.
    for (let y = 0; y < img.height; y++) {
      for (let x = 0; x < img.width; x++) {
        const tx = Math.round(dx) + x;
        const ty = Math.round(dy) + y;
        if (img.data[(y * img.width + x) * 4 + 3] !== 0 || tx < 0 || ty < 0 || tx >= this.canvas.width || ty >= this.canvas.height) continue;
        const i = (ty * this.canvas.width + tx) * 4;
        this.canvas.px.set(keep.data.subarray(i, i + 4), i);
      }
    }
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

/** Opaque source image. */
function solid(width: number, height: number): FakeCanvas {
  const c = new FakeCanvas();
  c.width = width;
  c.height = height;
  c.px.fill(255);
  return c;
}

/** Non-transparent bbox of a layer, document coords. */
function contentRect(ed: EditorClass, id: string): Rect {
  const c = ed.layerCanvas(id) as unknown as FakeCanvas;
  const b = ed.bounds;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let y = 0; y < c.height; y++) {
    for (let x = 0; x < c.width; x++) {
      if (!c.px[(y * c.width + x) * 4 + 3]) continue;
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
    }
  }
  return { x: b.x + x0, y: b.y + y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}

// ═══════════════════════════════════════════════════════════════════════════

describe("paste placement", () => {
  it("centres on the current image (frame map + placement), whatever the pan/zoom", () => {
    const ed = new Editor(createEmptyDocument({ width: 40, height: 30 }), "widgets");
    // Image 100 x 60: frame map scale 2, offset (10, 0); plus a Move-drawing offset.
    ed.setBackground({ kind: "fill", color: "#fff" }, { width: 100, height: 60 });
    ed.placement.set({ x: 3, y: -2, scale: 1 });
    ed.view.setStage({ width: 301, height: 199 }, 1);
    const before = imageCentreDoc(ed.imageSize, ed.frameMap);
    ed.view.wheelZoom(-120, { x: 50, y: 40 });
    ed.view.pan(-37, 23);
    const centre = imageCentreDoc(ed.imageSize, ed.frameMap);
    expect(centre).toEqual(before);
    const result = ed.clipboard.paste(solid(9, 7) as unknown as CanvasImageSource, { width: 9, height: 7 }, 1, { centre });
    expect(result).not.toBeNull();
    const rect = contentRect(ed, result!.layerId);
    expect(rect.width).toBe(9);
    expect(rect.height).toBe(7);
    const mid = docToImage(ed.frameMap, { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
    // Within half a document pixel (in image px) of the image centre (odd sizes round).
    const tol = ed.frameMap.scale / 2 + 1e-9;
    expect(Math.abs(mid.x - 50)).toBeLessThanOrEqual(tol);
    expect(Math.abs(mid.y - 30)).toBeLessThanOrEqual(tol);
  });

  it("drops the selection in the same undo step", () => {
    const ed = new Editor(createEmptyDocument({ width: 20, height: 20 }), "widgets");
    ed.selection.apply(rectSelection({ x: 2, y: 2, width: 4, height: 4 }), "replace");
    const layersBefore = ed.doc.layers.length;
    ed.clipboard.paste(solid(3, 3) as unknown as CanvasImageSource, { width: 3, height: 3 }, 1, { centre: { x: 10, y: 10 } });
    expect(ed.selection.current).toBeNull();
    expect(ed.doc.layers.length).toBe(layersBefore + 1);
    ed.undo();
    expect(ed.doc.layers.length).toBe(layersBefore);
    expect(ed.selection.current).not.toBeNull();
    ed.redo();
    expect(ed.selection.current).toBeNull();
    expect(ed.doc.layers.length).toBe(layersBefore + 1);
  });
});

describe("copy / cut gates", () => {
  const setup = (): { ed: EditorClass; id: string; notes: string[] } => {
    const ed = new Editor(createEmptyDocument({ width: 4, height: 4 }), "widgets");
    const id = ed.doc.activeLayerId as string;
    (ed.layerCanvas(id) as unknown as FakeCanvas).px.fill(255);
    ed.selection.apply(rectSelection({ x: 0, y: 0, width: 2, height: 2 }), "replace");
    const notes: string[] = [];
    ed.events.on("note", (text) => notes.push(text));
    return { ed, id, notes };
  };

  it("copy refuses a hidden layer (eye off or hidden by solo)", () => {
    const { ed, id, notes } = setup();
    ed.layerOps.setVisible(id, false);
    expect(ed.clipboard.copy(false)).toBeNull();
    expect(notes).toEqual([HIDDEN_LAYER_NOTE]);
    ed.layerOps.setVisible(id, true);
    const other = ed.layerOps.addLayer({ ...ed.doc.layers.find((l) => l.id === id)!, id: "solo", name: "Solo" });
    ed.toggleSolo(other as string);
    ed.layerOps.setActiveLayer(id);
    expect(ed.clipboard.copy(false)).toBeNull();
    expect(notes[1]).toBe(SOLO_HIDDEN_NOTE);
  });

  it("copy allows a locked layer; cut refuses it", () => {
    const { ed, id, notes } = setup();
    ed.layerOps.setLocked(id, true);
    expect(ed.clipboard.copy(false)).not.toBeNull();
    expect(ed.clipboard.cut()).toBeNull();
    expect(notes).toEqual([LOCKED_LAYER_NOTE]);
  });
});

describe("copy merged under Quick Mask", () => {
  it("copies the visible masks' effective union as gray, within the selection", () => {
    const ed = new Editor(createEmptyDocument({ width: 4, height: 1 }), "widgets");
    ed.setPaintTarget("mask");
    const a = ed.layerOps.addMask();
    const b = ed.layerOps.addMask();
    expect(a && b).toBeTruthy();
    const masks = ed.doc.layers.filter((l) => l.kind === "mask");
    const write = (id: string, alpha: number[]): void => {
      const px = new Uint8ClampedArray(alpha.flatMap((v) => [255, 255, 255, v]));
      (ed.layerCanvas(id) as unknown as FakeCanvas).ctx.putImageData(new FakeImageData(px, alpha.length, 1), -ed.bounds.x, -ed.bounds.y);
    };
    for (const m of masks) write(m.id, [0, 0, 0, 0]);
    write(a as string, [200, 0, 0, 0]);
    write(b as string, [0, 0, 255, 0]);
    ed.layerOps.setMaskInvert(b as string, true); // effective 255, 255, 0, 255
    ed.selection.apply(rectSelection({ x: 0, y: 0, width: 3, height: 1 }), "replace");
    const clip = ed.clipboard.copy(true);
    expect(clip).not.toBeNull();
    const gray = Array.from(clip!.data.data).filter((_, i) => i % 4 === 0);
    const alpha = Array.from(clip!.data.data).filter((_, i) => i % 4 === 3);
    expect(gray).toEqual([255, 255, 0]);
    expect(alpha).toEqual([255, 255, 255]);
  });

  it("unionMaskCoverage treats pixels outside the read rect as uncovered (255 inverted)", () => {
    const area = { x: 0, y: 0, width: 3, height: 1 };
    const union = new Uint8Array(3);
    unionMaskCoverage(union, area, { x: 1, y: 0, width: 1, height: 1 }, new Uint8ClampedArray([0, 0, 0, 100]), false);
    expect(Array.from(union)).toEqual([0, 100, 0]);
    unionMaskCoverage(union, area, { x: 1, y: 0, width: 1, height: 1 }, new Uint8ClampedArray([0, 0, 0, 200]), true);
    expect(Array.from(union)).toEqual([255, 100, 255]);
  });
});
