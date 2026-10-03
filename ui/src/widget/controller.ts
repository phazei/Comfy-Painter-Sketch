/**
 * Per-node controller: connects one PainterSketch node instance to an editor
 * session and its DOM host. It orchestrates focused collaborators:
 * `backgroundLoader.ts` (image source resolution + loading, refresh
 * triggers), `frameSync.ts` (background/frame pushed to the editor, frame
 * widgets) and `uploadScheduler.ts` (upload timing, Ctrl+S, graph-sync
 * captures).
 *
 * - Widget value: `""` for an untouched document, else the manifest JSON
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
import { hasDocumentContent } from "../document/content";
import { parseDocument } from "../document/parse";
import { stringifyDocument } from "../document/serialize";
import type { IBaseWidget, LGraphNode, NodeExecutionOutput } from "../types/comfy";
import { EditorHost } from "../ui/editorHost";
import { chooseForEmpty } from "./attachDecision";
import { BackgroundLoader, SourceWatcher } from "./backgroundLoader";
import { INPUT_NAMES, LINK_INPUT, PANEL_MIN_CAP, WIDGET_MARGIN } from "./constants";
import { isolateEvents } from "./eventIsolation";
import type { EventIsolation } from "./eventIsolation";
import { FrameSync } from "./frameSync";
import { minimumFrame } from "../engine/drawingResolution";
import { handoffKey, offerHandoff, takeHandoff } from "./handoff";
import type { NodeHandoff } from "./handoff";
import { invalidDocumentMessage, skippedLayersMessage } from "./failures";
import { emitDocumentChange } from "./documentEvents";
import { EDIT_SYNC_DELAY_MS, requestGraphSync } from "./graphSync";
import { syncImageMask } from "./imageMaskSync";
import { inputSlotIndex, isInputConnected } from "./imageSource";
import { InputMaskWatch } from "./inputMaskSync";
import { LayerSourceWatch } from "./layerSourceWatch";
import { syncSizeWidgets } from "./sizeWidgets";
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
  /** `layer_source` history (per node instance, memory only). */
  private readonly sources: LayerSourceWatch;
  /** The `mask` input's Input Mask row. */
  private readonly inputMask: InputMaskWatch;
  private readonly saver = new WorkflowSaver();
  /** Our DOM widget (its `y` places the editor inside the node), once created. */
  private widget: IBaseWidget | null = null;
  private disposed = false;

  /**
   * @param node - The node this controller belongs to.
   */
  constructor(private readonly node: LGraphNode) {
    this.sources = new LayerSourceWatch(node);
    this.inputMask = new InputMaskWatch(node);
    this.host = new EditorHost({
      onBecameVisible: () => this.refresh(),
      isDetached: () => this.isOffViewedGraph(),
      onDisengage: () => this.session?.uploader.flushQuietly(),
      onSave: () => void this.saver.save(this.session),
    }, this.sources.history);
    this.isolation = isolateEvents({
      root: this.host.root,
      stage: this.host.stage,
      onWheel: (event) => this.host.input.handleWheel(event),
      onChromeWheel: (event) => this.host.handleChromeWheel(event),
      onMiddlePointer: (event) => this.host.input.handlePointer(event),
    });
    this.loader = new BackgroundLoader(node, () => this.updateContent());
    this.watcher = new SourceWatcher(() => this.refresh(), () => this.tick());
    // Size widgets followed a new image: let the draft see it (`graphSync.ts`).
    this.frame = new FrameSync(node, this.loader, () => requestGraphSync(node, EDIT_SYNC_DELAY_MS));
    controllers.set(node, this);
    this.attach(this.newEmptySession());
  }

  /** A session for a brand-new document (mask styled by the user's "Defaults" settings). */
  private newEmptySession(): EditorSession {
    return createSession(createEmptyDocument(minimumFrame(this.frame.fallbackFrame().size), undefined, readFirstMaskStyle()), "widgets");
  }

  // ── Widget value ────────────────────────────────────────────────────────

  /** @returns The manifest string (`""` = untouched). */
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
      if (parsed.skippedLayers) {
        notify("warn", skippedLayersMessage(parsed.skippedLayers), { key: "skipped-layers" });
      }
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
      hasPaint: this.session ? hasDocumentContent(this.session.editor.doc, this.session.editor.hasPaint) : false,
      handoff: handoff !== null,
    });
    if (choice === "adopt" && handoff) this.attach(handoff);
    else if (choice === "reset") this.attach(this.newEmptySession());
  }

  /**
   * Value for the prompt: uploads dirty layers first.
   * @returns Manifest string.
   * @throws If an upload failed (the toast has been shown); queueing stops so
   *   the output never silently differs from the editor.
   */
  async serialize(): Promise<string> {
    const session = this.session;
    if (!session) return this.valueCache;
    await flushForQueue(session);
    this.syncValue();
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
   * The DOM widget was created (`painterWidget.ts`): the side panel's
   * height cap needs its position inside the node.
   * @param widget - Our editor widget.
   */
  setWidget(widget: IBaseWidget): void {
    this.widget = widget;
    this.syncPanelCap();
  }

  /**
   * The node was selected / deselected on the canvas.
   * @param selected - Node selected.
   */
  handleSelected(selected: boolean): void {
    if (!this.disposed) this.host.setNodeSelected(selected);
  }

  /**
   * Our node executed; its `ui` output carries the input image preview.
   * @param output - Execution output.
   */
  handleExecuted(output: NodeExecutionOutput): void {
    this.loader.setExecuted(output);
    this.sources.setExecuted(output);
    this.inputMask.setExecuted(output);
    this.refresh();
  }

  /**
   * A link on our node changed.
   * @param type - Slot type (`LINK_INPUT` for inputs).
   * @param slot - Slot index.
   */
  handleConnectionsChange(type: number, slot: number): void {
    // During `configure` (before the deferred first refresh) upstream nodes
    // may not be configured yet; resolving now could load a bogus source.
    if (this.watcher.starting) {
      this.updateContent();
      return;
    }
    if (type === LINK_INPUT && slot === inputSlotIndex(this.node, INPUT_NAMES.layerSource)) this.sources.arm();
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
    this.syncValue();
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
    const untouched = !hasDocumentContent(editor.doc, editor.hasPaint);
    const previous = this.valueCache;
    if (!untouched) this.unreadableValue = null;
    this.valueCache = untouched ? (this.unreadableValue ?? "") : stringifyDocument(editor.doc);
    const changed = this.valueCache !== previous;
    if (changed) emitDocumentChange(this.node);
    return changed;
  }

  // ── Background + content ────────────────────────────────────────────────

  /**
   * Re-resolve the background source and reload only if it changed. While
   * `image` is disconnected no source is used and in-flight loads are dropped.
   */
  refresh(): void {
    if (this.disposed) return;
    this.loader.refresh(this.isImageConnected(), this.watcher.active && !this.watcher.starting);
    syncSizeWidgets(this.node);
    // Not before the deferred start: unconfigured upstream values would seed the history.
    if (this.watcher.active && !this.watcher.starting) this.sources.refresh();
    this.updateContent();
  }

  private tick(): void {
    // Safety net for missed select hooks (node re-created while selected).
    this.host.setNodeSelected(this.node.selected === true);
    if (!this.host.isVisible()) return;
    this.host.refreshScale();
    this.syncPanelCap();
    this.refresh();
  }

  /**
   * In-node side panel cap: the node's height below the editor top, at
   * least {@link PANEL_MIN_CAP} (graph units = editor CSS px). The host
   * ignores it while fullscreen (CSS caps the panel there).
   */
  private syncPanelCap(): void {
    const top = (this.widget?.y ?? 0) + WIDGET_MARGIN;
    this.host.setPanelHeightCap(Math.max(PANEL_MIN_CAP, this.node.size[1] - top));
  }

  /** Push background + frame (and the Image Mask / Input Mask source) to the editor when anything relevant changed. */
  private updateContent(): void {
    const session = this.session;
    if (this.disposed || !session) return;
    const connected = this.isImageConnected();
    this.frame.apply(session, connected);
    const settled = this.watcher.active && !this.watcher.starting;
    if (!this.inputMask.sync(session, this.loader.background?.size ?? null, settled)) syncImageMask(session, this.loader.status);
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
