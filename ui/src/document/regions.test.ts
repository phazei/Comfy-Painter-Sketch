/** Region geometry, names and additive-v1 parsing, without canvas/DOM. */
import { describe, expect, it } from "vitest";
import { createEmptyDocument } from "./create";
import { parseDocument } from "./parse";
import { cloneDocument, stringifyDocument } from "./serialize";
import {
  clampRegionRect, commitRegionName, createRegion, defaultRegionName, defaultRegionRect,
  isRegionSlot, nextRegionSlot, readRegionRect, readRegions, regionArea, regionName,
  regionSlotLabel, roundRegionEdge,
} from "./regions";
import { cloneOutputOptions } from "./outputOptions";

const image = { width: 400, height: 200 };
const rect = { x: 50, y: 25, width: 100, height: 50 };

// ── Geometry ──────────────────────────────────────────────────────────────────

describe("region geometry", () => {
  it("rounds edges half up with floor(v + 0.5), as Python", () => {
    expect([0.5, 1.5, 2.5, -0.5, -1.5, 0.49].map(roundRegionEdge)).toEqual([1, 2, 3, 0, -1, 0]);
    expect(clampRegionRect({ x: 0.5, y: 2.5, width: 2, height: 2 }, image)).toEqual({ x: 1, y: 3, width: 2, height: 2 });
    expect(clampRegionRect({ x: 0.4, y: 0.4, width: 1.2, height: 1.2 }, image)).toEqual({ x: 0, y: 0, width: 2, height: 2 });
  });

  it("allows one image size beyond each edge and clamps beyond that", () => {
    expect(regionArea(image)).toEqual({ x: -400, y: -200, width: 1200, height: 600 });
    expect(clampRegionRect({ x: -50, y: 150, width: 100, height: 100 }, image)).toEqual({ x: -50, y: 150, width: 100, height: 100 });
    expect(clampRegionRect({ x: -9000, y: -9000, width: 99999, height: 99999 }, image)).toEqual(regionArea(image));
    expect(clampRegionRect({ x: 5000, y: 5000, width: 10, height: 10 }, image)).toEqual({ x: 799, y: 399, width: 1, height: 1 });
  });

  it("keeps at least 1x1", () => {
    expect(clampRegionRect({ x: 3.2, y: 3.2, width: 0.1, height: 0.1 }, image)).toEqual({ x: 3, y: 3, width: 1, height: 1 });
    expect(clampRegionRect(rect, { width: 1, height: 1 })).toEqual({ x: 1, y: 1, width: 1, height: 1 });
  });

  it("default rect is centred at half the image", () => {
    expect(defaultRegionRect(image)).toEqual({ x: 100, y: 50, width: 200, height: 100 });
    expect(defaultRegionRect({ width: 7, height: 1 })).toEqual({ x: 1, y: 0, width: 4, height: 1 });
  });
});

// ── Slots and names ───────────────────────────────────────────────────────────

describe("region slots and names", () => {
  it("accepts only slots 1..6 and fills the lowest empty slot", () => {
    for (const invalid of [0, 7, 1.5, "1", NaN, Infinity]) expect(isRegionSlot(invalid)).toBe(false);
    expect(nextRegionSlot([{ slot: 1 }, { slot: 3 }, { slot: 6 }])).toBe(2);
    expect(nextRegionSlot(Array.from({ length: 6 }, (_, i) => ({ slot: i + 1 })))).toBeNull();
  });

  it("names: default, trimmed commit, card label", () => {
    expect(defaultRegionName(3)).toBe("Region 3");
    expect(commitRegionName("  face ", 3)).toBe("face");
    expect(commitRegionName("   ", 3)).toBe("Region 3");
    expect(regionName({ name: "", slot: 6 })).toBe("Region 6");
    expect(regionSlotLabel({ name: "face", slot: 2 })).toBe("2 · face");
    expect(createRegion("a", 4, rect).name).toBe("Region 4");
  });
});

// ── Parsing ───────────────────────────────────────────────────────────────────

describe("region parsing", () => {
  it("maps legacy index to slot; each bad record is skipped on its own", () => {
    const result = readRegions([
      null, { id: "bad", slot: 1, rect: { ...rect, width: 0 } },
      { id: "bad", index: 0, rect },
      { id: "dup", slot: 1, rect }, { id: "bad", slot: 2, rect },
      { id: "last", index: 5, rect },
      { id: "outside", index: 6, rect }, { id: "negative", index: -1, rect },
      { id: "fraction", index: 0.9999999999999999, rect },
      { id: "explicitBad", slot: 0, index: 2, rect },
      { id: "two", slot: 2, rect, visible: false, name: "face", unknown: true },
    ]);
    expect(result.repaired).toBe(true);
    expect(result.regions.map((r) => [r.id, r.slot])).toEqual([["bad", 1], ["last", 6], ["two", 2]]);
    expect(result.regions[0]).toMatchObject({ name: "", visible: true, output: cloneOutputOptions() });
    expect(result.regions[2]).toMatchObject({ visible: false, name: "face" });
    expect(result.regions[2]).not.toHaveProperty("unknown");
  });

  it("rounds fractional saved edges and rejects malformed rects", () => {
    expect(readRegionRect({ x: 0.5, y: -0.5, width: 10.2, height: 3 })).toEqual({ x: 1, y: 0, width: 10, height: 3 });
    for (const bad of [null, [], {}, { ...rect, x: NaN }, { ...rect, height: -1 }, { ...rect, width: 0.2 },
      { ...rect, width: Infinity }, { ...rect, x: Number.MAX_VALUE, width: Number.MAX_VALUE }]) {
      expect(readRegionRect(bad)).toBeNull();
    }
    expect(readRegions([{ id: "f", slot: 1, rect: { ...rect, x: 0.25 } }]).repaired).toBe(true);
  });

  it("bad region records never reject paint; the old reference field is dropped", () => {
    const doc = createEmptyDocument(image);
    doc.layers[0]!.file = "painter-sketch/retained.png [input]";
    const parsed = parseDocument({ ...doc, regionsReferenceSize: image, regions: [false, { id: "ok", slot: 3, rect }] });
    if (parsed.status !== "ok") throw new Error("expected ok");
    expect(parsed.repaired).toBe(true);
    expect(parsed.document.layers).toEqual(doc.layers);
    expect(parsed.document.regions).toHaveLength(1);
    expect(stringifyDocument(parsed.document)).not.toContain("regionsReferenceSize");
  });

  it("round-trips regions and options; clones are independent", () => {
    const doc = createEmptyDocument({ width: 17, height: 23 });
    doc.regions = [createRegion("regionA", 4, { ...rect, x: -30 })];
    doc.regions[0]!.output = { ...cloneOutputOptions(), applyMask: "crop", fillColor: "#abcdef", cropPadding: 7 };
    doc.mainOutput = { ...cloneOutputOptions(), applyMask: "fill", fillColor: "#123456", cropPadding: 5 };
    const serialized = stringifyDocument(doc);
    expect(parseDocument(serialized)).toEqual({ status: "ok", document: doc, repaired: false });
    expect(serialized).not.toContain('"index"');
    const clone = cloneDocument(doc);
    clone.regions[0]!.rect.x = 99;
    clone.regions[0]!.output.cropPadding = 99;
    clone.mainOutput!.fillColor = "#ffffff";
    expect(stringifyDocument(doc)).toBe(serialized);
  });
});
