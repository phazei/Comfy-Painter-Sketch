import { describe, expect, it } from "vitest";

import { createPaintLayer, createTextLayer } from "../document/create";
import type { TextData } from "../document/textData";
import type { Layer } from "../document/types";
import { hitTestText } from "./textLayer";
import { cssFontFamily, fontString, isFontAvailable, layoutText, lineHeightPx } from "./textRender";
import type { MeasureText } from "./textRender";

const TD: TextData = { text: "ab\nabcd", x: 100, y: 50, font: "sans-serif", size: 10, color: "#000000", bold: false, italic: false, align: "left" };

/** 5 px per character, font ascent 8 / descent 2, ink = advance box. */
const measure: MeasureText = (line) => ({
  width: line.length * 5,
  left: 0,
  right: line.length * 5,
  ascent: 7,
  descent: 1,
  fontAscent: 8,
  fontDescent: 2,
});

describe("font strings", () => {
  it("quotes named families (escaped) with a fallback; generics stay bare", () => {
    expect(cssFontFamily("sans-serif")).toBe("sans-serif");
    expect(cssFontFamily("Monospace")).toBe("monospace");
    expect(cssFontFamily("Times New Roman")).toBe('"Times New Roman", sans-serif');
    expect(cssFontFamily('My "Odd" \\ Font')).toBe('"My \\"Odd\\" \\\\ Font", sans-serif');
    expect(cssFontFamily("  ")).toBe("sans-serif");
  });

  it("builds style, weight, size and family", () => {
    expect(fontString(TD)).toBe("10px sans-serif");
    expect(fontString({ ...TD, bold: true, italic: true, font: "Georgia", size: 12.3456 })).toBe('italic bold 12.35px "Georgia", sans-serif');
  });

  it("treats generic families as available without a browser", () => {
    expect(isFontAvailable("serif")).toBe(true);
    expect(isFontAvailable("Whatever")).toBe(true);
  });
});

describe("layoutText", () => {
  it("places lines on baselines lineHeight apart from the anchor", () => {
    const lay = layoutText(TD, measure);
    expect(lineHeightPx(TD)).toBe(12.5);
    expect(lay.lines.map((l) => [l.text, l.x, l.baseline])).toEqual([
      ["ab", 100, 50],
      ["abcd", 100, 62.5],
    ]);
    // CSS line box: baseline = top + half-leading (1.25) + font ascent (8).
    expect(lay.box).toEqual({ x: 100, y: 50 - 1.25 - 8, width: 20, height: 25 });
  });

  it("aligns every line to the anchor", () => {
    const center = layoutText({ ...TD, align: "center" }, measure);
    expect(center.lines.map((l) => l.x)).toEqual([95, 90]);
    expect(center.box.x).toBe(90);
    const right = layoutText({ ...TD, align: "right" }, measure);
    expect(right.lines.map((l) => l.x)).toEqual([90, 80]);
    expect(right.box.x + right.box.width).toBe(100);
  });

  it("returns an integer ink bbox covering all glyphs (padded)", () => {
    const { bbox } = layoutText(TD, measure);
    expect(Number.isInteger(bbox.x) && Number.isInteger(bbox.width)).toBe(true);
    expect(bbox.x).toBeLessThanOrEqual(98);
    expect(bbox.x + bbox.width).toBeGreaterThanOrEqual(122);
    expect(bbox.y).toBeLessThanOrEqual(50 - 8 - 2);
    expect(bbox.y + bbox.height).toBeGreaterThanOrEqual(62.5 + 2 + 2);
  });

  it("gives empty text an empty bbox but a caret-sized box", () => {
    const lay = layoutText({ ...TD, text: "" }, measure);
    expect(lay.bbox.width).toBe(0);
    expect(lay.box.height).toBe(12.5);
  });
});

describe("hitTestText", () => {
  const boxOf = (td: Readonly<TextData>) => layoutText(td, measure).box;
  const text = (x: number, extra: Partial<Layer> = {}): Layer => ({ ...createTextLayer({ ...TD, x }), ...extra });

  it("finds the top-most visible text layer under the point", () => {
    const low = text(100);
    const high = text(105);
    const layers = [createPaintLayer("P"), low, high];
    expect(hitTestText(layers, { x: 110, y: 55 }, boxOf)).toBe(high.id);
    expect(hitTestText(layers, { x: 101, y: 55 }, boxOf)).toBe(low.id);
    expect(hitTestText(layers, { x: 300, y: 55 }, boxOf)).toBeNull();
  });

  it("skips hidden layers and non-text layers", () => {
    const hidden = text(100, { visible: false });
    const paint = { ...createPaintLayer("P"), textData: TD };
    expect(hitTestText([hidden, paint], { x: 110, y: 55 }, boxOf)).toBeNull();
  });

  it("allows a small margin around the box", () => {
    const layer = text(100);
    expect(hitTestText([layer], { x: 99, y: 55 }, boxOf)).toBe(layer.id);
    expect(hitTestText([layer], { x: 97, y: 55 }, boxOf)).toBeNull();
  });
});
