/**
 * User-facing notifications via `app.extensionManager.toast` (present in the
 * installed 1.52.7 bundle and 1.55 source), falling back to the console.
 */

import { app } from "@comfy/scripts/app.js";

import { log } from "../log";

/** Toast severity. */
export type ToastSeverity = "info" | "warn" | "error";

/**
 * Show a toast (or log when the toast API is unavailable).
 *
 * @param severity - Severity.
 * @param detail - Message.
 */
export function notify(severity: ToastSeverity, detail: string): void {
  const toast = app.extensionManager?.toast;
  if (toast && typeof toast.add === "function") {
    toast.add({ severity, summary: "PainterSketch", detail, life: severity === "error" ? 8000 : 5000 });
  }
  if (severity === "info") return;
  if (severity === "error") log.error(detail);
  else log.warn(detail);
}
