/**
 * The editor's DOM shell: root element (the DOM widget element), left tool
 * rail, and the canvas stage. Owns canvas sizing (ResizeObserver +
 * devicePixelRatio + graph zoom) and on-demand redraws.
 *
 * Knows nothing about ComfyUI; the widget layer feeds it frame content.
 */

import { DEFAULT_STAGE_STYLE, renderStage } from "../engine/backgroundRenderer";
import type { FrameContent } from "../engine/backgroundRenderer";
import { backingStoreSize } from "../engine/viewport";
import { createToolRail } from "./toolRail";

// ── Types ─────────────────────────────────────────────────────────────────────

/** Callbacks from the host to its owner. */
export interface EditorHostEvents {
  /** The stage went from zero size (hidden/unmounted) to a visible size. */
  onBecameVisible?: () => void;
}

// ═══════════════════════════════════════════════════════════════════════════
// EditorHost
// ═══════════════════════════════════════════════════════════════════════════

/**
 * DOM shell of one editor instance.
 */
export class EditorHost {
  /** Root element handed to `addDOMWidget`. */
  readonly root: HTMLDivElement;
  /** Canvas area (receives wheel; later: pointer tools). */
  readonly stage: HTMLDivElement;

  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D | null;
  private readonly resizeObserver: ResizeObserver;
  private content: FrameContent | null = null;
  private frameRequest = 0;
  private pixelRatio = 1;
  private wasVisible = false;
  private disposed = false;

  /**
   * @param events - Owner callbacks.
   */
  constructor(private readonly events: EditorHostEvents = {}) {
    this.root = document.createElement("div");
    this.root.className = "cps-root";

    this.stage = document.createElement("div");
    this.stage.className = "cps-stage";
    this.stage.tabIndex = -1;

    this.canvas = document.createElement("canvas");
    this.canvas.className = "cps-canvas";
    this.ctx = this.canvas.getContext("2d");

    this.stage.appendChild(this.canvas);
    this.root.append(createToolRail(), this.stage);

    this.resizeObserver = new ResizeObserver(() => this.handleResize());
    this.resizeObserver.observe(this.stage);
  }

  // ── Public API ──────────────────────────────────────────────────────────

  /**
   * Replace what the frame shows and redraw.
   *
   * @param content - New frame content.
   */
  setContent(content: FrameContent): void {
    this.content = content;
    this.requestRender();
  }

  /**
   * Re-check the on-screen scale (graph zoom changes don't trigger
   * ResizeObserver) and redraw if the backing store would change. Cheap;
   * safe to call from a timer.
   */
  refreshScale(): void {
    if (this.syncBackingStore()) this.requestRender();
  }

  /** Whether the stage is attached and has a non-zero layout size. */
  isVisible(): boolean {
    return this.stage.isConnected && this.stage.clientWidth > 0 && this.stage.clientHeight > 0;
  }

  /** Schedule a redraw on the next animation frame (coalesced). */
  requestRender(): void {
    if (this.disposed || this.frameRequest) return;
    this.frameRequest = requestAnimationFrame(() => {
      this.frameRequest = 0;
      this.render();
    });
  }

  /** Stop observing and drop the canvas. Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.frameRequest) cancelAnimationFrame(this.frameRequest);
    this.frameRequest = 0;
    this.resizeObserver.disconnect();
    this.canvas.width = 0;
    this.canvas.height = 0;
    this.root.remove();
  }

  // ── Internals ───────────────────────────────────────────────────────────

  private handleResize(): void {
    const visible = this.isVisible();
    if (visible && !this.wasVisible) this.events.onBecameVisible?.();
    this.wasVisible = visible;
    this.syncBackingStore();
    this.requestRender();
  }

  /**
   * Size the backing store for the current layout size, DPR and ancestor
   * zoom. @returns `true` if the size changed.
   */
  private syncBackingStore(): boolean {
    const cssWidth = this.stage.clientWidth;
    const cssHeight = this.stage.clientHeight;
    if (cssWidth <= 0 || cssHeight <= 0) return false;
    const rect = this.stage.getBoundingClientRect();
    const displayScale = rect.width > 0 ? rect.width / cssWidth : 1;
    const size = backingStoreSize({ width: cssWidth, height: cssHeight }, window.devicePixelRatio, displayScale);
    this.pixelRatio = size.ratio;
    if (this.canvas.width === size.width && this.canvas.height === size.height) return false;
    this.canvas.width = size.width;
    this.canvas.height = size.height;
    return true;
  }

  private render(): void {
    if (!this.ctx || !this.content || !this.isVisible()) return;
    this.syncBackingStore();
    renderStage(
      this.ctx,
      { width: this.stage.clientWidth, height: this.stage.clientHeight },
      this.pixelRatio,
      this.content,
      DEFAULT_STAGE_STYLE,
    );
  }
}
