import { describe, expect, it } from "vitest";

import { HELP_SECTIONS } from "./shortcutList";

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
