/**
 * Text layer moves through the editor core with bounds growth, undo/redo and
 * restore of layer files saved before a bounds growth. The test environment
 * has no canvas, so a minimal fake records `fillText` anchors ("marks") and
 * carries them through `drawImage` / `clearRect`: enough to check where text
 * pixels sit in document coords.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createEmptyDocument } from "../document/create";
import type { TextData } from "../document/textData";
import type { Point } from "../geometry/rect";
import type { Editor as EditorClass } from "./editor";

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
    return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
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

// ── Helpers ───────────────────────────────────────────────────────────────────

const STYLE = { font: "sans-serif", size: 20, color: "#000000", bold: false, italic: false, align: "left" as const };

function addText(ed: EditorClass, at: Point, text: string): string {
  const id = ed.text.create(at, STYLE);
  if (!id) throw new Error("text layer not created");
  ed.text.update({ text });
  ed.text.commit();
  return id;
}

function textOf(ed: EditorClass, id: string): TextData {
  const td = ed.doc.layers.find((l) => l.id === id)?.textData;
  if (!td) throw new Error("no text data");
  return td;
}

/** Document positions of the text anchors painted in a layer. */
function inkAnchors(ed: EditorClass, id: string): Point[] {
  const canvas = ed.layerCanvas(id) as unknown as FakeCanvas;
  const b = ed.bounds;
  return canvas.ctx.marks.map((m) => ({ x: m.x + b.x, y: m.y + b.y }));
}

function drag(ed: EditorClass, id: string, dx: number, dy: number): boolean {
  ed.layerOps.setActiveLayer(id);
  if (!ed.layerMove.begin()) return false;
  ed.layerMove.preview(dx, dy);
  return ed.layerMove.commit();
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("text layer move", () => {
  it("re-renders at the new anchor after growing bounds; undo/redo restore exactly", () => {
    const ed = new Editor(createEmptyDocument({ width: 512, height: 512 }), "widgets");
    const id = addText(ed, { x: 100, y: 200 }, "Hello");
    expect(inkAnchors(ed, id)).toEqual([{ x: 100, y: 200 }]);

    expect(drag(ed, id, -400, -450)).toBe(true);
    expect(ed.bounds.x).toBeLessThan(0);
    expect(ed.bounds.y).toBeLessThan(0);
    expect(textOf(ed, id)).toMatchObject({ x: -300, y: -250 });
    expect(inkAnchors(ed, id)).toEqual([{ x: -300, y: -250 }]);

    ed.undo();
    expect(textOf(ed, id)).toMatchObject({ x: 100, y: 200 });
    expect(inkAnchors(ed, id)).toEqual([{ x: 100, y: 200 }]);
    ed.redo();
    expect(inkAnchors(ed, id)).toEqual([{ x: -300, y: -250 }]);
  });

  it("moving one text layer past the edge leaves the others in place", () => {
    const ed = new Editor(createEmptyDocument({ width: 512, height: 512 }), "widgets");
    const a = addText(ed, { x: 100, y: 200 }, "A");
    const b = addText(ed, { x: 300, y: 400 }, "B");
    drag(ed, a, -400, -400);
    expect(inkAnchors(ed, b)).toEqual([{ x: 300, y: 400 }]);
    drag(ed, b, 10, 10);
    expect(inkAnchors(ed, b)).toEqual([{ x: 310, y: 410 }]);
  });
});

describe("bounds growth and saved layer files", () => {
  it("marks every layer with content for re-upload (its file no longer matches bounds)", () => {
    const ed = new Editor(createEmptyDocument({ width: 512, height: 512 }), "widgets");
    const a = addText(ed, { x: 100, y: 200 }, "A");
    const b = addText(ed, { x: 300, y: 400 }, "B");
    for (const id of [a, b]) ed.markUploaded(id, ed.layerRuntime(id)?.version ?? -1, `painter-sketch/${id}.webp [input]`);
    expect(ed.dirty).toBe(false);

    drag(ed, a, -400, -400);
    expect(ed.layerRuntime(b)?.dirty).toBe(true);
  });

  it("restores a text layer whose file predates a bounds growth at its textData position", () => {
    // Saved state: bounds grew to the top-left after B's file was uploaded
    // at the old 512x512 bounds (origin 0,0).
    const doc = createEmptyDocument({ width: 512, height: 512 });
    doc.bounds = { x: -256, y: -256, width: 768, height: 768 };
    const td: TextData = { ...STYLE, text: "B", x: 300, y: 400 };
    doc.layers.push({ id: "tb", name: "B", kind: "text", visible: true, locked: false, opacity: 1, blendMode: "normal", file: "painter-sketch/b.webp [input]", textData: td });
    const ed = new Editor(doc, "document");
    const stale = new FakeCanvas();
    stale.width = 512;
    stale.height = 512;
    stale.ctx.marks.push({ x: 300, y: 400 });

    ed.beginLoading();
    ed.restoreLayerPixels("tb", stale as unknown as HTMLCanvasElement);
    ed.endLoading();
    expect(inkAnchors(ed, "tb")).toEqual([{ x: 300, y: 400 }]);

    // First move: no jump.
    drag(ed, "tb", 5, 5);
    expect(inkAnchors(ed, "tb")).toEqual([{ x: 305, y: 405 }]);
  });
});
