/**
 * Pointer + wheel input on the canvas stage: routes presses to the active
 * tool, or pans (middle-drag, Space-drag), and zooms on wheel around the
 * cursor. Pointer positions are converted through `getBoundingClientRect()`
 * on every event (the node is drawn at graph zoom; never cache a scale), then
 * stage -> image (view) -> document (inverse frame map, decision 4).
 */

import { normalizePressure } from "../engine/brush";
import { imageToDoc } from "../engine/frameMap";
import { stageToDoc } from "../engine/viewport";
import type { Point } from "../geometry/rect";
import type { ToolPointer } from "../tools/types";
import type { EditorSession } from "../widget/sessions";

/** What the stage input needs from its host. */
export interface StageInputHost {
  /** Current session (may be `null` while detached). */
  session(): EditorSession | null;
  /** Space is held. */
  isSpaceDown(): boolean;
  /** A drag started/ended (keeps keyboard scope alive). */
  setDragging(dragging: boolean): void;
  /** Pointer hover position in stage CSS px (`null` = left the stage). */
  setHover(point: Point | null): void;
  /** View changed by pan/zoom. */
  viewChanged(): void;
}

type DragMode = { kind: "tool"; pointerId: number } | { kind: "pan"; pointerId: number; last: Point };

/**
 * Stage pointer/wheel controller.
 */
export class StageInput {
  private drag: DragMode | null = null;
  private readonly controller = new AbortController();

  /**
   * @param stage - Stage element.
   * @param host - Host callbacks.
   */
  constructor(
    private readonly stage: HTMLElement,
    private readonly host: StageInputHost,
  ) {
    const { signal } = this.controller;
    stage.addEventListener("pointerdown", (e) => this.handlePointer(e), { signal });
    stage.addEventListener("pointermove", (e) => this.handlePointer(e), { signal });
    stage.addEventListener("pointerup", (e) => this.handlePointer(e), { signal });
    stage.addEventListener("pointercancel", (e) => this.handlePointer(e), { signal });
    stage.addEventListener("lostpointercapture", (e) => this.handleLostCapture(e), { signal });
    stage.addEventListener("pointerleave", () => this.host.setHover(null), { signal });
  }

  /**
   * Wheel over the stage (already stopped by the isolation guard): zoom
   * around the cursor.
   * @param event - Wheel event.
   */
  handleWheel(event: WheelEvent): void {
    const session = this.host.session();
    if (!session) return;
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? this.stage.clientHeight : 1;
    const delta = (Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX) * unit;
    session.editor.view.wheelZoom(delta, this.toStage(event));
    this.host.viewChanged();
  }

  /**
   * Any pointer event for the stage (also called by the isolation guard for
   * middle-button events).
   * @param event - Pointer event.
   */
  handlePointer(event: PointerEvent): void {
    switch (event.type) {
      case "pointerdown":
        this.down(event);
        break;
      case "pointermove":
        this.move(event);
        break;
      case "pointerup":
        this.up(event, false);
        break;
      case "pointercancel":
        this.up(event, true);
        break;
    }
  }

  /** Abort any drag in progress (tool switch, detach). */
  cancel(): void {
    const drag = this.drag;
    this.drag = null;
    if (drag?.kind === "tool") {
      const session = this.host.session();
      if (session) session.tools.active.onCancel(session.editor);
    }
    this.host.setDragging(false);
  }

  /** Remove listeners. */
  dispose(): void {
    this.cancel();
    this.controller.abort();
  }

  // ── Internals ───────────────────────────────────────────────────────────

  private down(event: PointerEvent): void {
    const session = this.host.session();
    if (!session || this.drag) return;
    const pan = event.button === 1 || (event.button === 0 && this.host.isSpaceDown());
    if (!pan && event.button !== 0) return;
    event.preventDefault();
    this.capture(event.pointerId);
    this.host.setDragging(true);
    if (pan) {
      this.drag = { kind: "pan", pointerId: event.pointerId, last: this.toStage(event) };
      this.stage.classList.add("cps-panning");
      return;
    }
    this.drag = { kind: "tool", pointerId: event.pointerId };
    session.tools.active.onPointerDown(session.editor, this.samples(event, session));
  }

  private move(event: PointerEvent): void {
    const point = this.toStage(event);
    this.host.setHover(point);
    const drag = this.drag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.stopPropagation();
    const session = this.host.session();
    if (!session) return;
    if (drag.kind === "pan") {
      session.editor.view.pan(point.x - drag.last.x, point.y - drag.last.y);
      drag.last = point;
      this.host.viewChanged();
      return;
    }
    session.tools.active.onPointerMove(session.editor, this.samples(event, session));
  }

  private up(event: PointerEvent, cancelled: boolean): void {
    const drag = this.drag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    this.drag = null;
    this.stage.classList.remove("cps-panning");
    this.release(event.pointerId);
    this.host.setDragging(false);
    if (drag.kind !== "tool") return;
    const session = this.host.session();
    if (!session) return;
    const tool = session.tools.active;
    if (cancelled) tool.onCancel(session.editor);
    else tool.onPointerUp(session.editor, this.samples(event, session)[0] ?? this.sample(event, session));
  }

  private handleLostCapture(event: PointerEvent): void {
    if (this.drag?.pointerId === event.pointerId) this.up(event, false);
  }

  private samples(event: PointerEvent, session: EditorSession): ToolPointer[] {
    const coalesced = typeof event.getCoalescedEvents === "function" ? event.getCoalescedEvents() : [];
    const list = coalesced.length ? coalesced : [event];
    return list.map((e) => this.sample(e, session, event));
  }

  private sample(e: PointerEvent, session: EditorSession, modifiers: PointerEvent = e): ToolPointer {
    const { editor } = session;
    const doc = imageToDoc(editor.frameMap, stageToDoc(editor.view.current, this.toStage(e)));
    return {
      x: doc.x,
      y: doc.y,
      pressure: normalizePressure(e.pointerType, e.pressure),
      pointerType: e.pointerType,
      shiftKey: modifiers.shiftKey,
      altKey: modifiers.altKey,
      ctrlKey: modifiers.ctrlKey || modifiers.metaKey,
    };
  }

  private toStage(e: { clientX: number; clientY: number }): Point {
    const rect = this.stage.getBoundingClientRect();
    const sx = rect.width > 0 ? this.stage.clientWidth / rect.width : 1;
    const sy = rect.height > 0 ? this.stage.clientHeight / rect.height : 1;
    return { x: (e.clientX - rect.left) * sx, y: (e.clientY - rect.top) * sy };
  }

  private capture(pointerId: number): void {
    try {
      this.stage.setPointerCapture(pointerId);
    } catch {
      // Pointer already released (fast click); nothing to capture.
    }
  }

  private release(pointerId: number): void {
    if (this.stage.hasPointerCapture(pointerId)) this.stage.releasePointerCapture(pointerId);
  }
}
