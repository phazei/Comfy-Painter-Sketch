/**
 * Clipboard shortcuts (SPEC M10 Clipboard, Photoshop), active only while the
 * editor owns the keyboard (called from `shortcuts.ts`):
 *
 * | Key | Action |
 * |---|---|
 * | Ctrl+C | copy the current layer's selected pixels (whole layer without a selection) |
 * | Ctrl+Shift+C | copy merged (what is visible, incl. the image) |
 * | Ctrl+X | cut (copy + clear, one undo step) |
 * | Ctrl+V | paste as a new layer, centred on the image: system image, else our copy, else clipspace |
 * | Ctrl+Shift+V | our copy at its copied position (system clipboard ignored); without one like Ctrl+V |
 *
 * Ctrl+Shift+V with an internal copy is handled on keydown (prevented, so
 * Chrome's plain-text paste never fires). Clipspace alone: Paste button menu.
 *
 * Ctrl+V is special: the keydown must NOT be prevented, or the browser never
 * fires `paste` (the only way to read the system clipboard without a
 * permission prompt). It is stopped here (so ComfyUI's keybindings never see
 * it) and reported as unhandled, and the paste itself runs from the `paste`
 * event ({@link ClipboardActions.armPaste}).
 */

import type { ClipboardActions } from "./clipboardActions";

/**
 * Handle a clipboard key.
 * @param event - Key event.
 * @param actions - Clipboard commands of the host.
 * @param cancelDrag - Abort a drag in progress first.
 * @returns `true` if handled (prevent + stop); `false` for Ctrl+V too (already stopped).
 */
export function handleClipboardShortcut(event: KeyboardEvent, actions: ClipboardActions, cancelDrag: () => void): boolean {
  const ctrl = event.ctrlKey || event.metaKey;
  if (!ctrl || event.altKey) return false;
  const key = event.key.toLowerCase();
  if (key === "v") {
    // Paste in place never reads the system clipboard: handle it right here.
    if (event.shiftKey && actions.hasInternal) {
      if (!event.repeat) {
        cancelDrag();
        actions.pasteInPlace();
      }
      return true;
    }
    event.stopPropagation();
    if (!event.repeat) {
      cancelDrag();
      actions.armPaste(event.shiftKey);
    }
    return false;
  }
  if (key === "c" || (key === "x" && !event.shiftKey)) {
    if (!event.repeat) {
      cancelDrag();
      if (key === "x") actions.cut();
      else actions.copy(event.shiftKey);
    }
    return true;
  }
  return false;
}
