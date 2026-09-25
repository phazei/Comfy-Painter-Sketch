/**
 * Which editor session a node shows when a widget value arrives (workflow
 * load, tab switch, paste, graph undo/redo). Pure, so the rules are
 * unit-testable without ComfyUI.
 *
 * Graph undo/redo (ComfyUI's ChangeTracker) re-runs `graph.configure`, which
 * removes every node and re-creates it in the same synchronous task. The
 * restored widget value may be OLDER than the live paint, because the change
 * tracker snapshots our widget value like any other. Paint has its own undo
 * stack, so a session handed off by the node's previous instance
 * (`handoff.ts`) is always kept: graph undo never rolls back paint.
 */

/** How to obtain a session for a parsed manifest. */
export type ManifestChoice =
  /** Show the live session for this `docId`. */
  | "reuse"
  /** Another live node shows it (node copy/paste): copy its editor under a new `docId`. */
  | "fork-copy"
  /** Another live node shows it and the manifest is a different state: restore under a new `docId`. */
  | "fork-restore"
  /** Build a new session from the manifest's layer files. */
  | "restore";

/** Facts about the live session registered for the manifest's `docId`. */
export interface LiveSessionFacts {
  /** Who shows it: nobody (detached), this node, or another live node. */
  owner: "none" | "self" | "other";
  /** The manifest is one of the session's recent saved states. */
  matchesRecent: boolean;
  /** Handed off by this node's previous instance moments ago (graph undo/redo). */
  handedOff: boolean;
}

/**
 * Decide how to get a session for a manifest.
 *
 * @param live - Facts about the live session with the same `docId`, or `null` if none.
 * @returns The choice.
 */
export function chooseForManifest(live: LiveSessionFacts | null): ManifestChoice {
  if (!live) return "restore";
  if (live.owner === "other") return live.matchesRecent ? "fork-copy" : "fork-restore";
  if (live.handedOff || live.matchesRecent) return "reuse";
  return "restore";
}

/** What to do when the value holds no usable manifest. */
export type EmptyChoice =
  /** Keep the current session. */
  | "keep"
  /** Show a fresh empty session. */
  | "reset"
  /** Show the session handed off by the node's previous instance. */
  | "adopt";

/**
 * Decide what an empty (`""`) or unreadable value does.
 *
 * @param status - Parse status of the value.
 * @param facts - `hasPaint`: the current session has paint; `handoff`: a
 *   handed-off session is waiting for this node.
 * @returns The choice.
 */
export function chooseForEmpty(
  status: "empty" | "invalid",
  facts: { hasPaint: boolean; handoff: boolean },
): EmptyChoice {
  if (status === "invalid") return "reset";
  if (facts.handoff) return "adopt";
  return facts.hasPaint ? "reset" : "keep";
}
