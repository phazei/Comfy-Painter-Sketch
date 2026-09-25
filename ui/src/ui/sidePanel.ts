/**
 * Right side panel of the editor shell (~180 px, collapsible). M3.3 mounts
 * the layers panel into {@link SidePanel.content}. Collapse follows
 * `sidePanelState.ts`: automatic by editor width, user toggle wins until the
 * next size-class change.
 */

import { Emitter } from "../engine/emitter";
import { INITIAL_PANEL_STATE, isPanelCollapsed, panelResized, panelSetByUser } from "./sidePanelState";
import type { PanelState } from "./sidePanelState";

/** Side panel events. */
export interface SidePanelEvents {
  [key: string]: unknown;
  /** Collapsed state changed (payload = collapsed). */
  collapse: boolean;
}

/**
 * Collapsible right-hand panel.
 */
export class SidePanel {
  /** Panel element (a region of the shell body). */
  readonly element: HTMLDivElement;
  /** Mount point for panel content (placeholder "Layers" until M3.3). */
  readonly content: HTMLDivElement;
  readonly events = new Emitter<SidePanelEvents>();
  private state: Readonly<PanelState> = INITIAL_PANEL_STATE;
  private shown: boolean;

  constructor() {
    this.element = document.createElement("div");
    this.element.className = "cps-side";
    this.content = document.createElement("div");
    this.content.className = "cps-side-content";
    const placeholder = document.createElement("div");
    placeholder.className = "cps-side-placeholder";
    placeholder.textContent = "Layers";
    this.content.appendChild(placeholder);
    this.element.appendChild(this.content);
    this.shown = !isPanelCollapsed(this.state);
    this.apply();
  }

  /** Whether the panel is collapsed. */
  get collapsed(): boolean {
    return !this.shown;
  }

  /**
   * Collapse or expand (counts as an explicit choice until the editor
   * changes size class).
   * @param collapsed - New state.
   */
  setCollapsed(collapsed: boolean): void {
    this.update(panelSetByUser(this.state, collapsed));
  }

  /**
   * Current collapse state, for {@link SidePanel.restore} (fullscreen saves
   * it on enter and restores it on exit).
   * @returns Immutable state snapshot.
   */
  snapshot(): Readonly<PanelState> {
    return this.state;
  }

  /**
   * Restore a {@link SidePanel.snapshot}. Its size class is the one the
   * editor returns to, so the following resize keeps it.
   * @param state - Snapshot.
   */
  restore(state: Readonly<PanelState>): void {
    this.update(state);
  }

  /** Flip the collapsed state (the bar's panel button). */
  toggle(): void {
    this.setCollapsed(!this.collapsed);
  }

  /**
   * Editor root width changed (from the shell's ResizeObserver).
   * @param width - Root width, CSS px.
   */
  handleWidth(width: number): void {
    this.update(panelResized(this.state, width));
  }

  private update(next: Readonly<PanelState>): void {
    this.state = next;
    const shown = !isPanelCollapsed(next);
    if (shown === this.shown) return;
    this.shown = shown;
    this.apply();
    this.events.emit("collapse", !shown);
  }

  private apply(): void {
    this.element.hidden = !this.shown;
  }
}
