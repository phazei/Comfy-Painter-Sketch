/**
 * One tool-dock slot for a tool group (Photoshop tool groups): shows the
 * group's current tool icon with the shared corner caret
 * (`longPress.ts`). Click selects the current tool; a long-press,
 * right-click or a press on the caret opens a fly-out menu below the slot
 * (`menu.ts`) listing the members with their keys. Generic over
 * {@link ToolGroupSpec}: the dock's Shapes slot (U) and its synthetic Select
 * slot (M / L / W) both use it.
 */

import type { ToolGroupSpec } from "../tools/toolGroups";
import type { Tool } from "../tools/types";
import { setIcon } from "./icons";
import { cornerCaret, installLongPress } from "./longPress";
import type { LongPressHandle } from "./longPress";
import { openMenu } from "./menu";
import type { PopoverHandle, PopoverHost } from "./popover";

/** What a slot needs. */
export interface ToolGroupSlotOptions {
  group: ToolGroupSpec;
  /** Member tools in group order. */
  tools: readonly Tool[];
  popovers: PopoverHost;
  /** A member was chosen (click or fly-out). */
  select(toolId: string): void;
  /** Slot tooltip (default: `"{label} (keys) · hold or right-click for more"`). */
  title?: string;
  /** Fly-out key column overrides by tool id (e.g. `"⇧M"`); `""` hides the key. */
  keys?: Readonly<Record<string, string>>;
}

/**
 * Key labels of the members: a tool's shortcut uppercased, shown on the
 * first member using that key only (Shift+key cycles the rest), unless
 * `overrides` names the tool.
 * @param tools - Members in group order.
 * @param overrides - Per-tool labels.
 * @returns Label per tool id.
 */
export function memberKeyLabels(tools: readonly Tool[], overrides: Readonly<Record<string, string>> = {}): Map<string, string> {
  const seen = new Set<string>();
  const labels = new Map<string, string>();
  for (const tool of tools) {
    const key = tool.shortcut.toUpperCase();
    const first = key !== "" && !seen.has(key);
    seen.add(key);
    labels.set(tool.id, overrides[tool.id] ?? (first ? key : ""));
  }
  return labels;
}

/**
 * Dock button + fly-out of one tool group.
 */
export class ToolGroupSlot {
  readonly element: HTMLButtonElement;
  private currentId: string;
  private readonly press: LongPressHandle;
  private readonly caret: HTMLSpanElement;
  private flyout: PopoverHandle | null = null;

  /**
   * @param options - Group, members, popover host, select callback.
   */
  constructor(private readonly options: ToolGroupSlotOptions) {
    this.currentId = options.tools[0]?.id ?? "";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "cps-bar-button cps-dock-tool cps-dock-group";
    button.dataset["group"] = options.group.id;
    const title = options.title ?? defaultTitle(options.group, options.tools);
    button.title = title;
    button.setAttribute("aria-label", title);
    button.setAttribute("aria-haspopup", "menu");
    button.setAttribute("aria-pressed", "false");
    this.element = button;
    this.caret = cornerCaret(() => this.press.openNow());
    this.press = installLongPress(button, {
      tap: () => {
        this.flyout?.close();
        this.options.select(this.currentId);
      },
      hold: () => this.openFlyout(),
    });
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
    this.setCurrent(activeId);
    const on = this.options.tools.some((t) => t.id === activeId);
    this.element.classList.toggle("cps-active", on);
    this.element.setAttribute("aria-pressed", String(on));
  }

  /** Close the fly-out and remove the press listeners. */
  dispose(): void {
    this.press.dispose();
    this.flyout?.close();
  }

  // ── Internals ───────────────────────────────────────────────────────────

  private render(): void {
    const tool = this.options.tools.find((t) => t.id === this.currentId);
    setIcon(this.element, tool?.icon ?? "", 19);
    this.element.appendChild(this.caret);
  }

  private openFlyout(): void {
    if (this.flyout) return;
    const keys = memberKeyLabels(this.options.tools, this.options.keys);
    this.element.classList.add("cps-menu-open");
    this.flyout = openMenu(this.options.popovers, {
      anchor: this.element,
      placement: "below",
      className: "cps-pop-flyout",
      entries: this.options.tools.map((tool) => {
        const key = keys.get(tool.id) ?? "";
        return {
          label: tool.label,
          icon: tool.icon,
          current: tool.id === this.currentId,
          ...(key ? { key } : {}),
          onPick: () => this.options.select(tool.id),
        };
      }),
      onClose: () => {
        this.flyout = null;
        this.element.classList.remove("cps-menu-open");
      },
    });
  }
}

/** `"{label} (M / L / W) · hold or right-click for more"`. */
function defaultTitle(group: ToolGroupSpec, tools: readonly Tool[]): string {
  const keys = [...new Set(tools.map((t) => t.shortcut.toUpperCase()).filter((k) => k !== ""))];
  const label = keys.length > 0 ? `${group.label} (${keys.join(" / ")})` : group.label;
  return `${label} \u00b7 hold or right-click for more`;
}
