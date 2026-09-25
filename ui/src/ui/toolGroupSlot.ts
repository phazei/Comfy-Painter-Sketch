/**
 * One rail slot for a tool group (Photoshop tool groups): shows the group's
 * current tool icon with a small corner triangle. Click selects the current
 * tool; long-press or right-click opens a flyout (popover to the right)
 * listing the members. Generic over {@link ToolGroupSpec}: the shape group
 * (U) uses it now, the M5 marquee group (M) can reuse it unchanged.
 */

import type { ToolGroupSpec } from "../tools/toolGroups";
import type { Tool } from "../tools/types";
import { setIcon } from "./icons";
import type { PopoverHandle, PopoverHost } from "./popover";

/** Press duration that opens the flyout, ms. */
const LONG_PRESS_MS = 400;

/** What a slot needs. */
export interface ToolGroupSlotOptions {
  group: ToolGroupSpec;
  /** Member tools in group order. */
  tools: readonly Tool[];
  popovers: PopoverHost;
  /** A member was chosen (click or flyout). */
  select(toolId: string): void;
}

/**
 * Rail button + flyout of one tool group.
 */
export class ToolGroupSlot {
  readonly element: HTMLButtonElement;
  private currentId: string;
  private activeId = "";
  private pressTimer: ReturnType<typeof setTimeout> | null = null;
  private suppressClick = false;
  private flyout: PopoverHandle | null = null;

  /**
   * @param options - Group, members, popover host, select callback.
   */
  constructor(private readonly options: ToolGroupSlotOptions) {
    this.currentId = options.tools[0]?.id ?? "";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "cps-rail-button cps-rail-grouped";
    button.dataset["group"] = options.group.id;
    const key = options.tools[0]?.shortcut.toUpperCase() ?? "";
    const title = key ? `${options.group.label} (${key}, Shift+${key} cycles)` : options.group.label;
    button.title = title;
    button.setAttribute("aria-label", title);
    button.setAttribute("aria-haspopup", "menu");
    button.addEventListener("click", () => this.handleClick());
    button.addEventListener("pointerdown", (e) => this.startPress(e));
    button.addEventListener("pointerup", () => this.endPress());
    button.addEventListener("pointerleave", () => this.endPress());
    button.addEventListener("pointercancel", () => this.endPress());
    button.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      this.endPress();
      this.openFlyout();
    });
    this.element = button;
    this.render();
  }

  /** Group id. */
  get groupId(): string {
    return this.options.group.id;
  }

  /**
   * Show a member as the group's current tool (the slot icon).
   * @param toolId - Member id (others are ignored).
   */
  setCurrent(toolId: string): void {
    if (!this.options.tools.some((t) => t.id === toolId) || toolId === this.currentId) return;
    this.currentId = toolId;
    this.render();
  }

  /**
   * Highlight when the active tool is a member (it also becomes current).
   * @param activeId - Active tool id.
   */
  setActive(activeId: string): void {
    this.activeId = activeId;
    this.setCurrent(activeId);
    const on = this.options.tools.some((t) => t.id === activeId);
    this.element.classList.toggle("cps-active", on);
    this.element.setAttribute("aria-pressed", String(on));
  }

  /** Close the flyout and stop timers. */
  dispose(): void {
    this.endPress();
    this.flyout?.close();
  }

  // ── Internals ───────────────────────────────────────────────────────────

  private render(): void {
    const tool = this.options.tools.find((t) => t.id === this.currentId);
    setIcon(this.element, tool?.icon ?? "");
    const corner = document.createElement("span");
    corner.className = "cps-rail-corner";
    this.element.appendChild(corner);
  }

  private handleClick(): void {
    if (this.suppressClick) {
      this.suppressClick = false;
      return;
    }
    this.flyout?.close();
    this.options.select(this.currentId);
  }

  private startPress(event: PointerEvent): void {
    this.suppressClick = false;
    if (event.button !== 0) return;
    this.endPress();
    this.pressTimer = setTimeout(() => {
      this.pressTimer = null;
      this.suppressClick = true;
      this.openFlyout();
    }, LONG_PRESS_MS);
  }

  private endPress(): void {
    if (this.pressTimer !== null) clearTimeout(this.pressTimer);
    this.pressTimer = null;
  }

  private openFlyout(): void {
    if (this.flyout) return;
    const menu = document.createElement("div");
    menu.className = "cps-tool-flyout";
    menu.setAttribute("role", "menu");
    for (const tool of this.options.tools) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "cps-tool-flyout-item";
      item.setAttribute("role", "menuitem");
      item.classList.toggle("cps-active", tool.id === this.activeId);
      setIcon(item, tool.icon, 18);
      const label = document.createElement("span");
      label.textContent = tool.label;
      const key = document.createElement("span");
      key.className = "cps-tool-flyout-key";
      key.textContent = tool.shortcut.toUpperCase();
      item.append(label, key);
      item.addEventListener("click", () => {
        this.flyout?.close();
        this.options.select(tool.id);
      });
      menu.appendChild(item);
    }
    this.flyout = this.options.popovers.open(menu, {
      anchor: this.element,
      placement: "right",
      onClose: () => {
        this.flyout = null;
      },
    });
  }
}
