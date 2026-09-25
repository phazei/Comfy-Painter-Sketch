import { describe, expect, it } from "vitest";

import { coerceOption } from "./options";
import type { TextOption } from "./options";
import { CURATED_FONTS, fontSuggestions } from "./text";

describe("font menu", () => {
  it("lists recent fonts first, then the curated list without duplicates", () => {
    const list = fontSuggestions(["My Font", "arial"]);
    expect(list.slice(0, 2)).toEqual(["My Font", "arial"]);
    expect(list.filter((f) => f.toLowerCase() === "arial")).toHaveLength(1);
    expect(list).toHaveLength(CURATED_FONTS.length + 1);
    expect(fontSuggestions([])).toEqual([...CURATED_FONTS]);
  });
});

describe("text option values", () => {
  const desc: TextOption = { kind: "text", key: "font", label: "Font", suggestions: () => [], customLabel: "Custom", maxLength: 10 };

  it("trims and collapses whitespace; rejects empty, too long and non-strings", () => {
    expect(coerceOption(desc, "  Comic   Sans ")).toBe("Comic Sans");
    expect(coerceOption(desc, "   ")).toBeUndefined();
    expect(coerceOption(desc, "12345678901")).toBeUndefined();
    expect(coerceOption(desc, 5)).toBeUndefined();
  });
});
