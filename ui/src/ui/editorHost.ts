/**
 * The editor''s DOM shell: root element (the DOM widget element) with the
 * tool rail, options strip and canvas stage (display canvas + overlay canvas
 * for the brush ring). Binds to one session at a time; redraws are
 * rAF-coalesced and driven by editor events, never by graph repaints.
 *
 * Knows nothing about ComfyUI; the widget layer attaches sessions.
 */

import { DEFAULT_MASK_COLOR } from "../document/create";
import { maskDisplayColor } from "../document/masks";
import { composite } from "../engine/compositor";
import { backingStoreSize } from "../engine/viewport";
import type { Point, Size } from "../geometry/rect";
import type { EditorSession } from "../widget/sessions";
import { KeyboardScope } from "./keyboard";
import { OptionsBar } from "./optionsBar";
import { handleShortcut } from "./shortcuts";
import { StageInput } from "./stageInput";
import { ToolRail } from "./toolRail";

/** Callbacks from the host to its owner. */
export interface EditorHostEvents {
  /** The stage went from zero size (hidden/unmounted) to a visible size. */
  onBecameVisible?: () => void;
}

/** How long transient notes stay visible. */
const NOTE_MS = 5000;

// ═══════════════════════════════════════════════════════════════════════════
// EditorHost
// ═══════════════════════════════════════════════════════════════════════════

/**
 * DOM shell of one node''s editor.
 */
export class EditorHost {
  /** Root element handed to `addDOMWidget`. */
  readonly root: HTMLDivElement;
  /** Canvas area. */
  readonly stage: HTMLDivElement;
  /** Pointer/wheel router (the isolation guard forwards to it). */
  readonly input: StageInput;

  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D | null;
  private readonly overlay: HTMLCanvasElement;
  private readonly overlayCtx: CanvasRenderingContext2D | null;
  private readonly note: HTMLDivElement;
  private readonly rail: ToolRail;
  private readonly optionsBar: OptionsBar;
  private readonly keyboard: KeyboardScope;
  private readonly resizeObserver: ResizeObserver;

  private session: EditorSession | null = null;
  private unbind: Array<() => void> = [];
  private frameRequest = 0;
  private overlayRequest = 0;
  private pixelRatio = 1;
  private hover: Point | null = null;
  private wasVisible = false;
  private noteTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  /**
   * @param events - Owner callbacks.
   */
  constructor(private readonly events: EditorHostEvents = {}) {
    this.root = document.createElement("div");
    this.root.className = "cps-root";

    this.rail = new ToolRail({
      selectTool: (id) => {
        this.input.cancel();
        this.session?.tools.setActive(id);
      },
      toggleQuickMask: () => {
        this.input.cancel();
        this.session?.editor.togglePaintTarget();
      },
      undo: () => this.session?.editor.undo(),
      redo: () => this.session?.editor.redo(),
      fit: () => {
        this.session?.editor.view.fit();
        this.requestRender();
      },
      clear: () => this.confirmClear(),
    });
    this.optionsBar = new OptionsBar(
      () => this.optionsChanged(),
      () => {
        const editor = this.session?.editor;
        if (!editor || editor.loading) return;
        this.input.cancel();
        editor.setMaskVisible(!(editor.maskLayer?.visible ?? true));
      },
    );

    this.stage = document.createElement("div");
    this.stage.className = "cps-stage";
    this.stage.tabIndex = -1;
    this.canvas = document.createElement("canvas");
    this.canvas.className = "cps-canvas";
    this.ctx = this.canvas.getContext("2d");
    this.overlay = document.createElement("canvas");
    this.overlay.className = "cps-canvas cps-overlay";
    this.overlayCtx = this.overlay.getContext("2d");
    this.note = document.createElement("div");
    this.note.className = "cps-note";
    this.note.hidden = true;
    this.stage.append(this.canvas, this.overlay, this.note);

    const main = document.createElement("div");
    main.className = "cps-main";
    main.append(this.optionsBar.element, this.stage);
    this.root.append(this.rail.element, main);

    this.input = new StageInput(this.stage, {
      session: () => this.session,
      isSpaceDown: () => this.keyboard.isSpaceDown,
      setDragging: (dragging) => this.keyboard.setHeld(dragging),
      setHover: (point) => {
        this.hover = point;
        this.requestOverlay();
      },
      viewChanged: () => this.requestRender(),
    });
    this.keyboard = new KeyboardScope(this.root, {
      onKeyDown: (event) =>
        this.session
          ? handleShortcut(event, this.session, {
              optionsChanged: () => this.optionsChanged(),
              viewChanged: () => this.requestRender(),
              cancelDrag: () => this.input.cancel(),
            })
          : false,
      onSpaceChange: (down) => this.stage.classList.toggle("cps-pan-ready", down),
    });

    this.resizeObserver = new ResizeObserver(() => this.handleResize());
    this.resizeObserver.observe(this.stage);
  }

  // ── Public API ──────────────────────────────────────────────────────────

  /**
   * Show a session (or nothing).
   * @param session - Session to bind.
   */
  setSession(session: EditorSession | null): void {
    if (session === this.session) return;
    this.input.cancel();
    for (const off of this.unbind) off();
    this.unbind = [];
    this.session = session;
    if (session) {
      const { editor, tools } = session;
      this.unbind.push(
        editor.events.on("render", () => this.requestRender()),
        editor.events.on("history", () => this.syncHistory()),
        editor.events.on("note", (text) => this.showNote(text)),
        editor.events.on("mask", () => this.syncMask()),
        editor.events.on("change", () => this.syncMask()),
        tools.events.on("change", () => this.syncTools()),
      );
      this.rail.setTools(tools.list(), tools.active.id);
      this.syncTools();
      this.syncMask();
      this.syncHistory();
      this.syncView();
    }
    this.requestRender();
  }

  /**
   * Re-check the on-screen scale (graph zoom changes don''t trigger
   * ResizeObserver) and redraw if the backing store would change.
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

  /** Tear down listeners and canvases. Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.setSession(null);
    this.disposed = true;
    if (this.frameRequest) cancelAnimationFrame(this.frameRequest);
    if (this.overlayRequest) cancelAnimationFrame(this.overlayRequest);
    if (this.noteTimer !== null) clearTimeout(this.noteTimer);
    this.resizeObserver.disconnect();
    this.input.dispose();
    this.keyboard.dispose();
    this.canvas.width = this.canvas.height = 0;
    this.overlay.width = this.overlay.height = 0;
    this.root.remove();
  }

  // ── Sync ────────────────────────────────────────────────────────────────

  private syncTools(): void {
    const session = this.session;
    if (!session) return;
    this.rail.setActive(session.tools.active.id);
    this.optionsBar.bind(session.tools.active.options);
    this.requestOverlay();
  }

  /** Quick Mask button, "Mask" badge and eye toggle. */
  private syncMask(): void {
    const editor = this.session?.editor;
    if (!editor) return;
    const mask = editor.maskLayer;
    const color = mask ? maskDisplayColor(mask) : DEFAULT_MASK_COLOR;
    const targeting = editor.paintTarget === "mask";
    this.rail.setQuickMask(targeting, color);
    this.optionsBar.setMask({ targeting, color, visible: mask?.visible ?? true });
  }

  private syncHistory(): void {
    const editor = this.session?.editor;
    this.rail.setHistory(editor?.canUndo ?? false, editor?.canRedo ?? false);
  }

  private optionsChanged(): void {
    this.optionsBar.refresh();
    this.session?.tools.notifyOptions();
    this.requestOverlay();
  }

  /** Clear button: confirm, then one undoable Clear (SPEC Behavior Notes). */
  private confirmClear(): void {
    const editor = this.session?.editor;
    if (!editor || editor.loading) return;
    if (!window.confirm("Clear all paint? This can be undone.")) return;
    this.input.cancel();
    editor.clear();
  }

  private showNote(text: string): void {
    this.note.textContent = text;
    this.note.hidden = false;
    if (this.noteTimer !== null) clearTimeout(this.noteTimer);
    this.noteTimer = setTimeout(() => {
      this.note.hidden = true;
      this.noteTimer = null;
    }, NOTE_MS);
  }

  // ── Sizing ──────────────────────────────────────────────────────────────

  private handleResize(): void {
    const visible = this.isVisible();
    if (visible && !this.wasVisible) this.events.onBecameVisible?.();
    this.wasVisible = visible;
    this.syncBackingStore();
    this.requestRender();
  }

  private stageSize(): Size {
    return { width: this.stage.clientWidth, height: this.stage.clientHeight };
  }

  private displayScale(): number {
    const rect = this.stage.getBoundingClientRect();
    return this.stage.clientWidth > 0 && rect.width > 0 ? rect.width / this.stage.clientWidth : 1;
  }

  /** Push stage size + graph zoom into the view (re-fits in fit mode). */
  private syncView(): void {
    if (!this.session || !this.isVisible()) return;
    this.session.editor.view.setStage(this.stageSize(), this.displayScale());
  }

  /** @returns `true` if the backing store size changed. */
  private syncBackingStore(): boolean {
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

  // ── Rendering ───────────────────────────────────────────────────────────

  private render(): void {
    const session = this.session;
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

  private requestOverlay(): void {
    if (this.disposed || this.overlayRequest) return;
    this.overlayRequest = requestAnimationFrame(() => {
      this.overlayRequest = 0;
      this.drawOverlay();
    });
  }

  /** Brush-size ring at the hover position (cheap; separate canvas). */
  private drawOverlay(): void {
    const ctx = this.overlayCtx;
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.overlay.width, this.overlay.height);
    const session = this.session;
    const hover = this.hover;
    const panning = this.stage.classList.contains("cps-panning") || this.stage.classList.contains("cps-pan-ready");
    if (!session || !hover || panning) return;
    const cursor = session.tools.active.cursor();
    if (cursor.kind !== "ring") return;
    const pr = this.pixelRatio;
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