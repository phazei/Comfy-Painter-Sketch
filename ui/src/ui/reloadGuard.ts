/**
 * Pure decision functions for the reload-key intercept feature (saved-file
 * contract, Upload timing). Pure so they are unit-testable without a browser.
 *
 * The page-level guard in `pageGuards.ts` uses these to decide whether to
 * intercept F5 / Ctrl+R / Ctrl+Shift+R before the browser acts on them.
 */

import type { KeyChord } from "./fullscreenKeys";

/**
 * Whether a keydown event is one of the browser-reload chords: F5,
 * Ctrl/Cmd+R, or Ctrl/Cmd+Shift+R (hard reload).
 *
 * @param event - Key chord (a `KeyboardEvent` satisfies it).
 * @returns `true` for any of the three reload chords.
 */
export function isReloadKey(event: KeyChord): boolean {
  const key = event.key.toLowerCase();
  if (key === "f5" && !event.ctrlKey && !event.metaKey && !event.altKey) return true;
  const mod = event.ctrlKey || event.metaKey;
  if (mod && !event.altKey && key === "r") return true;
  return false;
}