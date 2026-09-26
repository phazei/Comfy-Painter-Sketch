/**
 * Module-level registry of live editor sessions, keyed by the document's
 * `docId` (stored in the manifest).
 *
 * Why: tab switches, graph undo/redo and workflow reloads destroy and
 * recreate node instances (AGENTS.md "Node Lifecycle"). The session -- layer
 * canvases, undo history, dirty flags -- outlives them, so unsaved strokes and
 * undo history survive; a new node instance whose widget value carries the
 * same `docId` re-attaches.
 *
 * Release policy: a node's `onRemoved` cannot tell "deleted" from "tab
 * switched / graph reloaded", so removal only DETACHES. Detached sessions are
 * kept in LRU order and the oldest beyond {@link MAX_DETACHED_SESSIONS} are
 * disposed. Worst case (many closed tabs) is bounded to that many documents'
 * canvases + history.
 */

import { readFirstMaskStyle, readPressureDefaults, readSampleDefaults } from "../defaults/readDefaults";
import type { PainterDocument } from "../document/types";
import { Editor } from "../engine/editor";
import type { FrameSource } from "../engine/editor";
import { createDefaultTools } from "../tools/registry";
import type { ToolRegistry } from "../tools/registry";
import { LayerUploader, restoreLayers } from "./persistence";

/** Detached sessions kept for re-attachment. */
export const MAX_DETACHED_SESSIONS = 6;

/** Saved-state signatures remembered per session. */
const RECENT_SIGNATURES = 4;

/** Live editing state for one document. */
export interface EditorSession {
  readonly docId: string;
  readonly editor: Editor;
  readonly tools: ToolRegistry;
  readonly uploader: LayerUploader;
  /** Every file reference this document has loaded or uploaded. */
  readonly knownFiles: Set<string>;
  /** Last few {@link fileSignature}s, newest last. */
  readonly recentSignatures: string[];
  /** Controller currently showing it, or `null` when detached. */
  owner: object | null;
  /** `false` once disposed. */
  alive: boolean;
  /** Resolves when layer files have been restored. */
  ready: Promise<void>;
}

const sessions = new Map<string, EditorSession>();
/** Detached docIds, oldest first. */
const detachedOrder: string[] = [];

/**
 * Create and register a session for a document.
 *
 * @param doc - Document (layers with `file` are restored asynchronously).
 * @param source - Origin of the frame size.
 * @param editor - Existing editor (for forks); a new one is built otherwise.
 * @returns The session.
 */
export function createSession(doc: PainterDocument, source: FrameSource, editor?: Editor): EditorSession {
  releaseSession(doc.docId);
  const ed = editor ?? new Editor(doc, source);
  // User "Defaults" settings: a lazily added mask reads them when created;
  // pressure options are the tools' initial values (in-session edits win).
  ed.setMaskStyleProvider(readFirstMaskStyle);
  const knownFiles = new Set<string>();
  for (const layer of ed.doc.layers) if (layer.file) knownFiles.add(layer.file);
  const session: EditorSession = {
    docId: doc.docId,
    editor: ed,
    tools: createDefaultTools(ed, readPressureDefaults(), readSampleDefaults()),
    uploader: new LayerUploader(ed, knownFiles),
    knownFiles,
    recentSignatures: [fileSignature(ed.doc)],
    owner: null,
    alive: true,
    ready: Promise.resolve(),
  };
  ed.events.on("change", () => {
    const signature = fileSignature(ed.doc);
    const list = session.recentSignatures;
    if (list[list.length - 1] === signature) return;
    list.push(signature);
    if (list.length > RECENT_SIGNATURES) list.shift();
  });
  if (!editor) session.ready = restoreLayers(ed, () => session.alive);
  sessions.set(doc.docId, session);
  return session;
}

/**
 * Find a live session.
 * @param docId - Document id.
 * @returns The session or `undefined`.
 */
export function findSession(docId: string): EditorSession | undefined {
  return sessions.get(docId);
}

/**
 * Identity of a manifest's saved state: frame + per-layer files.
 * @param doc - Document.
 * @returns Signature string.
 */
export function fileSignature(doc: Pick<PainterDocument, "frame" | "layers">): string {
  return `${doc.frame.width}x${doc.frame.height}|${doc.layers.map((l) => `${l.id}=${l.file ?? ""}`).join(",")}`;
}

/**
 * Whether a manifest is (recently) this session's own state, so the session
 * -- which may hold newer unsaved strokes and undo history -- can be reused.
 * The last few signatures are accepted because an upload may finish between
 * the frontend capturing the widget value and the node being recreated.
 * An older manifest (reopening a file after discarding changes) does not
 * match and is restored from its files instead -- except for a session handed
 * off by a node re-created in the same task (graph undo/redo, see
 * `attachDecision.ts` / `handoff.ts`), which is always kept.
 *
 * @param session - Candidate session.
 * @param doc - Parsed manifest.
 * @returns `true` if the session may be reused for this manifest.
 */
export function sessionMatches(session: EditorSession, doc: PainterDocument): boolean {
  return session.recentSignatures.includes(fileSignature(doc));
}

/**
 * Mark a session as shown by `owner`.
 * @param session - Session.
 * @param owner - Controller.
 */
export function attachSession(session: EditorSession, owner: object): void {
  session.owner = owner;
  const index = detachedOrder.indexOf(session.docId);
  if (index >= 0) detachedOrder.splice(index, 1);
}

/**
 * Detach a session from its owner; evict the oldest detached sessions.
 * @param session - Session.
 * @param owner - Controller releasing it (ignored if it is not the owner).
 */
export function detachSession(session: EditorSession, owner: object): void {
  if (session.owner !== owner) return;
  session.owner = null;
  if (!session.alive) return;
  detachedOrder.push(session.docId);
  while (detachedOrder.length > MAX_DETACHED_SESSIONS) {
    const oldest = detachedOrder.shift();
    if (oldest) releaseSession(oldest);
  }
}

/**
 * Dispose a session and forget it.
 * @param docId - Document id.
 */
export function releaseSession(docId: string): void {
  const session = sessions.get(docId);
  if (!session) return;
  sessions.delete(docId);
  const index = detachedOrder.indexOf(docId);
  if (index >= 0) detachedOrder.splice(index, 1);
  session.alive = false;
  session.uploader.dispose();
  session.editor.dispose();
}


/**
 * Whether any live session has dirty layers not yet uploaded.
 *
 * @returns `true` when at least one session has pending uploads.
 */
export function pendingUploads(): boolean {
  for (const session of sessions.values()) {
    if (session.alive && session.editor.dirty) return true;
  }
  return false;
}

/**
 * Flush all live sessions' uploads concurrently.
 *
 * Each session's uploader already toasts on failure; errors are collected so
 * the caller can decide whether to proceed anyway.
 *
 * @returns Resolves with an array of per-session errors (empty = all ok).
 */
export async function flushAll(): Promise<Error[]> {
  const errors: Error[] = [];
  await Promise.all(
    [...sessions.values()]
      .filter((s) => s.alive && s.editor.dirty)
      .map((s) =>
        s.uploader.flush().catch((err: unknown) => {
          errors.push(err instanceof Error ? err : new Error(String(err)));
        }),
      ),
  );
  return errors;
}