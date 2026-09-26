import { describe, expect, it } from "vitest";

import { fullscreenKeyPolicy } from "./fullscreenKeys";
import type { KeyChord } from "./fullscreenKeys";

function chord(key: string, mods: Partial<Omit<KeyChord, "key">> = {}): KeyChord {
  return { key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods };
}

describe("fullscreenKeyPolicy", () => {
  it("passes browser function keys", () => {
    for (const key of ["F5", "F11", "F12", "F1", "F24"]) expect(fullscreenKeyPolicy(chord(key))).toBe("pass");
    expect(fullscreenKeyPolicy(chord("F4", { altKey: true }))).toBe("pass");
  });

  it("passes browser Ctrl/Cmd combos", () => {
    expect(fullscreenKeyPolicy(chord("r", { ctrlKey: true }))).toBe("pass");
    expect(fullscreenKeyPolicy(chord("R", { ctrlKey: true, shiftKey: true }))).toBe("pass");
    expect(fullscreenKeyPolicy(chord("w", { metaKey: true }))).toBe("pass");
    expect(fullscreenKeyPolicy(chord("Tab", { ctrlKey: true }))).toBe("pass");
    expect(fullscreenKeyPolicy(chord("PageDown", { ctrlKey: true }))).toBe("pass");
    expect(fullscreenKeyPolicy(chord("I", { ctrlKey: true, shiftKey: true }))).toBe("pass");
    expect(fullscreenKeyPolicy(chord("ArrowLeft", { altKey: true }))).toBe("pass");
  });

  it("passes save and queue", () => {
    expect(fullscreenKeyPolicy(chord("s", { ctrlKey: true }))).toBe("pass");
    expect(fullscreenKeyPolicy(chord("Enter", { ctrlKey: true }))).toBe("pass");
    expect(fullscreenKeyPolicy(chord("Enter", { ctrlKey: true, shiftKey: true }))).toBe("pass");
  });

  it("swallows graph-editing keys", () => {
    expect(fullscreenKeyPolicy(chord("Delete"))).toBe("swallow");
    expect(fullscreenKeyPolicy(chord("Backspace"))).toBe("swallow");
    expect(fullscreenKeyPolicy(chord("c", { ctrlKey: true }))).toBe("swallow");
    expect(fullscreenKeyPolicy(chord("v", { ctrlKey: true }))).toBe("swallow");
    expect(fullscreenKeyPolicy(chord("V", { ctrlKey: true, shiftKey: true }))).toBe("swallow");
    expect(fullscreenKeyPolicy(chord("a", { ctrlKey: true }))).toBe("swallow");
    expect(fullscreenKeyPolicy(chord("g", { ctrlKey: true }))).toBe("swallow");
    expect(fullscreenKeyPolicy(chord("r"))).toBe("swallow");
    expect(fullscreenKeyPolicy(chord("Tab"))).toBe("swallow");
  });

  it("passes bare modifier keydowns (modifier tracking is observe-only)", () => {
    expect(fullscreenKeyPolicy(chord("Shift", { shiftKey: true }))).toBe("pass");
    expect(fullscreenKeyPolicy(chord("Control", { ctrlKey: true }))).toBe("pass");
    expect(fullscreenKeyPolicy(chord("Alt", { altKey: true }))).toBe("pass");
    expect(fullscreenKeyPolicy(chord("Meta", { metaKey: true }))).toBe("pass");
    expect(fullscreenKeyPolicy(chord("AltGraph", { ctrlKey: true, altKey: true }))).toBe("pass");
    // Held Ctrl+Shift, then Shift pressed again: still a bare modifier.
    expect(fullscreenKeyPolicy(chord("Shift", { ctrlKey: true, shiftKey: true }))).toBe("pass");
  });

  it("does not treat Ctrl+Alt combos as browser keys", () => {
    expect(fullscreenKeyPolicy(chord("r", { ctrlKey: true, altKey: true }))).toBe("swallow");
    expect(fullscreenKeyPolicy(chord("ArrowLeft", { altKey: true, ctrlKey: true }))).toBe("swallow");
  });
});
