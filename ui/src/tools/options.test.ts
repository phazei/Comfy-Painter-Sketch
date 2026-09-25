import { describe, expect, it } from "vitest";

import {
  clampDisplay,
  displayToSlider,
  formatDisplay,
  fromDisplay,
  isGroupActive,
  isOptionEnabled,
  layoutOptions,
  OptionSet,
  sliderToDisplay,
  stepDecimals,
  toDisplay,
} from "./options";
import type { NumberOption, OptionBarItem, OptionDescriptor, OptionGroup, OptionValues } from "./options";

const percent: NumberOption = { kind: "number", key: "hardness", label: "Hard", min: 0, max: 100, step: 1, unit: "%", scale: 100 };
const gamma: NumberOption = { kind: "number", key: "gamma", label: "g", min: 0.2, max: 5, step: 0.05 };
const size: NumberOption = { kind: "number", key: "size", label: "Size", min: 1, max: 1000, step: 1, curve: "pow" };

describe("number descriptors", () => {
  it("derives decimals from the step", () => {
    expect(stepDecimals(1)).toBe(0);
    expect(stepDecimals(0.05)).toBe(2);
    expect(stepDecimals(0.1)).toBe(1);
  });

  it("clamps to the range and snaps to the step grid anchored at min", () => {
    expect(clampDisplay(percent, 150)).toBe(100);
    expect(clampDisplay(percent, -3)).toBe(0);
    expect(clampDisplay(percent, 42.4)).toBe(42);
    expect(clampDisplay(gamma, 1.02)).toBe(1);
    expect(clampDisplay(gamma, 1.03)).toBe(1.05);
    expect(clampDisplay(gamma, 0)).toBe(0.2);
    expect(clampDisplay(gamma, Number.NaN)).toBe(0.2);
  });

  it("converts between stored and display units without float noise", () => {
    expect(toDisplay(percent, 0.8)).toBe(80);
    expect(toDisplay(percent, 0.29)).toBe(29);
    expect(fromDisplay(percent, 29)).toBeCloseTo(0.29, 12);
    expect(fromDisplay(percent, 250)).toBe(1);
    expect(formatDisplay(gamma, 1)).toBe("1.00");
    expect(formatDisplay(percent, 33.3)).toBe("33");
  });

  it("maps slider positions through the curve and back", () => {
    expect(sliderToDisplay(percent, 0.5)).toBe(50);
    expect(sliderToDisplay(size, 0)).toBe(1);
    expect(sliderToDisplay(size, 1)).toBe(1000);
    // pow curve: half the slider covers a quarter of the range.
    expect(sliderToDisplay(size, 0.5)).toBe(251);
    expect(displayToSlider(size, 251)).toBeCloseTo(0.5, 2);
    expect(displayToSlider(percent, 25)).toBe(0.25);
    expect(sliderToDisplay(percent, 2)).toBe(100);
  });
});

describe("OptionSet", () => {
  const descriptors: OptionDescriptor[] = [
    percent,
    { kind: "toggle", key: "pressure", label: "P" },
    { kind: "select", key: "mode", label: "Mode", choices: [{ value: "a", label: "A" }, { value: "b", label: "B" }] },
    { ...gamma, dependsOn: ["pressure"] },
  ];

  it("clamps numbers, rejects wrong types and unknown keys, reports changes", () => {
    const values: OptionValues = { hardness: 0.5, pressure: false, mode: "a", gamma: 1 };
    const set = new OptionSet(descriptors, values);
    expect(set.set("hardness", 3)).toBe(true);
    expect(values["hardness"]).toBe(1);
    expect(set.set("hardness", 1)).toBe(false);
    expect(set.set("hardness", "x")).toBe(false);
    expect(set.set("pressure", true)).toBe(true);
    expect(set.set("mode", "z")).toBe(false);
    expect(set.set("mode", "b")).toBe(true);
    expect(set.set("unknown", 1)).toBe(false);
    expect(set.get("unknown")).toBeUndefined();
    expect(set.get("mode")).toBe("b");
  });

  it("enables dependent options only when a toggle they depend on is on", () => {
    const values: OptionValues = { hardness: 0.5, pressure: false, mode: "a", gamma: 1 };
    const set = new OptionSet(descriptors, values);
    const dependent = descriptors[3];
    if (!dependent) throw new Error("missing descriptor");
    expect(isOptionEnabled(dependent, (k) => set.get(k))).toBe(false);
    set.set("pressure", true);
    expect(isOptionEnabled(dependent, (k) => set.get(k))).toBe(true);
    expect(isOptionEnabled(percent, (k) => set.get(k))).toBe(true);
  });
});

describe("layoutOptions", () => {
  const pressure: OptionGroup = { id: "pressure", icon: "stylus", title: "Pen pressure", activeWhen: ["pSize", "pOpac"] };
  const descriptors: OptionDescriptor[] = [
    { ...size },
    { ...percent },
    { kind: "toggle", key: "pSize", label: "Size", group: "pressure" },
    { kind: "toggle", key: "pOpac", label: "Opacity", group: "pressure" },
    { ...gamma, group: "pressure" },
    { kind: "toggle", key: "other", label: "X", group: "extra" },
  ];
  const shape = (items: OptionBarItem[]): string[] =>
    items.map((i) => (i.kind === "separator" ? "|" : i.kind === "group" ? `[${i.descriptors.map((d) => d.key).join(",")}]` : i.desc.key));

  it("renders every descriptor inline with separators when nothing is collapsed", () => {
    expect(shape(layoutOptions(descriptors))).toEqual(["size", "hardness", "|", "pSize", "pOpac", "gamma", "|", "other"]);
  });

  it("collapses a group into one item at its first member", () => {
    expect(shape(layoutOptions(descriptors, [pressure]))).toEqual(["size", "hardness", "|", "[pSize,pOpac,gamma]", "|", "other"]);
  });

  it("keeps non-adjacent members in the same group item", () => {
    const split: OptionDescriptor[] = [descriptors[2], descriptors[0], descriptors[4]].filter((d) => d !== undefined);
    expect(shape(layoutOptions(split, [pressure]))).toEqual(["[pSize,gamma]", "|", "size"]);
  });

  it("tints the group button while any activeWhen toggle is on", () => {
    const values: OptionValues = { pSize: false, pOpac: false };
    expect(isGroupActive(pressure, (k) => values[k])).toBe(false);
    values["pOpac"] = true;
    expect(isGroupActive(pressure, (k) => values[k])).toBe(true);
    expect(isGroupActive({ id: "g", icon: "x", title: "G" }, () => true)).toBe(false);
  });
});
