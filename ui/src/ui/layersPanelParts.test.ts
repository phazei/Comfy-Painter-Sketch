/** Layers panel row models: solo marks and the per-kind row model (pure). */
import { describe, expect, it } from "vitest";

import type { Layer } from "../document/types";
import { rowModel, soloMark } from "./layersPanelParts";
import type { RowFlags } from "./layersPanelParts";

const FLAGS: RowFlags = { selected: false, standby: false, current: false, solo: "off" };

function layer(patch: Partial<Layer> & Pick<Layer, "id" | "kind">): Layer {
  return { name: patch.id, visible: true, locked: false, opacity: 1, ...patch } as Layer;
}

describe("soloMark", () => {
  it("off without any solo", () => {
    expect(soloMark({ id: "a", kind: "paint" }, { paint: null, mask: null })).toBe("off");
  });

  it("on for the soloed row of its group, dimmed for everything else", () => {
    const solo = { paint: "a", mask: null };
    expect(soloMark({ id: "a", kind: "paint" }, solo)).toBe("on");
    expect(soloMark({ id: "b", kind: "text" }, solo)).toBe("dimmed");
    expect(soloMark({ id: "m", kind: "mask" }, solo)).toBe("dimmed");
    expect(soloMark({ id: "m", kind: "mask" }, { paint: null, mask: "m" })).toBe("on");
  });
});

describe("rowModel", () => {
  it("cmask: colour, subtract and current; no lmask slot", () => {
    const m = rowModel(layer({ id: "m", kind: "mask", color: "#00ff00", subtract: true }), { ...FLAGS, current: true });
    expect(m.color).toBe("#00ff00");
    expect(m.subtract).toBe(true);
    expect(m.current).toBe(true);
    expect(m.maskSlot).toBeUndefined();
  });

  it("paint: lmask slot with target / view flags", () => {
    const l = layer({ id: "p", kind: "paint" });
    expect(rowModel(l, FLAGS).maskSlot).toEqual({ canHave: true, mask: null });
    const masked = { ...l, layerMask: { enabled: false, invert: false } } as unknown as Layer;
    expect(rowModel(masked, { ...FLAGS, maskTarget: true, maskViewing: true }).maskSlot).toEqual({
      canHave: true,
      mask: { enabled: false, targeted: true, viewing: true },
    });
  });

  it("text: T flag, can't have an lmask", () => {
    const t = rowModel(layer({ id: "t", kind: "text" }), { ...FLAGS, selected: true });
    expect(t.text).toBe(true);
    expect(t.selected).toBe(true);
    expect(t.maskSlot).toEqual({ canHave: false, mask: null });
  });
});
