import { describe, expect, it } from "vitest";

import { hoverMayTakeFocus, isScopeActive, isTextEntry, mayKeepFocus, pointerFocusAction } from "./focusPolicy";

const input = (type: string) => ({ tagName: "INPUT", type });

describe("focus classification", () => {
  it("treats text inputs, textareas, selects and contenteditable as text entry", () => {
    expect(isTextEntry(input("text"))).toBe(true);
    expect(isTextEntry(input("number"))).toBe(true);
    expect(isTextEntry({ tagName: "INPUT" })).toBe(true);
    expect(isTextEntry({ tagName: "TEXTAREA" })).toBe(true);
    expect(isTextEntry({ tagName: "SELECT" })).toBe(true);
    expect(isTextEntry({ tagName: "DIV", editable: true })).toBe(true);
    expect(isTextEntry(input("range"))).toBe(false);
    expect(isTextEntry(input("checkbox"))).toBe(false);
    expect(isTextEntry({ tagName: "BUTTON" })).toBe(false);
    expect(isTextEntry({ tagName: "DIV" })).toBe(false);
  });

  it("lets text entries and range sliders keep the browser default on pointerdown", () => {
    expect(pointerFocusAction(input("text"))).toBe("text");
    expect(pointerFocusAction({ tagName: "TEXTAREA" })).toBe("text");
    expect(pointerFocusAction(input("range"))).toBe("native");
    expect(pointerFocusAction(input("RANGE"))).toBe("native");
  });

  it("sends every other press (rows, buttons, canvas, svg) to the key sink", () => {
    for (const tagName of ["DIV", "SPAN", "BUTTON", "CANVAS", "svg", "path"]) {
      expect(pointerFocusAction({ tagName })).toBe("sink");
    }
    expect(pointerFocusAction(input("checkbox"))).toBe("sink");
    expect(pointerFocusAction(input("color"))).toBe("sink");
  });

  it("only text entries and sliders may keep focus inside the root", () => {
    expect(mayKeepFocus(input("text"))).toBe(true);
    expect(mayKeepFocus(input("range"))).toBe(true);
    expect(mayKeepFocus({ tagName: "BUTTON" })).toBe(false);
    expect(mayKeepFocus({ tagName: "DIV" })).toBe(false);
  });
});

describe("scope state", () => {
  const idle = { hovered: false, held: false, engaged: false, fullscreen: false };

  it("is active for hover, drag, engagement (click inside) or fullscreen", () => {
    expect(isScopeActive(idle)).toBe(false);
    expect(isScopeActive({ ...idle, hovered: true })).toBe(true);
    expect(isScopeActive({ ...idle, held: true })).toBe(true);
    expect(isScopeActive({ ...idle, engaged: true })).toBe(true);
    expect(isScopeActive({ ...idle, fullscreen: true })).toBe(true);
  });

  it("hover never steals focus from a text field", () => {
    expect(hoverMayTakeFocus(null)).toBe(true);
    expect(hoverMayTakeFocus({ tagName: "CANVAS" })).toBe(true);
    expect(hoverMayTakeFocus({ tagName: "BUTTON" })).toBe(true);
    expect(hoverMayTakeFocus({ tagName: "TEXTAREA" })).toBe(false);
    expect(hoverMayTakeFocus(input("text"))).toBe(false);
  });
});
