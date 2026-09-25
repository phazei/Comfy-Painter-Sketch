/**
 * Collect layer file references the server cannot see: open workflow tabs,
 * the current graph and browser-stored drafts. Everything is stringified and
 * regex-scanned (`references.ts`), never interpreted, so format changes in the
 * frontend's stores only matter if the names disappear from them entirely.
 *
 * Sources (checked against ComfyUI_frontend 1.55 source and the 1.52.7 bundle):
 * - `app.extensionManager.workflow.openWorkflows` (the workspace store's
 *   workflow store): per tab `content`, `originalContent`, and the change
 *   tracker's `activeState`, `initialState`, `undoQueue`, `redoQueue` (graph
 *   undo can bring old file references back).
 * - `app.graph.serialize()`: the live root graph incl. subgraph definitions.
 * - Every `localStorage` / `sessionStorage` value. Drafts live under
 *   `Comfy.Workflow.Draft.v2:<workspace>:<key>` (1.52+), legacy
 *   `Comfy.Workflow.Drafts:<workspace>` and `workflow` / `workflow:<id>`;
 *   scanning all keys is a cheap superset that survives key renames.
 */

import { app } from "@comfy/scripts/app.js";

import { extractReferences } from "./references";

/** Plain object narrowing. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Scan one value (string as is, anything else as JSON) into `into`. */
function scanValue(value: unknown, into: Set<string>): void {
  if (value === null || value === undefined) return;
  if (typeof value === "string") {
    extractReferences(value, into);
    return;
  }
  try {
    const text = JSON.stringify(value);
    if (text) extractReferences(text, into);
  } catch {
    // Circular or otherwise unserializable: nothing we can scan.
  }
}

/** References in every open workflow tab (saved content, live state, graph undo history). */
function scanOpenWorkflows(into: Set<string>): void {
  const manager: unknown = app.extensionManager;
  const store = isRecord(manager) ? manager["workflow"] : undefined;
  const open = isRecord(store) ? store["openWorkflows"] : undefined;
  if (!Array.isArray(open)) return;
  for (const workflow of open) {
    if (!isRecord(workflow)) continue;
    scanValue(workflow["content"], into);
    scanValue(workflow["originalContent"], into);
    const tracker = workflow["changeTracker"];
    if (!isRecord(tracker)) continue;
    for (const key of ["activeState", "initialState", "undoQueue", "redoQueue"]) scanValue(tracker[key], into);
  }
}

/** References in the live root graph. */
function scanCurrentGraph(into: Set<string>): void {
  const root: unknown = app;
  const graph = isRecord(root) ? root["graph"] : undefined;
  if (!isRecord(graph) || typeof graph["serialize"] !== "function") return;
  try {
    scanValue((graph["serialize"] as () => unknown).call(graph), into);
  } catch {
    // A graph mid-reconfigure can throw; open-tab states still cover it.
  }
}

/** References in every value of a Web Storage area (the getter throws when storage is blocked). */
function scanStorage(getStorage: () => Storage, into: Set<string>): void {
  let storage: Storage;
  try {
    storage = getStorage();
  } catch {
    return;
  }
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (key !== null) scanValue(storage.getItem(key), into);
  }
}

/**
 * Collect every layer file name referenced in this browser tab.
 *
 * @returns Sorted lower-cased file names (no directory).
 */
export function collectClientReferences(): string[] {
  const names = new Set<string>();
  scanOpenWorkflows(names);
  scanCurrentGraph(names);
  scanStorage(() => globalThis.localStorage, names);
  scanStorage(() => globalThis.sessionStorage, names);
  return [...names].sort();
}
