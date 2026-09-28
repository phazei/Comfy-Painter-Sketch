/**
 * Session history of the images seen on the `layer_source` input (SPEC
 * "Image sources (M12)"): the last {@link SOURCE_HISTORY_SIZE} distinct
 * images, newest first; a repeat moves to the top. One instance per node
 * controller, in memory only (never in the manifest or the workflow).
 *
 * Also the pure half of the source lookup: reading our executed `ui` output
 * (`layer_source` key, written by `nodes/painter_sketch.py`). Pure: no
 * `app` / `api` imports.
 */

import type { NodeExecutionOutput, ResultItem } from "../types/comfy";
import { viewQuery } from "./viewUrl";

/** How many sources the history keeps. */
export const SOURCE_HISTORY_SIZE = 10;

/**
 * What a change was: `"new"` = a key not in the list went on top and should
 * be announced (auto-open), `"seed"` = the same without an announcement
 * (initial state at node / workflow load), `"moved"` = a known key moved up.
 */
export type SourceChange = "new" | "seed" | "moved";

/** UI output key of the `layer_source` preview (Python `LAYER_SOURCE_UI_KEY`). */
export const LAYER_SOURCE_UI_KEY = "layer_source";

/** One remembered source. */
export interface SourceEntry {
  /** Stable identity (dedupe key; no cache-buster). */
  key: string;
  /** URL to load (may carry a cache-buster). */
  url: string;
  /** Layer name for an insert (file name without extension), when meaningful. */
  name?: string;
}

/**
 * Newest-first, de-duplicated, capped list of sources.
 */
export class SourceHistory {
  private list: SourceEntry[] = [];
  private readonly listeners = new Set<(change: SourceChange) => void>();

  /**
   * @param cap - Maximum entries (default {@link SOURCE_HISTORY_SIZE}).
   */
  constructor(private readonly cap: number = SOURCE_HISTORY_SIZE) {}

  /** Entries, newest first. */
  get entries(): readonly SourceEntry[] {
    return this.list;
  }

  /**
   * Record a sighting: new keys go on top (the oldest falls off past the
   * cap), a known key moves to the top. Seeing the current top again is a no-op.
   * @param entry - Source seen.
   * @param announce - A new key is reported as `"new"` (else `"seed"`).
   * @returns `true` if the list changed.
   */
  add(entry: SourceEntry, announce = true): boolean {
    if (this.list[0]?.key === entry.key) return false;
    const known = this.list.some((e) => e.key === entry.key);
    this.list = [{ ...entry }, ...this.list.filter((e) => e.key !== entry.key)].slice(0, this.cap);
    const change: SourceChange = known ? "moved" : announce ? "new" : "seed";
    for (const listener of this.listeners) listener(change);
    return true;
  }

  /**
   * Listen for changes.
   * @param listener - Called after every change with its kind.
   * @returns Unsubscribe.
   */
  onChange(listener: (change: SourceChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

/**
 * The `layer_source` preview item of an executed output, if any.
 * @param output - Our node's `ui` output.
 * @returns First usable item, or `null`.
 */
export function layerSourceItem(output: NodeExecutionOutput | null | undefined): (ResultItem & { source_id?: string }) | null {
  const items = output?.[LAYER_SOURCE_UI_KEY];
  if (!Array.isArray(items)) return null;
  for (const item of items as unknown[]) {
    if (isResultItem(item)) return item;
  }
  return null;
}

/**
 * Stable key of an executed `layer_source` item: its content id (preview
 * files get random names on every run), else its `/view` query.
 * @param item - Item from {@link layerSourceItem}.
 * @returns Key.
 */
export function layerSourceKey(item: ResultItem & { source_id?: string }): string {
  return typeof item.source_id === "string" && item.source_id ? `source:${item.source_id}` : viewQuery(item);
}

function isResultItem(value: unknown): value is ResultItem & { source_id?: string } {
  if (typeof value !== "object" || value === null) return false;
  const filename = (value as { filename?: unknown }).filename;
  return typeof filename === "string" && filename.length > 0;
}
