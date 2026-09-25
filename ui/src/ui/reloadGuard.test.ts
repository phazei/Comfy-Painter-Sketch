import { describe, expect, it } from "vitest";

import type { KeyChord } from "./fullscreenKeys";
import { isReloadKey } from "./reloadGuard";

function chord(key: string, mods: Partial<Omit<KeyChord, "key">> = {}): KeyChord {
  return { key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods };
}

describe("isReloadKey", () => {
  it("matches F5 (no modifier)", () => {
    expect(isReloadKey(chord("F5"))).toBe(true);
    expect(isReloadKey(chord("f5"))).toBe(true);
  });

  it("matches Ctrl+R and Cmd+R", () => {
    expect(isReloadKey(chord("r", { ctrlKey: true }))).toBe(true);
    expect(isReloadKey(chord("R", { metaKey: true }))).toBe(true);
  });

  it("matches Ctrl+Shift+R and Cmd+Shift+R (hard reload)", () => {
    expect(isReloadKey(chord("r", { ctrlKey: true, shiftKey: true }))).toBe(true);
    expect(isReloadKey(chord("R", { metaKey: true, shiftKey: true }))).toBe(true);
  });

  it("does not match F5 with Ctrl/Cmd (browser shortcut, not reload)", () => {
    expect(isReloadKey(chord("F5", { ctrlKey: true }))).toBe(false);
    expect(isReloadKey(chord("F5", { metaKey: true }))).toBe(false);
  });

  it("does not match Alt+R or Ctrl+Alt+R", () => {
    expect(isReloadKey(chord("r", { altKey: true }))).toBe(false);
    expect(isReloadKey(chord("r", { ctrlKey: true, altKey: true }))).toBe(false);
  });

  it("does not match unrelated keys", () => {
    expect(isReloadKey(chord("s", { ctrlKey: true }))).toBe(false);
    expect(isReloadKey(chord("F12"))).toBe(false);
    expect(isReloadKey(chord("r"))).toBe(false);
  });
});