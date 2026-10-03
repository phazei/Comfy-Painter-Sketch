import { describe, expect, it } from "vitest";
import type { Layer } from "../document/types";
import { BACKGROUND_NOTE, HIDDEN_LAYER_NOTE, LOCKED_LAYER_NOTE, SOLO_HIDDEN_NOTE } from "./editorTypes";
import type { EditorState } from "./editorState";
import { editBlockNote, layerBlockNote } from "./rasterize";
import type { SoloIds } from "./solo";

const state = (solo: SoloIds): EditorState => ({ solo: { current: solo } }) as unknown as EditorState;
const layer = (id: string, extra: Partial<Layer> = {}): Layer =>
  ({ id, name: id, kind: "paint", visible: true, locked: false, opacity: 1, blendMode: "normal", file: null, ...extra }) as Layer;

describe("editBlockNote", () => {
  it("allows a visible, unlocked layer with no solo", () => {
    expect(editBlockNote(state({ paint: null, mask: null }), layer("a"))).toBeNull();
  });
  it("blocks a layer hidden by another layer's solo (or a mask solo)", () => {
    expect(editBlockNote(state({ paint: "b", mask: null }), layer("a"))).toBe(SOLO_HIDDEN_NOTE);
    expect(editBlockNote(state({ paint: null, mask: "m" }), layer("a"))).toBe(SOLO_HIDDEN_NOTE);
    expect(editBlockNote(state({ paint: "a", mask: null }), layer("a"))).toBeNull();
  });
  it("eye-hidden and locked still block a soloed layer; hidden wins", () => {
    const solo = state({ paint: "a", mask: null });
    expect(editBlockNote(solo, layer("a", { visible: false, locked: true }))).toBe(HIDDEN_LAYER_NOTE);
    expect(editBlockNote(solo, layer("a", { locked: true }))).toBe(LOCKED_LAYER_NOTE);
  });
  it("a selected Background row refuses every edit first; layerBlockNote ignores it", () => {
    const s = { solo: { current: { paint: null, mask: null } }, sourceSelected: "background" } as unknown as EditorState;
    expect(editBlockNote(s, layer("a"))).toBe(BACKGROUND_NOTE);
    expect(editBlockNote(s, layer("a", { visible: false, locked: true }), "whole")).toBe(BACKGROUND_NOTE);
    expect(BACKGROUND_NOTE).toBe("Background can't be edited \u2014 duplicate it to edit.");
    expect(layerBlockNote(s, layer("a"))).toBeNull();
    expect(layerBlockNote(s, layer("a", { locked: true }))).toBe(LOCKED_LAYER_NOTE);
  });
});
