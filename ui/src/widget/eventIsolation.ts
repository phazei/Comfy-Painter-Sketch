/**
 * Keeps pointer and wheel input on the editor from reaching the graph.
 *
 * Why each piece exists (checked against ComfyUI_frontend 1.55.2):
 * - LiteGraph renderer: DOM widgets live in an overlay that is a sibling of
 *   the graph `<canvas>` (`DomWidgets.vue`), so events never bubble into
 *   LiteGraph, but they do bubble to document-level listeners. Stopping
 *   propagation on our root keeps them local.
 * - Nodes 2.0: the node component (`LGraphNode.vue`) starts node drags on
 *   `pointerdown` (`WidgetDOM.vue` already `.stop`s pointerdown/move/up; we
 *   stop down/up too so we don't depend on that), and `TransformPane` forwards wheel to
 *   the graph in the **capture** phase (`@wheel.capture`), before any
 *   listener on our element runs. The only way to see a wheel event first is
 *   a capture listener on `window`, so we attach one while the pointer is over
 *   the stage and remove it on leave (no always-on global listener).
 *   `data-capture-wheel="true"` is also set: the frontend honours it when our
 *   element contains focus, which covers plain wheel even without the guard.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

/** Handle returned by {@link isolateEvents}; call `dispose` on teardown. */
export interface EventIsolation {
  dispose(): void;
}

/** Options for {@link isolateEvents}. */
export interface IsolationOptions {
  /** Element whose pointer events must not reach the graph (editor root). */
  root: HTMLElement;
  /** Element where wheel is consumed by the editor (the canvas stage). */
  wheelTarget: HTMLElement;
  /** Editor wheel handler (zoom in M1). Receives the already-stopped event. */
  onWheel?: (event: WheelEvent) => void;
}

// ── Implementation ────────────────────────────────────────────────────────────

/**
 * Bubbling events stopped at the editor root. `pointermove` is left alone so
 * document-level hover tracking (e.g. LiteGraph's ghost-node placement) keeps
 * working; strokes in M1 stop it while a pointer is captured.
 */
const POINTER_EVENTS = [
  "pointerdown",
  "pointerup",
  "pointercancel",
  "mousedown",
  "mouseup",
  "dblclick",
  "contextmenu",
] as const;

/**
 * Install pointer/wheel isolation on the editor.
 *
 * @param options - Root and wheel target elements plus the editor wheel handler.
 * @returns Handle that removes every listener it added.
 */
export function isolateEvents(options: IsolationOptions): EventIsolation {
  const { root, wheelTarget, onWheel } = options;
  const controller = new AbortController();
  const { signal } = controller;

  const stop = (event: Event): void => event.stopPropagation();
  for (const type of POINTER_EVENTS) root.addEventListener(type, stop, { signal });

  wheelTarget.dataset["captureWheel"] = "true";

  let guardActive = false;
  const guard = (event: WheelEvent): void => {
    const target = event.target;
    if (!(target instanceof Node) || !wheelTarget.contains(target)) return;
    event.preventDefault();
    event.stopPropagation();
    onWheel?.(event);
  };
  const armGuard = (): void => {
    if (guardActive) return;
    guardActive = true;
    window.addEventListener("wheel", guard, { capture: true, passive: false });
  };
  const disarmGuard = (): void => {
    if (!guardActive) return;
    guardActive = false;
    window.removeEventListener("wheel", guard, { capture: true });
  };

  // pointermove also arms, in case the element mounted under a resting cursor.
  wheelTarget.addEventListener("pointerenter", armGuard, { signal });
  wheelTarget.addEventListener("pointermove", armGuard, { signal });
  wheelTarget.addEventListener("pointerleave", disarmGuard, { signal });

  return {
    dispose(): void {
      controller.abort();
      disarmGuard();
    },
  };
}
