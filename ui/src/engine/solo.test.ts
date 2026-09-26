import { describe, expect, it, vi } from "vitest";
import { pruneSolo, shownOnStage, SoloState, toggleSolo } from "./solo";
import type { SoloIds } from "./solo";

const none: SoloIds = { paint: null, mask: null };
const p1 = { id: "p1", kind: "paint" as const, visible: true };
const p2 = { id: "p2", kind: "paint" as const, visible: false };
const t1 = { id: "t1", kind: "text" as const, visible: true };
const m1 = { id: "m1", kind: "mask" as const, visible: true };
const m2 = { id: "m2", kind: "mask" as const, visible: false };
const all = [p1, p2, t1, m1, m2];
const shown = (solo: SoloIds): string[] => all.filter((l) => shownOnStage(l, solo)).map((l) => l.id);

describe("shownOnStage", () => {
  it("follows the eyes without solos", () => {
    expect(shown(none)).toEqual(["p1", "t1", "m1"]);
  });
  it("a solo hides everything else, including the other group", () => {
    expect(shown({ paint: "t1", mask: null })).toEqual(["t1"]);
    expect(shown({ paint: null, mask: "m1" })).toEqual(["m1"]);
  });
  it("a hidden layer can be soloed", () => {
    expect(shown({ paint: "p2", mask: null })).toEqual(["p2"]);
    expect(shown({ paint: null, mask: "m2" })).toEqual(["m2"]);
  });
  it("paint and mask solos combine", () => {
    expect(shown({ paint: "p1", mask: "m2" })).toEqual(["p1", "m2"]);
  });
});

describe("toggleSolo", () => {
  it("sets, replaces within a group and ends on re-click", () => {
    let s = toggleSolo(none, p1);
    expect(s).toEqual({ paint: "p1", mask: null });
    s = toggleSolo(s, m1);
    expect(s).toEqual({ paint: "p1", mask: "m1" });
    s = toggleSolo(s, t1);
    expect(s).toEqual({ paint: "t1", mask: "m1" });
    s = toggleSolo(s, t1);
    expect(s).toEqual({ paint: null, mask: "m1" });
  });
});

describe("pruneSolo", () => {
  it("drops solos of deleted layers", () => {
    expect(pruneSolo({ paint: "gone", mask: "m1" }, all)).toEqual({ paint: null, mask: "m1" });
    expect(pruneSolo({ paint: "m1", mask: "p1" }, all)).toEqual(none);
  });
});

describe("SoloState", () => {
  it("notifies only on change", () => {
    const fn = vi.fn();
    const state = new SoloState(fn);
    state.clear();
    expect(fn).not.toHaveBeenCalled();
    state.set({ paint: "p1", mask: null });
    state.set({ paint: "p1", mask: null });
    expect(fn).toHaveBeenCalledTimes(1);
    state.clear();
    expect(state.current).toEqual(none);
  });
});
