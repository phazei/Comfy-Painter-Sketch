/**
 * Floating-selection and layer-merge shortcuts (SPEC "Floating selections", SPEC "Shortcuts", Photoshop), active
 * only while the editor owns the keyboard (called first from `shortcuts.ts`):
 *
 * | Key | Action |
 * |---|---|
 * | Enter | commit the floating selection (one undo step) |
 * | Esc | cancel the floating selection (everything back) |
 * | Arrows (Shift = 10 px) | nudge the floating selection, whatever the active tool (a Free Transform session's tool nudges the session instead) |
 * | Ctrl+E | Merge Down (current row into the row below, one undo step) |
 * | Ctrl+Alt+T | Free Transform (Enter commits the session -- a selection float stays floating until the next Enter; Esc cancels the float) |
 *
 * Ctrl+T is deliberately unbound: Chrome reserves it (new tab), pages can't cancel it.
 *
 * Ctrl+Z while floating (or transforming) cancels and Ctrl+Y is ignored (`Editor.undo` / `redo`).
 */

import type { Editor } from "../engine/editor";
import { nudgeStep } from "../engine/translateMath";

/** Arrow key -> unit direction. */
const ARROWS: Readonly<Record<string, readonly [number, number]>> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

/** UI callbacks the float keys need. */
export interface FloatShortcutEffects {
  /** Abort any drag in progress. */
  cancelDrag(): void;
}

/**
 * Handle a float / merge key.
 * @param event - Key event.
 * @param editor - Session editor.
 * @param effects - UI callbacks.
 * @returns `true` if handled.
 */
export function handleFloatShortcut(event: KeyboardEvent, editor: Editor, effects: FloatShortcutEffects): boolean {
  const ctrl = event.ctrlKey || event.metaKey;
  const key = event.key.toLowerCase();
  if (ctrl && !event.altKey && !event.shiftKey && key === "e") {
    if (!event.repeat) {
      effects.cancelDrag();
      editor.mergeDown();
    }
    return true;
  }
  if (isTransformChord(event)) {
    // Any gesture ends first: the text rasterize confirm never runs mid-press.
    if (!event.repeat) {
      effects.cancelDrag();
      editor.float.transform.enter();
    }
    return true;
  }
  // A text transform session has no float but takes Enter / Esc too.
  if (!(editor.float.active || editor.float.transform.active) || ctrl || event.altKey) return false;
  if (key === "escape") {
    effects.cancelDrag();
    editor.float.cancel();
    return true;
  }
  const dir = ARROWS[event.key];
  if (dir) {
    // A session's own tool (transformTool.onKey) nudges the session.
    if (editor.float.transform.active) return false;
    const step = nudgeStep(event.shiftKey ? 10 : 1, editor.frameMap.scale);
    // Mid-drag the float refuses the nudge; the key is still swallowed.
    editor.float.nudge(dir[0] * step, dir[1] * step);
    return true;
  }
  if (key === "enter" && !event.shiftKey) {
    effects.cancelDrag();
    // A session commits first (a selection float stays floating); the next Enter drops the float.
    if (editor.float.transform.active) editor.float.transform.commit();
    else editor.float.commit();
    return true;
  }
  return false;
}

/**
 * Free Transform chord: Ctrl+Alt+T (Chrome reserves Ctrl+T; Photopea's choice).
 * Only the literal `t` key counts, so AltGr (= Ctrl+Alt) characters on other
 * layouts never trigger it. Text fields never reach here (`keyboard.ts`).
 * @param event - Key event.
 * @returns `true` for the chord.
 */
export function isTransformChord(event: KeyboardEvent): boolean {
  const ctrl = event.ctrlKey || event.metaKey;
  return ctrl && event.altKey && !event.shiftKey && (event.key === "t" || event.key === "T");
}
