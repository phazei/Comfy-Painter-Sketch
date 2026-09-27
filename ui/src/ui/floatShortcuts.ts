/**
 * Floating-selection and layer-merge shortcuts (SPEC M10a, Photoshop), active
 * only while the editor owns the keyboard (called first from `shortcuts.ts`):
 *
 * | Key | Action |
 * |---|---|
 * | Enter | commit the floating selection (one undo step) |
 * | Esc | cancel the floating selection (everything back) |
 * | Ctrl+E | Merge Down (current row into the row below, one undo step) |
 *
 * Ctrl+Z while floating cancels and Ctrl+Y is ignored (`Editor.undo` / `redo`).
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
  if (!editor.float.active || ctrl || event.altKey) return false;
  if (key === "escape") {
    effects.cancelDrag();
    editor.float.cancel();
    return true;
  }
  if (key === "enter" && !event.shiftKey) {
    effects.cancelDrag();
    editor.float.commit();
    return true;
  }
  return false;
}
