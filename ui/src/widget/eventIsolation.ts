/**
 * Keeps pointer and wheel input on the editor from reaching the graph.
 *
 * Why each piece exists (checked against ComfyUI_frontend 1.55.2):
 * - LiteGraph renderer: DOM widgets live in an overlay that is a sibling of
 *   the graph `<canvas>` (`DomWidgets.vue`), so events never bubble into
 *   LiteGraph, but they do bubble to document-level listeners. Stopping
 *   propagation on our root keeps them local.
 * - Nodes 2.0: `TransformPane` forwards wheel (`@wheel.capture`) and
 *   middle-button pointer events (`@pointerdown/move/up.capture`, used for
 *   graph panning) to the graph in the CAPTURE phase, before any listener on
 *   our element runs. The only way to see them first is a capture listener on
 *   `window`, so one is attached while the pointer is over the editor root
 *   (or a guarded drag is in progress) and removed afterwards. Guarded events
 *   are stopped there and handed to the editor directly: wheel over the stage
 *   zooms; wheel over the rest (rail, bar, side panel, popovers) goes to
 *   `onChromeWheel` with the default left alone (native scrolling).
 *   Middle-drag is only guarded when it starts on the stage.
 *   `data-capture-wheel="true"` is also set: the frontend honours it when our
 *   element contains focus.
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
  /** Canvas stage (wheel zoom, middle-drag pan). */
  stage: HTMLElement;
  /** Editor wheel handler (zoom). Receives the already-stopped event. */
  onWheel: (event: WheelEvent) => void;
  /**
   * Wheel over the rest of the editor (rail, options bar, side panel,
   * popovers). Propagation is stopped (never reaches the graph); default is
   * NOT prevented, so native scrolling works unless the handler prevents it.
   */
  onChromeWheel: (event: WheelEvent) => void;
  /** Editor handler for middle-button pointer events (already stopped). */
  onMiddlePointer: (event: PointerEvent) => void;
}

// ── Implementation ────────────────────────────────────────────────────────────

/**
 * Bubbling events stopped at the editor root. `pointermove` is left alone so
 * document-level hover tracking (e.g. LiteGraph's ghost-node placement) keeps
 * working; the stage stops it itself during strokes.
 */
const ROOT_STOPPED = [
  "pointerdown",
  "pointerup",
  "pointercancel",
  "mousedown",
  "mouseup",
  "dblclick",
  "contextmenu",
] as const;

const GUARDED_POINTER = ["pointerdown", "pointermove", "pointerup", "pointercancel"] as const;

/**
 * Install pointer/wheel isolation on the editor.
 *
 * @param options - Elements and editor handlers.
 * @returns Handle that removes every listener it added.
 */
export function isolateEvents(options: IsolationOptions): EventIsolation {
  const { root, stage, onWheel, onChromeWheel, onMiddlePointer } = options;
  const controller = new AbortController();
  const { signal } = controller;

  const stop = (event: Event): void => event.stopPropagation();
  for (const type of ROOT_STOPPED) root.addEventListener(type, stop, { signal });
  // Middle-click autoscroll / paste on Linux.
  stage.addEventListener("auxclick", (e) => e.preventDefault(), { signal });

  root.dataset["captureWheel"] = "true";

  let hovering = false;
  let middleDrag = false;
  let armed = false;

  const inStage = (target: EventTarget | null): boolean => target instanceof Node && stage.contains(target);
  const inRoot = (target: EventTarget | null): boolean => target instanceof Node && root.contains(target);

  const wheelGuard = (event: WheelEvent): void => {
    if (!inRoot(event.target)) return;
    event.stopPropagation();
    if (!inStage(event.target)) {
      onChromeWheel(event);
      return;
    }
    event.preventDefault();
    onWheel(event);
  };
  const pointerGuard = (event: PointerEvent): void => {
    const middle = event.button === 1 || (event.buttons & 4) !== 0;
    if (event.type === "pointerdown" && middle && inStage(event.target)) middleDrag = true;
    if (!middleDrag) return;
    event.preventDefault();
    event.stopPropagation();
    onMiddlePointer(event);
    if (event.type === "pointerup" || event.type === "pointercancel") {
      if (!(event.buttons & 4)) middleDrag = false;
      sync();
    }
  };

  const sync = (): void => {
    const want = hovering || middleDrag;
    if (want === armed) return;
    armed = want;
    if (want) {
      window.addEventListener("wheel", wheelGuard, { capture: true, passive: false });
      for (const type of GUARDED_POINTER) window.addEventListener(type, pointerGuard, { capture: true });
    } else {
      window.removeEventListener("wheel", wheelGuard, { capture: true });
      for (const type of GUARDED_POINTER) window.removeEventListener(type, pointerGuard, { capture: true });
    }
  };

  const enter = (): void => {
    hovering = true;
    sync();
  };
  // Armed over the whole root (rail, bar, side panel and popovers included).
  // pointermove also arms, in case the element mounted under a resting cursor.
  root.addEventListener("pointerenter", enter, { signal });
  root.addEventListener("pointermove", enter, { signal });
  root.addEventListener(
    "pointerleave",
    () => {
      hovering = false;
      sync();
    },
    { signal },
  );

  return {
    dispose(): void {
      controller.abort();
      hovering = false;
      middleDrag = false;
      sync();
    },
  };
}
