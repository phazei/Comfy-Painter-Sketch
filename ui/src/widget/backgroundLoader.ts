/**
 * Background image source for one node: resolves which image the editor
 * should show behind the document and loads it.
 *
 * - {@link BackgroundLoader}: resolution (live upstream source first, else
 *   our own last executed preview, via `imageSource.ts`) and loading. Results
 *   of superseded loads are ignored; while `image` is disconnected in-flight
 *   loads are dropped. The last loaded image is kept (and handed off, see
 *   `handoff.ts`) but only shown while `image` is connected.
 * - {@link SourceWatcher}: what triggers re-resolution -- the `executed` API
 *   event, a fallback poll (upstream LoadImage selection and preview-store
 *   updates raise no event reachable with only app/api) and a deferred first
 *   refresh.
 *
 * Owned by `controller.ts`, which decides what to do with the result.
 */

import { api } from "@comfy/scripts/api.js";

import { log } from "../log";
import type { LGraphNode, NodeExecutionOutput } from "../types/comfy";
import { INPUT_NAMES, SOURCE_POLL_MS } from "./constants";
import type { LoadedBackground } from "./handoff";
import { findUpstreamNode, inputSlotIndex, sourceFromExecuted, sourceFromNode } from "./imageSource";
import type { ImageSource } from "./imageSource";

// ═══════════════════════════════════════════════════════════════════════════
// BackgroundLoader
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Resolves and loads the background image for one node.
 */
export class BackgroundLoader {
  /** Last loaded background image; shown only while `image` is connected. */
  private loaded: LoadedBackground | null = null;
  /** Key of the most recent source we started loading (success or not). */
  private requestedKey: string | null = null;
  /** A background load is in flight. */
  private loadPending = false;
  private loadSeq = 0;
  private executed: NodeExecutionOutput | null = null;
  private disposed = false;

  /**
   * @param node - The node whose `image` input is resolved.
   * @param onSettled - Called when a load finishes (success, empty or error).
   */
  constructor(
    private readonly node: LGraphNode,
    private readonly onSettled: () => void,
  ) {}

  /** @returns The last loaded background, if any. */
  get background(): LoadedBackground | null {
    return this.loaded;
  }

  /** @returns Our node's last executed output (input-image preview). */
  get lastExecuted(): NodeExecutionOutput | null {
    return this.executed;
  }

  /**
   * @returns `true` while this instance's first load has not settled (a load
   *   is in flight, or nothing was requested yet).
   */
  get awaitingImage(): boolean {
    return this.loadPending || this.requestedKey === null;
  }

  /**
   * Record our node's executed output (a source for {@link refresh}).
   * @param output - Execution output.
   */
  setExecuted(output: NodeExecutionOutput): void {
    this.executed = output;
  }

  /**
   * Take over a predecessor's state (graph undo/redo hand-off).
   * @param background - Its loaded background, if any.
   * @param lastExecuted - Its last executed output (kept only if we have none).
   */
  adopt(background: LoadedBackground | null, lastExecuted: NodeExecutionOutput | null): void {
    this.executed ??= lastExecuted;
    if (background) {
      this.loaded = background;
      this.requestedKey = background.key;
    }
  }

  /**
   * Re-resolve the source and reload only if it changed. While `image` is
   * disconnected no source is used and in-flight loads are dropped.
   * @param connected - Whether the `image` input has a link.
   */
  refresh(connected: boolean): void {
    if (connected) {
      const source = this.resolveSource();
      if (source && source.key !== this.requestedKey) this.load(source);
    } else if (this.requestedKey !== (this.loaded?.key ?? null)) {
      this.loadSeq++;
      this.loadPending = false;
      this.requestedKey = this.loaded?.key ?? null;
    }
  }

  /** Ignore all in-flight and future load results. */
  dispose(): void {
    this.disposed = true;
    this.loadSeq++;
  }

  /** Live upstream source first, else our own last executed preview. */
  private resolveSource(): ImageSource | null {
    const slot = inputSlotIndex(this.node, INPUT_NAMES.image);
    const upstream = slot >= 0 ? findUpstreamNode(this.node, slot) : null;
    return (upstream ? sourceFromNode(upstream) : null) ?? sourceFromExecuted(this.node, this.executed);
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
        this.onSettled();
        return;
      }
      this.loaded = {
        key: source.key,
        image,
        size: { width: image.naturalWidth, height: image.naturalHeight },
      };
      this.onSettled();
    };
    image.onerror = () => {
      if (seq !== this.loadSeq || this.disposed) return;
      this.loadPending = false;
      this.onSettled();
      log.warn(`Could not load background image from ${source.origin} node:`, source.url);
    };
    image.src = source.url;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// SourceWatcher
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Triggers background re-resolution: `executed` API events, a fallback poll
 * and one deferred initial refresh.
 */
export class SourceWatcher {
  private listening = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private startTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly handleApiExecuted = (): void => this.refresh();

  /**
   * @param refresh - Re-resolve the source (API event, deferred start).
   * @param tick - Poll callback (cheap; should skip while hidden).
   */
  constructor(
    private readonly refresh: () => void,
    private readonly tick: () => void,
  ) {}

  /** @returns `true` once {@link start} ran (until {@link stop}). */
  get active(): boolean {
    return this.listening;
  }

  /**
   * @returns `true` until the deferred first refresh ran (upstream nodes may
   *   not be configured yet).
   */
  get starting(): boolean {
    return this.startTimer !== null;
  }

  /** Start listening, polling, and schedule the deferred first refresh. */
  start(): void {
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

  /** Remove the listener and timers. Idempotent. */
  stop(): void {
    if (this.listening) api.removeEventListener("executed", this.handleApiExecuted);
    this.listening = false;
    if (this.pollTimer !== null) clearInterval(this.pollTimer);
    if (this.startTimer !== null) clearTimeout(this.startTimer);
    this.pollTimer = null;
    this.startTimer = null;
  }
}
