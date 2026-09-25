/**
 * Pointer + wheel input on the canvas stage: routes presses to the active
 * tool, or pans (middle-drag, Space-drag), and zooms on wheel around the
 * cursor. Pointer positions are converted through `getBoundingClientRect()`
 * on every event (the node is drawn at graph zoom; never cache a scale), then
 * stage -> image (view) -> document (inverse frame map, decision 4).
 * During a tool drag, modifier key changes re-send the last sample
 * (`dragModifiers.ts`) and Esc can cancel the drag ({@link StageInput.cancelToolDrag}).
 */

import { normalizePressure } from "../engine/brush";
import { imageToDoc } from "../engine/frameMap";
import { stageToDoc } from "../engine/viewport";
import type { Point } from "../geometry/rect";
import type { Tool, ToolPointer } from "../tools/types";
import type { EditorSession } from "../widget/sessions";
import { DragModifierWatch } from "./dragModifiers";
import type { ModifierState } from "./dragModifiers";

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
  /** Alt state seen on a pointer event (keeps the Alt-eyedropper cursor in sync). */
  setAlt?(down: boolean): void;
  /** View changed by pan/zoom. */
  viewChanged(): void;
}

/**
 * A drag in progress. Tool drags keep the tool resolved at pointer-down
 * (`ToolRegistry.resolve`, Alt = temporary eyedropper) until release, even
 * if Alt changes mid-drag.
 */
type DragMode = { kind: "tool"; pointerId: number; tool: Tool } | { kind: "pan"; pointerId: number; last: Point };

/**
 * Stage pointer/wheel controller.
 */
export class StageInput {
  private drag: DragMode | null = null;
  private readonly controller = new AbortController();
  /** Last pointer event of the tool drag (re-sent when modifiers change). */
  private lastToolEvent: PointerEvent | null = null;
  private readonly modifierWatch = new DragModifierWatch((mods) => this.modifiersChanged(mods));

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
   * The tool locked at pointer-down for the current drag, or `null` when no
   * tool drag is in progress. Used by the stage overlay to show the correct
   * cursor/ring during modifier changes (e.g. Alt held mid-drag must not
   * switch the overlay to the eyedropper).
   * @returns The locked tool, or `null`.
   */
  get activeTool(): Tool | null {
    return this.drag?.kind === "tool" ? this.drag.tool : null;
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
    this.endToolDrag();
    if (drag?.kind === "tool") {
      const session = this.host.session();
      if (session) drag.tool.onCancel(session.editor);
    }
    this.host.setDragging(false);
  }

  /**
   * Esc: abort a tool drag in progress (e.g. a shape); pans are unaffected.
   * @returns `true` if a tool drag was cancelled.
   */
  cancelToolDrag(): boolean {
    if (this.drag?.kind !== "tool") return false;
    this.cancel();
    return true;
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
    this.host.setAlt?.(event.altKey);
    const tool = session.tools.resolve(event.altKey);
    this.drag = { kind: "tool", pointerId: event.pointerId, tool };
    this.lastToolEvent = event;
    this.modifierWatch.start();
    tool.onPointerDown(session.editor, this.samples(event, session));
    this.host.setHover(this.toStage(event));
  }

  private move(event: PointerEvent): void {
    const point = this.toStage(event);
    this.host.setAlt?.(event.altKey);
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
    this.lastToolEvent = event;
    drag.tool.onPointerMove(session.editor, this.samples(event, session));
  }

  /** Shift/Alt/Ctrl changed mid-drag: re-send the last position with the new modifiers. */
  private modifiersChanged(mods: ModifierState): void {
    const drag = this.drag;
    const last = this.lastToolEvent;
    const session = this.host.session();
    if (drag?.kind !== "tool" || !last || !session) return;
    drag.tool.onPointerMove(session.editor, [this.sample(last, session, mods)]);
  }

  private endToolDrag(): void {
    this.modifierWatch.stop();
    this.lastToolEvent = null;
  }

  private up(event: PointerEvent, cancelled: boolean): void {
    const drag = this.drag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    this.drag = null;
    this.endToolDrag();
    this.stage.classList.remove("cps-panning");
    this.release(event.pointerId);
    this.host.setDragging(false);
    if (drag.kind !== "tool") return;
    const session = this.host.session();
    if (!session) return;
    const tool = drag.tool;
    if (cancelled) tool.onCancel(session.editor);
    else tool.onPointerUp(session.editor, this.samples(event, session)[0] ?? this.sample(event, session));
    // Redraw the overlay: tool overlays (eyedropper loupe) end with the drag.
    if (event.type !== "lostpointercapture") this.host.setHover(this.toStage(event));
  }

  private handleLostCapture(event: PointerEvent): void {
    if (this.drag?.pointerId === event.pointerId) this.up(event, false);
  }

  private samples(event: PointerEvent, session: EditorSession): ToolPointer[] {
    const coalesced = typeof event.getCoalescedEvents === "function" ? event.getCoalescedEvents() : [];
    const list = coalesced.length ? coalesced : [event];
    return list.map((e) => this.sample(e, session, event));
  }

  private sample(e: PointerEvent, session: EditorSession, modifiers: ModifierState = e): ToolPointer {
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