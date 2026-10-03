/**
 * Editor keyboard shortcuts (SPEC "Shortcuts", incl. Quick Mask `Q`;
 * Photoshop conventions). Returns whether a key was handled so the keyboard scope
 * stops only those.
 *
 * | Key | Action |
 * |---|---|
 * | Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y | undo / redo |
 * | Ctrl+0 / Ctrl+1 / Ctrl+= / Ctrl+- | fit / 100% / zoom in / out |
 * | `[` `]` (Shift: hardness) | size (tools with a `size` / `hardness` option); shape tools: width (1..500) |
 * | `1`..`9`, `0` | opacity 10%..90%, 100% |
 * | Q | Quick Mask (nothing in region mode) |
 * | ? | help overlay (toggle) |
 * | X / D | swap / reset FG-BG colours (with a layer mask targeted: the black / white mask swatches) |
 * | F | toggle fullscreen (shell `fullscreen` event) |
 * | O | Outputs tab / region mode (toggle) |
 * | Esc | the Esc chain ({@link handleEscape}): help, popover, text commit, float / transform, tool drag, deselect, fullscreen |
 * | tool keys | from the tool registry (B, E, ...; group keys pick the last-used tool) |
 * | Shift+group key | cycle the group (Shift+U shapes) |
 * | active tool's `onKey` | e.g. Move: arrows nudge 1 px, Shift+arrows 10 px |
 * | selection keys | `selectionShortcuts.ts` (Ctrl+A/D, Shift+F7, Delete, Alt/Ctrl+Backspace; arrows nudge the outline with a selection tool) |
 * | float / merge / transform keys | `floatShortcuts.ts` (Enter / Esc while floating, Ctrl+E Merge Down, Ctrl+Alt+T Free Transform) |
 * | clipboard keys | `clipboardShortcuts.ts` (Ctrl+C, Ctrl+Shift+C, Ctrl+X, Ctrl+V, Ctrl+Shift+V) |
 */

import type { ToolOptions } from "../tools/options";
import { REGION_TOOL_ID } from "../tools/region";
import type { EditorSession } from "../widget/sessions";
import type { ClipboardActions } from "./clipboardActions";
import { handleClipboardShortcut } from "./clipboardShortcuts";
import { handleFloatShortcut } from "./floatShortcuts";
import { handleOutlineNudge, handleSelectionShortcut } from "./selectionShortcuts";

/** Largest shape-tool width `]` steps to (matches the Width option). */
const MAX_SHAPE_WIDTH = 500;

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
  /** A stage tool press is in progress (button down). Absent = never. */
  isToolDragging?(): boolean;
  /** Fullscreen requested. */
  fullscreen(): void;
  /** `O`: open the Outputs tab (region mode), or leave it. */
  toggleOutputs?(): void;
  /** Close an open popover. @returns `true` if one was open. */
  closePopover(): boolean;
  /** Close the help overlay. @returns `true` if it was open. */
  closeHelp(): boolean;
  /** `?`: open / close the help overlay. */
  toggleHelp(): void;
  /** Leave fullscreen. @returns `true` if the editor was fullscreen. */
  exitFullscreen(): boolean;
  /** Clipboard commands (Ctrl+C / X / V); absent = clipboard keys unhandled. */
  clipboard?: ClipboardActions;
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

  // Outputs tab (region tool): the image selection is hidden and out of reach --
  // no copy/cut/select/clear on it; Delete goes to the region tool (removes the region).
  const regionMode = tools.active.id === REGION_TOOL_ID;
  if (key === "escape" && !ctrl && !event.altKey) return handleEscape(event, session, effects, regionMode);
  // Floating selection (Enter), Free Transform chord and Merge Down (Ctrl+E).
  if (handleFloatShortcut(event, editor, { cancelDrag: () => effects.cancelDrag() })) return true;
  // Their chords are still swallowed (so Ctrl+C doesn't copy graph nodes, Ctrl+D doesn't bookmark).
  if (regionMode && ((ctrl && !event.altKey && "cxad".includes(key) && key.length === 1) || ((ctrl || event.altKey) && key === "backspace"))) return true;
  // Clipboard: Ctrl+C / Ctrl+Shift+C / Ctrl+X; Ctrl+V only stopped (the `paste` event does the work).
  if (!regionMode && effects.clipboard && handleClipboardShortcut(event, effects.clipboard, () => effects.cancelDrag())) return true;
  if (ctrl && !event.altKey && key === "v") return false;
  // Selection: Ctrl+A/D, Shift+F7, Delete/Backspace, Alt/Ctrl+Backspace.
  if (!regionMode && handleSelectionShortcut(event, editor, () => effects.cancelDrag())) return true;

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
  // Tool-specific keys first (Move: arrow nudges; a Free Transform session's tool wins).
  if (tools.resolve(false).onKey?.(editor, event)) return true;
  // Selection tools: arrows nudge the selection outline (a float nudge was handled above).
  if (handleOutlineNudge(event, tools.active, editor, effects.isToolDragging?.() ?? false)) return true;

  const options = tools.active.options;
  if (event.code === "BracketLeft" || event.code === "BracketRight" || key === "[" || key === "]") {
    const up = event.code === "BracketRight" || key === "]" || key === "}";
    const changed = event.shiftKey
      ? stepOption(options, "hardness", (v) => stepHardness(v, up))
      : (stepOption(options, "size", (v) => stepSize(v, up)) ??
        stepOption(options, "width", (v) => stepSize(v, up, MAX_SHAPE_WIDTH)));
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

  // Help overlay: `?` (Shift+/ on most layouts) before the Shift+group lookup.
  if (event.key === "?") {
    effects.toggleHelp();
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
      // Quick Mask: toggle the paint target (its button is hidden in region mode; Q does nothing there).
      if (regionMode) return false;
      effects.cancelDrag();
      editor.togglePaintTarget();
      return true;
    case "x":
      // While a layer mask is targeted X / D act on the black / white mask swatches.
      if (!editor.layerMask.swapSwatches()) editor.colors.swap();
      return true;
    case "d":
      if (!editor.layerMask.resetSwatches()) editor.colors.reset();
      return true;
    case "f":
      effects.fullscreen();
      return true;
    case "o":
      if (!effects.toggleOutputs) return false;
      effects.toggleOutputs();
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

/**
 * The Esc chain (design handoff "Interactions and behaviour"; first consumer
 * wins): help overlay, popover / menu, (confirms are native dialogs), open
 * text edit -> commit, float / Free Transform -> cancel, tool drag / pending
 * interaction -> cancel, selection -> deselect (not in region mode, where
 * the selection is out of reach), fullscreen -> exit. Esc never ends Solo,
 * the lmask view or region mode. The Images tray is closed by the host
 * before this runs (`ImagesPanel.handleKey`).
 * @param event - The Esc key event.
 * @param session - Current session.
 * @param effects - UI callbacks.
 * @param regionMode - The region tool is active.
 * @returns `true` if a step consumed the key.
 */
function handleEscape(event: KeyboardEvent, session: EditorSession, effects: ShortcutEffects, regionMode: boolean): boolean {
  const { editor } = session;
  if (effects.closeHelp()) return true;
  if (effects.closePopover()) return true;
  if (editor.text.editing) {
    effects.cancelDrag();
    editor.text.commit();
    return true;
  }
  if (handleFloatShortcut(event, editor, { cancelDrag: () => effects.cancelDrag() })) return true;
  if (effects.cancelToolDrag?.()) return true;
  if (!regionMode && editor.selection.active) {
    effects.cancelDrag();
    editor.selection.deselect();
    return true;
  }
  return effects.exitFullscreen();
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
 * @param max - Upper bound (default 1000; shape widths use 500).
 * @returns New diameter (1..max).
 */
export function stepSize(size: number, up: boolean, max = 1000): number {
  const step = size < 10 ? 1 : size < 50 ? 5 : size < 100 ? 10 : size < 300 ? 25 : 50;
  const next = up ? size + step : size - (size <= 10 ? 1 : size <= 50 ? 5 : size <= 100 ? 10 : size <= 300 ? 25 : 50);
  return Math.min(max, Math.max(1, Math.round(next)));
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
