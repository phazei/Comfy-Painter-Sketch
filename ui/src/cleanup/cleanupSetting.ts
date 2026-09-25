/**
 * The `PainterSketch.Cleanup` setting: a "Clean up files" button in the
 * ComfyUI settings panel (SPEC "Settings"). It stores no value; the custom
 * renderer (`type` as a function, rendered by the frontend's
 * `CustomFormValue`, present in 1.52.7 and 1.55) returns the button.
 *
 * Flow: fetch stats (when the row renders) -> show file counts -> collect
 * client-side references -> dry run -> confirm with count and size -> real
 * run -> toast -> refresh stats. The server re-checks everything on the real
 * run; the dry-run list is never trusted for deletion.
 *
 * Stats are fetched via `{mode:"stats"}` on the same route; no second route.
 */

import { api } from "@comfy/scripts/api.js";

import type { SettingParams } from "../types/comfy";
import { notify } from "../widget/toast";
import type { CleanupResponse, StatsResponse } from "./references";
import { confirmText, fileCount, formatBytes, isCleanupResponse, isStatsResponse } from "./references";
import { collectClientReferences } from "./sources";

/** Setting id. */
export const CLEANUP_SETTING_ID = "PainterSketch.Cleanup";

/** Server route (`nodes/cleanup_route.py`). */
const CLEANUP_ROUTE = "/painter-sketch/cleanup";

/** Settings-panel entry for the cleanup button. */
export const CLEANUP_SETTING: SettingParams = {
  id: CLEANUP_SETTING_ID,
  category: ["PainterSketch", "Storage", "Clean up files"],
  name: "Clean up files",
  tooltip:
    "Deletes layer files in input/painter-sketch/ that no saved workflow, open workflow tab or " +
    "unsaved draft in this browser uses and that are older than 24 hours. Asks before deleting.",
  type: () => renderCleanupControl(),
  defaultValue: "",
};

// ── Rendering ────────────────────────────────────────────────────────────────

/**
 * Build the stats line + button element for the settings row.
 *
 * @returns Element mounted by the settings panel.
 */
function renderCleanupControl(): HTMLElement {
  const root = document.createElement("div");
  root.style.cssText = "display:flex;flex-direction:column;gap:0.4rem;";

  const statsLine = document.createElement("span");
  statsLine.style.cssText = "font-size:0.8rem;opacity:0.7;";
  statsLine.textContent = "Loading file counts…";

  const row = document.createElement("div");
  row.style.cssText = "display:flex;align-items:center;gap:0.75rem;";

  const button = document.createElement("button");
  button.type = "button";
  button.className = "p-button p-component p-button-sm p-button-secondary";
  button.textContent = "Clean up files";
  button.addEventListener("click", () => {
    button.disabled = true;
    button.textContent = "Cleaning up…";
    void runCleanup(statsLine).finally(() => {
      button.disabled = false;
      button.textContent = "Clean up files";
    });
  });

  row.append(button);
  root.append(statsLine, row);

  // Fetch stats immediately when the row renders.
  void fetchStats(statsLine);

  return root;
}

/**
 * Update the stats line with current file counts from the server.
 *
 * @param statsLine - `<span>` element to update.
 */
async function fetchStats(statsLine: HTMLSpanElement): Promise<void> {
  try {
    const response = await api.fetchApi(CLEANUP_ROUTE, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "stats" }),
    });
    const data: unknown = await response.json().catch(() => null);
    if (response.ok && isStatsResponse(data)) {
      statsLine.textContent = statsText(data);
    } else {
      statsLine.textContent = "Could not load file counts.";
    }
  } catch {
    statsLine.textContent = "Could not load file counts.";
  }
}

/**
 * Format the stats line text.
 *
 * @param stats - Stats response from the server.
 * @returns Human-readable summary.
 */
function statsText(stats: StatsResponse): string {
  const all = `${stats.all.count} (${formatBytes(stats.all.bytes)})`;
  const old = `${stats.old.count} (${formatBytes(stats.old.bytes)})`;
  return `Files: ${all} · Older than 24 h: ${old}`;
}

// ── Flow ─────────────────────────────────────────────────────────────────────

/** POST to the cleanup route and narrow the response. */
async function postCleanup(dryRun: boolean, referenced: string[]): Promise<CleanupResponse> {
  const response = await api.fetchApi(CLEANUP_ROUTE, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dryRun, referenced }),
  });
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = typeof data === "object" && data !== null ? (data as { error?: unknown }).error : undefined;
    throw new Error(typeof message === "string" ? message : `server returned ${response.status}`);
  }
  if (!isCleanupResponse(data)) throw new Error("unexpected server response");
  return data;
}

/**
 * Run the two-step cleanup: dry run, confirm, delete, report. Errors toast;
 * never throws.
 *
 * @param statsLine - Stats `<span>` to refresh after cleanup.
 * @returns Resolves when done (or cancelled).
 */
export async function runCleanup(statsLine: HTMLSpanElement): Promise<void> {
  try {
    const referenced = collectClientReferences();
    const dry = await postCleanup(true, referenced);

    // Nothing to clean up cases.
    if (dry.old.count === 0) {
      notify("info", "Nothing to clean up (no files older than 24 h)");
      void fetchStats(statsLine);
      return;
    }
    if (dry.count === 0) {
      notify("info", `Nothing to clean up (the ${fileCount(dry.old.count)} files older than 24 h are all in use)`);
      void fetchStats(statsLine);
      return;
    }

    const text = confirmText(dry);
    if (text === null || !window.confirm(text)) return;

    // Re-collect: tabs/drafts may have changed while the dialog was open.
    const result = await postCleanup(false, collectClientReferences());
    const summary = `Deleted ${fileCount(result.count)} (${formatBytes(result.bytes)}).`;
    const errors = result.errors ?? [];
    if (errors.length) notify("warn", `${summary} ${errors.length} problem(s), see server log. First: ${errors[0]}`);
    else notify("info", summary);
  } catch (error) {
    notify("error", `File cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    void fetchStats(statsLine);
  }
}
