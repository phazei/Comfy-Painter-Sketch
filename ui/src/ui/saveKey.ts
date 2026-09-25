/**
 * The workflow-save chord the editor intercepts while it owns the keyboard
 * (saved-file contract, Upload timing): the owner flushes dirty layer
 * uploads first, then runs ComfyUI's save command, so the saved workflow
 * references the latest files. Pure so it is unit-testable.
 */

import type { KeyChord } from "./fullscreenKeys";

/**
 * Whether a key event is Ctrl+S / Cmd+S (no Shift, no Alt; Ctrl+Shift+S and
 * others keep their default handling).
 *
 * @param event - Key chord (a `KeyboardEvent` satisfies it).
 * @returns `true` for the save chord.
 */
export function isSaveChord(event: KeyChord): boolean {
  return event.key.toLowerCase() === "s" && (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey;
}
