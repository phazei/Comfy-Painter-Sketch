/**
 * Tell ComfyUI that our widget value changed without user interaction, so
 * the workflow draft (what a page reload restores) gets the new value.
 *
 * Why (verified against the installed 1.52.7 bundle and 1.55.2 source,
 * `src/scripts/changeTracker.ts`, `useWorkflowPersistenceV2.ts`): drafts are
 * written by a 512 ms debounced `persistCurrentWorkflow` (serializes the live
 * root graph) that only runs on the `graphChanged` api event, flushed on
 * `pagehide`. `graphChanged` is dispatched by `ChangeTracker.updateModified`,
 * i.e. only when `captureCanvasState()` finds the graph differs from its last
 * snapshot, and that runs on mouseup / keyup / keydown / promptQueued etc.
 * Our value changes after an async upload (or a stroke whose pointer events
 * never reach those listeners), so nothing captured it and the draft kept the
 * old file names. `graph.change()` only repaints; `graphChanged` alone would
 * write the draft but leave the tracker's snapshot / modified flag stale.
 *
 * So we call the active workflow's `captureCanvasState()` (coalesced), which
 * adds one graph-undo entry per burst and dispatches `graphChanged`. The
 * frontend's own `pagehide` flush writes a still-debounced draft before a
 * reload. Only nodes in the active workflow's root graph can be captured:
 * a tracker reads the live canvas, so a background tab (whose node instances
 * are gone anyway) is skipped.
 */

import { app } from "@comfy/scripts/app.js";

import type { LGraphNode } from "../types/comfy";
import { CoalescedTask, captureTrackerState, isInRootGraph } from "./graphSyncCore";

/** Delay after an editor edit (coalesces strokes / slider drags). */
export const EDIT_SYNC_DELAY_MS = 1000;

/** Delay after an upload batch settled (next task, out of the upload's stack). */
export const UPLOAD_SYNC_DELAY_MS = 0;

/** Nodes whose value changed since the last capture. */
const requested = new Set<LGraphNode>();

const task = new CoalescedTask(() => {
  const nodes = [...requested];
  requested.clear();
  const root = app.graph;
  if (!nodes.some((node) => isInRootGraph(node.graph, root))) return;
  const tracker = app.extensionManager?.workflow?.activeWorkflow?.changeTracker;
  if (tracker) captureTrackerState(tracker);
});

/**
 * Request a ChangeTracker capture for a node whose widget value changed.
 * Calls within the delay are coalesced into one capture.
 *
 * @param node - Node whose value changed.
 * @param delayMs - {@link EDIT_SYNC_DELAY_MS} or {@link UPLOAD_SYNC_DELAY_MS}.
 */
export function requestGraphSync(node: LGraphNode, delayMs: number): void {
  requested.add(node);
  task.schedule(delayMs);
}

/**
 * Run a pending capture now (before a reload / when the page is hidden), so
 * `graphChanged` is dispatched before the frontend's `pagehide` flush.
 */
export function flushGraphSync(): void {
  task.flush();
}
