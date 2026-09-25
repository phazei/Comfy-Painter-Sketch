/**
 * Per-node controller: connects one PainterSketch node instance to an editor
 * session and its DOM host.
 *
 * - Widget value: `""` for a never-painted document, else the manifest JSON
 *   of the attached session (file refs = last successful uploads). Updated on
 *   every document change so tab switches / workflow saves capture it.
 * - Sessions outlive node instances (see `sessions.ts`); `setValue` with a
 *   manifest re-attaches the session for its `docId`, forks it if another
 *   live node already owns it (node copy/paste), or restores from files.
 * - Background: resolved via `imageSource.ts` (M0) and fed to the editor,
 *   which adopts the size for an empty document and otherwise just draws the
 *   document through the doc -> image map (never resampling, decision 4).
 *
 * Controllers live in a module-level `WeakMap` keyed by node, not on the node.
 */

import { api } from "@comfy/scripts/api.js";

import { createEmptyDocument, createId } from "../document/create";
import { parseDocument } from "../document/parse";
import { stringifyDocument } from "../document/serialize";
import type { PainterDocument } from "../document/types";
import type { Size } from "../geometry/rect";
import { log } from "../log";
import type { IBaseWidget, LGraphNode, NodeExecutionOutput } from "../types/comfy";
import { EditorHost } from "../ui/editorHost";
import { INPUT_NAMES, SOURCE_POLL_MS } from "./constants";
import { isolateEvents } from "./eventIsolation";
import type { EventIsolation } from "./eventIsolation";
import { resolveFallbackFrame } from "./frameFallback";
import type { FallbackFrame } from "./frameFallback";
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

/** A successfully loaded background image. */
interface LoadedBackground {
  key: string;
  image: HTMLImageElement;
  size: Size;
}

// ═══════════════════════════════════════════════════════════════════════════
// PainterSketchController
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Wires one node instance to one editor session.
 */
export class PainterSketchController {
  /** Editor DOM shell; its `root` is the DOM widget element. */
  readonly host: EditorHost;

  private session: EditorSession | null = null;
  private sessionUnbind: (() => void) | null = null;
  private valueCache = "";
  private lastExecuted: NodeExecutionOutput | null = null;
  /** Last loaded background image; shown only while `image` is connected. */
  private background: LoadedBackground | null = null;
  /** Key of the most recent source we started loading (success or not). */
  private requestedKey: string | null = null;
  private loadSeq = 0;
  private contentKey = "";
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private startTimer: ReturnType<typeof setTimeout> | null = null;
  private listening = false;
  private readonly isolation: EventIsolation;
  private disposed = false;

  private readonly handleApiExecuted = (): void => this.refresh();

  /**
   * @param node - The node this controller belongs to.
   */
  constructor(private readonly node: LGraphNode) {
    this.host = new EditorHost({ onBecameVisible: () => this.refresh() });
    this.isolation = isolateEvents({
      root: this.host.root,
      stage: this.host.stage,
      onWheel: (event) => this.host.input.handleWheel(event),
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
    if (typeof value === "string" && value === this.valueCache) return;
    const parsed = parseDocument(value);
    if (parsed.status === "ok") {
      this.attach(this.sessionFor(parsed.document));
      return;
    }
    if (parsed.status === "invalid") {
      notify("warn", `Could not read the saved painting (${parsed.reason}); starting with an empty canvas.`);
    }
    if (parsed.status === "invalid" || this.session?.editor.hasPaint) {
      this.attach(createSession(createEmptyDocument(this.fallbackFrame().size), "widgets"));
    }
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
    return this.valueCache;
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

  /** Node added to a graph: start listening (after `configure` finishes). */
  handleAdded(): void {
    if (this.disposed || this.listening) return;
    this.listening = true;
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

  /** A link on our node changed. */
  handleConnectionsChange(): void {
    this.refresh();
  }

  /** Release node-bound resources; the session is only detached. Idempotent. */
  dispose(): void {
    if (this.disposed) return;
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
  }

  // ── Sessions ────────────────────────────────────────────────────────────

  /** Pick/create the session for a parsed manifest. */
  private sessionFor(doc: PainterDocument): EditorSession {
    const existing = findSession(doc.docId);
    if (!existing) return createSession(doc, "document");
    const ownedElsewhere = existing.owner !== null && existing.owner !== this;
    const matches = sessionMatches(existing, doc);
    if (ownedElsewhere) {
      // Duplicate docId while the original is live (copy/paste): fork.
      const docId = createId();
      return matches
        ? createSession({ ...doc, docId }, "document", existing.editor.fork(docId))
        : createSession({ ...doc, docId }, "document");
    }
    return matches ? existing : createSession(doc, "document");
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
    else detachSession(session, this);
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
      this.requestedKey = this.background?.key ?? null;
    }
    this.updateContent();
  }

  private tick(): void {
    if (!this.host.isVisible()) return;
    this.host.refreshScale();
    this.refresh();
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
    const seq = ++this.loadSeq;
    const image = new Image();
    image.decoding = "async";
    image.onload = () => {
      if (seq !== this.loadSeq || this.disposed) return;
      if (!image.naturalWidth || !image.naturalHeight) return;
      this.background = {
        key: source.key,
        image,
        size: { width: image.naturalWidth, height: image.naturalHeight },
      };
      this.updateContent();
    };
    image.onerror = () => {
      if (seq !== this.loadSeq || this.disposed) return;
      log.warn(`Could not load background image from ${source.origin} node:`, source.url);
    };
    image.src = source.url;
  }

  // ── Content ─────────────────────────────────────────────────────────────

  /**
   * Push background + frame decisions to the editor when anything relevant
   * changed. Connected: the loaded image (an empty editor adopts a new size;
   * otherwise it is only a display mapping). Disconnected: the `background` colour over the document's
   * frame; `width`/`height` only resize a fresh, empty, widget-sized document.
   */
  private updateContent(): void {
    const session = this.session;
    if (this.disposed || !session) return;
    const { editor } = session;
    const bg = this.isImageConnected() ? this.background : null;
    if (bg) {
      const key = `${session.docId}|image|${bg.key}`;
      if (key === this.contentKey) return;
      this.contentKey = key;
      editor.setBackground({ kind: "image", image: bg.image }, bg.size);
      editor.handleBackgroundSize(bg.size);
      return;
    }
    const frame = this.fallbackFrame();
    const key = `${session.docId}|fill|${frame.color}|${frame.size.width}x${frame.size.height}`;
    if (key === this.contentKey) return;
    this.contentKey = key;
    editor.setBackground({ kind: "fill", color: frame.color }, null);
    editor.handleWidgetFrame(frame.size);
  }

  /**
   * Frame used while disconnected: the document's frame once it has paint or
   * its size came from an image/manifest (SPEC Behavior Notes), else the
   * `width`/`height` widgets.
   */
  private fallbackFrame(): FallbackFrame {
    const editor = this.session?.editor;
    const known = editor && (editor.hasPaint || editor.frameSource !== "widgets") ? editor.doc.frame : null;
    return resolveFallbackFrame(
      known,
      this.findWidget(INPUT_NAMES.width)?.value,
      this.findWidget(INPUT_NAMES.height)?.value,
      this.findWidget(INPUT_NAMES.background)?.value,
    );
  }

  private findWidget(name: string): IBaseWidget | undefined {
    return this.node.widgets?.find((widget) => widget.name === name);
  }
}
