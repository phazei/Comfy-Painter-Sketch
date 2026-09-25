/**
 * Left tool rail: tool buttons generated from the tool registry metadata
 * (id, label, shortcut, icon -- no per-tool markup; tool groups share one
 * slot with a flyout, `toolGroupSlot.ts`), then Quick Mask, then
 * the always-visible actions (Undo, Redo, Fit, Clear, Fullscreen; SPEC
 * "Canvas / view"). Renders into the shell's `rail.tools` region; the swatch
 * widget lives in `rail.swatchSlot`.
 */

import type { ToolGroupView } from "../tools/toolGroups";
import type { Tool } from "../tools/types";
import { setIcon } from "./icons";
import type { PopoverHost } from "./popover";
import { ToolGroupSlot } from "./toolGroupSlot";

/** Callbacks from the rail. */
export interface ToolRailActions {
  selectTool(id: string): void;
  /** Toggle the Quick Mask paint target (Q). */
  toggleQuickMask(): void;
  undo(): void;
  redo(): void;
  /** Fit image to stage (Ctrl+0). */
  fit(): void;
  /** Clear canvas (the handler confirms). */
  clear(): void;
  /** Fullscreen requested (F). */
  fullscreen(): void;
}

/**
 * Tool rail buttons with update hooks.
 */
export class ToolRail {
  private readonly toolButtons = new Map<string, HTMLButtonElement>();
  private readonly toolBox: HTMLDivElement;
  private readonly undoButton: HTMLButtonElement;
  private readonly redoButton: HTMLButtonElement;
  private readonly quickMaskButton: HTMLButtonElement;
  private readonly fullscreenButton: HTMLButtonElement;
  private toolIds = "";
  private groupSlots: ToolGroupSlot[] = [];

  /**
   * @param container - Shell region to render into.
   * @param actions - Button handlers.
   * @param popovers - Popover host (tool group flyouts).
   */
  constructor(
    container: HTMLElement,
    private readonly actions: ToolRailActions,
    private readonly popovers: PopoverHost,
  ) {
    this.toolBox = group();
    this.quickMaskButton = railButton("quickMask", "Quick Mask (Q)", () => this.actions.toggleQuickMask());
    this.quickMaskButton.classList.add("cps-rail-quickmask");
    this.quickMaskButton.setAttribute("aria-pressed", "false");
    const maskGroup = group();
    maskGroup.appendChild(this.quickMaskButton);
    const spacer = document.createElement("div");
    spacer.className = "cps-rail-spacer";
    this.undoButton = railButton("undo", "Undo (Ctrl+Z)", () => this.actions.undo());
    this.redoButton = railButton("redo", "Redo (Ctrl+Shift+Z)", () => this.actions.redo());
    this.fullscreenButton = railButton("fullscreen", "Fullscreen (F)", () => this.actions.fullscreen());
    this.fullscreenButton.setAttribute("aria-pressed", "false");
    const actionGroup = group();
    actionGroup.append(
      this.undoButton,
      this.redoButton,
      railButton("fit", "Fit to view (Ctrl+0)", () => this.actions.fit()),
      railButton("clear", "Clear canvas", () => this.actions.clear()),
      this.fullscreenButton,
    );
    container.append(this.toolBox, maskGroup, spacer, actionGroup);
  }

  /**
   * Show the Quick Mask state (highlighted while strokes go to the mask).
   * @param on - Mask is the paint target.
   * @param color - Mask display colour (tints the highlighted icon).
   */
  setQuickMask(on: boolean, color: string): void {
    this.quickMaskButton.classList.toggle("cps-active", on);
    this.quickMaskButton.setAttribute("aria-pressed", String(on));
    this.quickMaskButton.style.color = on ? color : "";
  }

  /**
   * Rebuild tool buttons from registry metadata (skipped when unchanged).
   * Tools in a group get one shared {@link ToolGroupSlot}.
   * @param tools - Tools in order.
   * @param activeId - Active tool id.
   * @param groups - Tool groups (last-used member per group).
   */
  setTools(tools: readonly Tool[], activeId: string, groups?: ToolGroupView): void {
    const ids = tools.map((t) => t.id).join(",");
    if (ids !== this.toolIds) {
      this.toolIds = ids;
      this.toolBox.replaceChildren();
      this.toolButtons.clear();
      for (const slot of this.groupSlots) slot.dispose();
      this.groupSlots = [];
      for (const tool of tools) {
        const spec = groups?.groupOf(tool.id);
        if (spec) {
          // Members of a tool group share one slot at the first member's position.
          if (this.groupSlots.some((s) => s.groupId === spec.id)) continue;
          const members = spec.toolIds.flatMap((id) => tools.filter((t) => t.id === id));
          const slot = new ToolGroupSlot({ group: spec, tools: members, popovers: this.popovers, select: (id) => this.actions.selectTool(id) });
          this.groupSlots.push(slot);
          this.toolBox.appendChild(slot.element);
          continue;
        }
        const title = tool.shortcut ? `${tool.label} (${tool.shortcut.toUpperCase()})` : tool.label;
        const button = railButton(tool.icon, title, () => this.actions.selectTool(tool.id));
        button.dataset["tool"] = tool.id;
        this.toolButtons.set(tool.id, button);
        this.toolBox.appendChild(button);
      }
    }
    for (const slot of this.groupSlots) {
      const current = groups?.currentOf(slot.groupId);
      if (current) slot.setCurrent(current);
    }
    this.setActive(activeId);
  }

  /**
   * Highlight the active tool (a group slot also switches to it).
   * @param activeId - Tool id.
   */
  setActive(activeId: string): void {
    for (const [id, button] of this.toolButtons) {
      button.classList.toggle("cps-active", id === activeId);
      button.setAttribute("aria-pressed", String(id === activeId));
    }
    for (const slot of this.groupSlots) slot.setActive(activeId);
  }

  /**
   * Enable/disable undo and redo.
   * @param canUndo - Undo available.
   * @param canRedo - Redo available.
   */
  setHistory(canUndo: boolean, canRedo: boolean): void {
    this.undoButton.disabled = !canUndo;
    this.redoButton.disabled = !canRedo;
  }

  /**
   * Show the fullscreen state (the same button exits).
   * @param on - Editor is fullscreen.
   */
  setFullscreen(on: boolean): void {
    const title = on ? "Exit fullscreen (F / Esc)" : "Fullscreen (F)";
    this.fullscreenButton.classList.toggle("cps-active", on);
    this.fullscreenButton.setAttribute("aria-pressed", String(on));
    this.fullscreenButton.title = title;
    this.fullscreenButton.setAttribute("aria-label", title);
    setIcon(this.fullscreenButton, on ? "exitFullscreen" : "fullscreen");
  }
}

function group(): HTMLDivElement {
  const element = document.createElement("div");
  element.className = "cps-rail-group";
  return element;
}

function railButton(icon: string, title: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "cps-rail-button";
  button.title = title;
  button.setAttribute("aria-label", title);
  button.addEventListener("click", onClick);
  setIcon(button, icon);
  return button;
}
