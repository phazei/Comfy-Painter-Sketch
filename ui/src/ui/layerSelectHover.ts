/**
 * Ctrl-hover feedback on layers-panel rows: while the pointer is over a
 * paint / text / mask row (not one of its buttons) and Ctrl is held, the row
 * shows the "load selection" cursor (arrow + marquee badge, + / - / x for
 * Shift / Alt / Shift+Alt). Over an lmask thumbnail or its add icon, the
 * held modifier is written to `data-mod` (`alt` / `shift`) so the slot shows
 * what a click will do (`layerMaskThumb.ts`). Modifier tracking is observe-only: key events
 * are read, never prevented; the window key listeners exist only while the
 * pointer is over the list.
 */

import { isControl } from "./layerRow";
import { layerSelectCursorCss, layerSelectMode } from "./moveCursors";

/** Rows that can load a selection (not the background). */
const ROW_SELECTOR = ".cps-layer-paint, .cps-layer-mask, .cps-layer-image-mask";
/** lmask slot parts with modifier indicators. */
const MOD_SELECTOR = ".cps-layer-mask-thumb, .cps-layer-mask-add";

/**
 * Cursor tracker for one layers list.
 */
export class LayerSelectHover {
  private readonly controller = new AbortController();
  private keys: AbortController | null = null;
  private row: HTMLElement | null = null;
  /** Hovered lmask slot part (modifier indicators). */
  private modTarget: HTMLElement | null = null;
  private mods = { ctrl: false, shift: false, alt: false };

  /**
   * @param list - The rows container.
   */
  constructor(list: HTMLElement) {
    const { signal } = this.controller;
    list.addEventListener("pointerenter", () => this.listenKeys(), { signal });
    list.addEventListener("pointerleave", () => this.leave(), { signal });
    list.addEventListener("pointermove", (e) => this.move(e), { signal });
  }

  /** Remove listeners and any cursor override. */
  dispose(): void {
    this.leave();
    this.controller.abort();
  }

  private move(event: PointerEvent): void {
    const target = event.target;
    const row = target instanceof Element && !isControl(target) ? target.closest<HTMLElement>(ROW_SELECTOR) : null;
    const modTarget = target instanceof Element ? target.closest<HTMLElement>(MOD_SELECTOR) : null;
    if (row !== this.row || modTarget !== this.modTarget) {
      this.clear();
      this.row = row;
      this.modTarget = modTarget;
    }
    this.read(event);
    this.listenKeys();
  }

  private listenKeys(): void {
    if (this.keys) return;
    this.keys = new AbortController();
    const opts = { capture: true, signal: this.keys.signal };
    window.addEventListener("keydown", (e) => this.read(e), opts);
    window.addEventListener("keyup", (e) => this.read(e), opts);
  }

  private leave(): void {
    this.keys?.abort();
    this.keys = null;
    this.clear();
    this.row = null;
    this.modTarget = null;
  }

  private read(event: KeyboardEvent | PointerEvent): void {
    this.mods = { ctrl: event.ctrlKey || event.metaKey, shift: event.shiftKey, alt: event.altKey };
    this.apply();
  }

  private apply(): void {
    const mode = layerSelectMode(this.mods);
    // Ctrl = load selection (the cursor says so); else Shift beats Alt, as the click does.
    if (this.modTarget) this.modTarget.dataset["mod"] = mode ? "" : this.mods.shift ? "shift" : this.mods.alt ? "alt" : "";
    if (this.row) this.row.style.cursor = mode ? layerSelectCursorCss(mode) : "";
  }

  private clear(): void {
    if (this.row) this.row.style.cursor = "";
    if (this.modTarget) delete this.modTarget.dataset["mod"];
  }
}
