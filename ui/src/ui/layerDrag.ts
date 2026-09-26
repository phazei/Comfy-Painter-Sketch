/**
 * Drag-to-reorder for the layers panel (pointer events). A press on a paint
 * row becomes a drag after a few pixels; only then is the pointer captured
 * (capturing earlier would retarget the row's `click`). While dragging, the
 * row under the pointer shows a drop line above or below it; the list
 * auto-scrolls near its edges. Paint rows drop only onto paint rows and mask
 * rows only onto mask rows (M8), so masks stay above paint layers and the
 * Background row never moves.
 */

import { isControl } from "./layerRow";

/** Pixels the pointer must travel before a press becomes a drag. */
const DRAG_THRESHOLD_PX = 4;
/** Auto-scroll zone at the list's top/bottom edge, CSS px (screen). */
const EDGE_PX = 18;
/** Auto-scroll step per pointermove. */
const SCROLL_STEP_PX = 8;

/** A drop position. */
export interface DropTarget {
  /** Layer id of the row dropped next to. */
  targetId: string;
  /** Above the target row (higher in the stack). */
  above: boolean;
}

/**
 * Pointer-driven row reordering on a list element.
 */
export class LayerDrag {
  private press: { id: string; pointerId: number; startY: number; row: HTMLElement; group: string } | null = null;
  private dragging = false;
  private drop: DropTarget | null = null;
  private marked: HTMLElement | null = null;
  private readonly controller = new AbortController();

  /**
   * @param list - Scrolling list holding `.cps-layer-row` elements.
   * @param onDrop - Called with the dragged id and the drop target.
   */
  constructor(
    private readonly list: HTMLElement,
    private readonly onDrop: (id: string, drop: DropTarget) => void,
  ) {
    const { signal } = this.controller;
    list.addEventListener("pointerdown", (e) => this.down(e), { signal });
    list.addEventListener("pointermove", (e) => this.move(e), { signal });
    list.addEventListener("pointerup", (e) => this.up(e, true), { signal });
    list.addEventListener("pointercancel", (e) => this.up(e, false), { signal });
    list.addEventListener("lostpointercapture", (e) => this.up(e, false), { signal });
  }

  /** Whether a drag is in progress. */
  get active(): boolean {
    return this.dragging;
  }

  /** Remove listeners. */
  dispose(): void {
    this.reset();
    this.controller.abort();
  }

  private down(event: PointerEvent): void {
    if (event.button !== 0 || isControl(event.target) || !(event.target instanceof Element)) return;
    const row = event.target.closest<HTMLElement>(".cps-layer-paint, .cps-layer-mask");
    const id = row?.dataset["layerId"];
    if (!row || !id) return;
    const group = row.classList.contains("cps-layer-mask") ? ".cps-layer-mask" : ".cps-layer-paint";
    this.press = { id, pointerId: event.pointerId, startY: event.clientY, row, group };
  }

  private move(event: PointerEvent): void {
    const press = this.press;
    if (!press || event.pointerId !== press.pointerId) return;
    if (!this.dragging) {
      if (Math.abs(event.clientY - press.startY) < DRAG_THRESHOLD_PX) return;
      try {
        this.list.setPointerCapture(event.pointerId);
      } catch {
        this.press = null;
        return;
      }
      this.dragging = true;
      press.row.classList.add("cps-dragging");
    }
    event.preventDefault();
    this.autoScroll(event.clientY);
    this.drop = this.findDrop(event.clientY, press.group);
    this.mark(this.drop);
  }

  private up(event: PointerEvent, commit: boolean): void {
    const press = this.press;
    if (!press || event.pointerId !== press.pointerId) return;
    const drop = this.drop;
    const wasDragging = this.dragging;
    this.reset();
    if (this.list.hasPointerCapture(event.pointerId)) this.list.releasePointerCapture(event.pointerId);
    if (commit && wasDragging && drop && drop.targetId !== press.id) this.onDrop(press.id, drop);
  }

  private reset(): void {
    this.press?.row.classList.remove("cps-dragging");
    this.press = null;
    this.dragging = false;
    this.drop = null;
    this.mark(null);
  }

  /** Row of the dragged row's group under (or nearest to) the pointer, above/below its middle. */
  private findDrop(clientY: number, group: string): DropTarget | null {
    const rows = [...this.list.querySelectorAll<HTMLElement>(group)];
    let best: DropTarget | null = null;
    for (const row of rows) {
      const id = row.dataset["layerId"];
      if (!id) continue;
      const r = row.getBoundingClientRect();
      if (clientY < r.top) return best ?? { targetId: id, above: true };
      best = { targetId: id, above: clientY < r.top + r.height / 2 };
      if (clientY <= r.bottom) return best;
      best = { targetId: id, above: false };
    }
    return best;
  }

  private mark(drop: DropTarget | null): void {
    const marked = this.marked;
    marked?.classList.remove("cps-drop-above", "cps-drop-below");
    this.marked = null;
    if (!drop) return;
    const row = [...this.list.querySelectorAll<HTMLElement>(".cps-layer-row")].find(
      (r) => r.dataset["layerId"] === drop.targetId,
    );
    if (!row) return;
    row.classList.add(drop.above ? "cps-drop-above" : "cps-drop-below");
    this.marked = row;
  }

  private autoScroll(clientY: number): void {
    const r = this.list.getBoundingClientRect();
    if (clientY < r.top + EDGE_PX) this.list.scrollTop -= SCROLL_STEP_PX;
    else if (clientY > r.bottom - EDGE_PX) this.list.scrollTop += SCROLL_STEP_PX;
  }
}
