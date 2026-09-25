import { describe, expect, it } from "vitest";

import type { KeyChord } from "./fullscreenKeys";
import { isSaveChord } from "./saveKey";

const chord = (key: string, mods: Partial<Omit<KeyChord, "key">> = {}): KeyChord => ({
  key,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

describe("isSaveChord", () => {
  it("matches Ctrl+S and Cmd+S (any letter case)", () => {
    expect(isSaveChord(chord("s", { ctrlKey: true }))).toBe(true);
    expect(isSaveChord(chord("S", { metaKey: true }))).toBe(true);
  });

  it("ignores plain S, Shift/Alt variants and other keys", () => {
    expect(isSaveChord(chord("s"))).toBe(false);
    expect(isSaveChord(chord("s", { ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(isSaveChord(chord("s", { ctrlKey: true, altKey: true }))).toBe(false);
    expect(isSaveChord(chord("d", { ctrlKey: true }))).toBe(false);
  });
});
