/**
 * Floating side panel of the editor shell (design handoff "Side panel"):
 * 300 px wide, outside the node to its right in-node (16 px gap), inside the
 * editor at the top right in fullscreen (`styles/panel.css`). Header:
 * segmented tabs `Layers | Outputs | [shrink]` plus the active tab's header
 * extra (the Layers tab's opacity chip); body: the tab panels. Only the
 * tab's own list scrolls; the header and the tab's footer stay fixed.
 *
 * - Visibility is decided by the host ({@link SidePanel.setVisible}: node
 *   selected, editor engaged or fullscreen). A hide waits
 *   {@link HIDE_GRACE_MS} so the pointer can cross the gap between node and
 *   panel; entering the panel cancels the pending hide, and the panel stays
 *   while hovered.
 * - Height: {@link SidePanel.setHeightCap} sets `max-height`; below the cap
 *   the panel fits its content.
 * - Shrunk = header only (the third segment); clicking a tab expands.
 */

import { Emitter } from "../engine/emitter";
import { setIcon } from "./icons";

/** Delay before a requested hide takes effect, ms. */
export const HIDE_GRACE_MS = 250;

/** Side panel events. */
export interface SidePanelEvents {
  [key: string]: unknown;
  /** Visible tab changed (payload = tab id). */
  tab: string;
  /** Shrunk state changed (payload = shrunk). */
  shrink: boolean;
  /** Panel shown / hidden on screen (payload = visible). */
  visible: boolean;
}

/** One tab of {@link SidePanel.setTabs}. */
export interface SidePanelTab {
  /** Stable id (`showTab`, `tab` event). */
  id: string;
  /** Segment label. */
  label: string;
  /** Tab body (mounted once; hidden rather than recreated). */
  panel: HTMLElement;
  /** Segment tooltip. */
  title?: string;
  /** Shown on the header's right while this tab is active. */
  headerExtra?: HTMLElement;
}

interface MountedTab {
  id: string;
  button: HTMLButtonElement;
  panel: HTMLElement;
  extra: HTMLElement | null;
}

/**
 * The floating Layers / Outputs panel.
 */
export class SidePanel {
  /** Panel element (a child of the editor root). */
  readonly element: HTMLDivElement;
  /** Body holding the tab panels (a "Layers" placeholder until {@link SidePanel.setTabs}). */
  readonly content: HTMLDivElement;
  readonly events = new Emitter<SidePanelEvents>();
  private readonly segments: HTMLDivElement;
  private readonly extras: HTMLDivElement;
  private readonly shrinkButton: HTMLButtonElement;
  private tabs: MountedTab[] = [];
  private currentTab = "";
  private isShrunk = false;
  /** What the host asked for. */
  private wanted = false;
  /** Pointer over the panel. */
  private hovered = false;
  /** On screen (last emitted). */
  private shown = false;
  private graceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.element = div("cps-side");
    const header = div("cps-side-header");
    this.segments = div("cps-side-seg");
    this.segments.setAttribute("role", "tablist");
    this.shrinkButton = document.createElement("button");
    this.shrinkButton.type = "button";
    this.shrinkButton.className = "cps-side-shrink";
    setIcon(this.shrinkButton, "panelCollapse", 15);
    this.shrinkButton.addEventListener("click", () => this.setShrunk(!this.isShrunk));
    this.segments.append(this.shrinkButton);
    this.extras = div("cps-side-extra");
    header.append(this.segments, this.extras);
    this.content = div("cps-side-body");
    const placeholder = div("cps-side-placeholder");
    placeholder.textContent = "Layers";
    this.content.appendChild(placeholder);
    this.element.append(header, this.content);
    this.element.addEventListener("pointerenter", () => {
      this.hovered = true;
      this.cancelGrace();
    });
    this.element.addEventListener("pointerleave", () => {
      this.hovered = false;
      if (!this.wanted) this.startGrace();
    });
    this.syncShrink();
    this.apply(false);
  }

  /** Id of the visible tab ("" before {@link SidePanel.setTabs}). */
  get activeTab(): string {
    return this.currentTab;
  }

  /** Whether only the header shows. */
  get shrunk(): boolean {
    return this.isShrunk;
  }

  /** Whether the panel is on screen (including a pending hide's grace). */
  get visible(): boolean {
    return this.shown;
  }

  // ── Tabs ────────────────────────────────────────────────────────────────

  /**
   * Install the tabs (mounted once; hidden rather than recreated). The first
   * tab is shown.
   * @param panels - Tabs in order.
   */
  setTabs(panels: ReadonlyArray<SidePanelTab>): void {
    this.tabs = panels.map(({ id, label, panel, title, headerExtra }) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "cps-side-tab";
      button.textContent = label;
      if (title) button.title = title;
      button.setAttribute("role", "tab");
      button.addEventListener("click", () => {
        this.setShrunk(false);
        this.showTab(id);
      });
      panel.setAttribute("role", "tabpanel");
      return { id, button, panel, extra: headerExtra ?? null };
    });
    this.segments.replaceChildren(...this.tabs.map((t) => t.button), this.shrinkButton);
    this.extras.replaceChildren(...this.tabs.flatMap((t) => (t.extra ? [t.extra] : [])));
    this.content.replaceChildren(...this.tabs.map((t) => t.panel));
    this.currentTab = "";
    this.showTab(panels[0]?.id ?? "");
  }

  /**
   * Reveal a tab (kept across shrink and fullscreen; does not expand a shrunk
   * panel -- only a tab click does). Emits `tab` when the visible tab changes.
   * @param id - Tab id.
   */
  showTab(id: string): void {
    for (const tab of this.tabs) {
      const active = tab.id === id;
      tab.panel.hidden = !active;
      if (tab.extra) tab.extra.hidden = !active;
      tab.button.classList.toggle("cps-active", active);
      tab.button.setAttribute("aria-selected", String(active));
    }
    if (id === this.currentTab) return;
    this.currentTab = id;
    this.events.emit("tab", id);
  }

  // ── Shrink, height, visibility ──────────────────────────────────────────

  /**
   * Shrink to the header or expand. Emits `shrink` on change.
   * @param shrunk - New state.
   */
  setShrunk(shrunk: boolean): void {
    if (shrunk === this.isShrunk) return;
    this.isShrunk = shrunk;
    this.syncShrink();
    this.events.emit("shrink", shrunk);
  }

  /**
   * Cap the panel height (it fits its content below the cap; only the
   * active tab's list scrolls).
   * @param px - Maximum height in CSS px, or `null` for no cap.
   */
  setHeightCap(px: number | null): void {
    this.element.style.maxHeight = px !== null && Number.isFinite(px) && px > 0 ? `${Math.round(px)}px` : "";
  }

  /**
   * Show or hide the panel. A hide is delayed by {@link HIDE_GRACE_MS} and
   * waits while the pointer is over the panel; a show is immediate.
   * @param visible - Requested visibility.
   */
  setVisible(visible: boolean): void {
    this.wanted = visible;
    if (visible) {
      this.cancelGrace();
      this.apply(true);
    } else if (this.shown && !this.hovered) {
      this.startGrace();
    } else if (!this.shown) {
      this.apply(false);
    }
  }

  /** Cancel timers (the shell clears listeners). */
  dispose(): void {
    this.cancelGrace();
  }

  private startGrace(): void {
    if (this.graceTimer !== null) return;
    this.graceTimer = setTimeout(() => {
      this.graceTimer = null;
      if (!this.wanted && !this.hovered) this.apply(false);
    }, HIDE_GRACE_MS);
  }

  private cancelGrace(): void {
    if (this.graceTimer === null) return;
    clearTimeout(this.graceTimer);
    this.graceTimer = null;
  }

  private syncShrink(): void {
    this.element.classList.toggle("cps-shrunk", this.isShrunk);
    this.content.hidden = this.isShrunk;
    this.shrinkButton.title = this.isShrunk ? "Expand panel" : "Shrink panel";
    this.shrinkButton.setAttribute("aria-pressed", String(this.isShrunk));
  }

  private apply(shown: boolean): void {
    this.element.hidden = !shown;
    if (shown === this.shown) return;
    this.shown = shown;
    this.events.emit("visible", shown);
  }
}

function div(className: string): HTMLDivElement {
  const element = document.createElement("div");
  element.className = className;
  return element;
}
