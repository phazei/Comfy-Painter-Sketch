/**
 * Session choice for one node: which session a manifest attaches (reuse,
 * restore or fork; rules in `attachDecision.ts`) and what happens to a
 * session the node lets go (released if never painted, else flushed and
 * detached so a later instance can re-attach, see `sessions.ts`).
 *
 * Used by `controller.ts`; the controller object is the session `owner`.
 */

import { createId } from "../document/create";
import type { PainterDocument } from "../document/types";
import { chooseForManifest } from "./attachDecision";
import { createSession, detachSession, findSession, releaseSession, sessionMatches } from "./sessions";
import type { EditorSession } from "./sessions";
import { notify } from "./toast";

/**
 * Pick or create the session for a parsed manifest.
 *
 * @param doc - Parsed manifest.
 * @param owner - The controller asking (compared with `session.owner`).
 * @param handoff - Session handed off by the node's previous instance, if
 *   still unclaimed (graph undo/redo; always kept).
 * @returns The session to attach (possibly a fork under a new `docId`).
 */
export function sessionForManifest(doc: PainterDocument, owner: object, handoff: EditorSession | null): EditorSession {
  const existing = findSession(doc.docId);
  if (!existing) return createSession(doc, "document");
  const choice = chooseForManifest({
    owner: existing.owner === null ? "none" : existing.owner === owner ? "self" : "other",
    matchesRecent: sessionMatches(existing, doc),
    handedOff: existing === handoff,
  });
  switch (choice) {
    case "reuse":
      return existing;
    case "restore":
      // The manifest is an older/other saved state (e.g. a workflow file
      // reopened after closing its tab without saving): it replaces the live
      // session. Say so if that drops pixels that were never uploaded.
      if (existing.editor.dirty) {
        notify(
          "warn",
          "Loaded the painting as saved in this workflow; newer unsaved strokes from the previous " +
            "copy of this node were discarded.",
          { details: [`docId ${doc.docId}`] },
        );
      }
      return createSession(doc, "document");
    case "fork-copy":
    case "fork-restore": {
      // Duplicate docId while the original is live (copy/paste): fork.
      const docId = createId();
      return choice === "fork-copy"
        ? createSession({ ...doc, docId }, "document", existing.editor.fork(docId))
        : createSession({ ...doc, docId }, "document");
    }
  }
}

/**
 * A node stops showing `session` (node removed / tab switched / another
 * session attached): dispose it if it was never painted, else upload dirty
 * layers quietly and detach it for later re-attachment.
 *
 * @param session - Session being let go.
 * @param owner - The controller that showed it.
 */
export function releaseOrDetach(session: EditorSession, owner: object): void {
  if (!session.editor.hasPaint && !session.editor.dirty) releaseSession(session.docId);
  else {
    // Node removed / tab switched: the editor is no longer in use.
    session.uploader.flushQuietly();
    detachSession(session, owner);
  }
}
