import { describe, expect, it } from "vitest";

import { createEmptyDocument } from "./create";
import { parseDocument } from "./parse";
import { stringifyDocument } from "./serialize";
import {
  commitName,
  nameFromText,
  parseRecentFonts,
  pushRecentFont,
  readTextData,
  sameTextData,
  serializeTextData,
} from "./textData";
import type { TextData } from "./textData";

const TD: TextData = { text: "Hi\nthere", x: 10, y: 20.5, font: "Georgia", size: 32, color: "#ff0000", bold: true, italic: false, align: "center" };

describe("readTextData", () => {
  it("accepts complete data unchanged", () => {
    expect(readTextData({ ...TD })).toEqual(TD);
    expect(readTextData({ ...TD, lineHeight: 1.5 })?.lineHeight).toBe(1.5);
  });

  it("requires text and a finite anchor", () => {
    expect(readTextData(null)).toBeNull();
    expect(readTextData([])).toBeNull();
    expect(readTextData({ ...TD, text: 5 })).toBeNull();
    expect(readTextData({ ...TD, x: Number.NaN })).toBeNull();
    expect(readTextData({ ...TD, y: "3" })).toBeNull();
  });

  it("fills cosmetic fields leniently", () => {
    const td = readTextData({ text: "a", x: 0, y: 0, font: "  ", size: -4, color: "red", bold: "yes", align: "justify", lineHeight: 0 });
    expect(td).toEqual({ text: "a", x: 0, y: 0, font: "sans-serif", size: 1, color: "#000000", bold: false, italic: false, align: "left" });
    expect(readTextData({ text: "a", x: 0, y: 0 })?.size).toBe(48);
    expect(readTextData({ ...TD, color: "#ABCDEF" })?.color).toBe("#abcdef");
  });

  it("serializes with a stable key order and round-trips", () => {
    const { align, text, ...rest } = TD;
    const shuffled: TextData = { align, ...rest, text };
    expect(JSON.stringify(serializeTextData(shuffled))).toBe(JSON.stringify(serializeTextData(TD)));
    expect(readTextData(JSON.parse(JSON.stringify(serializeTextData(TD))))).toEqual(TD);
    expect(sameTextData(TD, { ...TD })).toBe(true);
    expect(sameTextData(TD, { ...TD, lineHeight: 1.25 })).toBe(true);
    expect(sameTextData(TD, { ...TD, x: 11 })).toBe(false);
  });
});

describe("text layers in documents", () => {
  const withText = (textData: unknown): string => {
    const doc = createEmptyDocument({ width: 64, height: 64 }, "abcd1234");
    const value = JSON.parse(stringifyDocument(doc));
    value.layers.push({ id: "t1", name: "Hi", kind: "text", visible: true, locked: false, opacity: 1, blendMode: "normal", file: "painter-sketch/ps-x-1.webp [input]", textData });
    return JSON.stringify(value);
  };

  it("keeps valid text layers and their data through parse + serialize", () => {
    const result = parseDocument(withText(TD));
    expect(result.status).toBe("ok");
    const doc = result.status === "ok" ? result.document : null;
    const layer = doc?.layers.find((l) => l.id === "t1");
    expect(layer?.kind).toBe("text");
    expect(layer?.textData).toEqual(TD);
    expect(doc && parseDocument(stringifyDocument(doc))).toEqual(result);
  });

  it("loads a text layer with bad textData as paint, keeping its file", () => {
    const result = parseDocument(withText({ text: 3 }));
    const layer = result.status === "ok" ? result.document.layers.find((l) => l.id === "t1") : undefined;
    expect(layer?.kind).toBe("paint");
    expect(layer?.textData).toBeUndefined();
    expect(layer?.file).toBe("painter-sketch/ps-x-1.webp [input]");
  });
});

describe("text layer names", () => {
  it("uses the first ~20 characters with whitespace collapsed", () => {
    expect(nameFromText("  Hello\n  world ")).toBe("Hello world");
    expect(nameFromText("")).toBe("Text");
    expect(nameFromText(" \n ")).toBe("Text");
    expect(nameFromText("abcdefghijklmnopqrstuvwxyz")).toBe("abcdefghijklmnopqrst\u2026");
  });

  it("follows the text unless the user renamed the layer", () => {
    expect(commitName("Hello", "Hello", "Hello there")).toBe("Hello there");
    expect(commitName("Text", "", "New")).toBe("New");
    expect(commitName("My title", "Hello", "Bye")).toBe("My title");
  });
});

describe("recent fonts", () => {
  it("keeps the newest first, deduplicated, capped at 5", () => {
    let list: string[] = [];
    for (const f of ["Arial", "Georgia", "Impact", "Verdana", "Tahoma", "Courier New"]) list = pushRecentFont(list, f);
    expect(list).toEqual(["Courier New", "Tahoma", "Verdana", "Impact", "Georgia"]);
    expect(pushRecentFont(list, "georgia")[0]).toBe("georgia");
    expect(pushRecentFont(list, "georgia")).toHaveLength(5);
    expect(pushRecentFont(list, "  ")).toEqual(list);
  });

  it("parses stored lists defensively", () => {
    expect(parseRecentFonts(null)).toEqual([]);
    expect(parseRecentFonts("{")).toEqual([]);
    expect(parseRecentFonts('{"a":1}')).toEqual([]);
    expect(parseRecentFonts('["Arial", 3, "Impact", "arial"]')).toEqual(["Arial", "Impact"]);
  });
});
