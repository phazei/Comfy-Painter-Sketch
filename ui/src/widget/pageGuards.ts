/**
 * Page-level guards that flush pending layer uploads before the browser can
 * navigate away and lose them (saved-file contract, Upload timing).
 *
 * Two guards, sharing the same flush path (`flushAll`):
 *
 * 1. **Reload keys** -- a single capture-phase `window` keydown listener that
 *    intercepts F5, Ctrl/Cmd+R, Ctrl/Cmd+Shift+R. If any session has pending
 *    uploads: flush all in parallel (3 s timeout), then `location.reload()`.
 *    If nothing is pending, the event is NOT cancelled so the browser reloads
 *    normally. Upload failure: `confirm()` asks whether to reload anyway.
 *
 * 2. **Earlier flush** -- `document.visibilitychange` -> hidden and `window`
 *    `blur` both flush (fire-and-forget).
 *
 * Every path also runs a pending ChangeTracker capture (`graphSync.ts`) so
 * the workflow draft a reload restores has our latest widget value. The
 * draft write itself is the frontend's 512 ms debounce, flushed by its own
 * `pagehide` listener (1.52.7 bundle / 1.55 `useWorkflowPersistenceV2.ts`).
 * `beforeunload` (no prompt) covers the browser's reload button.
 *
 * No `beforeunload` prompt of our own: ComfyUI already shows its "are you
 * sure" dialog on reload/close, which gives in-flight uploads time to finish,
 * and a second prompt would be noise.
 *
 * Registered once via {@link installPageGuards} called from `main.ts`.
 */

import { isReloadKey } from "../ui/reloadGuard";
import { flushGraphSync } from "./graphSync";
import { flushAll, pendingUploads } from "./sessions";

// ── Constants ─────────────────────────────────────────────────────────────────

/** Hard ceiling on how long we wait for uploads before reloading anyway. */
const RELOAD_FLUSH_TIMEOUT_MS = 3000;

// ── Earlier flush ─────────────────────────────────────────────────────────────

/** Fire-and-forget flush; errors are already toasted by each session's uploader. */
function flushQuietlyAll(): void {
  flushGraphSync();
  if (!pendingUploads()) return;
  flushAll().catch(() => undefined);
}

// ── Reload-key intercept ──────────────────────────────────────────────────────

/**
 * Capture-phase keydown: intercept reload chords when there are pending
 * uploads, flush, then reload. If nothing is pending, let the event pass
 * so the browser reloads normally.
 *
 * @param event - Window keydown event.
 */
const handleReloadKey = (event: KeyboardEvent): void => {
  if (!isReloadKey(event)) return;
  if (!pendingUploads()) {
    flushGraphSync();
    return;
  }

  event.preventDefault();
  event.stopPropagation();

  const timeout = new Promise<void>((resolve) => setTimeout(resolve, RELOAD_FLUSH_TIMEOUT_MS));
  void Promise.race([flushAll(), timeout.then(() => [] as Error[])]).then((errors) => {
    // The upload batches requested a capture; run it now so `graphChanged`
    // is dispatched and the frontend's `pagehide` flush writes the draft.
    flushGraphSync();
    if (errors.length > 0 && !window.confirm("Some paint couldn't be uploaded. Reload anyway?")) return;
    location.reload();
  });
};

// ── Public API ────────────────────────────────────────────────────────────────

let installed = false;

/**
 * Install the page-level guards. Called once from the extension setup in
 * `main.ts`; idempotent (additional calls are ignored).
 */
export function installPageGuards(): void {
  if (installed) return;
  installed = true;

  // Reload-key intercept (capture phase beats LiteGraph and ComfyUI).
  window.addEventListener("keydown", handleReloadKey, true);

  // Earlier flush when the tab is hidden or the window loses focus.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushQuietlyAll();
  });
  window.addEventListener("blur", flushQuietlyAll);

  // Browser reload button / tab close: capture a pending (debounced) value
  // change before the frontend's `pagehide` draft flush. No prompt.
  window.addEventListener("beforeunload", flushGraphSync);
}
