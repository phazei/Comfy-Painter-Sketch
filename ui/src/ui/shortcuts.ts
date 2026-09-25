/**
 * Editor keyboard shortcuts (SPEC "Brush shortcuts", "Canvas / view",
 * "Undo / Redo"; Photoshop conventions). Returns whether a key was handled so
 * the keyboard scope stops only those.
 */

import type { PaintOptions } from "../tools/types";
import type { EditorSession } from "../widget/sessions";

/** Side effects the shortcuts need from the UI. */
export interface ShortcutEffects {
  /** Tool options changed (refresh the options strip + cursor). */
  optionsChanged(): void;
  /** View changed. */
  viewChanged(): void;
  /** Cancel an in-progress drag (before switching tools). */
  cancelDrag(): void;
}

/**
 * Handle a keydown for the editor.
 *
 * @param event - Key event.
 * @param session - Current session.
 * @param effects - UI callbacks.
 * @returns `true` if handled.
 */
export function handleShortcut(event: KeyboardEvent, session: EditorSession, effects: ShortcutEffects): boolean {
  const { editor, tools } = session;
  const ctrl = event.ctrlKey || event.metaKey;
  const key = event.key.toLowerCase();

  if (ctrl && !event.altKey) {
    if (key === "z" && !event.shiftKey) return run(() => editor.undo());
    if ((key === "z" && event.shiftKey) || (key === "y" && !event.shiftKey)) return run(() => editor.redo());
    if (key === "0" || event.code === "Digit0") return run(() => (editor.view.fit(), effects.viewChanged()));
    if (key === "1" || event.code === "Digit1") return run(() => (editor.view.actualPixels(), effects.viewChanged()));
    if (key === "=" || key === "+") return run(() => (editor.view.zoomBy(1.25), effects.viewChanged()));
    if (key === "-" || key === "_") return run(() => (editor.view.zoomBy(0.8), effects.viewChanged()));
    return false;
  }
  if (event.altKey || ctrl) return false;

  const options = tools.active.options;
  if (event.code === "BracketLeft" || event.code === "BracketRight" || key === "[" || key === "]") {
    if (!options) return false;
    const up = event.code === "BracketRight" || key === "]" || key === "}";
    if (event.shiftKey) options.hardness = stepHardness(options.hardness, up);
    else options.size = stepSize(options.size, up);
    effects.optionsChanged();
    return true;
  }

  const digit = /^Digit([0-9])$/.exec(event.code)?.[1] ?? (/^[0-9]$/.test(key) ? key : null);
  if (digit !== null && !event.shiftKey) {
    if (!options) return false;
    setOpacity(options, digit === "0" ? 1 : Number(digit) / 10);
    effects.optionsChanged();
    return true;
  }

  if (!event.shiftKey && key.length === 1) {
    const tool = tools.byShortcut(key);
    if (tool) {
      if (tool.id !== tools.active.id) {
        effects.cancelDrag();
        tools.setActive(tool.id);
      }
      return true;
    }
  }
  return false;
}

function run(action: () => void): true {
  action();
  return true;
}

/**
 * Photoshop-like bracket steps: finer for small brushes.
 * @param size - Current diameter.
 * @param up - Increase.
 * @returns New diameter (1..1000).
 */
export function stepSize(size: number, up: boolean): number {
  const step = size < 10 ? 1 : size < 50 ? 5 : size < 100 ? 10 : size < 300 ? 25 : 50;
  const next = up ? size + step : size - (size <= 10 ? 1 : size <= 50 ? 5 : size <= 100 ? 10 : size <= 300 ? 25 : 50);
  return Math.min(1000, Math.max(1, Math.round(next)));
}

/**
 * Hardness in 25% steps (Photoshop).
 * @param hardness - 0..1
 * @param up - Increase.
 * @returns New hardness.
 */
export function stepHardness(hardness: number, up: boolean): number {
  const next = Math.round((hardness + (up ? 0.25 : -0.25)) * 4) / 4;
  return Math.min(1, Math.max(0, next));
}

function setOpacity(options: PaintOptions, value: number): void {
  options.opacity = value;
}
