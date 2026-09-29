/** Layers panel section dividers and drag drop math with dividers in the list (no DOM). */
import { describe, expect, it } from "vitest";
import { findDropTarget } from "./layerDrag";
import type { DropRow } from "./layerDrag";
import type { RowKind } from "./layerRow";
import { dividerPositions, DIVIDER_CLASS, withDividers } from "./layerSections";

/** Row kinds top -> bottom as the panel builds them. */
function kinds(masks: number, paints: number, imageMask: boolean): RowKind[] {
  return [
    ...Array.from({ length: masks }, (): RowKind => "mask"),
    ...Array.from({ length: paints }, (): RowKind => "paint"),
    ...(imageMask ? (["imageMask"] as const) : []),
    "background",
  ];
}

describe("dividerPositions", () => {
  it("masks + paint + background: two dividers", () => {
    expect(dividerPositions(kinds(2, 3, false))).toEqual([2, 5]);
  });

  it("no masks: only the lower divider", () => {
    expect(dividerPositions(kinds(0, 2, false))).toEqual([2]);
  });

  it("Image Mask belongs to the input section with Background", () => {
    expect(dividerPositions(kinds(1, 1, true))).toEqual([1, 2]);
    expect(dividerPositions(kinds(0, 1, true))).toEqual([1]);
  });

  it("empty paint group: one divider between masks and input rows", () => {
    expect(dividerPositions(kinds(2, 0, false))).toEqual([2]);
  });

  it("background only / empty list: none", () => {
    expect(dividerPositions(kinds(0, 0, false))).toEqual([]);
    expect(dividerPositions(kinds(0, 0, true))).toEqual([]);
    expect(dividerPositions([])).toEqual([]);
  });
});

describe("withDividers", () => {
  it("interleaves numbered dividers between groups", () => {
    const rows = kinds(1, 2, true);
    const out = withDividers(rows, (k) => k, (n) => `div${n}`);
    expect(out).toEqual(["mask", "div0", "paint", "paint", "div1", "imageMask", "background"]);
  });
});

// ── Drag drop math with dividers in the list ─────────────────────────────

interface FakeEl extends DropRow {
  classes: string[];
}

const ROW_H = 40;
const DIV_H = 3;

/** Lay out rows + dividers top -> bottom like the panel list. */
function layout(rowKinds: RowKind[]): FakeEl[] {
  let y = 0;
  const items = withDividers(rowKinds.map((k, i) => ({ k, id: `${k}${i}` })), (r) => r.k, () => null);
  return items.map((item) => {
    const top = y;
    const height = item ? ROW_H : DIV_H;
    y += height;
    const rect = { top, bottom: top + height, height } as DOMRect;
    const classes = item ? ["cps-layer-row", `cps-layer-${item.k === "imageMask" ? "image-mask" : item.k}`] : [DIVIDER_CLASS];
    const dataset: DOMStringMap = item ? { layerId: item.id } : {};
    return { classes, dataset, getBoundingClientRect: () => rect };
  });
}

/** `querySelectorAll(".cls")` on the fake list. */
function query(list: FakeEl[], selector: string): FakeEl[] {
  const cls = selector.replace(/^\./, "");
  return list.filter((e) => e.classes.includes(cls));
}

describe("findDropTarget with section dividers", () => {
  // mask0 [0,40) | div [40,43) | paint1 [43,83) paint2 [83,123) | div [123,126) | background3 [126,166)
  const list = layout(["mask", "paint", "paint", "background"]);

  it("group queries never include dividers", () => {
    expect(query(list, ".cps-layer-paint").map((e) => e.dataset["layerId"])).toEqual(["paint1", "paint2"]);
    expect(query(list, ".cps-layer-mask").map((e) => e.dataset["layerId"])).toEqual(["mask0"]);
    expect(query(list, `.${DIVIDER_CLASS}`)).toHaveLength(2);
  });

  it("paint drag over the upper divider drops above the first paint row", () => {
    expect(findDropTarget(query(list, ".cps-layer-paint"), 41)).toEqual({ targetId: "paint1", above: true });
  });

  it("paint drag over the lower divider / input rows drops below the last paint row", () => {
    const paint = query(list, ".cps-layer-paint");
    expect(findDropTarget(paint, 124)).toEqual({ targetId: "paint2", above: false });
    expect(findDropTarget(paint, 150)).toEqual({ targetId: "paint2", above: false });
  });

  it("mask drag over the divider or paint rows drops below the last mask", () => {
    const masks = query(list, ".cps-layer-mask");
    expect(findDropTarget(masks, 41)).toEqual({ targetId: "mask0", above: false });
    expect(findDropTarget(masks, 60)).toEqual({ targetId: "mask0", above: false });
  });

  it("row halves still decide above/below", () => {
    const paint = query(list, ".cps-layer-paint");
    expect(findDropTarget(paint, 50)).toEqual({ targetId: "paint1", above: true });
    expect(findDropTarget(paint, 70)).toEqual({ targetId: "paint1", above: false });
    expect(findDropTarget(paint, 90)).toEqual({ targetId: "paint2", above: true });
  });

  it("no rows: null", () => {
    expect(findDropTarget([], 10)).toBeNull();
  });
});
