/**
 * Floating-selection and layer-merge shortcuts (SPEC M10a, Photoshop), active
 * only while the editor owns the keyboard (called first from `shortcuts.ts`):
 *
 * | Key | Action |
 * |---|---|
 * | Enter | commit the floating selection (one undo step) |
 * | Esc | cancel the floating selection (everything back) |
 * | Ctrl+E | Merge Down (current row into the row below, one undo step) |
 * | Ctrl+Alt+T | Free Transform (M11; Enter commits the session -- a selection float stays floating until the next Enter; Esc cancels the float) |
 *
 * Ctrl+T is deliberately unbound: Chrome reserves it (new tab), pages can't cancel it.
 *
 * Ctrl+Z while floating (or transforming) cancels and Ctrl+Y is ignored (`Editor.undo` / `redo`).
 */

import type { Editor } from "../engine/editor";

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
  // A text transform session (M11b) has no float but takes Enter / Esc too.
  if (!(editor.float.active || editor.float.transform.active) || ctrl || event.altKey) return false;
  if (key === "escape") {
    effects.cancelDrag();
    editor.float.cancel();
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
