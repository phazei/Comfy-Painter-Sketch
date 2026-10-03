import { describe, expect, it } from "vitest";

import { HELP_SECTIONS, QUICK_ROWS } from "./shortcutList";

describe("QUICK_ROWS", () => {
  it("is a short list of distinct, filled rows", () => {
    expect(QUICK_ROWS.length).toBeGreaterThan(0);
    expect(QUICK_ROWS.length).toBeLessThanOrEqual(16);
    expect(new Set(QUICK_ROWS.map((r) => r.keys)).size).toBe(QUICK_ROWS.length);
    for (const row of QUICK_ROWS) expect(row.action.trim()).not.toBe("");
  });

  it("every key alternative also appears in a full section", () => {
    const all = HELP_SECTIONS.flatMap((s) => s.rows.map((r) => r.keys)).join(" / ");
    for (const row of QUICK_ROWS) {
      for (const alt of row.keys.split(" / ")) expect(all, alt).toContain(alt.replace(" (hold)", ""));
    }
  });
});

describe("HELP_SECTIONS", () => {
  it("has the overlay's eight sections, in order", () => {
    expect(HELP_SECTIONS.map((s) => s.title)).toEqual([
      "General",
      "Tools",
      "Brush and options",
      "Selection",
      "Layers and masks",
      "Move and transform",
      "Clipboard",
      "Regions",
    ]);
  });

  it("every section has rows with keys and an action", () => {
    for (const section of HELP_SECTIONS) {
      expect(section.rows.length, section.title).toBeGreaterThan(0);
      for (const row of section.rows) {
        expect(row.keys.trim(), section.title).not.toBe("");
        expect(row.action.trim(), `${section.title}: ${row.keys}`).not.toBe("");
      }
    }
  });

  it("no section lists the same keys twice", () => {
    for (const section of HELP_SECTIONS) {
      const keys = section.rows.map((r) => r.keys);
      expect(new Set(keys).size, section.title).toBe(keys.length);
    }
  });
});
