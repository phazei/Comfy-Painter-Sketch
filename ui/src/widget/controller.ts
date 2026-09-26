/**
 * Per-node controller: connects one PainterSketch node instance to an editor
 * session and its DOM host. It orchestrates focused collaborators:
 * `backgroundLoader.ts` (image source resolution + loading, refresh
 * triggers), `frameSync.ts` (background/frame pushed to the editor, frame
 * widgets) and `uploadScheduler.ts` (upload timing, Ctrl+S, graph-sync
 * captures).
 *
 * - Widget value: `""` for a never-painted document, else the manifest JSON
 *   of the attached session (file refs = last successful uploads). Updated on
 *   every document change so tab switches / workflow saves capture it.
 *   Value changes ComfyUI can't observe (edits, finished upload batches)
 *   request a ChangeTracker capture (`graphSync.ts`) so the workflow draft
 *   restored on page reload has them.
 * - Sessions outlive node instances (see `sessions.ts`); `setValue` with a
 *   manifest re-attaches the session for its `docId`, forks it if another
 *   live node already owns it (node copy/paste), or restores from files
 *   (`sessionAttach.ts`, rules in `attachDecision.ts`). A node re-created in the same task (graph
 *   undo/redo) takes over its predecessor's element slot, session and
 *   background (`handoff.ts`), so nothing blanks or reloads.
 *
 * Controllers live in a module-level `WeakMap` keyed by node, not on the node.
 */

import { app } from "@comfy/scripts/app.js";

import { readFirstMaskStyle } from "../defaults/readDefaults";
import { createEmptyDocument } from "../document/create";
import { parseDocument } from "../document/parse";
import { stringifyDocument } from "../document/serialize";
import type { LGraphNode, NodeExecutionOutput } from "../types/comfy";
import { EditorHost } from "../ui/editorHost";
import { chooseForEmpty } from "./attachDecision";
import { BackgroundLoader, SourceWatcher } from "./backgroundLoader";
import { INPUT_NAMES } from "./constants";
import { isolateEvents } from "./eventIsolation";
import type { EventIsolation } from "./eventIsolation";
import { FrameSync } from "./frameSync";
import { handoffKey, offerHandoff, takeHandoff } from "./handoff";
import type { NodeHandoff } from "./handoff";
import { invalidDocumentMessage } from "./failures";
import { EDIT_SYNC_DELAY_MS, requestGraphSync } from "./graphSync";
import { isInputConnected } from "./imageSource";
import { releaseOrDetach, sessionForManifest } from "./sessionAttach";
import { attachSession, createSession, findSession } from "./sessions";
import type { EditorSession } from "./sessions";
import { notify } from "./toast";
import { bindSessionUploads, flushForQueue, WorkflowSaver } from "./uploadScheduler";

// ── Registry ──────────────────────────────────────────────────────────────────

const controllers = new WeakMap<LGraphNode, PainterSketchController>();

/**
 * Controller for a node, if our widget was created on it.
 *
 * @param node - Any node.
 * @returns The controller or `undefined`.
 */
export function getController(node: LGraphNode): PainterSketchController | undefined {
  return controllers.get(node);
}

// ═══════════════════════════════════════════════════════════════════════════
// PainterSketchController
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Wires one node instance to one editor session.
 */
export class PainterSketchController {
  /** Editor DOM shell; its `element` is the DOM widget element. */
  readonly host: EditorHost;

  private session: EditorSession | null = null;
  private sessionUnbind: (() => void) | null = null;
  private valueCache = "";
  /**
   * An incoming value `parseDocument` rejected (unknown version, corrupt),
   * reported as our value while the editor is untouched; `null` otherwise.
   */
  private unreadableValue: string | null = null;
  /**
   * Session handed off by this node's previous instance, until the widget
   * value has been applied (same task; see `handoff.ts`).
   */
  private handoff: EditorSession | null = null;
  private readonly isolation: EventIsolation;
  private readonly loader: BackgroundLoader;
  private readonly watcher: SourceWatcher;
  private readonly frame: FrameSync;
  private readonly saver = new WorkflowSaver();
  private disposed = false;

  /**
   * @param node - The node this controller belongs to.
   */
  constructor(private readonly node: LGraphNode) {
    this.host = new EditorHost({
      onBecameVisible: () => this.refresh(),
      isDetached: () => this.isOffViewedGraph(),
      onDisengage: () => this.session?.uploader.flushQuietly(),
      onSave: () => void this.saver.save(this.session),
    });
    this.isolation = isolateEvents({
      root: this.host.root,
      stage: this.host.stage,
      onWheel: (event) => this.host.input.handleWheel(event),
      onChromeWheel: (event) => this.host.handleChromeWheel(event),
      onMiddlePointer: (event) => this.host.input.handlePointer(event),
    });
    this.loader = new BackgroundLoader(node, () => this.updateContent());
    this.watcher = new SourceWatcher(() => this.refresh(), () => this.tick());
    this.frame = new FrameSync(node, this.loader);
    controllers.set(node, this);
    this.attach(this.newEmptySession());
  }

  /** A session for a brand-new document (mask styled by the user's "Defaults" settings). */
  private newEmptySession(): EditorSession {
    return createSession(createEmptyDocument(this.frame.fallbackFrame().size, undefined, readFirstMaskStyle()), "widgets");
  }

  // ── Widget value ────────────────────────────────────────────────────────

  /** @returns The manifest string (`""` = never painted). */
  getValue(): string {
    return this.valueCache;
  }

  /**
   * A value arrived from outside (workflow load, paste, graph undo, ...).
   *
   * @param value - Incoming widget value.
   */
  setValue(value: unknown): void {
    if (this.disposed) return;
    if (!this.handoff && typeof value === "string" && value === this.valueCache) return;
    const parsed = parseDocument(value);
    if (parsed.status === "ok") {
      this.unreadableValue = null;
      const existing = findSession(parsed.document.docId);
      const session = sessionForManifest(parsed.document, this, this.handoff);
      const handedOff = session === this.handoff;
      this.attach(session);
      this.handoff = null;
      // The graph holds `value`, but a re-attached session (uploads finished
      // while this tab was in the background) or a fork (new docId) differs:
      // let the ChangeTracker / draft see ours. Not for graph undo/redo
      // (handed off): capturing then would push an entry and clear redo.
      const reusedOrForked = session === existing || session.docId !== parsed.document.docId;
      if (!handedOff && reusedOrForked && this.valueCache !== value) {
        requestGraphSync(this.node, EDIT_SYNC_DELAY_MS);
      }
      return;
    }
    // An unreadable value stays the widget value until the user paints, so
    // saving the workflow never silently drops it (see syncValue).
    this.unreadableValue = null;
    if (parsed.status === "invalid") {
      this.unreadableValue = typeof value === "string" ? value : JSON.stringify(value);
      notify("warn", invalidDocumentMessage(parsed.reason), { key: `invalid-document:${parsed.reason}` });
    }
    const handoff = this.handoff?.alive && this.handoff.owner === null ? this.handoff : null;
    this.handoff = null;
    const choice = chooseForEmpty(parsed.status, {
      hasPaint: this.session?.editor.hasPaint ?? false,
      handoff: handoff !== null,
    });
    if (choice === "adopt" && handoff) this.attach(handoff);
    else if (choice === "reset") this.attach(this.newEmptySession());
  }

  /**
   * Value for the prompt: uploads dirty layers first (decision 8).
   * @returns Manifest string.
   * @throws If an upload failed (the toast has been shown); queueing stops so
   *   the output never silently differs from the editor.
   */
  async serialize(): Promise<string> {
    const session = this.session;
    if (!session) return this.valueCache;
    await flushForQueue(session);
    return this.valueCache;
  }

  // ── Lifecycle (called from node hooks) ──────────────────────────────────

  /**
   * Node constructor finished: chain our own widgets' callbacks so fallback
   * frame edits apply immediately (the poll catches programmatic changes).
   */
  handleNodeCreated(): void {
    this.frame.chainWidgetCallbacks(() => this.updateContent());
    this.updateContent();
  }

  /**
   * Node added to a graph (before `configure` applies saved values): claim a
   * hand-off from a predecessor re-created in this task, then start listening.
   */
  handleAdded(): void {
    if (this.disposed || this.watcher.active) return;
    const key = handoffKey(this.node);
    const handoff = key ? takeHandoff(key) : undefined;
    if (handoff) this.adoptHandoff(handoff);
    this.watcher.start();
  }

  /**
   * Our node executed; its `ui` output carries the input image preview.
   * @param output - Execution output.
   */
  handleExecuted(output: NodeExecutionOutput): void {
    this.loader.setExecuted(output);
    this.refresh();
  }

  /**
   * A link on our node changed.
   * @param type - Slot type (`LINK_INPUT` for inputs).
   * @param slot - Slot index.
   * @param isConnected - `false` when a link was removed.
   */
  handleConnectionsChange(type: number, slot: number, isConnected: boolean): void {
    // During `configure` (before the deferred first refresh) upstream nodes
    // may not be configured yet; resolving now could load a bogus source.
    if (this.watcher.starting) {
      this.updateContent();
      return;
    }
    // `image` unlinked by the user: the widgets take over the last image size.
    this.frame.handleLinkChange(type, slot, isConnected, this.session, () => !this.disposed && !this.isImageConnected());
    this.refresh();
  }

  /**
   * Release node-bound resources; the session is only detached. The widget
   * element and state are offered to a successor re-created in the same task
   * (graph undo/redo), else the element is removed. Idempotent.
   */
  dispose(): void {
    if (this.disposed) return;
    const key = handoffKey(this.node);
    const session = this.session;
    this.disposed = true;
    this.loader.dispose();
    this.watcher.stop();
    this.detach();
    this.isolation.dispose();
    this.host.dispose();
    controllers.delete(this.node);
    const element = this.host.element;
    if (!key) {
      element.remove();
      return;
    }
    offerHandoff(key, {
      element,
      session: session?.alive ? session : null,
      background: this.loader.background,
      lastExecuted: this.loader.lastExecuted,
    });
  }

  /**
   * Take over from the removed previous instance of this node: put our
   * element into its renderer slot (Nodes 2.0 does not remount the widget),
   * reuse its background, and remember its session for `setValue`.
   */
  private adoptHandoff(handoff: NodeHandoff): void {
    const element = this.host.element;
    if (!element.isConnected && handoff.element.isConnected) handoff.element.replaceWith(element);
    else handoff.element.remove();
    this.loader.adopt(handoff.background, handoff.lastExecuted);
    const session = handoff.session;
    if (!session?.alive || session.owner !== null) return;
    this.handoff = session;
    // Normally consumed by `setValue` during `configure`; if no value
    // arrives in this task, show the handed-off session anyway.
    queueMicrotask(() => {
      if (this.handoff !== session) return;
      this.handoff = null;
      if (!this.disposed && session.alive && session.owner === null && this.valueCache === "") this.attach(session);
    });
  }

  // ── Sessions ────────────────────────────────────────────────────────────

  private attach(session: EditorSession): void {
    if (session === this.session) {
      this.syncValue();
      return;
    }
    this.detach();
    this.session = session;
    attachSession(session, this);
    this.sessionUnbind = bindSessionUploads(this.node, session, () => this.syncValue());
    this.host.setSession(session);
    this.frame.reset();
    this.syncValue();
    this.updateContent();
    if (session.editor.dirty) session.uploader.schedule();
  }

  private detach(): void {
    const session = this.session;
    if (!session) return;
    this.sessionUnbind?.();
    this.sessionUnbind = null;
    this.session = null;
    this.host.setSession(null);
    releaseOrDetach(session, this);
  }

  /** @returns `true` if the widget value changed. */
  private syncValue(): boolean {
    const editor = this.session?.editor;
    if (!editor) return false;
    const untouched = !editor.hasPaint && editor.doc.layers.every((l) => l.file === null);
    const previous = this.valueCache;
    if (!untouched) this.unreadableValue = null;
    this.valueCache = untouched ? (this.unreadableValue ?? "") : stringifyDocument(editor.doc);
    return this.valueCache !== previous;
  }

  // ── Background + content ────────────────────────────────────────────────

  /**
   * Re-resolve the background source and reload only if it changed. While
   * `image` is disconnected no source is used and in-flight loads are dropped.
   */
  refresh(): void {
    if (this.disposed) return;
    this.loader.refresh(this.isImageConnected());
    this.updateContent();
  }

  private tick(): void {
    if (!this.host.isVisible()) return;
    this.host.refreshScale();
    this.refresh();
  }

  /** Push background + frame to the editor when anything relevant changed. */
  private updateContent(): void {
    const session = this.session;
    if (this.disposed || !session) return;
    this.frame.apply(session, this.isImageConnected());
  }

  /**
   * Fullscreen exit check: the node left its graph (removal, tab switch
   * clears `node.graph`) or another graph is being viewed (subgraph
   * navigation; Nodes 2.0 also unmounts the widget then).
   */
  private isOffViewedGraph(): boolean {
    const graph = this.node.graph;
    if (!graph) return true;
    const viewed = app.canvas?.graph;
    return viewed != null && viewed !== graph;
  }

  private isImageConnected(): boolean {
    return isInputConnected(this.node, INPUT_NAMES.image);
  }
}
