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
 * | Arrows (Shift = 10 px), selection tool active, no float | nudge the selection outline ({@link handleOutlineNudge}) |
 *
 * Every command is one undo step.
 */

import type { Editor } from "../engine/editor";
import { nudgeStep } from "../engine/translateMath";

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
    if (key === "backspace" && alt && !ctrl) return run(cancelDrag, () => sel.fillSelected(editor.colors.fg, "fg"));
    if (key === "backspace" && ctrl && !alt) return run(cancelDrag, () => sel.fillSelected(editor.colors.bg, "bg"));
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

/** Arrow key -> unit direction. */
const ARROWS: Readonly<Record<string, readonly [number, number]>> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

/**
 * Arrows with a selection tool active (marquee / lasso / wand) and a
 * selection: nudge the OUTLINE 1 image px (Shift 10), consecutive nudges one
 * `selection` undo step. Called after the float / tool keys (a float nudge
 * wins). Being handled, the key is swallowed even while only hover-focused.
 * While a tool press is in progress (marquee / lasso / wand button down) the
 * old outline must not shift under the drag: the key is swallowed without
 * acting, like a float nudge mid-drag (`floatShortcuts.ts`).
 * @param event - Key event (no Ctrl / Alt; `shortcuts.ts` checks).
 * @param tool - Active rail tool (`combinesSelection`, `pending`).
 * @param editor - Session editor.
 * @param dragging - A stage tool press is in progress.
 * @returns `true` if handled.
 */
export function handleOutlineNudge(
  event: KeyboardEvent,
  tool: { combinesSelection?: boolean; pending?(): boolean },
  editor: Editor,
  dragging = false,
): boolean {
  const dir = ARROWS[event.key];
  if (!dir || !tool.combinesSelection || !editor.selection.active || (tool.pending?.() ?? false)) return false;
  // Mid-press (or mid outline drag: `nudge` refuses) nothing moves; the key is still swallowed.
  if (dragging) return true;
  const step = nudgeStep(event.shiftKey ? 10 : 1, editor.frameMap.scale);
  editor.selectionMove.nudge(dir[0] * step, dir[1] * step);
  return true;
}

function run(cancelDrag: () => void, action: () => void): true {
  cancelDrag();
  action();
  return true;
}
