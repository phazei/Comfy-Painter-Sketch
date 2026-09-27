/**
 * Detects a plain click on the cobweb area (outside the maximum paint area,
 * where no tool can do anything): primary button, no modifiers, no Space
 * (pan-ready) or pan in progress, released within {@link CLICK_SLOP} px and
 * {@link CLICK_MS} ms of the press. Observe-only passive listeners: the press
 * still reaches the active tool unchanged (tools clip to the paint area).
 */

import type { Point } from "../geometry/rect";

/** Max pointer travel (stage CSS px) for a click. */
export const CLICK_SLOP = 4;
/** Max press duration for a click. */
export const CLICK_MS = 500;

/** A press being watched. */
interface Press {
  id: number;
  x: number;
  y: number;
  t: number;
}

/**
 * Whether a press/release pair is a plain click.
 * @param down - Press position + time.
 * @param up - Release position + time.
 * @returns `true` within the slop and time limits.
 */
export function isPlainClick(down: { x: number; y: number; t: number }, up: { x: number; y: number; t: number }): boolean {
  return Math.hypot(up.x - down.x, up.y - down.y) <= CLICK_SLOP && up.t - down.t <= CLICK_MS;
}

/** Click watcher on one stage element. */
export class WebClick {
  private press: Press | null = null;
  private readonly controller = new AbortController();

  /**
   * @param stage - Stage element.
   * @param onWeb - Whether a stage CSS point lies on the web (outside the cap).
   * @param onClick - Called on a plain click on the web.
   */
  constructor(
    private readonly stage: HTMLElement,
    private readonly onWeb: (p: Point) => boolean,
    private readonly onClick: () => void,
  ) {
    const opts = { signal: this.controller.signal, passive: true, capture: true };
    stage.addEventListener("pointerdown", (e) => this.down(e), opts);
    stage.addEventListener("pointerup", (e) => this.up(e), opts);
    stage.addEventListener("pointercancel", () => (this.press = null), opts);
  }

  /** Remove listeners. */
  dispose(): void {
    this.controller.abort();
  }

  private down(e: PointerEvent): void {
    this.press = null;
    const panning = this.stage.classList.contains("cps-pan-ready") || this.stage.classList.contains("cps-panning");
    if (e.button !== 0 || !e.isPrimary || panning || e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) return;
    this.press = { id: e.pointerId, x: e.clientX, y: e.clientY, t: e.timeStamp };
  }

  private up(e: PointerEvent): void {
    const press = this.press;
    this.press = null;
    if (!press || press.id !== e.pointerId || e.button !== 0) return;
    const scale = this.cssScale();
    const down = { x: press.x / scale, y: press.y / scale, t: press.t };
    if (!isPlainClick(down, { x: e.clientX / scale, y: e.clientY / scale, t: e.timeStamp })) return;
    if (this.onWeb(this.toStage(press.x, press.y)) && this.onWeb(this.toStage(e.clientX, e.clientY))) this.onClick();
  }

  /** Screen px per stage CSS px (graph zoom). */
  private cssScale(): number {
    const rect = this.stage.getBoundingClientRect();
    return this.stage.clientWidth > 0 && rect.width > 0 ? rect.width / this.stage.clientWidth : 1;
  }

  private toStage(clientX: number, clientY: number): Point {
    const rect = this.stage.getBoundingClientRect();
    const s = this.cssScale();
    return { x: (clientX - rect.left) / s, y: (clientY - rect.top) / s };
  }
}
