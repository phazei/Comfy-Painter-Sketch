/**
 * Per-node controller: connects one PainterSketch node instance to an editor
 * session and its DOM host.
 *
 * - Widget value: `""` for a never-painted document, else the manifest JSON
 *   of the attached session (file refs = last successful uploads). Updated on
 *   every document change so tab switches / workflow saves capture it.
 * - Uploads (saved-file contract, Upload timing): dirty layers upload when
 *   the editor disengages or leaves fullscreen, when the session detaches,
 *   ~5 s after the last edit (idle fallback), at queue (`serialize`), and on
 *   Ctrl/Cmd+S (flush, then ComfyUI's `Comfy.SaveWorkflow`).
 * - Sessions outlive node instances (see `sessions.ts`); `setValue` with a
 *   manifest re-attaches the session for its `docId`, forks it if another
 *   live node already owns it (node copy/paste), or restores from files
 *   (rules in `attachDecision.ts`). A node re-created in the same task (graph
 *   undo/redo) takes over its predecessor's element slot, session and
 *   background (`handoff.ts`), so nothing blanks or reloads.
 * - Background: resolved via `imageSource.ts` (M0) and fed to the editor,
 *   which adopts the size for an empty document and otherwise just draws the
 *   document through the doc -> image map (never resampling, decision 4).
 *
 * Controllers live in a module-level `WeakMap` keyed by node, not on the node.
 */

import { api } from "@comfy/scripts/api.js";
import { app } from "@comfy/scripts/app.js";

import { createEmptyDocument, createId } from "../document/create";
import { parseDocument } from "../document/parse";
import { stringifyDocument } from "../document/serialize";
import type { PainterDocument } from "../document/types";
import type { Size } from "../geometry/rect";
import { log } from "../log";
import { HIDDEN_MASK_NOTE } from "../engine/editor";
import type { IBaseWidget, LGraphNode, NodeExecutionOutput } from "../types/comfy";
import { EditorHost } from "../ui/editorHost";
import { chooseForEmpty, chooseForManifest } from "./attachDecision";
import { executeCommand, SAVE_WORKFLOW_COMMAND } from "./comfyApi";
import { INPUT_NAMES, LINK_INPUT, SOURCE_POLL_MS } from "./constants";
import { isolateEvents } from "./eventIsolation";
import type { EventIsolation } from "./eventIsolation";
import { resolveFallbackFrame, widgetDimension } from "./frameFallback";
import type { FallbackFrame } from "./frameFallback";
import { handoffKey, offerHandoff, takeHandoff } from "./handoff";
import type { LoadedBackground, NodeHandoff } from "./handoff";
import { findUpstreamNode, inputSlotIndex, isInputConnected, sourceFromExecuted, sourceFromNode } from "./imageSource";
import type { ImageSource } from "./imageSource";
import {
  attachSession,
  createSession,
  detachSession,
  findSession,
  releaseSession,
  sessionMatches,
} from "./sessions";
import type { EditorSession } from "./sessions";
import { notify } from "./toast";

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
  private lastExecuted: NodeExecutionOutput | null = null;
  /** Last loaded background image; shown only while `image` is connected. */
  private background: LoadedBackground | null = null;
  /** Key of the most recent source we started loading (success or not). */
  private requestedKey: string | null = null;
  /** A background load is in flight. */
  private loadPending = false;
  private loadSeq = 0;
  /**
   * Session handed off by this node's previous instance, until the widget
   * value has been applied (same task; see `handoff.ts`).
   */
  private handoff: EditorSession | null = null;
  private contentKey = "";
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private startTimer: ReturnType<typeof setTimeout> | null = null;
  private listening = false;
  private readonly isolation: EventIsolation;
  /** A Ctrl+S flush + save is in progress. */
  private saving = false;
  private disposed = false;

  private readonly handleApiExecuted = (): void => this.refresh();

  /**
   * @param node - The node this controller belongs to.
   */
  constructor(private readonly node: LGraphNode) {
    this.host = new EditorHost({
      onBecameVisible: () => this.refresh(),
      isDetached: () => this.isOffViewedGraph(),
      onDisengage: () => this.session?.uploader.flushQuietly(),
      onSave: () => void this.saveWorkflow(),
    });
    this.isolation = isolateEvents({
      root: this.host.root,
      stage: this.host.stage,
      onWheel: (event) => this.host.input.handleWheel(event),
      onChromeWheel: (event) => this.host.handleChromeWheel(event),
      onMiddlePointer: (event) => this.host.input.handlePointer(event),
    });
    controllers.set(node, this);
    this.attach(createSession(createEmptyDocument(this.fallbackFrame().size), "widgets"));
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
      this.attach(this.sessionFor(parsed.document));
      this.handoff = null;
      return;
    }
    if (parsed.status === "invalid") {
      notify("warn", `Could not read the saved painting (${parsed.reason}); starting with an empty canvas.`);
    }
    const handoff = this.handoff?.alive && this.handoff.owner === null ? this.handoff : null;
    this.handoff = null;
    const choice = chooseForEmpty(parsed.status, {
      hasPaint: this.session?.editor.hasPaint ?? false,
      handoff: handoff !== null,
    });
    if (choice === "adopt" && handoff) this.attach(handoff);
    else if (choice === "reset") this.attach(createSession(createEmptyDocument(this.fallbackFrame().size), "widgets"));
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
    await session.ready;
    await session.uploader.flush();
    if (session.editor.hiddenMaskHasContent()) {
      session.editor.events.emit("note", HIDDEN_MASK_NOTE);
    }
    return this.valueCache;
  }

  /**
   * Ctrl/Cmd+S in the editor: upload dirty layers, then run ComfyUI's save
   * command so the saved workflow references the new files (the widget value
   * is updated by the upload's `change` event before the save serializes).
   * If an upload failed (already toasted), ask before saving the workflow
   * without the latest paint; the pixels stay in memory either way.
   */
  private async saveWorkflow(): Promise<void> {
    if (this.saving) return;
    this.saving = true;
    try {
      const session = this.session;
      if (session) {
        try {
          await session.ready;
          await session.uploader.flush();
        } catch {
          if (!window.confirm("Upload failed; save anyway without the latest paint?")) return;
        }
      }
      await executeCommand(SAVE_WORKFLOW_COMMAND);
    } catch (error) {
      notify("error", `Could not save the workflow: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.saving = false;
    }
  }

  // ── Lifecycle (called from node hooks) ──────────────────────────────────

  /**
   * Node constructor finished: chain our own widgets' callbacks so fallback
   * frame edits apply immediately (the poll catches programmatic changes).
   */
  handleNodeCreated(): void {
    for (const name of [INPUT_NAMES.width, INPUT_NAMES.height, INPUT_NAMES.background]) {
      const widget = this.findWidget(name);
      if (!widget) continue;
      const original = widget.callback;
      widget.callback = (...args: unknown[]) => {
        const [value, ...rest] = args;
        original?.call(widget, value, ...rest);
        this.updateContent();
      };
    }
    this.updateContent();
  }

  /**
   * Node added to a graph (before `configure` applies saved values): claim a
   * hand-off from a predecessor re-created in this task, then start listening.
   */
  handleAdded(): void {
    if (this.disposed || this.listening) return;
    this.listening = true;
    const key = handoffKey(this.node);
    const handoff = key ? takeHandoff(key) : undefined;
    if (handoff) this.adoptHandoff(handoff);
    api.addEventListener("executed", this.handleApiExecuted);
    // Fallback poll: upstream LoadImage selection and preview-store updates
    // raise no event reachable with only app/api. Each tick is a few property
    // reads + a string compare, skipped while hidden.
    this.pollTimer = setInterval(() => this.tick(), SOURCE_POLL_MS);
    // Deferred so upstream widgets are configured before the first lookup
    // (otherwise a default LoadImage value could trigger a bogus resize).
    this.startTimer = setTimeout(() => {
      this.startTimer = null;
      this.refresh();
    }, 0);
  }

  /**
   * Our node executed; its `ui` output carries the input image preview.
   * @param output - Execution output.
   */
  handleExecuted(output: NodeExecutionOutput): void {
    this.lastExecuted = output;
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
    if (this.startTimer !== null) {
      this.updateContent();
      return;
    }
    const imageSlot = inputSlotIndex(this.node, INPUT_NAMES.image);
    if (type === LINK_INPUT && slot === imageSlot && !isConnected && this.session && this.node.graph) {
      this.handleImageDisconnected(this.session.editor.imageSize);
    }
    this.refresh();
  }

  /**
   * `image` lost its link (a user edit, not a load): the widgets take over the
   * last image size so the canvas keeps its size and the node shows it.
   * Deferred a microtask so a link replaced by another (disconnect, then
   * connect in one call) leaves the widgets alone.
   * @param size - Image size shown when the link was removed.
   */
  private handleImageDisconnected(size: Size): void {
    queueMicrotask(() => {
      if (this.disposed || this.isImageConnected()) return;
      const width = this.setWidgetValue(INPUT_NAMES.width, widgetDimension(size.width));
      const height = this.setWidgetValue(INPUT_NAMES.height, widgetDimension(size.height));
      if (!width && !height) return;
      this.node.graph?.incrementVersion?.();
      app.canvas?.setDirty?.(true, true);
    });
  }

  /**
   * Set a widget's value like a user edit: the value setter (backed by the
   * widget value store, so both renderers update) plus its callback (ours
   * re-applies the frame; see `handleNodeCreated`).
   * @returns `true` if the value changed.
   */
  private setWidgetValue(name: string, value: number): boolean {
    const widget = this.findWidget(name);
    if (!widget || widget.value === value) return false;
    widget.value = value;
    widget.callback?.(widget.value);
    return true;
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
    this.loadSeq++;
    if (this.listening) api.removeEventListener("executed", this.handleApiExecuted);
    this.listening = false;
    if (this.pollTimer !== null) clearInterval(this.pollTimer);
    if (this.startTimer !== null) clearTimeout(this.startTimer);
    this.pollTimer = null;
    this.startTimer = null;
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
      background: this.background,
      lastExecuted: this.lastExecuted,
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
    this.lastExecuted ??= handoff.lastExecuted;
    if (handoff.background) {
      this.background = handoff.background;
      this.requestedKey = handoff.background.key;
    }
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

  /** Pick/create the session for a parsed manifest. */
  private sessionFor(doc: PainterDocument): EditorSession {
    const existing = findSession(doc.docId);
    if (!existing) return createSession(doc, "document");
    const choice = chooseForManifest({
      owner: existing.owner === null ? "none" : existing.owner === this ? "self" : "other",
      matchesRecent: sessionMatches(existing, doc),
      handedOff: existing === this.handoff,
    });
    switch (choice) {
      case "reuse":
        return existing;
      case "restore":
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

  private attach(session: EditorSession): void {
    if (session === this.session) {
      this.syncValue();
      return;
    }
    this.detach();
    this.session = session;
    attachSession(session, this);
    const { editor } = session;
    const offChange = editor.events.on("change", () => {
      this.syncValue();
      if (editor.dirty) session.uploader.schedule();
    });
    this.sessionUnbind = offChange;
    this.host.setSession(session);
    this.contentKey = "";
    this.syncValue();
    this.updateContent();
    if (editor.dirty) session.uploader.schedule();
  }

  private detach(): void {
    const session = this.session;
    if (!session) return;
    this.sessionUnbind?.();
    this.sessionUnbind = null;
    this.session = null;
    this.host.setSession(null);
    if (!session.editor.hasPaint && !session.editor.dirty) releaseSession(session.docId);
    else {
      // Node removed / tab switched: the editor is no longer in use.
      session.uploader.flushQuietly();
      detachSession(session, this);
    }
  }

  private syncValue(): void {
    const editor = this.session?.editor;
    if (!editor) return;
    const untouched = !editor.hasPaint && editor.doc.layers.every((l) => l.file === null);
    this.valueCache = untouched ? "" : stringifyDocument(editor.doc);
  }

  // ── Background resolution ───────────────────────────────────────────────

  /**
   * Re-resolve the background source and reload only if it changed. While
   * `image` is disconnected no source is used and in-flight loads are dropped.
   */
  refresh(): void {
    if (this.disposed) return;
    if (this.isImageConnected()) {
      const source = this.resolveSource();
      if (source && source.key !== this.requestedKey) this.load(source);
    } else if (this.requestedKey !== (this.background?.key ?? null)) {
      this.loadSeq++;
      this.loadPending = false;
      this.requestedKey = this.background?.key ?? null;
    }
    this.updateContent();
  }

  private tick(): void {
    if (!this.host.isVisible()) return;
    this.host.refreshScale();
    this.refresh();
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

  /** Live upstream source first, else our own last executed preview. */
  private resolveSource(): ImageSource | null {
    const slot = inputSlotIndex(this.node, INPUT_NAMES.image);
    const upstream = slot >= 0 ? findUpstreamNode(this.node, slot) : null;
    return (upstream ? sourceFromNode(upstream) : null) ?? sourceFromExecuted(this.node, this.lastExecuted);
  }

  /** Load `source`; results of superseded loads are ignored. */
  private load(source: ImageSource): void {
    this.requestedKey = source.key;
    this.loadPending = true;
    const seq = ++this.loadSeq;
    const image = new Image();
    image.decoding = "async";
    image.onload = () => {
      if (seq !== this.loadSeq || this.disposed) return;
      this.loadPending = false;
      if (!image.naturalWidth || !image.naturalHeight) {
        this.updateContent();
        return;
      }
      this.background = {
        key: source.key,
        image,
        size: { width: image.naturalWidth, height: image.naturalHeight },
      };
      this.updateContent();
    };
    image.onerror = () => {
      if (seq !== this.loadSeq || this.disposed) return;
      this.loadPending = false;
      this.updateContent();
      log.warn(`Could not load background image from ${source.origin} node:`, source.url);
    };
    image.src = source.url;
  }

  // ── Content ─────────────────────────────────────────────────────────────

  /**
   * Push background + frame decisions to the editor when anything relevant
   * changed. The current image is the loaded upstream image while connected,
   * else `width` x `height` filled with `background`; either way an empty
   * editor adopts its size and a painted one only maps onto it.
   */
  private updateContent(): void {
    const session = this.session;
    if (this.disposed || !session) return;
    const { editor } = session;
    const connected = this.isImageConnected();
    const bg = connected ? this.background : null;
    if (bg) {
      const key = `${session.docId}|image|${bg.key}`;
      if (key === this.contentKey) return;
      this.contentKey = key;
      editor.setBackground({ kind: "image", image: bg.image }, bg.size);
      editor.handleBackgroundSize(bg.size);
      return;
    }
    // A re-attached session (tab switch) still has its image: keep it until
    // this instance's first load settles instead of flashing the fill colour.
    const awaitingImage = connected && (this.loadPending || this.requestedKey === null);
    if (awaitingImage && editor.background.kind === "image") return;
    const frame = this.fallbackFrame();
    const key = `${session.docId}|fill|${frame.color}|${frame.size.width}x${frame.size.height}`;
    if (key === this.contentKey) return;
    this.contentKey = key;
    editor.setBackground({ kind: "fill", color: frame.color }, frame.size);
    editor.handleBackgroundSize(frame.size);
  }

  /**
   * The current image while disconnected: `width` x `height` filled with
   * `background`. Like any upstream image, an empty document adopts it and a
   * painted one is shown through the frame map (decision 4).
   */
  private fallbackFrame(): FallbackFrame {
    return resolveFallbackFrame(
      this.findWidget(INPUT_NAMES.width)?.value,
      this.findWidget(INPUT_NAMES.height)?.value,
      this.findWidget(INPUT_NAMES.background)?.value,
    );
  }

  private findWidget(name: string): IBaseWidget | undefined {
    return this.node.widgets?.find((widget) => widget.name === name);
  }
}
