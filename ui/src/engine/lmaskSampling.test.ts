/**
 * What the paint bucket and magic wand sample around layer masks
 * (Photoshop-checked): in the lmask-only view only the mask's grayscale,
 * whatever the sample option; otherwise "Current layer" = the layer's raw
 * pixels (lmask not applied) and "All layers" = the composite with lmasks
 * applied -- for both the pixel and the mask target. The bucket on a
 * targeted mask floods (tolerance / contiguous / selection clip) and paints
 * the foreground mask swatch. Uses the compositing canvas fake.
 *
 * Scene (16 x 16, white background): layer red for x < 12, blue beyond;
 * its mask hides the stripe 4 <= x < 8 (so "all" sees red | white | red | blue).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createEmptyDocument } from "../document/create";
import type { Editor as EditorClass } from "./editor";
import type { BlendCanvas } from "./fakeCanvas.testutil";
import { installBlendCanvasFakes, removeCanvasFakes } from "./fakeCanvas.testutil";
import type { SampleSource } from "./pixelOps";
import { lmaskGray } from "./pixelOps";
import { rectSelection } from "./selection";
import type { Selection } from "./selection";

let Editor: typeof EditorClass;

beforeAll(async () => {
  installBlendCanvasFakes();
  ({ Editor } = await import("./editor"));
});

afterAll(() => removeCanvasFakes());

// ── Helpers ───────────────────────────────────────────────────────────────────

const canvasPx = (ed: EditorClass, canvas: HTMLCanvasElement | null, x: number, y: number): number[] => {
  const c = canvas as unknown as BlendCanvas;
  const b = ed.bounds;
  const i = ((y - b.y) * c.width + (x - b.x)) * 4;
  return [...c.px.subarray(i, i + 4)];
};

const maskA = (ed: EditorClass, id: string, x: number, y: number): number => canvasPx(ed, ed.layerMask.canvas(id), x, y)[3] ?? -1;

/** Selection coverage at a document pixel. */
function selAt(sel: Selection | null | "blocked", x: number, y: number): number {
  if (!sel || sel === "blocked") return 0;
  const { rect } = sel;
  if (x < rect.x || y < rect.y || x >= rect.x + rect.width || y >= rect.y + rect.height) return sel.outside;
  return sel.data[(y - rect.y) * rect.width + (x - rect.x)] ?? 0;
}

/** The scene above; `stripe` = hidden amount of the mask stripe. */
function setup(stripe = 255): { ed: EditorClass; id: string } {
  const ed = new Editor(createEmptyDocument({ width: 16, height: 16 }), "widgets");
  const id = ed.doc.activeLayerId;
  ed.layerMask.add(id, "reveal");
  const layer = ed.layerCanvas(id) as unknown as BlendCanvas;
  const mask = ed.layerMask.canvas(id) as unknown as BlendCanvas;
  const b = ed.bounds;
  for (let y = 0; y < layer.height; y++) {
    for (let x = 0; x < layer.width; x++) {
      const i = (y * layer.width + x) * 4;
      layer.px.set(x + b.x < 12 ? [255, 0, 0, 255] : [0, 0, 255, 255], i);
      if (x + b.x >= 4 && x + b.x < 8) mask.px.set([255, 255, 255, stripe], i);
    }
  }
  return { ed, id };
}

const fillReq = (x: number, sample: SampleSource) => ({
  point: { x: x + 0.5, y: 1.5 },
  tolerance: 32,
  contiguous: true,
  antiAlias: false,
  sample,
  opacity: 1,
  color: "#00ff00",
});

const wandReq = (x: number, sample: SampleSource) => ({ point: { x: x + 0.5, y: 1.5 }, tolerance: 32, contiguous: true, antiAlias: false, sample });

const SAMPLES: readonly SampleSource[] = ["layer", "all", "background"];

// ═══════════════════════════════════════════════════════════════════════════

describe("lmaskGray", () => {
  it("opaque gray of the hidden amount, inverted when the mask is, outside value beyond the pixels", () => {
    const data = new ImageData(new Uint8ClampedArray([255, 255, 255, 200, 255, 255, 255, 0]), 2, 1);
    const read = { rect: { x: 1, y: 0, width: 2, height: 1 }, data };
    const area = { x: 0, y: 0, width: 4, height: 1 };
    expect([...lmaskGray(read, area, false, true)]).toEqual([255, 255, 255, 255, 200, 200, 200, 255, 0, 0, 0, 255, 255, 255, 255, 255]);
    expect([...lmaskGray(read, area, true, false)]).toEqual([255, 255, 255, 255, 55, 55, 55, 255, 255, 255, 255, 255, 255, 255, 255, 255]);
    expect([...lmaskGray(null, { x: 0, y: 0, width: 1, height: 1 }, false, false)]).toEqual([0, 0, 0, 255]);
  });
});

describe("lmask-only view (rule 1 + 2): only the mask's grayscale, whatever the option", () => {
  for (const sample of SAMPLES) {
    it(`bucket floods the black area the view shows (sample ${sample})`, () => {
      const { ed, id } = setup();
      ed.layerMask.toggleView(id);
      expect(ed.layerMask.viewing).toBe(id);
      expect(ed.pixelOps.fill(fillReq(10, sample))).toBe(true);
      // Black 8..15 flooded (across the red/blue edge); the white stripe stops it; 0..3 untouched.
      expect([maskA(ed, id, 9, 1), maskA(ed, id, 14, 1), maskA(ed, id, 1, 1)]).toEqual([255, 255, 0]);
      expect(canvasPx(ed, ed.layerCanvas(id), 10, 1)).toEqual([255, 0, 0, 255]); // layer pixels untouched
    });

    it(`wand selects the black area the view shows (sample ${sample})`, () => {
      const { ed, id } = setup();
      ed.layerMask.toggleView(id);
      const sel = ed.pixelOps.wandSelection(wandReq(10, sample));
      expect([selAt(sel, 9, 1), selAt(sel, 14, 1), selAt(sel, 5, 1), selAt(sel, 1, 1)]).toEqual([255, 255, 0, 0]);
    });
  }

  it("tolerance applies to the gray values; black swatch reveals; selection clips", () => {
    const soft = setup(20);
    soft.ed.layerMask.toggleView(soft.id);
    soft.ed.pixelOps.fill(fillReq(1, "all")); // 20 is within 32 of 0: floods across the stripe
    expect([maskA(soft.ed, soft.id, 5, 1), maskA(soft.ed, soft.id, 14, 1)]).toEqual([255, 255]);
    const tight = setup(20);
    tight.ed.layerMask.toggleView(tight.id);
    tight.ed.pixelOps.fill({ ...fillReq(1, "all"), tolerance: 10 });
    expect([maskA(tight.ed, tight.id, 1, 1), maskA(tight.ed, tight.id, 5, 1), maskA(tight.ed, tight.id, 14, 1)]).toEqual([255, 20, 0]);

    const { ed, id } = setup();
    ed.layerMask.toggleView(id);
    ed.layerMask.swapSwatches(); // black foreground reveals
    expect(ed.pixelOps.fill(fillReq(5, "layer"))).toBe(true); // the white stripe
    expect(maskA(ed, id, 5, 1)).toBe(0);
    ed.layerMask.resetSwatches();
    ed.selection.apply(rectSelection({ x: 8, y: 0, width: 4, height: 16 }), "replace");
    ed.pixelOps.fill(fillReq(10, "all"));
    expect([maskA(ed, id, 10, 1), maskA(ed, id, 14, 1), maskA(ed, id, 1, 1)]).toEqual([255, 0, 0]);
    ed.undo();
    expect(maskA(ed, id, 10, 1)).toBe(0);
  });
});

describe("mask targeted, normal view (rule 3)", () => {
  it("bucket: current layer = raw pixels (mask not applied), all = composite with the mask", () => {
    const a = setup();
    expect(a.ed.pixelOps.fill(fillReq(1, "layer"))).toBe(true); // red 0..11, through the stripe
    expect([maskA(a.ed, a.id, 1, 1), maskA(a.ed, a.id, 10, 1), maskA(a.ed, a.id, 14, 1)]).toEqual([255, 255, 0]);
    expect(canvasPx(a.ed, a.ed.layerCanvas(a.id), 1, 1)).toEqual([255, 0, 0, 255]); // layer pixels untouched

    const b = setup();
    b.ed.pixelOps.fill(fillReq(1, "all")); // red 0..3; the hidden stripe shows white
    expect([maskA(b.ed, b.id, 1, 1), maskA(b.ed, b.id, 10, 1), maskA(b.ed, b.id, 14, 1)]).toEqual([255, 0, 0]);
  });

  it("wand: current layer = raw pixels, all = composite with the mask", () => {
    const { ed } = setup();
    const layer = ed.pixelOps.wandSelection(wandReq(1, "layer"));
    expect([selAt(layer, 1, 1), selAt(layer, 5, 1), selAt(layer, 10, 1), selAt(layer, 14, 1)]).toEqual([255, 255, 255, 0]);
    const all = ed.pixelOps.wandSelection(wandReq(1, "all"));
    expect([selAt(all, 1, 1), selAt(all, 5, 1), selAt(all, 10, 1)]).toEqual([255, 0, 0]);
  });
});

describe("pixels targeted (rule 4)", () => {
  it("bucket and wand: current layer = raw pixels, all = composite with the mask; the mask is untouched", () => {
    const a = setup();
    a.ed.layerMask.setTarget(a.id, "layer");
    a.ed.pixelOps.fill({ ...fillReq(1, "layer"), tolerance: 0 });
    expect(canvasPx(a.ed, a.ed.layerCanvas(a.id), 10, 1)).toEqual([0, 255, 0, 255]);
    expect(canvasPx(a.ed, a.ed.layerCanvas(a.id), 14, 1)).toEqual([0, 0, 255, 255]);
    expect(maskA(a.ed, a.id, 1, 1)).toBe(0);
    const layer = a.ed.pixelOps.wandSelection(wandReq(14, "layer"));
    expect([selAt(layer, 14, 1), selAt(layer, 10, 1)]).toEqual([255, 0]);

    const b = setup();
    b.ed.layerMask.setTarget(b.id, "layer");
    b.ed.pixelOps.fill({ ...fillReq(1, "all"), tolerance: 0 });
    expect(canvasPx(b.ed, b.ed.layerCanvas(b.id), 1, 1)).toEqual([0, 255, 0, 255]);
    expect(canvasPx(b.ed, b.ed.layerCanvas(b.id), 10, 1)).toEqual([255, 0, 0, 255]);
    const all = b.ed.pixelOps.wandSelection(wandReq(10, "all"));
    expect([selAt(all, 10, 1), selAt(all, 5, 1), selAt(all, 14, 1)]).toEqual([255, 0, 0]);
  });
});
