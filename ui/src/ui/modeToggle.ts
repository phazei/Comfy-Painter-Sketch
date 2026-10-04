/**
 * Simple / Advanced segmented toggle (SPEC "Simple mode"). The host mounts
 * one in the node header (in-node) and one in the bottom bar (fullscreen,
 * where there is no node header); CSS shows the one that fits.
 *
 * Buttons never keep DOM focus (the keyboard scope redirects presses).
 */

import type { EditorMode } from "../defaults/modeDefaults";

/** Segments in order. */
const SEGMENTS: readonly { mode: EditorMode; label: string; title: string }[] = [
  { mode: "simple", label: "Simple", title: "Simple: basic tools; shortcuts still work (Tab)" },
  { mode: "advanced", label: "Advanced", title: "Advanced: all the things (Tab)" },
];

/**
 * One Simple / Advanced toggle.
 */
export class ModeToggle {
  /** `.cps-mode-toggle`. */
  readonly element: HTMLDivElement;
  private readonly buttons = new Map<EditorMode, HTMLButtonElement>();

  /**
   * @param className - Extra class (placement).
   * @param pick - A segment was clicked.
   */
  constructor(className: string, pick: (mode: EditorMode) => void) {
    this.element = document.createElement("div");
    this.element.className = `cps-mode-toggle ${className}`;
    this.element.setAttribute("role", "radiogroup");
    this.element.setAttribute("aria-label", "Editor mode");
    for (const { mode, label, title } of SEGMENTS) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "cps-mode-seg";
      button.textContent = label;
      button.title = title;
      button.setAttribute("role", "radio");
      button.addEventListener("click", () => pick(mode));
      this.buttons.set(mode, button);
      this.element.appendChild(button);
    }
  }

  /**
   * Show the current mode.
   * @param mode - Current mode.
   */
  set(mode: EditorMode): void {
    for (const [m, button] of this.buttons) {
      button.classList.toggle("cps-active", m === mode);
      button.setAttribute("aria-checked", String(m === mode));
    }
  }
}
