/**
 * Stage rendering: display canvas (compositor output), overlay canvas (brush
 * ring, loupe, selection marching ants via `marchingAnts.ts`) and the transient note, inside the shell's stage element. Redraws
 * are rAF-coalesced. Backing-store size follows stage CSS size x device
 * pixel ratio x graph zoom (never cached: re-read on every sync).
 */

import { composite } from "../engine/compositor";
import { backingStoreSize } from "../engine/viewport";
import type { Point, Size } from "../geometry/rect";
import type { Tool } from "../tools/types";
import type { EditorSession } from "../widget/sessions";
import { cssCursor, cursorBadge } from "./cursors";
import type { CursorBadge } from "./cursors";
import { drawLoupe } from "./loupe";
import { MarchingAnts } from "./marchingAnts";

/** How long transient notes stay visible. */
const NOTE_MS = 5000;

/**
 * Canvases and note of one stage.
 */
export class StageView {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D | null;
  private readonly overlay: HTMLCanvasElement;
  private readonly overlayCtx: CanvasRenderingContext2D | null;
  private readonly note: HTMLDivElement;
  private frameRequest = 0;
  private overlayRequest = 0;
  private pixelRatio = 1;
  private noteTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  /** Last value written to `--cps-tool-cursor`. */
  private cursorValue = "";
  /** Selection outline animation (redraws only while the stage is visible). */
  private readonly ants = new MarchingAnts(() => {
    // rAF pauses in background tabs; a hidden stage ends the loop until the next render.
    if (this.isVisible()) this.requestOverlay();
  });
  /** Pointer hover position, stage CSS px (`null` = outside). */
  hover: Point | null = null;
  /** Alt held: the cursor is that of `tools.resolve(true)` (temporary eyedropper). */
  altDown = false;
  /** Shift held (selection-mode cursor badge). */
  shiftDown = false;
  /** Selection-mode badge on the cursor (kept fixed during a drag). */
  private badge: CursorBadge | null = null;

  /**
   * @param stage - Stage element (canvases are appended to it).
   * @param session - Current session lookup.
   * @param getDragTool - Returns the tool locked at pointer-down during an
   *   active drag, or `null` when no drag is in progress. Used by the overlay
   *   so that Alt held mid-drag does not switch the ring/loupe to the
   *   eyedropper -- the tool is fixed for the duration of the drag.
   */
  constructor(
    private readonly stage: HTMLElement,
    private readonly session: () => EditorSession | null,
    private readonly getDragTool: () => Tool | null = () => null,
  ) {
    this.canvas = document.createElement("canvas");
    this.canvas.className = "cps-canvas";
    this.ctx = this.canvas.getContext("2d");
    this.overlay = document.createElement("canvas");
    this.overlay.className = "cps-canvas cps-overlay";
    this.overlayCtx = this.overlay.getContext("2d");
    this.note = document.createElement("div");
    this.note.className = "cps-note";
    this.note.hidden = true;
    stage.append(this.canvas, this.overlay, this.note);
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

  /** Redraw synchronously, replacing any scheduled frame. */
  renderNow(): void {
    if (this.disposed) return;
    if (this.frameRequest) cancelAnimationFrame(this.frameRequest);
    this.frameRequest = 0;
    this.render();
  }

  /** Schedule an overlay-only redraw (cheap). */
  requestOverlay(): void {
    if (this.disposed || this.overlayRequest) return;
    this.overlayRequest = requestAnimationFrame(() => {
      this.overlayRequest = 0;
      this.drawOverlay();
    });
  }

  /**
   * Show a transient note at the bottom of the stage.
   * @param text - Note text.
   */
  showNote(text: string): void {
    this.note.textContent = text;
    this.note.hidden = false;
    if (this.noteTimer !== null) clearTimeout(this.noteTimer);
    this.noteTimer = setTimeout(() => {
      this.note.hidden = true;
      this.noteTimer = null;
    }, NOTE_MS);
  }

  /** Push stage size + graph zoom into the view (re-fits in fit mode). */
  syncView(): void {
    const session = this.session();
    if (!session || !this.isVisible()) return;
    session.editor.view.setStage(this.stageSize(), this.displayScale());
  }

  /** @returns `true` if the backing store size changed. */
  syncBackingStore(): boolean {
    const css = this.stageSize();
    if (css.width <= 0 || css.height <= 0) return false;
    const size = backingStoreSize(css, window.devicePixelRatio, this.displayScale());
    this.pixelRatio = size.ratio;
    this.syncView();
    if (this.canvas.width === size.width && this.canvas.height === size.height) return false;
    this.canvas.width = this.overlay.width = size.width;
    this.canvas.height = this.overlay.height = size.height;
    this.requestOverlay();
    return true;
  }

  /**
   * Apply the CSS cursor of the tool in effect now: the tool locked at
   * pointer-down during a drag (Alt mid-drag changes nothing), else
   * `tools.resolve(altDown)` (Alt = temporary eyedropper). Synchronous, so
   * Alt down/up updates the cursor without pointer movement. Selection tools
   * with a selection add the Shift/Alt mode badge (`cursors.ts`). Written to the
   * `--cps-tool-cursor` property so the pan/loading class cursors still win.
   * @returns The tool in effect, or `null` without a session.
   */
  syncCursor(): Tool | null {
    const session = this.session();
    const dragTool = this.getDragTool();
    const tool = session ? (dragTool ?? session.tools.resolve(this.altDown)) : null;
    // Selection-mode badge: follows the modifiers between drags; during a
    // drag (or a pending polygonal lasso) the one from pointer-down stays.
    const locked = dragTool !== null || (tool?.pending?.() ?? false);
    if (!locked) {
      this.badge = cursorBadge({
        combinesSelection: tool?.combinesSelection ?? false,
        hasSelection: session?.editor.selection.active ?? false,
        shift: this.shiftDown,
        alt: this.altDown,
      });
    }
    const value = tool ? cssCursor(tool.cursor(), this.badge) : "crosshair";
    if (value !== this.cursorValue) {
      this.cursorValue = value;
      this.stage.style.setProperty("--cps-tool-cursor", value);
    }
    return tool;
  }

  /** Cancel frames and release canvases. Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.frameRequest) cancelAnimationFrame(this.frameRequest);
    if (this.overlayRequest) cancelAnimationFrame(this.overlayRequest);
    if (this.noteTimer !== null) clearTimeout(this.noteTimer);
    this.ants.dispose();
    this.canvas.width = this.canvas.height = 0;
    this.overlay.width = this.overlay.height = 0;
  }

  // ── Internals ───────────────────────────────────────────────────────────

  private stageSize(): Size {
    return { width: this.stage.clientWidth, height: this.stage.clientHeight };
  }

  private displayScale(): number {
    const rect = this.stage.getBoundingClientRect();
    return this.stage.clientWidth > 0 && rect.width > 0 ? rect.width / this.stage.clientWidth : 1;
  }

  private render(): void {
    const session = this.session();
    if (!this.ctx || !session || !this.isVisible()) return;
    this.syncBackingStore();
    const { editor } = session;
    composite({
      ctx: this.ctx,
      cssSize: this.stageSize(),
      pixelRatio: this.pixelRatio,
      view: editor.view.current,
      imageSize: editor.imageSize,
      map: editor.frameMap,
      bounds: editor.bounds,
      background: editor.background,
      layers: editor.compositeLayers(),
      masks: editor.maskOverlays(),
    });
    this.stage.classList.toggle("cps-loading", editor.loading);
    this.drawOverlay();
  }

  /**
   * Tool overlay (loupe) or brush-size ring at the hover position (separate
   * canvas). During an active drag the tool is the one locked at pointer-down
   * (getDragTool), so Alt held mid-drag does not flip the overlay to the
   * eyedropper.
   */
  private drawOverlay(): void {
    const ctx = this.overlayCtx;
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.overlay.width, this.overlay.height);
    const session = this.session();
    const tool = this.syncCursor();
    const hover = this.hover;
    const pr = this.pixelRatio;
    const overlay = tool?.overlay?.() ?? null;
    // Marching ants (selection + in-progress marquee) are drawn regardless of hover.
    if (session) this.ants.draw(ctx, session.editor, session.editor.view.current, pr, overlay?.kind === "selection" ? overlay.shape : null);
    const panning = this.stage.classList.contains("cps-panning") || this.stage.classList.contains("cps-pan-ready");
    if (!session || !tool || !hover || panning) return;
    if (overlay?.kind === "loupe") {
      drawLoupe(ctx, hover.x * pr, hover.y * pr, pr, overlay);
      return;
    }
    const cursor = tool.cursor();
    if (cursor.kind !== "ring") return;
    const radius = Math.max(1, (cursor.diameter * session.editor.view.current.scale * pr) / 2);
    ctx.lineWidth = Math.max(1, pr);
    ctx.beginPath();
    ctx.arc(hover.x * pr, hover.y * pr, radius, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(0, 0, 0, 0.8)";
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(hover.x * pr, hover.y * pr, radius + ctx.lineWidth, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(255, 255, 255, 0.8)";
    ctx.stroke();
  }
}