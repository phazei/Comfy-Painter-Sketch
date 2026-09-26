import { describe, expect, it } from "vitest";

import { createEmptyDocument, DEFAULT_MASK_STYLE } from "../document/create";
import { ensureMaskLayer } from "../document/masks";
import { createBrushTool } from "../tools/brush";
import { createEraserTool } from "../tools/eraser";
import {
  firstMaskStyleFrom,
  MASK_COLOR_ID,
  MASK_COLOR_SETTING,
  MASK_OPACITY_ID,
  normalizeMaskColor,
  normalizeMaskOpacity,
} from "./maskDefaults";
import {
  normalizeGamma,
  normalizeMinSize,
  PRESSURE_DEFAULTS,
  PRESSURE_GAMMA_ID,
  PRESSURE_MIN_SIZE_ID,
  PRESSURE_OPACITY_ID,
  PRESSURE_SETTINGS,
  PRESSURE_SIZE_ID,
  pressureDefaultsFrom,
} from "./pressureDefaults";

const reader = (values: Record<string, unknown>) => (id: string) => values[id];

describe("mask defaults", () => {
  it("normalizes colour settings to #rrggbb", () => {
    expect(normalizeMaskColor("ff0000")).toBe("#ff0000");
    expect(normalizeMaskColor("#00FF7f")).toBe("#00ff7f");
    expect(normalizeMaskColor("0f8")).toBe("#00ff88");
    expect(normalizeMaskColor("11223380")).toBe("#112233");
    expect(normalizeMaskColor(" 123abc ")).toBe("#123abc");
    for (const junk of [undefined, null, 5, "", "red", "#12345", "gggggg"]) {
      expect(normalizeMaskColor(junk)).toBe(DEFAULT_MASK_STYLE.color);
    }
  });

  it("normalizes opacity percent to a 0.1..1 fraction", () => {
    expect(normalizeMaskOpacity(50)).toBe(0.5);
    expect(normalizeMaskOpacity(73.4)).toBe(0.73);
    expect(normalizeMaskOpacity(0)).toBe(0.1);
    expect(normalizeMaskOpacity(500)).toBe(1);
    expect(normalizeMaskOpacity("50")).toBe(DEFAULT_MASK_STYLE.opacity);
    expect(normalizeMaskOpacity(Number.NaN)).toBe(DEFAULT_MASK_STYLE.opacity);
  });

  it("builds the first mask style; unavailable settings give the built-in style", () => {
    expect(firstMaskStyleFrom(reader({ [MASK_COLOR_ID]: "00ff00", [MASK_OPACITY_ID]: 80 }))).toEqual({
      color: "#00ff00",
      opacity: 0.8,
    });
    expect(firstMaskStyleFrom(() => undefined)).toEqual(DEFAULT_MASK_STYLE);
  });

  it("stores the colour default like core color settings (no #)", () => {
    expect(MASK_COLOR_SETTING.defaultValue).toBe("ff0000");
    expect(normalizeMaskColor(MASK_COLOR_SETTING.defaultValue)).toBe(DEFAULT_MASK_STYLE.color);
  });

  it("styles the mask of a new document and a lazily added mask only", () => {
    const style = { color: "#0000ff", opacity: 0.3 };
    const doc = createEmptyDocument({ width: 8, height: 8 }, "doc00001", style);
    const mask = doc.layers.find((l) => l.kind === "mask");
    expect(mask).toMatchObject({ color: "#0000ff", opacity: 0.3, invert: false });

    // Existing mask: the provider is not even consulted.
    let calls = 0;
    const provider = () => (calls++, { color: "#00ff00", opacity: 0.9 });
    expect(ensureMaskLayer(doc, provider)).toMatchObject({ created: false, layer: { color: "#0000ff" } });
    expect(calls).toBe(0);

    doc.layers = doc.layers.filter((l) => l.kind !== "mask");
    expect(ensureMaskLayer(doc, provider)).toMatchObject({ created: true, layer: { color: "#00ff00", opacity: 0.9 } });
    expect(calls).toBe(1);
  });
});

describe("pressure defaults", () => {
  it("normalizes min size percent to a fraction", () => {
    expect(normalizeMinSize(10)).toBe(0.1);
    expect(normalizeMinSize(-5)).toBe(0);
    expect(normalizeMinSize(250)).toBe(1);
    expect(normalizeMinSize(33.6)).toBe(0.34);
    expect(normalizeMinSize(undefined)).toBe(PRESSURE_DEFAULTS.minSize);
  });

  it("clamps and snaps gamma", () => {
    expect(normalizeGamma(1)).toBe(1);
    expect(normalizeGamma(1.1500000000000001)).toBe(1.15);
    expect(normalizeGamma(1.13)).toBe(1.15);
    expect(normalizeGamma(0)).toBe(0.2);
    expect(normalizeGamma(99)).toBe(5);
    expect(normalizeGamma("2")).toBe(PRESSURE_DEFAULTS.gamma);
    expect(normalizeGamma(Number.POSITIVE_INFINITY)).toBe(PRESSURE_DEFAULTS.gamma);
  });

  it("reads all four values with per-value fallbacks", () => {
    const read = reader({
      [PRESSURE_SIZE_ID]: false,
      [PRESSURE_OPACITY_ID]: true,
      [PRESSURE_MIN_SIZE_ID]: 25,
      [PRESSURE_GAMMA_ID]: 2,
    });
    expect(pressureDefaultsFrom(read)).toEqual({ pressureSize: false, pressureOpacity: true, minSize: 0.25, gamma: 2 });
    expect(pressureDefaultsFrom(reader({ [PRESSURE_SIZE_ID]: "yes" }))).toEqual(PRESSURE_DEFAULTS);
  });

  it("setting defaults match the built-in defaults", () => {
    const read = reader(Object.fromEntries(PRESSURE_SETTINGS.map((s) => [s.id, s.defaultValue])));
    expect(pressureDefaultsFrom(read)).toEqual(PRESSURE_DEFAULTS);
  });

  it("are the initial brush/eraser options; editing a tool does not touch the defaults", () => {
    const pressure = { pressureSize: false, pressureOpacity: true, minSize: 0.3, gamma: 2 };
    const brush = createBrushTool(pressure);
    const eraser = createEraserTool(pressure);
    expect(brush.values).toMatchObject({ ...pressure, size: 24 });
    expect(eraser.values).toMatchObject({ ...pressure, size: 48 });
    brush.options.set("pressureSize", true);
    expect(pressure.pressureSize).toBe(false);
    expect(createBrushTool().values).toMatchObject(PRESSURE_DEFAULTS);
  });
});
