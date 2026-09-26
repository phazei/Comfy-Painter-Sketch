/**
 * User-facing notifications via `app.extensionManager.toast` (present in the
 * installed 1.52.7 bundle and 1.55 source), falling back to the console.
 *
 * Conventions (every failure path):
 * - One clear, actionable sentence; the toast summary "PainterSketch" is the
 *   prefix, so `detail` never repeats it.
 * - Severity: `error` = the user's work is at risk (not saved / not
 *   loaded), `warn` = degraded but nothing lost, `info` = rare confirmations.
 * - Repeats are de-duplicated per `key` ({@link ToastLimiter}); the console
 *   (`[PainterSketch]`) logs every warn/error occurrence with its details.
 */

import { app } from "@comfy/scripts/app.js";

import { log } from "../log";
import { ToastLimiter } from "./toastLimiter";

/** Toast severity. */
export type ToastSeverity = "info" | "warn" | "error";

/** Options for {@link notify}. */
export interface NotifyOptions {
  /** De-duplication key (default: severity + message). */
  key?: string;
  /** Suppression window for `key` in ms (default 10 s). */
  windowMs?: number;
  /** Extra values for the console only (errors, URLs, file names). */
  details?: unknown[];
}

const limiter = new ToastLimiter();

/**
 * Show a toast (or log when the toast API is unavailable). Repeats of the
 * same key within its window are logged but not shown.
 *
 * @param severity - Severity.
 * @param detail - Message (no "PainterSketch" prefix; the summary has it).
 * @param options - De-duplication key/window and console-only details.
 */
export function notify(severity: ToastSeverity, detail: string, options: NotifyOptions = {}): void {
  const details = options.details ?? [];
  if (severity === "error") log.error(detail, ...details);
  else if (severity === "warn") log.warn(detail, ...details);
  if (!limiter.shouldShow(options.key ?? `${severity}:${detail}`, options.windowMs)) return;
  const toast = app.extensionManager?.toast;
  if (toast && typeof toast.add === "function") {
    toast.add({ severity, summary: "PainterSketch", detail, life: severity === "error" ? 10000 : 6000 });
  }
}

/**
 * Forget a de-duplication key so the next occurrence toasts immediately.
 * @param key - Key passed to {@link notify}.
 */
export function resetNotifyKey(key: string): void {
  limiter.reset(key);
}
