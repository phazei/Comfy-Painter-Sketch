/**
 * Key policy while the editor is fullscreen (M3.4). In fullscreen the graph
 * is hidden behind the overlay, so keys the editor does not handle must not
 * act on it either (Delete, Ctrl+C/V, Ctrl+A, letters bound to graph
 * commands, ...). Pure so it is unit-testable.
 *
 * Passed through (never prevented or stopped):
 * - browser keys: F1..F24 (reload, devtools, browser fullscreen, ...),
 *   Ctrl/Cmd + R / W / T / N / L / Tab / PageUp / PageDown (with or without
 *   Shift), Ctrl/Cmd+Shift + I / J / C (devtools), Alt+Left / Alt+Right;
 * - ComfyUI commands that do not edit the graph and are useful while
 *   painting: Ctrl/Cmd+Shift+S (save as) and Ctrl/Cmd+Enter (queue, also
 *   with Shift). Plain Ctrl/Cmd+S never reaches this policy: the keyboard
 *   scope intercepts it (`saveKey.ts`) to flush uploads before saving.
 *
 * Everything else is swallowed (`preventDefault` + `stopPropagation`).
 */

/** The fields of a `KeyboardEvent` the policy looks at. */
export interface KeyChord {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/** What to do with a key the editor did not handle. */
export type FullscreenKeyAction = "pass" | "swallow";

/** Ctrl/Cmd + key combos left to the browser (Shift optional). */
const BROWSER_MOD_KEYS: ReadonlySet<string> = new Set(["r", "w", "t", "n", "l", "tab", "pageup", "pagedown"]);

/** Ctrl/Cmd+Shift + key combos left to the browser (devtools). */
const BROWSER_MOD_SHIFT_KEYS: ReadonlySet<string> = new Set(["i", "j", "c"]);

/** Ctrl/Cmd + key ComfyUI commands allowed through (save, queue). */
const COMFY_MOD_KEYS: ReadonlySet<string> = new Set(["s", "enter"]);

/**
 * Decide whether an unhandled key reaches the page while fullscreen.
 *
 * @param event - Key chord (a `KeyboardEvent` satisfies it).
 * @returns `"pass"` to leave the event alone, `"swallow"` to stop it.
 */
export function fullscreenKeyPolicy(event: KeyChord): FullscreenKeyAction {
  const key = event.key.toLowerCase();
  if (/^f([1-9]|1[0-9]|2[0-4])$/.test(key)) return "pass";
  const mod = event.ctrlKey || event.metaKey;
  if (event.altKey && !mod && (key === "arrowleft" || key === "arrowright")) return "pass";
  if (mod && !event.altKey) {
    if (BROWSER_MOD_KEYS.has(key) || COMFY_MOD_KEYS.has(key)) return "pass";
    if (event.shiftKey && BROWSER_MOD_SHIFT_KEYS.has(key)) return "pass";
  }
  return "swallow";
}
