/**
 * "Current layer" sampling of the magic wand and paint bucket follows the
 * current TARGET: the active paint layer, or under Quick Mask the current
 * mask (incl. the Image Mask row) as its raw coverage in gray -- never
 * the last selected paint layer. A hidden target (eye off / hidden by solo)
 * refuses with the gate's hidden note; "All layers" never notes; the
 * lmask-only view still samples a hidden layer's mask. Compositing canvas fake.
 *
 * Scene (16 x 16, white background): Layer 1 red for x < 8, Layer 2 blue for
 * x >= 8 (both transparent elsewhere); Mask 1 covers the stripe 4 <= x < 12.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createEmptyDocument } from "../document/create";
import { IMAGE_MASK_ID } from "../document/imageMask";
import type { Editor as EditorClass } from "./editor";
import { HIDDEN_LAYER_NOTE, HIDDEN_MASK_NOTE, IMAGE_MASK_NOTE, SOLO_HIDDEN_NOTE } from "./editorTypes";
import type { BlendCanvas } from "./fakeCanvas.testutil";
import { installBlendCanvasFakes, removeCanvasFakes } from "./fakeCanvas.testutil";
import type { SampleSource } from "./pixelOps";
import type { Selection } from "./selection";

let Editor: typeof EditorClass;

beforeAll(async () => {
  installBlendCanvasFakes();
  ({ Editor } = await import("./editor"));
});

afterAll(() => removeCanvasFakes());

// ── Helpers ───────────────────────────────────────────────────────────────────

type Scene = { ed: EditorClass; l1: string; l2: string; mask: string; notes: string[] };

function paint(ed: EditorClass, id: string, rgba: (x: number) => number[] | null): void {
  const c = ed.layerCanvas(id) as unknown as BlendCanvas;
  const b = ed.bounds;
  for (let y = 0; y < c.height; y++) {
    for (let x = 0; x < c.width; x++) {
      const v = rgba(x + b.x);
      if (v) c.px.set(v, (y * c.width + x) * 4);
    }
  }
}

function alphaAt(ed: EditorClass, id: string, x: number, y: number): number {
  const c = ed.layerCanvas(id) as unknown as BlendCanvas;
  const b = ed.bounds;
  return c.px[((y - b.y) * c.width + (x - b.x)) * 4 + 3] ?? -1;
}

function setup(stripe = 255): Scene {
  const ed = new Editor(createEmptyDocument({ width: 16, height: 16 }), "widgets");
  const l1 = ed.doc.activeLayerId;
  const mask = ed.doc.layers.find((l) => l.kind === "mask")?.id ?? "";
  const l2 = ed.layerOps.add() ?? "";
  paint(ed, l1, (x) => (x < 8 ? [255, 0, 0, 255] : null));
  paint(ed, l2, (x) => (x >= 8 ? [0, 0, 255, 255] : null));
  paint(ed, mask, (x) => (x >= 4 && x < 12 ? [255, 255, 255, stripe] : null));
  const notes: string[] = [];
  ed.events.on("note", (n) => notes.push(n));
  return { ed, l1, l2, mask, notes };
}

const wandReq = (x: number, sample: SampleSource) => ({ point: { x: x + 0.5, y: 1.5 }, tolerance: 32, contiguous: true, antiAlias: false, sample });

const fillReq = (x: number, sample: SampleSource) => ({ ...wandReq(x, sample), opacity: 1, color: "#00ff00" });

/** Selection coverage at a document pixel (row y = 1). */
function selAt(sel: Selection | null | "blocked", x: number, y = 1): number {
  if (!sel || sel === "blocked") return -1;
  const { rect } = sel;
  if (x < rect.x || y < rect.y || x >= rect.x + rect.width || y >= rect.y + rect.height) return sel.outside;
  return sel.data[(y - rect.y) * rect.width + (x - rect.x)] ?? 0;
}

const row = (sel: Selection | null | "blocked", xs: readonly number[]): number[] => xs.map((x) => selAt(sel, x));

// ═══════════════════════════════════════════════════════════════════════════

describe("wand, Current layer = the current target (bug 1)", () => {
  it("paint target: the active paint layer's pixels", () => {
    const { ed, l1, l2 } = setup();
    ed.layerOps.setActiveLayer(l1);
    expect(row(ed.pixelOps.wandSelection(wandReq(1, "layer")), [1, 7, 8])).toEqual([255, 255, 0]);
    ed.layerOps.setActiveLayer(l2);
    expect(row(ed.pixelOps.wandSelection(wandReq(9, "layer")), [9, 15, 7])).toEqual([255, 255, 0]);
  });

  it("Quick Mask: the current mask's coverage, whichever paint layer was selected before", () => {
    for (const which of ["l1", "l2"] as const) {
      const sc = setup();
      sc.ed.layerOps.setActiveLayer(sc[which]);
      expect(sc.ed.selectMask(sc.mask)).toBe(true);
      // Coverage 0 at x 0..3 (the stripe stops it): not layer 1's red 0..7 / layer 2's transparent 0..7.
      expect(row(sc.ed.pixelOps.wandSelection(wandReq(1, "layer")), [1, 3, 4, 7, 12])).toEqual([255, 255, 0, 0, 0]);
      expect(row(sc.ed.pixelOps.wandSelection(wandReq(5, "layer")), [4, 11, 3, 12])).toEqual([255, 255, 0, 0]);
    }
  });

  it("gray coverage: tolerance applies to the coverage values; Subtract keeps the raw regions", () => {
    const soft = setup(20);
    soft.ed.selectMask(soft.mask);
    // 20 is within 32 of 0: selects across the stripe.
    expect(row(soft.ed.pixelOps.wandSelection(wandReq(1, "layer")), [1, 5, 14])).toEqual([255, 255, 255]);
    const inv = setup();
    inv.ed.selectMask(inv.mask);
    expect(inv.ed.layerOps.setMaskSubtract(inv.mask, true)).toBe(true);
    expect(row(inv.ed.pixelOps.wandSelection(wandReq(5, "layer")), [4, 11, 3, 12])).toEqual([255, 255, 0, 0]);
  });

  it("Quick Mask toggled (Q) with no row click: the current mask too", () => {
    const { ed, l1 } = setup();
    ed.layerOps.setActiveLayer(l1);
    ed.togglePaintTarget();
    expect(ed.paintTarget).toBe("mask");
    expect(row(ed.pixelOps.wandSelection(wandReq(1, "layer")), [1, 4, 7])).toEqual([255, 0, 0]);
  });
});

describe("bucket, Current layer on a mask (bug 1)", () => {
  it("floods by the current mask's coverage, not the paint layer's pixels", () => {
    const { ed, l1, mask } = setup();
    ed.layerOps.setActiveLayer(l1);
    ed.selectMask(mask);
    expect(ed.pixelOps.fill(fillReq(1, "layer"))).toBe(true);
    // 0..3 filled (coverage 0 region), stopped by the stripe; 12..15 not reached (contiguous).
    expect([alphaAt(ed, mask, 1, 1), alphaAt(ed, mask, 3, 1), alphaAt(ed, mask, 13, 1)]).toEqual([255, 255, 0]);
    expect(alphaAt(ed, l1, 10, 1)).toBe(0); // paint layer untouched
  });

  it("same with the mask in Subtract mode (raw coverage)", () => {
    const { ed, mask } = setup();
    ed.selectMask(mask);
    ed.layerOps.setMaskSubtract(mask, true);
    expect(ed.pixelOps.fill(fillReq(14, "layer"))).toBe(true);
    expect([alphaAt(ed, mask, 13, 1), alphaAt(ed, mask, 15, 1), alphaAt(ed, mask, 1, 1)]).toEqual([255, 255, 0]);
  });
});

describe("hidden current target (bug 2)", () => {
  it("wand refuses a hidden paint layer (eye / solo) with the gate's note; All layers does not", () => {
    const a = setup();
    a.ed.layerOps.setActiveLayer(a.l1);
    a.ed.layerOps.setVisible(a.l1, false);
    expect(a.ed.pixelOps.wandSelection(wandReq(1, "layer"))).toBe("blocked");
    expect(a.notes).toEqual([HIDDEN_LAYER_NOTE]);
    expect(a.ed.pixelOps.wandSelection(wandReq(1, "all"))).not.toBe("blocked");
    expect(a.ed.pixelOps.wandSelection(wandReq(1, "background"))).not.toBe("blocked");
    expect(a.notes).toHaveLength(1);

    const b = setup();
    b.ed.layerOps.setActiveLayer(b.l1);
    b.ed.toggleSolo(b.l2);
    expect(b.ed.pixelOps.wandSelection(wandReq(1, "layer"))).toBe("blocked");
    expect(b.notes).toEqual([SOLO_HIDDEN_NOTE]);
    b.ed.layerOps.setActiveLayer(b.l2); // the soloed layer is shown
    expect(row(b.ed.pixelOps.wandSelection(wandReq(9, "layer")), [9])).toEqual([255]);
  });

  it("wand refuses a hidden mask (eye / solo); All layers does not", () => {
    const { ed, mask, notes } = setup();
    ed.selectMask(mask);
    ed.layerOps.setVisible(mask, false);
    expect(ed.pixelOps.wandSelection(wandReq(1, "layer"))).toBe("blocked");
    expect(notes).toEqual([HIDDEN_MASK_NOTE]);
    expect(ed.pixelOps.wandSelection(wandReq(1, "all"))).not.toBe("blocked");
    expect(notes).toHaveLength(1);
    ed.layerOps.setVisible(mask, true);
    const other = ed.layerOps.addMask() ?? "";
    ed.toggleSolo(other);
    ed.selectMask(mask);
    expect(ed.pixelOps.wandSelection(wandReq(1, "layer"))).toBe("blocked");
    expect(notes).toEqual([HIDDEN_MASK_NOTE, SOLO_HIDDEN_NOTE]);
  });

  it("bucket refuses a hidden target with the same notes (the edit gate)", () => {
    const { ed, l1, mask, notes } = setup();
    ed.layerOps.setActiveLayer(l1);
    ed.layerOps.setVisible(l1, false);
    expect(ed.pixelOps.fill(fillReq(1, "layer"))).toBe(false);
    ed.selectMask(mask);
    ed.layerOps.setVisible(mask, false);
    expect(ed.pixelOps.fill(fillReq(1, "layer"))).toBe(false);
    expect(notes).toEqual([HIDDEN_LAYER_NOTE, HIDDEN_MASK_NOTE]);
  });

  it("lmask-only view: a hidden layer's viewed mask is still sampled (wand + bucket), no note", () => {
    const { ed, l1, notes } = setup();
    ed.layerOps.setActiveLayer(l1);
    ed.layerMask.add(l1, "reveal");
    const lm = ed.layerMask.canvas(l1) as unknown as BlendCanvas;
    const b = ed.bounds;
    for (let y = 0; y < lm.height; y++) for (let x = 0; x < lm.width; x++) if (x + b.x >= 4 && x + b.x < 8) lm.px.set([255, 255, 255, 255], (y * lm.width + x) * 4);
    ed.layerMask.toggleView(l1);
    ed.layerOps.setVisible(l1, false);
    for (const sample of ["layer", "all"] as const) {
      expect(row(ed.pixelOps.wandSelection(wandReq(10, sample)), [9, 14, 5, 1])).toEqual([255, 255, 0, 0]);
    }
    expect(ed.pixelOps.fill(fillReq(10, "layer"))).toBe(true);
    const lmA = (x: number): number => lm.px[((1 - b.y) * lm.width + (x - b.x)) * 4 + 3] ?? -1;
    expect([lmA(9), lmA(14), lmA(1)]).toEqual([255, 255, 0]);
    expect(notes).toEqual([]);
  });

  it("outside the lmask-only view a hidden layer with its mask targeted refuses", () => {
    const { ed, l1, notes } = setup();
    ed.layerOps.setActiveLayer(l1);
    ed.layerMask.add(l1, "reveal");
    ed.layerOps.setVisible(l1, false);
    expect(ed.pixelOps.wandSelection(wandReq(1, "layer"))).toBe("blocked");
    expect(notes).toEqual([HIDDEN_LAYER_NOTE]);
  });
});

// ── All layers with a mask targeted ───────────────────────────────────────────

describe("All layers with a mask targeted: the visible cmasks combined (normal union minus subtract union)", () => {
  /** setup() plus Mask 2 covering x >= 14; Mask 1 is the current mask. */
  function masksSetup(): Scene & { mask2: string } {
    const sc = setup();
    const mask2 = sc.ed.layerOps.addMask() ?? "";
    paint(sc.ed, mask2, (x) => (x >= 14 ? [255, 255, 255, 255] : null));
    expect(sc.ed.selectMask(sc.mask)).toBe(true);
    return { ...sc, mask2 };
  }

  it("wand: the union's regions, the paint composite ignored", () => {
    const { ed } = masksSetup();
    // The red/blue edge at x = 8 does not split the stripe 4..11.
    expect(row(ed.pixelOps.wandSelection(wandReq(5, "all")), [4, 8, 11, 3, 12])).toEqual([255, 255, 255, 0, 0]);
    expect(row(ed.pixelOps.wandSelection(wandReq(12, "all")), [12, 13, 11, 14])).toEqual([255, 255, 0, 0]);
  });

  it("a Subtract mask removes its coverage from the union; alone it leaves nothing", () => {
    const sub = masksSetup();
    paint(sub.ed, sub.mask2, (x) => (x >= 10 ? [255, 255, 255, 255] : null)); // now x >= 10
    sub.ed.layerOps.setMaskSubtract(sub.mask2, true);
    // U = stripe 4..11, S = 10..15: result 255 at 4..9 only.
    expect(row(sub.ed.pixelOps.wandSelection(wandReq(5, "all")), [4, 9, 3, 10])).toEqual([255, 255, 0, 0]);
    expect(row(sub.ed.pixelOps.wandSelection(wandReq(12, "all")), [10, 15, 9, 1])).toEqual([255, 255, 0, 0]);
    // Partial subtract: U * (1 - S) = 255 * (255 - 128) / 255 = 127 at 10..11 (its own region).
    paint(sub.ed, sub.mask2, (x) => (x >= 10 ? [255, 255, 255, 128] : null));
    expect(row(sub.ed.pixelOps.wandSelection(wandReq(10, "all")), [10, 11, 9, 12])).toEqual([255, 255, 0, 0]);
    // No normal cmask shown: nothing is covered.
    sub.ed.layerOps.setVisible(sub.mask, false);
    expect(row(sub.ed.pixelOps.wandSelection(wandReq(1, "all")), [1, 5, 12, 15])).toEqual([255, 255, 255, 255]);
  });

  it("hidden masks excluded, solo as displayed", () => {
    const hid = masksSetup();
    hid.ed.layerOps.setVisible(hid.mask2, false);
    expect(row(hid.ed.pixelOps.wandSelection(wandReq(12, "all")), [12, 15, 11])).toEqual([255, 255, 0]);

    const solo = masksSetup();
    solo.ed.toggleSolo(solo.mask2); // only Mask 2 shows
    expect(row(solo.ed.pixelOps.wandSelection(wandReq(1, "all")), [1, 5, 13, 14])).toEqual([255, 255, 255, 0]);
  });

  it("bucket floods the current mask by the union", () => {
    const { ed, mask, mask2 } = masksSetup();
    expect(ed.pixelOps.fill(fillReq(12, "all"))).toBe(true);
    expect([12, 13, 11, 14, 1].map((x) => alphaAt(ed, mask, x, 1))).toEqual([255, 255, 255, 0, 0]);
    expect(alphaAt(ed, mask2, 12, 1)).toBe(0);
  });

  it("paint target with All layers: still the visible composite (masks excluded)", () => {
    const { ed, l1 } = masksSetup();
    ed.layerOps.setActiveLayer(l1);
    ed.togglePaintTarget();
    expect(ed.paintTarget).toBe("paint");
    expect(row(ed.pixelOps.wandSelection(wandReq(1, "all")), [1, 4, 7, 8])).toEqual([255, 255, 255, 0]);
  });
});

// ── Image Mask row ────────────────────────────────────────────────────────────

describe("Image Mask row as the current mask", () => {
  const SIZE = { width: 8, height: 8 };
  /** Alpha 255 except a transparent 2x2 block at (1, 1) -> coverage 255 there. */
  function imageSetup(): { ed: EditorClass; notes: string[] } {
    const ed = new Editor(createEmptyDocument(SIZE), "image");
    const rgba = new Uint8ClampedArray(64 * 4);
    for (let i = 0; i < 64; i++) rgba[i * 4 + 3] = 255;
    for (const [x, y] of [[1, 1], [2, 1], [1, 2], [2, 2]] as const) rgba[(y * 8 + x) * 4 + 3] = 0;
    expect(ed.imageMask.setFromAlpha("filename=a.png&subfolder=&type=input", SIZE, rgba)).toBe(true);
    const notes: string[] = [];
    ed.events.on("note", (n) => notes.push(n));
    expect(ed.selectMask(IMAGE_MASK_ID)).toBe(true);
    return { ed, notes };
  }

  it("wand samples its raw coverage (Subtract ignored)", () => {
    const { ed } = imageSetup();
    const sel = ed.pixelOps.wandSelection(wandReq(1, "layer"));
    expect(row(sel, [1, 2, 0, 3])).toEqual([255, 255, 0, 0]);
    expect(selAt(sel, 1, 2)).toBe(255);
    ed.layerOps.setMaskSubtract(IMAGE_MASK_ID, true);
    expect(row(ed.pixelOps.wandSelection(wandReq(1, "layer")), [1, 2, 0, 3])).toEqual([255, 255, 0, 0]);
  });

  it("hidden: the wand refuses with the mask note; the bucket keeps the Image Mask note", () => {
    const { ed, notes } = imageSetup();
    ed.layerOps.setVisible(IMAGE_MASK_ID, false);
    expect(ed.pixelOps.wandSelection(wandReq(1, "layer"))).toBe("blocked");
    expect(ed.pixelOps.wandSelection(wandReq(1, "all"))).not.toBe("blocked");
    expect(ed.pixelOps.fill(fillReq(1, "layer"))).toBe(false);
    expect(notes).toEqual([HIDDEN_MASK_NOTE, IMAGE_MASK_NOTE]);
  });

  it("All layers: the row joins the union while shown", () => {
    const { ed } = imageSetup();
    // Shown / output only over an image background of its size (imageMaskApplies).
    ed.setBackground({ kind: "image", image: {} as CanvasImageSource }, SIZE);
    const mask = ed.doc.layers.find((l) => l.kind === "mask")?.id ?? "";
    expect(ed.selectMask(mask)).toBe(true);
    expect(row(ed.pixelOps.wandSelection(wandReq(1, "all")), [1, 2, 0, 3])).toEqual([255, 255, 0, 0]);
    ed.layerOps.setVisible(IMAGE_MASK_ID, false);
    expect(row(ed.pixelOps.wandSelection(wandReq(1, "all")), [1, 2, 0, 3])).toEqual([255, 255, 255, 255]);
  });

  it("All layers: a Subtract row removes its coverage from the normal union", () => {
    const { ed } = imageSetup();
    ed.setBackground({ kind: "image", image: {} as CanvasImageSource }, SIZE);
    const mask = ed.doc.layers.find((l) => l.kind === "mask")?.id ?? "";
    paint(ed, mask, () => [255, 255, 255, 255]); // Mask 1 covers everything
    expect(ed.selectMask(mask)).toBe(true);
    expect(ed.layerOps.setMaskSubtract(IMAGE_MASK_ID, true)).toBe(true);
    // 255 everywhere minus the row's 2x2 hole block at (1..2, 1..2).
    expect(row(ed.pixelOps.wandSelection(wandReq(1, "all")), [1, 2, 0, 3])).toEqual([255, 255, 0, 0]);
    expect(row(ed.pixelOps.wandSelection(wandReq(0, "all")), [0, 3, 7, 1])).toEqual([255, 255, 255, 0]);
    ed.layerOps.setMaskSubtract(IMAGE_MASK_ID, false); // normal: joins the union (all 255)
    expect(row(ed.pixelOps.wandSelection(wandReq(1, "all")), [1, 2, 0, 3])).toEqual([255, 255, 255, 255]);
  });
});

describe("hidden mask note", () => {
  it("matches the paint-layer note style", () => {
    expect(HIDDEN_MASK_NOTE).toBe("The mask is hidden.");
  });
});
