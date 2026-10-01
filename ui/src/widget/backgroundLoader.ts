/**
 * Background image source for one node: resolves which image the editor
 * should show behind the document and loads it.
 *
 * - {@link BackgroundLoader}: resolution (live upstream source first, else
 *   our own last executed preview from a run with the same link; rules in
 *   `backgroundRule.ts`, lookups in `imageSource.ts`) and loading. Results
 *   of superseded loads are ignored; without a source in-flight loads are
 *   dropped. The last loaded image is cached but only shown while it is the
 *   current source (never for another upstream); the shown one is handed
 *   off (`handoff.ts`).
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
import {
  backgroundStatus,
  chooseBackgroundSource,
  executedLinkOf,
  executedMatchesLink,
  forgetExecutedLink,
  recordExecutedLink,
  shownBackground,
} from "./backgroundRule";
import type { BackgroundStatus, CurrentSource } from "./backgroundRule";
import type { LoadedBackground } from "./handoff";
import { findUpstreamOutput, inputSlotIndex, sourceFromExecuted, sourceFromNode } from "./imageSource";
import type { ImageSource, UpstreamOutput } from "./imageSource";
import { firstOutputImage, viewQuery, withAlphaChannel, withRgbChannel } from "./viewUrl";

// ═══════════════════════════════════════════════════════════════════════════
// BackgroundLoader
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Resolves and loads the background image for one node.
 */
export class BackgroundLoader {
  /**
   * Last loaded background image (a cache: reconnecting the same source
   * shows it without reloading); shown only while it is the current source.
   */
  private loaded: LoadedBackground | null = null;
  /** Source of the latest lookup (`null`: disconnected / no image). */
  private current: CurrentSource | null = null;
  /** A lookup ran after startup (or a hand-off provided the current source). */
  private resolved = false;
  /** Key of the most recent source we started loading (success or not). */
  private requestedKey: string | null = null;
  /** A background load is in flight. */
  private loadPending = false;
  private loadSeq = 0;
  private executed: NodeExecutionOutput | null = null;
  /** The background handed off by the previous instance ({@link isHandedOff}). */
  private handedOff: LoadedBackground | null = null;
  private disposed = false;

  /**
   * @param node - The node whose `image` input is resolved.
   * @param onSettled - Called when a load finishes (success, empty or error).
   */
  constructor(
    private readonly node: LGraphNode,
    private readonly onSettled: () => void,
  ) {}

  /** @returns The background to show: the loaded image of the current source, else `null`. */
  get background(): LoadedBackground | null {
    return shownBackground(this.status);
  }

  /** @returns What the background is doing (`backgroundRule.ts`; drives the Image Mask row). */
  get status(): BackgroundStatus {
    return backgroundStatus({
      resolved: this.resolved,
      current: this.current,
      loaded: this.loaded,
      pendingKey: this.loadPending ? this.requestedKey : null,
    });
  }

  /** @returns Our node's last executed output (input-image preview). */
  get lastExecuted(): NodeExecutionOutput | null {
    return this.executed;
  }

  /**
   * @returns `true` while an image is on its way: a load is in flight, or
   *   nothing was looked up yet.
   */
  get awaitingImage(): boolean {
    return this.loadPending || !this.resolved;
  }

  /**
   * Record our node's executed output (a source for {@link refresh}) and the
   * `image` link it was produced with.
   * @param output - Execution output.
   */
  setExecuted(output: NodeExecutionOutput): void {
    this.executed = output;
    const item = firstOutputImage(output);
    const link = this.upstream()?.link;
    if (item && link) recordExecutedLink(viewQuery(item), link);
  }

  /**
   * Take over a predecessor's state (graph undo/redo hand-off).
   * @param background - Its shown background, if any.
   * @param lastExecuted - Its last executed output (kept only if we have none).
   */
  adopt(background: LoadedBackground | null, lastExecuted: NodeExecutionOutput | null): void {
    this.executed ??= lastExecuted;
    this.handedOff = background;
    if (background) {
      this.loaded = background;
      this.requestedKey = background.key;
      this.current = { key: background.key, origin: background.origin };
      this.resolved = true;
    }
  }

  /**
   * Whether `background` is the one handed off by this node's previous
   * instance (graph undo/redo re-creation). Stays `true` for it until the
   * image source is lost after startup (a later reconnect is a new push).
   * @param background - Background being pushed to the editor.
   * @returns `true` for the handed-off background.
   */
  isHandedOff(background: LoadedBackground): boolean {
    return this.handedOff === background;
  }

  /**
   * Re-resolve the source and reload only if it changed. Without a source
   * (disconnected, or an upstream with no image) in-flight loads are dropped
   * and nothing is shown.
   * @param connected - Whether the `image` input has a link.
   * @param settled - Startup is over (upstream nodes are configured), so a
   *   missing source means "no image" rather than "not known yet".
   */
  refresh(connected: boolean, settled = true): void {
    const source = connected ? this.resolveSource() : null;
    this.resolved ||= settled;
    this.current = source ? { key: source.key, origin: source.origin } : null;
    if (!source && settled) this.handedOff = null;
    if (source) {
      if (source.key !== this.requestedKey) this.load(source);
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

  /** What feeds `image`, if linked. */
  private upstream(): UpstreamOutput | null {
    const slot = inputSlotIndex(this.node, INPUT_NAMES.image);
    return slot >= 0 ? findUpstreamOutput(this.node, slot) : null;
  }

  /**
   * The upstream's own image, else our executed preview from a run with this
   * same link; an executed preview of another link is dropped.
   */
  private resolveSource(): ImageSource | null {
    const upstream = this.upstream();
    const link = upstream?.link ?? null;
    let executed = sourceFromExecuted(this.node, this.executed);
    const executedLink = executed ? executedLinkOf(executed.key) : undefined;
    if (executed && link !== null && !executedMatchesLink(executedLink, link)) {
      forgetExecutedLink(executed.key);
      this.executed = null;
      executed = null;
    }
    return chooseBackgroundSource({
      upstream: upstream?.node ? sourceFromNode(upstream.node) : null,
      executed,
      executedLink,
      link,
    });
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
        origin: source.origin,
        // Only an upstream file has alpha worth reading (our executed preview is RGB).
        alphaUrl: source.origin === "upstream" ? withAlphaChannel(source.url) : null,
      };
      this.onSettled();
    };
    // Background only (not layer sources): match LoadImage's RGB output, keyed
    // by `source.key`, so the extra param never triggers a reload.
    const url = withRgbChannel(source.url);
    image.onerror = () => {
      if (seq !== this.loadSeq || this.disposed) return;
      this.loadPending = false;
      this.onSettled();
      log.warn(`Could not load background image from ${source.origin} node:`, url);
    };
    image.src = url;
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
