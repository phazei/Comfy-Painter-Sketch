/**
 * Lightweight output metadata snapshots (regions + Main options) shared by
 * region gestures, the `outputs` history entry and Clear. No pixels.
 */

import { cloneOutputOptions } from "../document/outputOptions";
import { cloneRegion } from "../document/regions";
import type { OutputOptions, Region } from "../document/types";
import type { EditorState } from "./editorState";

// ── Snapshots ─────────────────────────────────────────────────────────────────

/** A complete output metadata state, independent of layer pixels and frame geometry. */
export interface OutputMetadata {
  regions: Region[];
  /** Main options; absent = defaults (older documents never stored them). */
  main?: OutputOptions;
  /** Selected region at capture time (UI state, not content). */
  selected: string | null;
}

/**
 * Snapshot the current output metadata.
 * @param s - Shared editor state.
 * @returns Independent copy.
 */
export function captureOutputs(s: EditorState): OutputMetadata {
  const snapshot: OutputMetadata = { regions: s.doc.regions.map(cloneRegion), selected: s.selectedRegionId };
  if (s.doc.mainOutput) snapshot.main = cloneOutputOptions(s.doc.mainOutput);
  return snapshot;
}

/**
 * Restore a snapshot (undo/redo, Clear) and notify `outputs` listeners.
 * The caller emits `change` / `history` (it knows whether this is an edit).
 * @param s - Shared editor state.
 * @param value - Snapshot; absent means the Clear defaults (no regions, default Main).
 */
export function applyOutputs(s: EditorState, value?: OutputMetadata): void {
  s.doc.regions = value?.regions.map(cloneRegion) ?? [];
  if (value?.main) s.doc.mainOutput = cloneOutputOptions(value.main);
  else delete s.doc.mainOutput;
  s.selectedRegionId = value?.selected ?? null;
  s.events.emit("outputs", undefined);
}

/**
 * Content identity of a snapshot (excludes selection), used to detect no-op
 * gestures and to size history entries.
 * @param value - Snapshot.
 * @returns Stable JSON string.
 */
export function outputsKey(value: OutputMetadata): string {
  return JSON.stringify({ regions: value.regions, main: cloneOutputOptions(value.main) });
}
