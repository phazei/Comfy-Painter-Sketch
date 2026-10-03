/**
 * Editor shell layout (SPEC "Editor shell and focus"). The stage fills the
 * root; every bar floats over it in a named slot:
 *
 * ```
 * root (.cps-root)
 * ├─ stage            canvas area (fills the root)
 * ├─ top              .cps-float-top: history pill | dock column (dock + options strip) | images/clipboard pill
 * ├─ slidersSlot      left sliders pill (Size / Hardness)
 * ├─ noticeSlot       resolution notice, above the bottom bar's right end
 * ├─ bottomSlot       bottom bar (edit chip, Quick Mask, Align, resolution, Fit, Fullscreen, Help)
 * ├─ sidePanel        floating Layers / Outputs panel (outside the node in-node, inside in fullscreen)
 * ├─ overlaySlot      full-stage overlays (help)
 * └─ popoverHost      menus, fly-outs, pickers (inside the root so fullscreen carries them)
 * ```
 *
 * The shell only builds regions and runs the responsive layout rules
 * (`data-layout`, right-anchoring of bars wider than the node); components
 * render into the slots. Other components plug in via `sidePanel`,
 * `popoverHost` + `requestColorPick` / `pick-color` and the `fullscreen` event.
 */

import type { ColorSlot } from "../engine/colors";
import { Emitter } from "../engine/emitter";
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
  /** Fullscreen toggle requested (bottom bar button or `F`); EditorHost handles it. */
  fullscreen: undefined;
  /** Colour swatch clicked (see {@link ColorPickRequest}). */
  "pick-color": ColorPickRequest;
  /** Outputs tab toggle requested (`O`); HostSync handles it. */
  outputs: undefined;
  /** Help overlay toggle requested (`?` key or the Help button). */
  help: undefined;
}

/** Top row slots. */
export interface TopRegions {
  /** `.cps-float-top`: the whole row. */
  element: HTMLDivElement;
  /** Undo / Redo / Clear pill goes here. */
  history: HTMLDivElement;
  /** Dock column: the tool dock pill, then the options strip under it. */
  dockColumn: HTMLDivElement;
  dock: HTMLDivElement;
  strip: HTMLDivElement;
  /** Images / Copy / Cut / Paste pill goes here. */
  clip: HTMLDivElement;
}

/** Side margin of the floating bars, CSS px (the handoff's 12). */
const EDGE = 12;
/** Gap between the top-row groups when they share one row. */
const ROW_GAP = 10;
/** Width cap of the top row / bottom bars, CSS px (editor.css `--cps-bar-max`). */
const BAR_MAX = 1100;
/** Gap between the options strip and a fullscreen side panel dropped below it, CSS px. */
const STRIP_GAP = 8;

// ═══════════════════════════════════════════════════════════════════════════
// EditorShell
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Layout regions of one editor.
 */
export class EditorShell {
  /** Editor root (child of the DOM widget element; re-parented for fullscreen). */
  readonly root: HTMLDivElement;
  /** Canvas stage. */
  readonly stage: HTMLDivElement;
  readonly top: TopRegions;
  readonly slidersSlot: HTMLDivElement;
  readonly noticeSlot: HTMLDivElement;
  readonly bottomSlot: HTMLDivElement;
  readonly overlaySlot: HTMLDivElement;
  readonly sidePanel: SidePanel;
  readonly popoverHost: PopoverHost;
  readonly events = new Emitter<ShellEvents>();
  private readonly resizeObserver: ResizeObserver;
  private layoutQueued = false;

  constructor() {
    this.root = div("cps-root");
    this.stage = div("cps-stage");
    this.stage.tabIndex = -1;

    this.top = {
      element: div("cps-float-top"),
      history: div("cps-slot cps-slot-history"),
      dockColumn: div("cps-dock-column"),
      dock: div("cps-slot cps-slot-dock"),
      strip: div("cps-slot cps-slot-strip"),
      clip: div("cps-slot cps-slot-clip"),
    };
    this.top.dockColumn.append(this.top.dock, this.top.strip);
    this.top.element.append(this.top.history, this.top.dockColumn, this.top.clip);

    this.slidersSlot = div("cps-slot cps-slot-sliders");
    this.noticeSlot = div("cps-slot cps-slot-notice");
    this.bottomSlot = div("cps-slot cps-slot-bottom");
    this.overlaySlot = div("cps-overlay-slot");
    this.sidePanel = new SidePanel();

    this.root.append(
      this.stage,
      this.top.element,
      this.slidersSlot,
      this.noticeSlot,
      this.bottomSlot,
      this.sidePanel.element,
      this.overlaySlot,
    );
    this.popoverHost = new PopoverHost(this.root, this.stage);

    this.resizeObserver = new ResizeObserver(() => this.requestLayout());
    for (const el of [this.root, this.top.history, this.top.dock, this.top.strip, this.top.clip, this.bottomSlot, this.sidePanel.element]) {
      this.resizeObserver.observe(el);
    }
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
   * Wheel over the editor chrome (not the stage): Ctrl+wheel is prevented
   * (no browser zoom); a wheel over the options strip scrolls it sideways
   * when it overflows; everything else scrolls natively. Called by the event
   * isolation guard (propagation already stopped).
   * @param event - Wheel event.
   */
  handleChromeWheel(event: WheelEvent): void {
    const target = event.target;
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      return;
    }
    const strip = this.top.strip;
    if (!(target instanceof Node) || !strip.contains(target) || strip.scrollWidth <= strip.clientWidth) return;
    event.preventDefault();
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? strip.clientWidth : 1;
    const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
    strip.scrollLeft += delta * unit;
  }

  /** Re-run the responsive layout on the next frame (bars changed size). */
  requestLayout(): void {
    if (this.layoutQueued) return;
    this.layoutQueued = true;
    requestAnimationFrame(() => {
      this.layoutQueued = false;
      this.layout();
    });
  }

  /** Disconnect observers and close popovers. */
  dispose(): void {
    this.resizeObserver.disconnect();
    this.popoverHost.dispose();
    this.events.clear();
    this.sidePanel.events.clear();
  }

  // ── Responsive layout (design handoff "Narrow layouts") ─────────────────

  /**
   * Wide: history left, dock centred, clipboard right. Narrow (the centred
   * dock would overlap a side group): one centred row of all three with the
   * strip floating under the dock. Very narrow (a bar wider than the node):
   * that bar anchors to the node's right edge so the overflow sticks out to
   * the left, never under the side panel. The rows are capped at
   * {@link BAR_MAX} and centred, so the maths uses the capped width.
   */
  private layout(): void {
    if (this.root.clientWidth === 0) return;
    const rootW = Math.min(this.root.clientWidth, BAR_MAX + 2 * EDGE);
    const historyW = this.top.history.offsetWidth;
    const dockW = this.top.dock.offsetWidth;
    const clipW = this.top.clip.offsetWidth;
    const sideW = Math.max(historyW, clipW);
    const narrow = rootW / 2 - dockW / 2 < sideW + EDGE + ROW_GAP;
    this.root.dataset["layout"] = narrow ? "narrow" : "wide";
    const avail = rootW - 2 * EDGE;
    const rowW = historyW + dockW + clipW + 2 * ROW_GAP;
    this.top.element.classList.toggle("cps-anchor-right", narrow && rowW > avail);
    this.top.strip.classList.toggle("cps-anchor-right", this.top.strip.scrollWidth > avail);
    this.bottomSlot.classList.toggle("cps-anchor-right", this.bottomSlot.scrollWidth > avail);
    this.syncStripClear();
  }

  /**
   * Fullscreen side panel vs the options strip: when the strip reaches under
   * the panel's column (right edge, {@link EDGE} in), publish the strip's
   * bottom as `--cps-strip-clear` (root CSS px + a gap) so panel.css drops the
   * panel below it; otherwise clear the variable. Measured in client px and
   * divided by the root's on-screen scale (graph zoom in-node).
   */
  private syncStripClear(): void {
    const rootRect = this.root.getBoundingClientRect();
    const stripRect = this.top.strip.getBoundingClientRect();
    const panelW = this.sidePanel.element.offsetWidth;
    const scale = rootRect.width / this.root.clientWidth || 1;
    const panelLeft = rootRect.right - (EDGE + panelW) * scale;
    const overlaps = stripRect.width > 0 && panelW > 0 && stripRect.right > panelLeft;
    if (overlaps) {
      const bottom = (stripRect.bottom - rootRect.top) / scale + STRIP_GAP;
      this.root.style.setProperty("--cps-strip-clear", `${Math.ceil(bottom)}px`);
    } else {
      this.root.style.removeProperty("--cps-strip-clear");
    }
  }
}

function div(className: string): HTMLDivElement {
  const element = document.createElement("div");
  element.className = className;
  return element;
}
