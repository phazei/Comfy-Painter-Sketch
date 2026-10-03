/**
 * Long-press detection shared by every button that has a secondary menu
 * (tool-group slots, Copy, Paste, Quick Mask, the swatches' eyedropper
 * reveal; SPEC "Editor shell and focus" > "Long-press fly-outs"). One
 * constant ({@link LONG_PRESS_MS}) for all of them. Right-click opens the
 * same menu at once, and the click that follows a long-press is suppressed
 * so the primary action does not also run.
 */

/** Press duration that opens the secondary menu, ms (the design handoff's 380). */
export const LONG_PRESS_MS = 380;

/** What a long-press target needs. */
export interface LongPressHandlers {
  /** Primary action (a plain click). */
  tap(): void;
  /** Secondary action (long-press, right-click, corner caret). */
  hold(): void;
}

/** Control handle returned by {@link installLongPress}. */
export interface LongPressHandle {
  /** Cancel a running timer (dispose / pointer left). */
  cancel(): void;
  /** Open the secondary action now and suppress the next click (corner caret). */
  openNow(): void;
  /** Remove the listeners. */
  dispose(): void;
}

/**
 * Wire tap / hold on a button: a left press that lasts {@link LONG_PRESS_MS}
 * runs `hold` and swallows the click; a shorter press runs `tap` on click;
 * right-click runs `hold` immediately. Release, leave or cancel ends the timer.
 * @param element - Button element.
 * @param handlers - Tap / hold callbacks.
 * @returns Handle to cancel or open programmatically.
 */
export function installLongPress(element: HTMLElement, handlers: LongPressHandlers): LongPressHandle {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let suppressClick = false;
  const controller = new AbortController();
  const { signal } = controller;
  const cancel = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  const fire = (): void => {
    cancel();
    suppressClick = true;
    handlers.hold();
  };
  element.addEventListener(
    "pointerdown",
    (event) => {
      suppressClick = false;
      if (event.button !== 0) return;
      cancel();
      timer = setTimeout(fire, LONG_PRESS_MS);
    },
    { signal },
  );
  element.addEventListener("pointerup", cancel, { signal });
  element.addEventListener("pointerleave", cancel, { signal });
  element.addEventListener("pointercancel", cancel, { signal });
  element.addEventListener(
    "click",
    () => {
      if (suppressClick) {
        suppressClick = false;
        return;
      }
      handlers.tap();
    },
    { signal },
  );
  element.addEventListener(
    "contextmenu",
    (event) => {
      event.preventDefault();
      fire();
    },
    { signal },
  );
  return {
    cancel,
    openNow: fire,
    dispose: () => {
      cancel();
      controller.abort();
    },
  };
}

/**
 * The small corner caret that marks a button as having a menu; a press on it
 * opens the menu at once (without waiting for the long-press).
 * @param open - Open the menu (and suppress the following click).
 * @returns The caret element (position it with `.cps-corner`).
 */
export function cornerCaret(open: () => void): HTMLSpanElement {
  const hit = document.createElement("span");
  hit.className = "cps-corner";
  const mark = document.createElement("span");
  mark.className = "cps-corner-mark";
  hit.appendChild(mark);
  hit.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    event.preventDefault();
    open();
  });
  // The caret's own click must not reach the button's tap handler.
  hit.addEventListener("click", (event) => event.stopPropagation());
  return hit;
}
