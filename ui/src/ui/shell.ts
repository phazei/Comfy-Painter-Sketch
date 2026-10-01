/**
 * Editor shell layout (SPEC "Editor shell and focus"). Regions inside the editor root:
 *
 * ```
 * root (.cps-root)
 * ├─ rail        left tool rail: `rail.tools` (scrolls) + `rail.swatchSlot` (pinned bottom)
 * ├─ main
 * │  ├─ bar      top options bar: `bar.leading` | `bar.scroller` (h-scroll) | `bar.trailing`
 * │  └─ body
 * │     ├─ stage       canvas area
 * │     └─ sidePanel   right panel (collapsible; Layers / Outputs tabs)
 * └─ popoverHost  floating panels (inside the root so fullscreen carries them)
 * ```
 *
 * The shell only builds and sizes regions; components (rail, options bar,
 * swatches, stage renderer) render into them. Other components plug in via:
 * `sidePanel` (the Layers / Outputs tabs), `popoverHost` + `requestColorPick` /
 * `pick-color` (colour picker) and the `fullscreen` event + `root` (fullscreen).
 */

import type { ColorSlot } from "../engine/colors";
import { Emitter } from "../engine/emitter";
import { setIcon } from "./icons";
import { PopoverHost } from "./popover";
import { SidePanel } from "./sidePanel";

// ── Types ─────────────────────────────────────────────────────────────────────

/** A swatch was clicked: the EditorHost opens the colour picker. */
export interface ColorPickRequest {
  /** Which colour to edit. */
  slot: ColorSlot;
  /** Element to anchor a popover to. */
  anchor: HTMLElement;
}

/** Shell events. */
export interface ShellEvents {
  [key: string]: unknown;
  /** Fullscreen toggle requested (rail button or `F`); EditorHost handles it. */
  fullscreen: undefined;
  /** Colour swatch clicked (see {@link ColorPickRequest}). */
  "pick-color": ColorPickRequest;
  /** Outputs button (or `O`): toggle region mode on the Outputs tab; HostSync handles it. */
  outputs: undefined;
}

/** Left rail regions. */
export interface RailRegions {
  element: HTMLDivElement;
  /** Tool/action buttons (scrolls vertically when the node is short). */
  tools: HTMLDivElement;
  /** Bottom slot for the FG/BG swatch widget. */
  swatchSlot: HTMLDivElement;
}

/** Options bar regions. */
export interface BarRegions {
  element: HTMLDivElement;
  /** Fixed left area (Quick Mask badge, mask eye). */
  leading: HTMLDivElement;
  /** Tool options; scrolls horizontally, never wraps. */
  scroller: HTMLDivElement;
  /** Fixed right area (Outputs button + side panel toggle). */
  trailing: HTMLDivElement;
}

// ═══════════════════════════════════════════════════════════════════════════
// EditorShell
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Layout regions of one editor.
 */
export class EditorShell {
  /** Editor root (child of the DOM widget element; re-parented for fullscreen). */
  readonly root: HTMLDivElement;
  readonly rail: RailRegions;
  readonly bar: BarRegions;
  /** Canvas stage. */
  readonly stage: HTMLDivElement;
  readonly sidePanel: SidePanel;
  readonly popoverHost: PopoverHost;
  readonly events = new Emitter<ShellEvents>();
  private readonly panelButton: HTMLButtonElement;
  /** Opens the side panel on the Outputs tab (region mode); next to the panel toggle. */
  readonly outputsButton: HTMLButtonElement;
  private readonly resizeObserver: ResizeObserver;

  constructor() {
    this.root = div("cps-root");
    this.rail = { element: div("cps-rail"), tools: div("cps-rail-tools"), swatchSlot: div("cps-rail-swatches") };
    this.rail.element.append(this.rail.tools, this.rail.swatchSlot);

    this.bar = {
      element: div("cps-bar"),
      leading: div("cps-bar-leading"),
      scroller: div("cps-bar-scroller"),
      trailing: div("cps-bar-trailing"),
    };
    this.panelButton = document.createElement("button");
    this.panelButton.type = "button";
    this.panelButton.className = "cps-icon-button";
    setIcon(this.panelButton, "panel", 18);
    this.panelButton.addEventListener("click", () => this.sidePanel.toggle());
    this.outputsButton = document.createElement("button");
    this.outputsButton.type = "button";
    this.outputsButton.className = "cps-icon-button cps-outputs-button";
    this.outputsButton.title = "Output regions (O)";
    this.outputsButton.setAttribute("aria-label", this.outputsButton.title);
    this.outputsButton.setAttribute("aria-pressed", "false");
    setIcon(this.outputsButton, "region", 18);
    this.outputsButton.addEventListener("click", () => this.events.emit("outputs", undefined));
    this.bar.trailing.append(this.outputsButton, this.panelButton);
    this.bar.element.append(this.bar.leading, this.bar.scroller, this.bar.trailing);

    this.stage = div("cps-stage");
    this.stage.tabIndex = -1;
    this.sidePanel = new SidePanel();
    const body = div("cps-body");
    body.append(this.stage, this.sidePanel.element);
    const main = div("cps-main");
    main.append(this.bar.element, body);
    this.root.append(this.rail.element, main);
    this.popoverHost = new PopoverHost(this.root);

    this.sidePanel.events.on("collapse", () => this.syncPanelButton());
    this.syncPanelButton();
    this.resizeObserver = new ResizeObserver(() => this.sidePanel.handleWidth(this.root.clientWidth));
    this.resizeObserver.observe(this.root);
  }

  /**
   * Ask for a colour picker for a swatch: emits `pick-color` (the EditorHost
   * opens the picker popover and applies the colour).
   * @param slot - Foreground or background.
   * @param anchor - Swatch element.
   */
  requestColorPick(slot: ColorSlot, anchor: HTMLElement): void {
    this.events.emit("pick-color", { slot, anchor });
  }

  /**
   * Horizontal scroll for wheel over the options bar (vertical wheels scroll
   * it sideways). Called by the event isolation guard for non-stage wheels.
   * @param event - Wheel event (propagation already stopped).
   */
  handleChromeWheel(event: WheelEvent): void {
    const target = event.target;
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      return;
    }
    if (!(target instanceof Node) || !this.bar.element.contains(target)) return;
    event.preventDefault();
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? this.bar.scroller.clientWidth : 1;
    const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
    this.bar.scroller.scrollLeft += delta * unit;
  }

  /** Disconnect observers and close popovers. */
  dispose(): void {
    this.resizeObserver.disconnect();
    this.popoverHost.dispose();
    this.events.clear();
    this.sidePanel.events.clear();
  }

  // ── Internals ───────────────────────────────────────────────────────────

  private syncPanelButton(): void {
    const open = !this.sidePanel.collapsed;
    this.panelButton.classList.toggle("cps-active", open);
    this.panelButton.setAttribute("aria-pressed", String(open));
    this.panelButton.title = open ? "Hide side panel" : "Show side panel";
  }
}

function div(className: string): HTMLDivElement {
  const element = document.createElement("div");
  element.className = className;
  return element;
}
