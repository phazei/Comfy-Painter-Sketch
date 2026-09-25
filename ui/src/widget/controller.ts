/**
 * Per-node controller: connects one PainterSketch node to its editor host.
 *
 * Owns the `document` widget value (a string in M0), the background image
 * (resolved via `imageSource.ts`, loaded with stale-load protection), and
 * every listener/timer/observer tied to the node, all released in
 * {@link PainterSketchController.dispose}.
 *
 * Controllers live in a module-level `WeakMap` keyed by node, not on the node
 * object (AGENTS.md: no new `node.*` instance state).
 */

import { api } from "@comfy/scripts/api.js";

import type { FrameContent } from "../engine/backgroundRenderer";
import type { Size } from "../engine/viewport";
import { log } from "../log";
import type { IBaseWidget, LGraphNode, NodeExecutionOutput } from "../types/comfy";
import { EditorHost } from "../ui/editorHost";
import { INPUT_NAMES, SOURCE_POLL_MS } from "./constants";
import { normalizeDocumentValue } from "./documentValue";
import { isolateEvents } from "./eventIsolation";
import type { EventIsolation } from "./eventIsolation";
import { resolveFallbackFrame } from "./frameFallback";
import { findUpstreamNode, inputSlotIndex, isInputConnected, sourceFromExecuted, sourceFromNode } from "./imageSource";
import type { ImageSource } from "./imageSource";

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

// ── Types ─────────────────────────────────────────────────────────────────────

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
 * Wires one node to one editor.
 */
export class PainterSketchController {
  /** Editor DOM shell; its `root` is the DOM widget element. */
  readonly host: EditorHost;

  private documentValue = "";
  private lastExecuted: NodeExecutionOutput | null = null;
  /**
   * Last loaded background image. Shown only while `image` is connected;
   * kept while disconnected so reconnecting the same source needs no reload.
   */
  private background: LoadedBackground | null = null;
  /**
   * Last known frame size, used (filled with `background`) while `image` is
   * disconnected. Set from each loaded background image; M1 seeds it from the
   * document manifest's `frame` via {@link setKnownFrame}.
   */
  private knownFrame: Size | null = null;
  /** Key of the most recent source we started loading (success or not). */
  private requestedKey: string | null = null;
  private loadSeq = 0;
  private contentKey = "";
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private listening = false;
  private readonly isolation: EventIsolation;
  private disposed = false;

  private readonly handleApiExecuted = (): void => this.refresh();

  /**
   * @param node - The node this controller belongs to.
   */
  constructor(private readonly node: LGraphNode) {
    this.host = new EditorHost({ onBecameVisible: () => this.refresh() });
    this.isolation = isolateEvents({ root: this.host.root, wheelTarget: this.host.stage });
    controllers.set(node, this);
  }

  // ── Widget value ────────────────────────────────────────────────────────

  /** @returns The stored document string (`""` = no document yet). */
  getValue(): string {
    return this.documentValue;
  }

  /**
   * Store a new document value (from workflow load, undo, paste, ...).
   *
   * @param value - Incoming value; coerced to a string.
   */
  setValue(value: unknown): void {
    this.documentValue = normalizeDocumentValue(value);
  }

  /**
   * Set the frame size used when no image is connected (M1: from the
   * document manifest's `frame`, matching what Python outputs).
   *
   * @param frame - Frame size, or `null` to forget it.
   */
  setKnownFrame(frame: Size | null): void {
    this.knownFrame = frame ? { width: frame.width, height: frame.height } : null;
    this.updateContent();
  }

  // ── Lifecycle (called from node hooks) ──────────────────────────────────

  /**
   * Node constructor finished: widgets exist but the node is not in a graph
   * yet. Chain our own widgets' callbacks so fallback-frame edits redraw
   * immediately (the poll catches programmatic changes).
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

  /** Node was added to a graph: start listening for background changes. */
  handleAdded(): void {
    if (this.disposed || this.listening) return;
    this.listening = true;
    api.addEventListener("executed", this.handleApiExecuted);
    // Fallback poll: upstream LoadImage selection and preview-store updates
    // raise no event we can subscribe to with only app/api. Each tick is a
    // few property reads + a string compare, and is skipped while hidden.
    this.pollTimer = setInterval(() => this.tick(), SOURCE_POLL_MS);
    this.refresh();
  }

  /**
   * Our node executed; its `ui` output carries the input image preview.
   *
   * @param output - Execution output (`output.images`).
   */
  handleExecuted(output: NodeExecutionOutput): void {
    this.lastExecuted = output;
    this.refresh();
  }

  /** A link on our node changed. */
  handleConnectionsChange(): void {
    this.refresh();
  }

  /** Release everything. Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.loadSeq++;
    if (this.listening) api.removeEventListener("executed", this.handleApiExecuted);
    this.listening = false;
    if (this.pollTimer !== null) clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.isolation.dispose();
    this.host.dispose();
    controllers.delete(this.node);
  }

  // ── Background resolution ───────────────────────────────────────────────

  /**
   * Re-resolve the background source and reload only if it changed. While
   * `image` is disconnected no source is used (not even our last executed
   * preview, which would no longer match the node's output) and any
   * in-flight load is abandoned.
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

  private isImageConnected(): boolean {
    return isInputConnected(this.node, INPUT_NAMES.image);
  }

  private tick(): void {
    if (!this.host.isVisible()) return;
    this.host.refreshScale();
    this.refresh();
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
      const size = { width: image.naturalWidth, height: image.naturalHeight };
      this.background = { key: source.key, image, size };
      this.knownFrame = size;
      this.updateContent();
    };
    image.onerror = () => {
      if (seq !== this.loadSeq || this.disposed) return;
      log.warn(`Could not load background image from ${source.origin} node:`, source.url);
    };
    image.src = source.url;
  }

  // ── Content ─────────────────────────────────────────────────────────────

  /** Push the current frame content to the host if it changed. */
  private updateContent(): void {
    if (this.disposed) return;
    const content = this.currentContent();
    const key =
      content.kind === "image"
        ? `image:${this.background?.key ?? ""}`
        : `fill:${content.size.width}x${content.size.height}:${content.color}`;
    if (key === this.contentKey) return;
    this.contentKey = key;
    this.host.setContent(content);
  }

  /**
   * Connected: the last loaded image. Disconnected (or nothing loaded yet):
   * the last known frame size -- else the width/height widgets -- filled
   * with the `background` colour, matching the Python output.
   */
  private currentContent(): FrameContent {
    if (this.background && this.isImageConnected()) {
      return { kind: "image", image: this.background.image, size: this.background.size };
    }
    const frame = resolveFallbackFrame(
      this.knownFrame,
      this.findWidget(INPUT_NAMES.width)?.value,
      this.findWidget(INPUT_NAMES.height)?.value,
      this.findWidget(INPUT_NAMES.background)?.value,
    );
    return { kind: "fill", color: frame.color, size: frame.size };
  }

  private findWidget(name: string): IBaseWidget | undefined {
    return this.node.widgets?.find((widget) => widget.name === name);
  }
}
