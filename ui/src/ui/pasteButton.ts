/**
 * The rail's Paste button (SPEC "Clipboard and drop"), following the tool-group
 * convention (`toolGroupSlot.ts`): long-press (or right-click) opens a small
 * menu with "System clipboard" / "Clipspace"; the chosen entry runs AND
 * becomes the button's main action and icon until changed. The choice lives
 * on the button instance, exactly like a tool group slot's current tool
 * (same scope and lifetime: this editor's rail). Both entries are always
 * enabled; an empty source shows a stage note. Modes:
 *
 * - System (default): the Ctrl+V order -- system clipboard via
 *   `navigator.clipboard.read()`, else our own copy, else the clipspace.
 * - Clipspace: the ComfyUI clipspace image only (paste icon with a "C" badge).
 *
 * The tooltip names the current source. Like every rail button it never
 * takes DOM focus (the keyboard scope prevents it).
 */

import { setIcon } from "./icons";
import type { PasteRequest } from "./clipboardActions";
import type { PopoverHandle, PopoverHost } from "./popover";

/** Press duration that opens the menu, ms. */
const LONG_PRESS_MS = 400;

/** Icon and label per mode. */
const MODES: Readonly<Record<PasteRequest, { icon: string; label: string }>> = {
  system: { icon: "paste", label: "System clipboard" },
  clipspace: { icon: "pasteClipspace", label: "Clipspace" },
};

/**
 * Tooltip of the button in a mode.
 * @param mode - Current mode.
 * @returns Title text.
 */
export function pasteButtonTitle(mode: PasteRequest): string {
  const source = mode === "clipspace" ? "from the ComfyUI clipspace" : "from the system clipboard (else our copy, else clipspace), Ctrl+V";
  return `Paste as new layer ${source}. Ctrl+Shift+V pastes our copy in place. Hold for sources`;
}

/** What the button needs. */
export interface PasteButtonOptions {
  popovers: PopoverHost;
  /** Run a paste. */
  paste(request: PasteRequest): void;
}

/**
 * Rail Paste button with a long-press source menu.
 */
export class PasteButton {
  readonly element: HTMLButtonElement;
  private pressTimer: ReturnType<typeof setTimeout> | null = null;
  private suppressClick = false;
  private menu: PopoverHandle | null = null;
  /** Current main action (per instance, like `ToolGroupSlot.currentId`). */
  private currentMode: PasteRequest = "system";

  /**
   * @param options - Popover host and callbacks.
   */
  constructor(private readonly options: PasteButtonOptions) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "cps-rail-button cps-rail-grouped";
    button.setAttribute("aria-haspopup", "menu");
    button.addEventListener("click", () => this.handleClick());
    button.addEventListener("pointerdown", (e) => this.startPress(e));
    button.addEventListener("pointerup", () => this.endPress());
    button.addEventListener("pointerleave", () => this.endPress());
    button.addEventListener("pointercancel", () => this.endPress());
    button.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      this.endPress();
      this.openMenu();
    });
    this.element = button;
    this.render();
  }

  /** Close the menu and stop timers. */
  dispose(): void {
    this.endPress();
    this.menu?.close();
  }

  // ── Internals ───────────────────────────────────────────────────────────

  /** Icon + tooltip for the current mode (the corner mark shows there is a menu). */
  private render(): void {
    const button = this.element;
    setIcon(button, MODES[this.currentMode].icon);
    const corner = document.createElement("span");
    corner.className = "cps-rail-corner";
    button.appendChild(corner);
    const title = pasteButtonTitle(this.currentMode);
    button.title = title;
    button.setAttribute("aria-label", title);
  }

  private handleClick(): void {
    if (this.suppressClick) {
      this.suppressClick = false;
      return;
    }
    this.menu?.close();
    this.options.paste(this.currentMode);
  }

  private startPress(event: PointerEvent): void {
    this.suppressClick = false;
    if (event.button !== 0) return;
    this.endPress();
    this.pressTimer = setTimeout(() => {
      this.pressTimer = null;
      this.suppressClick = true;
      this.openMenu();
    }, LONG_PRESS_MS);
  }

  private endPress(): void {
    if (this.pressTimer !== null) clearTimeout(this.pressTimer);
    this.pressTimer = null;
  }

  private openMenu(): void {
    if (this.menu) return;
    const menu = document.createElement("div");
    menu.className = "cps-tool-flyout";
    menu.setAttribute("role", "menu");
    menu.append(this.item("system"), this.item("clipspace"));
    this.menu = this.options.popovers.open(menu, {
      anchor: this.element,
      placement: "right",
      onClose: () => {
        this.menu = null;
      },
    });
  }

  private item(mode: PasteRequest): HTMLButtonElement {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "cps-tool-flyout-item";
    if (mode === this.currentMode) item.classList.add("cps-active");
    item.setAttribute("role", "menuitem");
    setIcon(item, MODES[mode].icon, 18);
    const text = document.createElement("span");
    text.textContent = MODES[mode].label;
    item.appendChild(text);
    // The click is still a user gesture for `navigator.clipboard.read()`.
    item.addEventListener("click", () => {
      this.menu?.close();
      this.currentMode = mode;
      this.render();
      this.options.paste(mode);
    });
    return item;
  }
}
