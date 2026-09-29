/**
 * Which image the background (and the M13a Image Mask row) may use: pure
 * rules plus the executed-preview provenance store. Used by
 * `backgroundLoader.ts` (source choice, status) and `imageMaskSync.ts`.
 *
 * Rule: the background only shows an image that belongs to the currently
 * connected upstream (its own preview / widget file), or our own executed
 * preview from a run made with that same upstream link (origin node + output
 * slot). An upstream without an image shows the same fallback as the
 * disconnected state; a remembered image of an earlier upstream is never
 * reused for another one.
 */

import type { LoadedBackground } from "./handoff";
import type { ImageSource, ImageSourceOrigin } from "./imageSource";

// ── Executed-preview provenance ───────────────────────────────────────────────

/** Most provenance entries kept (oldest dropped first). */
const MAX_PROVENANCE = 256;

/**
 * Executed preview key -> identity of the `image` link it was produced with.
 * Module-level so it survives tab switches / graph undo (node instances are
 * re-created; `app.nodeOutputs` keeps the preview itself).
 */
const provenance = new Map<string, string>();

/**
 * Remember which upstream link an executed preview came from.
 * @param executedKey - `ImageSource.key` of our executed preview.
 * @param link - {@link linkIdentity} of `image` at execution time.
 */
export function recordExecutedLink(executedKey: string, link: string): void {
  provenance.delete(executedKey);
  provenance.set(executedKey, link);
  while (provenance.size > MAX_PROVENANCE) {
    const oldest = provenance.keys().next().value;
    if (oldest === undefined) break;
    provenance.delete(oldest);
  }
}

/**
 * @param executedKey - `ImageSource.key` of an executed preview.
 * @returns The link it was produced with, or `undefined` when unknown.
 */
export function executedLinkOf(executedKey: string): string | undefined {
  return provenance.get(executedKey);
}

/**
 * Forget an executed preview's provenance (the link changed: it no longer applies).
 * @param executedKey - `ImageSource.key` of the executed preview.
 */
export function forgetExecutedLink(executedKey: string): void {
  provenance.delete(executedKey);
}

// ── Link identity ─────────────────────────────────────────────────────────────

/**
 * Stable identity of what feeds `image`: the real origin node (after virtual
 * reroutes) and its output slot. Re-linking the same node/slot gives the same
 * identity; a different node or slot a different one.
 * @param graphPrefix - `""` in the root graph, `"<subgraph id>:"` otherwise.
 * @param originId - Origin node id (a subgraph input's id inside subgraphs).
 * @param originSlot - Origin output slot.
 * @returns The identity string.
 */
export function linkIdentity(graphPrefix: string, originId: string | number, originSlot: number): string {
  return `${graphPrefix}${String(originId)}#${originSlot}`;
}

// ── Source choice ─────────────────────────────────────────────────────────────

/** Inputs of {@link chooseBackgroundSource}. */
export interface SourceCandidates {
  /** Source of the connected upstream itself (`sourceFromNode`), if any. */
  upstream: ImageSource | null;
  /** Our own executed preview, if any. */
  executed: ImageSource | null;
  /** Link the executed preview was produced with (`undefined` = unknown). */
  executedLink: string | undefined;
  /** Current `image` link identity (`null` = disconnected). */
  link: string | null;
}

/**
 * Whether our executed preview belongs to the current link.
 * @param executedLink - Link recorded for the preview (`undefined` = unknown).
 * @param link - Current link (`null` = disconnected).
 * @returns `true` only for a known, identical link.
 */
export function executedMatchesLink(executedLink: string | undefined, link: string | null): boolean {
  return link !== null && executedLink === link;
}

/**
 * The background source: the upstream's own image, else our executed preview
 * if it was made with this same link, else nothing (fallback, like disconnected).
 * @param c - Candidates.
 * @returns Source to show, or `null`.
 */
export function chooseBackgroundSource(c: SourceCandidates): ImageSource | null {
  if (c.link === null) return null;
  if (c.upstream) return c.upstream;
  return c.executed && executedMatchesLink(c.executedLink, c.link) ? c.executed : null;
}

// ── Status ────────────────────────────────────────────────────────────────────

/** Resolved source identity (what the loader is currently after). */
export interface CurrentSource {
  key: string;
  origin: ImageSourceOrigin;
}

/**
 * What the background is doing right now.
 * - `unresolved`: nothing known yet (startup; a restored row is kept);
 * - `none`: disconnected, the upstream has no image, or its load failed;
 * - `loading`: `key` is (re)loading;
 * - `loaded`: `background` is shown.
 */
export type BackgroundStatus =
  | { kind: "unresolved" }
  | { kind: "none" }
  | { kind: "loading"; key: string; origin: ImageSourceOrigin }
  | { kind: "loaded"; background: LoadedBackground };

/** Inputs of {@link backgroundStatus}. */
export interface StatusInput {
  /** A lookup ran after startup (else a missing source is `unresolved`, not `none`). */
  resolved: boolean;
  /** Source of the latest lookup, `null` when none. */
  current: CurrentSource | null;
  /** Last successfully loaded image (any source). */
  loaded: LoadedBackground | null;
  /** Key currently loading, `null` when idle. */
  pendingKey: string | null;
}

/**
 * Status of the background; a loaded image counts only for the current key.
 * @param s - Loader state.
 * @returns The status.
 */
export function backgroundStatus(s: StatusInput): BackgroundStatus {
  const current = s.current;
  if (current && s.loaded?.key === current.key) return { kind: "loaded", background: s.loaded };
  if (current && s.pendingKey === current.key) return { kind: "loading", key: current.key, origin: current.origin };
  return s.resolved ? { kind: "none" } : { kind: "unresolved" };
}

/**
 * The background image to show for a status (`null` = fallback / hold).
 * @param status - {@link backgroundStatus}.
 * @returns The loaded background, or `null`.
 */
export function shownBackground(status: BackgroundStatus): LoadedBackground | null {
  return status.kind === "loaded" ? status.background : null;
}

// ── Image Mask row ────────────────────────────────────────────────────────────

/** What to do with the Image Mask row for a background status. */
export type ImageMaskAction = "keep" | "remove" | "read";

/**
 * Image Mask row rule (M13a): read an upstream file's alpha; keep the row
 * while unresolved (page reload restores it), while the row's own key is
 * (re)loading, and for our executed preview (same link by construction;
 * Python reads the alpha from the same uploaded file); otherwise (no
 * source, no image, another key loading) remove it.
 * @param status - Background status.
 * @param rowSourceKey - Source key of the existing row, if any.
 * @returns The action (`read` also covers non-`/view` upstreams, which remove the row once read).
 */
export function imageMaskAction(status: BackgroundStatus, rowSourceKey: string | undefined): ImageMaskAction {
  switch (status.kind) {
    case "unresolved":
      return "keep";
    case "none":
      return "remove";
    case "loading":
      return status.origin === "executed" || status.key === rowSourceKey ? "keep" : "remove";
    case "loaded":
      return status.background.origin === "executed" ? "keep" : "read";
  }
}
