import { describe, expect, it } from "vitest";

import { frameMap } from "./frameMap";
import { clampIntoArea, pasteTopLeft, selectionBox, viewRectDoc } from "./pastePlacement";
import type { PasteContext } from "./pastePlacement";

const AREA = { x: 0, y: 0, width: 100, height: 80 };
const SIZE = { width: 10, height: 10 };
const ctx = (over: Partial<PasteContext>): PasteContext => ({ selection: null, original: null, imageArea: AREA, view: null, ...over });

describe("pasteTopLeft", () => {
  it("1: centres on the selection bbox (even off screen), wins over the original", () => {
    const view = { x: 0, y: 0, width: 20, height: 20 };
    expect(pasteTopLeft(SIZE, ctx({ selection: { x: 60, y: 50, width: 20, height: 10 }, original: { x: 1, y: 1 }, view }))).toEqual({ x: 65, y: 50 });
  });

  it("1: never resizes to the selection; still clamped into the area", () => {
    expect(pasteTopLeft({ width: 40, height: 40 }, ctx({ selection: { x: 90, y: 70, width: 4, height: 4 } }))).toEqual({ x: 60, y: 40 });
  });

  it("2: own copy pastes in place", () => {
    expect(pasteTopLeft(SIZE, ctx({ original: { x: 7, y: 3 } }))).toEqual({ x: 7, y: 3 });
  });

  it("3: whole image area visible -> image area centre", () => {
    expect(pasteTopLeft(SIZE, ctx({ view: { x: -50, y: -50, width: 300, height: 300 } }))).toEqual({ x: 45, y: 35 });
    expect(pasteTopLeft(SIZE, ctx({ view: null }))).toEqual({ x: 45, y: 35 });
  });

  it("4: zoomed in -> view centre", () => {
    expect(pasteTopLeft(SIZE, ctx({ view: { x: 10, y: 10, width: 30, height: 20 } }))).toEqual({ x: 20, y: 15 });
  });

  it("clamps: view entirely off the image area", () => {
    expect(pasteTopLeft(SIZE, ctx({ view: { x: 500, y: -300, width: 50, height: 50 } }))).toEqual({ x: 90, y: 0 });
  });

  it("clamps an off-area original", () => {
    expect(pasteTopLeft(SIZE, ctx({ original: { x: -20, y: 200 } }))).toEqual({ x: 0, y: 70 });
  });
});

describe("clampIntoArea", () => {
  it("centres an oversized item on that axis only", () => {
    expect(clampIntoArea({ x: 500, y: 500 }, { width: 120, height: 10 }, AREA)).toEqual({ x: -10, y: 70 });
  });

  it("snaps to whole pixels", () => {
    expect(clampIntoArea({ x: 12.4, y: 12.6 }, SIZE, AREA)).toEqual({ x: 12, y: 13 });
    expect(pasteTopLeft({ width: 7, height: 5 }, ctx({}))).toEqual({ x: 47, y: 38 });
  });

  it("stays inside a fractional area", () => {
    expect(clampIntoArea({ x: 0, y: 0 }, SIZE, { x: 0.5, y: 0.5, width: 50, height: 50 })).toEqual({ x: 1, y: 1 });
  });
});

describe("helpers", () => {
  it("selectionBox: rect, inverted -> image area, none -> null", () => {
    const r = { x: 1, y: 2, width: 3, height: 4 };
    expect(selectionBox({ rect: r, data: new Uint8Array(12), outside: 0 }, AREA)).toBe(r);
    expect(selectionBox({ rect: r, data: new Uint8Array(12), outside: 255 }, AREA)).toBe(AREA);
    expect(selectionBox(null, AREA)).toBeNull();
  });

  it("viewRectDoc maps the stage through the view (identity frame map)", () => {
    const map = frameMap({ width: 100, height: 80 }, { width: 100, height: 80 });
    expect(viewRectDoc({ scale: 2, offsetX: -20, offsetY: 10 }, { width: 100, height: 60 }, map)).toEqual({ x: 10, y: -5, width: 50, height: 30 });
    expect(viewRectDoc({ scale: 2, offsetX: 0, offsetY: 0 }, { width: 0, height: 60 }, map)).toBeNull();
  });
});
