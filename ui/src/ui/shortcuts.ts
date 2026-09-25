/**
 * Editor keyboard shortcuts (SPEC "Brush shortcuts", "Canvas / view",
 * "Undo / Redo", "Color", Tools table incl. Quick Mask `Q`; Photoshop
 * conventions). Returns whether a key was handled so the keyboard scope
 * stops only those.
 *
 * | Key | Action |
 * |---|---|
 * | Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y | undo / redo |
 * | Ctrl+0 / Ctrl+1 / Ctrl+= / Ctrl+- | fit / 100% / zoom in / out |
 * | `[` `]` (Shift: hardness) | size (tools with a `size` / `hardness` option) |
 * | `1`..`9`, `0` | opacity 10%..90%, 100% |
 * | Q | Quick Mask |
 * | X / D | swap / reset FG-BG colours |
 * | F | toggle fullscreen (shell `fullscreen` event) |
 * | Esc | cancel a tool drag, else close an open popover, else leave fullscreen |
 * | tool keys | from the tool registry (B, E, ...; group keys pick the last-used tool) |
 * | Shift+group key | cycle the group (Shift+U shapes) |
 */

import type { ToolOptions } from "../tools/options";
import type { EditorSession } from "../widget/sessions";

/** Side effects the shortcuts need from the UI. */
export interface ShortcutEffects {
  /** Tool options changed (refresh the options bar + cursor). */
  optionsChanged(): void;
  /** View changed. */
  viewChanged(): void;
  /** Cancel an in-progress drag (before switching tools). */
  cancelDrag(): void;
  /** Esc: cancel a tool drag in progress (e.g. a shape). @returns `true` if one was cancelled. */
  cancelToolDrag?(): boolean;
  /** Fullscreen requested. */
  fullscreen(): void;
  /** Close an open popover. @returns `true` if one was open. */
  closePopover(): boolean;
  /** Leave fullscreen. @returns `true` if the editor was fullscreen. */
  exitFullscreen(): boolean;
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

  if (key === "escape" && !ctrl && !event.altKey) {
    return (effects.cancelToolDrag?.() ?? false) || effects.closePopover() || effects.exitFullscreen();
  }

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
    const up = event.code === "BracketRight" || key === "]" || key === "}";
    const changed = event.shiftKey
      ? stepOption(options, "hardness", (v) => stepHardness(v, up))
      : stepOption(options, "size", (v) => stepSize(v, up));
    if (changed === null) return false;
    if (changed) effects.optionsChanged();
    return true;
  }

  const digit = /^Digit([0-9])$/.exec(event.code)?.[1] ?? (/^[0-9]$/.test(key) ? key : null);
  if (digit !== null && !event.shiftKey) {
    const changed = stepOption(options, "opacity", () => (digit === "0" ? 1 : Number(digit) / 10));
    if (changed === null) return false;
    if (changed) effects.optionsChanged();
    return true;
  }

  if (event.shiftKey && key.length === 1) {
    // Shift+group key cycles the group's tools (Shift+U shapes).
    const next = tools.cycleShortcut(key);
    if (!next) return false;
    effects.cancelDrag();
    tools.setActive(next.id);
    return true;
  }
  if (key.length !== 1) return false;
  switch (key) {
    case "q":
      // Quick Mask: toggle the paint target (decision 6).
      effects.cancelDrag();
      editor.togglePaintTarget();
      return true;
    case "x":
      editor.colors.swap();
      return true;
    case "d":
      editor.colors.reset();
      return true;
    case "f":
      effects.fullscreen();
      return true;
  }
  const tool = tools.byShortcut(key);
  if (!tool) return false;
  if (tool.id !== tools.active.id) {
    effects.cancelDrag();
    tools.setActive(tool.id);
  }
  return true;
}

function run(action: () => void): true {
  action();
  return true;
}

/**
 * Apply `next` to a numeric option if the tool has it.
 * @returns `null` if the option is missing, else whether it changed.
 */
function stepOption(options: ToolOptions | null, key: string, next: (value: number) => number): boolean | null {
  const value = options?.get(key);
  if (!options || typeof value !== "number") return null;
  return options.set(key, next(value));
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
