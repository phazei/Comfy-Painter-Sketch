import { describe, expect, it } from "vitest";

import { SelectionModifiers } from "./selectionModifiers";

const mods = (shiftKey: boolean, altKey: boolean) => ({ shiftKey, altKey });

describe("SelectionModifiers", () => {
  it("picks the mode from the keys at pointer-down when a selection exists", () => {
    expect(new SelectionModifiers(mods(true, false), true).mode).toBe("add");
    expect(new SelectionModifiers(mods(false, true), true).mode).toBe("subtract");
    expect(new SelectionModifiers(mods(true, true), true).mode).toBe("intersect");
    expect(new SelectionModifiers(mods(false, false), true).mode).toBe("replace");
  });

  it("without a selection the mode is replace and held keys constrain at once", () => {
    const m = new SelectionModifiers(mods(true, true), false);
    expect(m.mode).toBe("replace");
    expect(m.update(mods(true, true))).toEqual({ square: true, fromCentre: true });
  });

  it("a mode key constrains only after release + re-press", () => {
    const m = new SelectionModifiers(mods(true, false), true);
    expect(m.update(mods(true, false)).square).toBe(false);
    expect(m.update(mods(false, false)).square).toBe(false);
    expect(m.update(mods(true, false)).square).toBe(true);
  });

  it("keys pressed after the start constrain immediately", () => {
    const m = new SelectionModifiers(mods(false, false), true);
    expect(m.update(mods(false, true))).toEqual({ square: false, fromCentre: true });
  });
});
