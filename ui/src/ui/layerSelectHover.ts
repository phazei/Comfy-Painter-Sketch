/**
 * Ctrl-hover feedback on layers-panel rows: while the pointer is over a
 * paint / text / mask row (not one of its buttons) and Ctrl is held, the row
 * shows the "load selection" cursor (arrow + marquee badge, + / - / x for
 * Shift / Alt / Shift+Alt). Modifier tracking is observe-only: key events
 * are read, never prevented; the window key listeners exist only while the
 * pointer is over the list.
 */

import { isControl } from "./layerRow";
import { layerSelectCursorCss, layerSelectMode } from "./moveCursors";

/** Rows that can load a selection (not the background). */
const ROW_SELECTOR = ".cps-layer-paint, .cps-layer-mask, .cps-layer-image-mask";

/**
 * Cursor tracker for one layers list.
 */
export class LayerSelectHover {
  private readonly controller = new AbortController();
  private keys: AbortController | null = null;
  private row: HTMLElement | null = null;
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
    if (row !== this.row) {
      this.clear();
      this.row = row;
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
  }

  private read(event: KeyboardEvent | PointerEvent): void {
    this.mods = { ctrl: event.ctrlKey || event.metaKey, shift: event.shiftKey, alt: event.altKey };
    this.apply();
  }

  private apply(): void {
    const row = this.row;
    if (!row) return;
    const mode = layerSelectMode(this.mods);
    row.style.cursor = mode ? layerSelectCursorCss(mode) : "";
  }

  private clear(): void {
    if (this.row) this.row.style.cursor = "";
  }
}
