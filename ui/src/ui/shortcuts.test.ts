import { describe, expect, it } from "vitest";

import { isTransformChord } from "./floatShortcuts";
import { stepHardness, stepSize } from "./shortcuts";

describe("bracket steps", () => {
  it("steps size finer for small brushes and clamps", () => {
    expect(stepSize(5, true)).toBe(6);
    expect(stepSize(10, true)).toBe(15);
    expect(stepSize(15, false)).toBe(10);
    expect(stepSize(10, false)).toBe(9);
    expect(stepSize(1, false)).toBe(1);
    expect(stepSize(1000, true)).toBe(1000);
  });

  it("steps hardness by 25%", () => {
    expect(stepHardness(0.8, true)).toBe(1);
    expect(stepHardness(0.5, false)).toBe(0.25);
    expect(stepHardness(0, false)).toBe(0);
  });
});

describe("free transform chord", () => {
  const key = (k: string, mods: Partial<KeyboardEvent>): KeyboardEvent =>
    ({ key: k, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods }) as KeyboardEvent;

  it("is Ctrl+Alt+T only (Ctrl+T reaches the browser; AltGr characters never match)", () => {
    expect(isTransformChord(key("t", { ctrlKey: true, altKey: true }))).toBe(true);
    expect(isTransformChord(key("T", { ctrlKey: true, altKey: true }))).toBe(true);
    expect(isTransformChord(key("t", { ctrlKey: true }))).toBe(false);
    expect(isTransformChord(key("t", { ctrlKey: true, altKey: true, shiftKey: true }))).toBe(false);
    expect(isTransformChord(key("ţ", { ctrlKey: true, altKey: true }))).toBe(false);
  });
});
