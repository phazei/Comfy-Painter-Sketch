/**
 * Selection shortcuts (SPEC "Selection", Photoshop), active only while the
 * editor owns the keyboard (called from `shortcuts.ts`):
 *
 * | Key | Action |
 * |---|---|
 * | Ctrl+A | select all (the image frame) |
 * | Ctrl+D | deselect |
 * | Ctrl+Shift+I, Shift+F7 | invert (also the options bar's "Invert" button) |
 * | Delete / Backspace | clear the selection on the paint target (always swallowed, so the graph never deletes nodes) |
 * | Alt+Backspace / Ctrl+Backspace | fill the selection with FG / BG |
 *
 * Every command is one undo step.
 */

import type { Editor } from "../engine/editor";

/**
 * Handle a selection key.
 * @param event - Key event.
 * @param editor - Session editor.
 * @param cancelDrag - Abort a drag in progress first (commands never run mid-stroke).
 * @returns `true` if handled.
 */
export function handleSelectionShortcut(event: KeyboardEvent, editor: Editor, cancelDrag: () => void): boolean {
  const ctrl = event.ctrlKey || event.metaKey;
  const alt = event.altKey;
  const shift = event.shiftKey;
  const key = event.key.toLowerCase();
  const sel = editor.selection;

  if (key === "backspace" || key === "delete") {
    if (event.repeat) return true;
    if (key === "backspace" && alt && !ctrl) return run(cancelDrag, () => sel.fillSelected(editor.colors.fg));
    if (key === "backspace" && ctrl && !alt) return run(cancelDrag, () => sel.fillSelected(editor.colors.bg));
    if (!ctrl && !alt && sel.active) return run(cancelDrag, () => sel.clearSelected());
    return !ctrl && !alt;
  }
  if (ctrl && !alt) {
    if (key === "a" && !shift) return run(cancelDrag, () => sel.selectAll());
    if (key === "d" && !shift) return run(cancelDrag, () => sel.deselect());
    // Photoshop invert. Also the browsers' DevTools key, but we only see it
    // while the editor owns the keyboard, so DevTools still opens elsewhere.
    if (key === "i" && shift) return run(cancelDrag, () => sel.invert());
    return false;
  }
  if (key === "f7" && shift && !alt) return run(cancelDrag, () => sel.invert());
  return false;
}

function run(cancelDrag: () => void, action: () => void): true {
  cancelDrag();
  action();
  return true;
}
