/**
 * Top-centre tool dock (design handoff "Top-centre tool dock"): one pill
 * with the rail tools from the registry metadata (id, label, shortcut, icon
 * -- no per-tool markup), split into sections by dividers, then the FG/BG
 * swatches (`swatches.ts`):
 *
 * ```
 * Brush, Eraser, Fill │ Select ▾, Move layer │ Shapes ▾, Text │ swatches
 * ```
 *
 * - Tool groups share one {@link ToolGroupSlot}. The registry's marquee
 *   group, the lasso and the magic wand are folded into one synthetic
 *   "Select" slot (its fly-out lists all four); the keys (M, Shift+M, L, W)
 *   stay registry / shortcut business.
 * - The order comes from {@link DOCK_SECTIONS}; rail tools it does not name
 *   are appended in registry order, so a new tool is never lost.
 * - The eyedropper is not a dock button: hovering the swatches (or a 380 ms
 *   press on them) reveals a small floating pill with it above the dock; it
 *   stays while the eyedropper is the active tool and hides 250 ms after the
 *   pointer leaves.
 * - Modal states (Free Transform, region mode, Align drawing) dim the dock
 *   ({@link ToolDock.setModal}).
 * - Simple mode ({@link ToolDock.setSimple}) hides the bucket, the Shapes slot
 *   and Text; one shows while it is the active tool (its shortcut picked it)
 *   and hides again once another tool is picked.
 *
 * Buttons never keep DOM focus (the keyboard scope redirects presses).
 */

import { MARQUEE_GROUP } from "../tools/marquee";
import type { ToolGroupSpec, ToolGroupView } from "../tools/toolGroups";
import type { Tool } from "../tools/types";
import { setIcon } from "./icons";
import { LONG_PRESS_MS } from "./longPress";
import type { PopoverHost } from "./popover";
import { SwatchWidget } from "./swatches";
import type { SwatchActions } from "./swatches";
import { ToolGroupSlot } from "./toolGroupSlot";

// ── Layout ────────────────────────────────────────────────────────────────────

/** Id of the eyedropper tool (revealed from the swatches, not a dock button). */
const EYEDROPPER_ID = "eyedropper";

/** The dock's Select slot: marquees, lasso, wand (the registry keeps M / L / W). */
const SELECT_GROUP: ToolGroupSpec = { id: "select", label: "Select", toolIds: [...MARQUEE_GROUP.toolIds, "lasso", "wand"] };

/** Dock sections (divider between them): tool ids or slot ids. */
const DOCK_SECTIONS: readonly (readonly string[])[] = [
  ["brush", "eraser", "bucket"],
  [SELECT_GROUP.id, "move-layer"],
  ["shape", "text"],
];

/** Dock entries (tool ids or slot ids) hidden in Simple mode unless active. */
const SIMPLE_HIDDEN: ReadonlySet<string> = new Set(["bucket", "shape", "text"]);

/** One rendered section: its leading divider and its entries. */
interface SectionView {
  divider: HTMLElement | null;
  items: { key: string; element: HTMLElement; toolIds: readonly string[] }[];
}

/** Slot tooltips (handoff copy). */
const SLOT_TITLES: Readonly<Record<string, string>> = {
  select: "Select (M / L / W) \u00b7 hold or right-click for more",
  shape: "Shapes (U) \u00b7 hold or right-click for more",
};

/** Fly-out key overrides (Shift+M reaches the ellipse marquee). */
const SLOT_KEYS: Readonly<Record<string, string>> = { "marquee-ellipse": "\u21e7M" };

/** Delay before the eyedropper pill hides after the pointer left, ms. */
const DROPPER_HIDE_MS = 250;

/** Callbacks from the dock. */
export interface ToolDockActions {
  selectTool(id: string): void;
  /** Swatch clicks. */
  swatches: SwatchActions;
}

/** One dock entry: a plain tool or a group slot. */
type DockEntry = { kind: "tool"; tool: Tool } | { kind: "group"; spec: ToolGroupSpec; tools: Tool[] };

// ═══════════════════════════════════════════════════════════════════════════
// ToolDock
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The tool dock pill.
 */
export class ToolDock {
  /** The pill. */
  readonly element: HTMLDivElement;
  /** Tool buttons (a press here closes the Images tray). */
  readonly toolBox: HTMLDivElement;
  readonly swatches: SwatchWidget;
  private readonly toolButtons = new Map<string, HTMLButtonElement>();
  private groupSlots: ToolGroupSlot[] = [];
  private sections: SectionView[] = [];
  private simple = false;
  private toolIds = "";
  private activeId = "";
  private readonly swatchBox: HTMLDivElement;
  private readonly dropperPill: HTMLDivElement;
  private readonly dropperButton: HTMLButtonElement;
  private hovering = false;
  private hideTimer: ReturnType<typeof setTimeout> | null = null;
  private pressTimer: ReturnType<typeof setTimeout> | null = null;
  private suppressClick = false;
  private readonly abort = new AbortController();

  /**
   * @param container - Shell slot (`shell.top.dock`).
   * @param actions - Tool selection + swatch handlers.
   * @param popovers - Popover host (group fly-outs).
   */
  constructor(
    container: HTMLElement,
    private readonly actions: ToolDockActions,
    private readonly popovers: PopoverHost,
  ) {
    this.element = document.createElement("div");
    this.element.className = "cps-pill cps-dock";
    this.toolBox = document.createElement("div");
    this.toolBox.className = "cps-dock-tools";
    this.swatches = new SwatchWidget(actions.swatches);

    this.dropperButton = document.createElement("button");
    this.dropperButton.type = "button";
    this.dropperButton.className = "cps-bar-button";
    const dropperTitle = "Eyedropper (I \u00b7 or hold Alt while painting)";
    this.dropperButton.title = dropperTitle;
    this.dropperButton.setAttribute("aria-label", dropperTitle);
    this.dropperButton.dataset["tool"] = EYEDROPPER_ID;
    setIcon(this.dropperButton, "eyedropper", 19);
    this.dropperButton.addEventListener("click", () => this.actions.selectTool(EYEDROPPER_ID));
    this.dropperPill = document.createElement("div");
    this.dropperPill.className = "cps-pill cps-dropper-pill";
    this.dropperPill.hidden = true;
    this.dropperPill.appendChild(this.dropperButton);

    this.swatchBox = document.createElement("div");
    this.swatchBox.className = "cps-dock-swatches";
    this.swatchBox.append(this.dropperPill, this.swatches.element);
    this.installReveal();

    this.element.append(this.toolBox, divider(), this.swatchBox);
    container.appendChild(this.element);
  }

  /**
   * Rebuild the tool buttons from registry metadata (skipped when the tool
   * list is unchanged), then sync the group slots and the highlight.
   * @param tools - Rail tools in registry order.
   * @param activeId - Active tool id.
   * @param groups - Tool groups (last-used member per group).
   */
  setTools(tools: readonly Tool[], activeId: string, groups?: ToolGroupView): void {
    const ids = tools.map((t) => t.id).join(",");
    if (ids !== this.toolIds) {
      this.toolIds = ids;
      this.rebuild(tools, groups);
    }
    for (const slot of this.groupSlots) {
      // The Select slot remembers its own last member (lasso / wand are in no registry group).
      const current = slot.groupId === SELECT_GROUP.id ? undefined : groups?.currentOf(slot.groupId);
      if (current) slot.setCurrent(current);
    }
    this.setActive(activeId);
  }

  /**
   * Highlight the active tool (a group slot also switches to it; the
   * eyedropper pill stays out while the eyedropper is active).
   * @param activeId - Tool id.
   */
  setActive(activeId: string): void {
    this.activeId = activeId;
    for (const [id, button] of this.toolButtons) {
      button.classList.toggle("cps-active", id === activeId);
      button.setAttribute("aria-pressed", String(id === activeId));
    }
    for (const slot of this.groupSlots) slot.setActive(activeId);
    this.syncSimple();
    const dropper = activeId === EYEDROPPER_ID;
    this.dropperButton.classList.toggle("cps-active", dropper);
    this.dropperButton.setAttribute("aria-pressed", String(dropper));
    this.syncDropper();
  }

  /**
   * Dim the dock while a modal state runs (Free Transform, region mode,
   * Align drawing): idle icon colour, no active tint.
   * @param on - A modal state is on.
   */
  setModal(on: boolean): void {
    this.toolBox.classList.toggle("cps-dimmed", on);
    this.dropperPill.classList.toggle("cps-dimmed", on);
    this.element.classList.toggle("cps-modal", on);
  }

  /**
   * Simple mode: hide the advanced tools (each still shows while active).
   * @param on - Simple mode.
   */
  setSimple(on: boolean): void {
    this.simple = on;
    this.syncSimple();
  }

  /** Close fly-outs, stop timers and listeners. */
  dispose(): void {
    for (const slot of this.groupSlots) slot.dispose();
    this.clearTimers();
    this.abort.abort();
  }

  // ── Building ────────────────────────────────────────────────────────────

  private rebuild(tools: readonly Tool[], groups?: ToolGroupView): void {
    this.toolBox.replaceChildren();
    this.toolButtons.clear();
    for (const slot of this.groupSlots) slot.dispose();
    this.groupSlots = [];
    this.sections = dockSections(tools, groups).map((section, i) => {
      const line = i > 0 ? divider() : null;
      if (line) this.toolBox.appendChild(line);
      const items = section.map((entry) => {
        const element = this.entryElement(entry);
        this.toolBox.appendChild(element);
        return entry.kind === "group"
          ? { key: entry.spec.id, element, toolIds: entry.tools.map((t) => t.id) }
          : { key: entry.tool.id, element, toolIds: [entry.tool.id] };
      });
      return { divider: line, items };
    });
    this.syncSimple();
  }

  /** Simple-mode visibility of the entries, and of dividers between visible sections. */
  private syncSimple(): void {
    let before = false;
    for (const section of this.sections) {
      let any = false;
      for (const item of section.items) {
        const hide = hiddenInDock(this.simple, item.key, item.toolIds, this.activeId);
        item.element.hidden = hide;
        any ||= !hide;
      }
      if (section.divider) section.divider.hidden = !(any && before);
      before ||= any;
    }
  }

  private entryElement(entry: DockEntry): HTMLElement {
    if (entry.kind === "group") {
      const slot = new ToolGroupSlot({
        group: entry.spec,
        tools: entry.tools,
        popovers: this.popovers,
        select: (id) => this.actions.selectTool(id),
        ...(SLOT_TITLES[entry.spec.id] ? { title: SLOT_TITLES[entry.spec.id] } : {}),
        keys: SLOT_KEYS,
      });
      this.groupSlots.push(slot);
      return slot.element;
    }
    const { tool } = entry;
    const title = tool.shortcut ? `${tool.label} (${tool.shortcut.toUpperCase()})` : tool.label;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "cps-bar-button cps-dock-tool";
    button.title = title;
    button.setAttribute("aria-label", title);
    button.setAttribute("aria-pressed", "false");
    button.dataset["tool"] = tool.id;
    setIcon(button, tool.icon, 19);
    button.addEventListener("click", () => this.actions.selectTool(tool.id));
    this.toolButtons.set(tool.id, button);
    return button;
  }

  // ── Eyedropper reveal ───────────────────────────────────────────────────

  private installReveal(): void {
    const { signal } = this.abort;
    const box = this.swatchBox;
    // Mouse: hover reveals; leaving hides after a short delay (the gap up to the pill is crossable).
    box.addEventListener("pointerenter", (event) => event.pointerType === "mouse" && this.setHover(true), { signal });
    box.addEventListener("pointerleave", (event) => event.pointerType === "mouse" && this.setHover(false), { signal });
    // Any pointer: a long press on the swatches reveals the pill until the next press elsewhere.
    box.addEventListener(
      "pointerdown",
      (event) => {
        this.suppressClick = false;
        if (event.button !== 0 || (event.target instanceof Node && this.dropperPill.contains(event.target))) return;
        this.clearPress();
        this.pressTimer = setTimeout(() => {
          this.pressTimer = null;
          this.suppressClick = true;
          this.setHover(true);
          this.watchOutsidePress();
        }, LONG_PRESS_MS);
      },
      { signal },
    );
    for (const type of ["pointerup", "pointercancel"] as const) box.addEventListener(type, () => this.clearPress(), { signal });
    // The click ending a long press must not also open the colour picker / swap.
    box.addEventListener(
      "click",
      (event) => {
        if (!this.suppressClick) return;
        this.suppressClick = false;
        event.stopPropagation();
      },
      { capture: true, signal },
    );
  }

  /** After a long-press reveal: hide on the next press outside the swatches. */
  private watchOutsidePress(): void {
    const outside = (event: PointerEvent): void => {
      if (event.target instanceof Node && this.swatchBox.contains(event.target)) return;
      window.removeEventListener("pointerdown", outside, true);
      this.setHover(false);
    };
    window.addEventListener("pointerdown", outside, { capture: true, signal: this.abort.signal });
  }

  private setHover(on: boolean): void {
    if (this.hideTimer !== null) clearTimeout(this.hideTimer);
    this.hideTimer = null;
    if (on) {
      this.hovering = true;
      this.syncDropper();
      return;
    }
    this.clearPress();
    this.hideTimer = setTimeout(() => {
      this.hideTimer = null;
      this.hovering = false;
      this.syncDropper();
    }, DROPPER_HIDE_MS);
  }

  private syncDropper(): void {
    this.dropperPill.hidden = !(this.hovering || this.activeId === EYEDROPPER_ID);
  }

  private clearPress(): void {
    if (this.pressTimer !== null) clearTimeout(this.pressTimer);
    this.pressTimer = null;
  }

  private clearTimers(): void {
    this.clearPress();
    if (this.hideTimer !== null) clearTimeout(this.hideTimer);
    this.hideTimer = null;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Group the dock's tools into sections: {@link DOCK_SECTIONS} order, then
 * any rail tool it does not name (registry order). The eyedropper and tools
 * outside the rail are skipped; empty sections are dropped.
 * @param tools - Rail tools in registry order.
 * @param groups - Registry tool groups.
 * @returns Sections of entries.
 */
function dockSections(tools: readonly Tool[], groups?: ToolGroupView): DockEntry[][] {
  const byKey = new Map<string, DockEntry>();
  const order: string[] = [];
  for (const tool of tools) {
    if (tool.id === EYEDROPPER_ID || tool.rail === false) continue;
    const spec = SELECT_GROUP.toolIds.includes(tool.id) ? SELECT_GROUP : groups?.groupOf(tool.id);
    const key = spec?.id ?? tool.id;
    const existing = byKey.get(key);
    if (existing?.kind === "group") {
      existing.tools.push(tool);
      continue;
    }
    byKey.set(key, spec ? { kind: "group", spec, tools: [tool] } : { kind: "tool", tool });
    order.push(key);
  }
  // Members in the spec's order (the fly-out and cycle order).
  for (const entry of byKey.values()) {
    if (entry.kind === "group") entry.tools.sort((a, b) => entry.spec.toolIds.indexOf(a.id) - entry.spec.toolIds.indexOf(b.id));
  }
  const placed = new Set<string>();
  const sections = DOCK_SECTIONS.map((keys) =>
    keys.flatMap((key) => {
      const entry = byKey.get(key);
      if (!entry) return [];
      placed.add(key);
      return [entry];
    }),
  );
  const rest = order.filter((key) => !placed.has(key)).flatMap((key) => byKey.get(key) ?? []);
  return [...sections, rest].filter((s) => s.length > 0);
}

/**
 * Whether a dock entry is hidden: in Simple mode the bucket, the Shapes slot
 * and Text are, unless one of their tools is active.
 * @param simple - Simple mode.
 * @param key - Tool id or slot id.
 * @param toolIds - Tools behind the entry.
 * @param activeId - Active tool id.
 * @returns `true` to hide.
 */
export function hiddenInDock(simple: boolean, key: string, toolIds: readonly string[], activeId: string): boolean {
  return simple && SIMPLE_HIDDEN.has(key) && !toolIds.includes(activeId);
}

function divider(): HTMLSpanElement {
  const el = document.createElement("span");
  el.className = "cps-vdiv";
  return el;
}
