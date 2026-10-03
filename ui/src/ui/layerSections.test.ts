/** Layers panel sections (order, titles, collapse) and drag drop math with headers in the list (no DOM). */
import { describe, expect, it } from "vitest";
import { findDropTarget } from "./layerDrag";
import type { DropRow } from "./layerDrag";
import type { RowKind } from "./layerRow";
import { arrangeSections, isCollapsible, rowSection, sectionTitle } from "./layerSections";
import type { SectionId } from "./layerSections";

/** Row kinds top -> bottom as the panel builds them. */
function kinds(masks: number, paints: number, imageMask: boolean): RowKind[] {
  return [
    ...Array.from({ length: masks }, (): RowKind => "mask"),
    ...Array.from({ length: paints }, (): RowKind => "paint"),
    ...(imageMask ? (["imageMask"] as const) : []),
    "background",
  ];
}

const none = (): boolean => false;
const hdr = (id: SectionId): string => `#${id}`;

describe("rowSection / isCollapsible", () => {
  it("maps row kinds to sections", () => {
    expect(rowSection("mask")).toBe("masks");
    expect(rowSection("paint")).toBe("layers");
    expect(rowSection("imageMask")).toBe("source");
    expect(rowSection("background")).toBe("source");
  });

  it("SOURCE never collapses", () => {
    expect(isCollapsible("masks")).toBe(true);
    expect(isCollapsible("layers")).toBe(true);
    expect(isCollapsible("source")).toBe(false);
  });
});

describe("sectionTitle", () => {
  it("fixed titles", () => {
    expect(sectionTitle("masks", false)).toBe("COMFYUI MASKS");
    expect(sectionTitle("masks", true, "x")).toBe("COMFYUI MASKS");
    expect(sectionTitle("source", true)).toBe("SOURCE");
  });

  it("collapsed layers section names the active layer", () => {
    expect(sectionTitle("layers", false, "Sky")).toBe("LAYERS");
    expect(sectionTitle("layers", true, "Sky 2")).toBe("LAYER: SKY 2");
    expect(sectionTitle("layers", true)).toBe("LAYERS");
  });
});

describe("arrangeSections", () => {
  it("headers before their rows, top -> bottom", () => {
    expect(arrangeSections(kinds(1, 2, true), (k) => k, hdr, none)).toEqual([
      "#masks", "mask", "#layers", "paint", "paint", "#source", "imageMask", "background",
    ]);
  });

  it("masks and layers headers show even when empty (their + buttons)", () => {
    expect(arrangeSections(kinds(0, 0, false), (k) => k, hdr, none)).toEqual(["#masks", "#layers", "#source", "background"]);
  });

  it("collapsed sections keep their header but drop their rows", () => {
    const collapsed = (id: SectionId): boolean => id === "masks" || id === "layers";
    expect(arrangeSections(kinds(2, 1, false), (k) => k, hdr, collapsed)).toEqual(["#masks", "#layers", "#source", "background"]);
  });

  it("SOURCE ignores a collapsed flag", () => {
    expect(arrangeSections(kinds(0, 1, false), (k) => k, hdr, () => true)).toEqual(["#masks", "#layers", "#source", "background"]);
  });

  it("no rows (no editor): empty", () => {
    expect(arrangeSections([], (k: RowKind) => k, hdr, none)).toEqual([]);
  });
});

// ── Drag drop math with section headers in the list ─────────────────────────

interface FakeEl extends DropRow {
  classes: string[];
}

const ROW_H = 40;
const HDR_H = 24;

/** Lay out headers + rows top -> bottom like the panel list. */
function layout(rowKinds: RowKind[]): FakeEl[] {
  let y = 0;
  const items = arrangeSections(rowKinds.map((k, i) => ({ k, id: `${k}${i}` })), (r) => r.k, () => null, none);
  return items.map((item) => {
    const top = y;
    const height = item ? ROW_H : HDR_H;
    y += height;
    const rect = { top, bottom: top + height, height } as DOMRect;
    const classes = item ? ["cps-layer-row", `cps-layer-${item.k === "imageMask" ? "image-mask" : item.k}`] : ["cps-layers-section"];
    const dataset: DOMStringMap = item ? { layerId: item.id } : {};
    return { classes, dataset, getBoundingClientRect: () => rect };
  });
}

/** `querySelectorAll(".cls")` on the fake list. */
function query(list: FakeEl[], selector: string): FakeEl[] {
  const cls = selector.replace(/^\./, "");
  return list.filter((e) => e.classes.includes(cls));
}

describe("findDropTarget with section headers", () => {
  // #masks [0,24) | mask0 [24,64) | #layers [64,88) | paint1 [88,128) paint2 [128,168) | #source [168,192) | background3 [192,232)
  const list = layout(["mask", "paint", "paint", "background"]);

  it("group queries never include headers", () => {
    expect(query(list, ".cps-layer-paint").map((e) => e.dataset["layerId"])).toEqual(["paint1", "paint2"]);
    expect(query(list, ".cps-layer-mask").map((e) => e.dataset["layerId"])).toEqual(["mask0"]);
    expect(query(list, ".cps-layers-section")).toHaveLength(3);
  });

  it("paint drag over the LAYERS header drops above the first paint row", () => {
    expect(findDropTarget(query(list, ".cps-layer-paint"), 70)).toEqual({ targetId: "paint1", above: true });
  });

  it("paint drag over the SOURCE header / rows drops below the last paint row", () => {
    const paint = query(list, ".cps-layer-paint");
    expect(findDropTarget(paint, 170)).toEqual({ targetId: "paint2", above: false });
    expect(findDropTarget(paint, 210)).toEqual({ targetId: "paint2", above: false });
  });

  it("mask drag over the masks header drops above; over paint rows below the last mask", () => {
    const masks = query(list, ".cps-layer-mask");
    expect(findDropTarget(masks, 5)).toEqual({ targetId: "mask0", above: true });
    expect(findDropTarget(masks, 100)).toEqual({ targetId: "mask0", above: false });
  });

  it("row halves still decide above/below", () => {
    const paint = query(list, ".cps-layer-paint");
    expect(findDropTarget(paint, 95)).toEqual({ targetId: "paint1", above: true });
    expect(findDropTarget(paint, 120)).toEqual({ targetId: "paint1", above: false });
    expect(findDropTarget(paint, 135)).toEqual({ targetId: "paint2", above: true });
  });

  it("no rows: null", () => {
    expect(findDropTarget([], 10)).toBeNull();
  });
});
