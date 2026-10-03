/**
 * Stage rendering: display canvas (compositor output), overlay canvas (brush
 * ring + indicators via `ringCursor.ts`, loupe, selection marching ants via `marchingAnts.ts`, output regions
 * via `regionOverlay.ts`) and the transient note, inside the shell's stage element. Redraws
 * are rAF-coalesced. Owns this stage's cobweb backdrop (grown around the
 * maximum paint area; a plain click on it regrows it, `webClick.ts`). Backing-store size follows stage CSS size x device
 * pixel ratio x graph zoom (never cached: re-read on every sync).
 */

import { boundsCap } from "../engine/bounds";
import { CobwebBackdrop } from "../engine/cobweb/cobwebBackdrop";
import { composite, stageDirtyRect } from "../engine/compositor";
import type { RenderHint } from "../engine/editorTypes";
import { imageToDoc, layerPlacement } from "../engine/frameMap";
import { backgroundShown } from "../engine/solo";
import { backingStoreSize, docRectToStage, stageToDoc } from "../engine/viewport";
import type { Point, Rect, Size } from "../geometry/rect";
import { REGION_TOOL_ID } from "../tools/region";
import type { Tool, ToolCursor } from "../tools/types";
import type { EditorSession } from "../widget/sessions";
import { CURSOR_PALETTE_VARS, setCursorPalette } from "./cursorArt";
import { cssCursor, cursorBadge, stateCursors } from "./cursors";
import type { CursorBadge, CursorExtras } from "./cursors";
import { drawLoupe } from "./loupe";
import { moveCursorCss, moveCursorKind } from "./moveCursors";
import type { MoveCursorKind } from "./moveCursors";
import { MarchingAnts } from "./marchingAnts";
import { drawRegionOverlay } from "./regionOverlay";
import { drawRingCursor } from "./ringCursor";
import { drawTransformOverlay } from "./transformOverlay";
import { WebClick } from "./webClick";

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
  /** A render without the `"stroke"` hint is pending: the next frame redraws everything. */
  private fullPending = true;
  /** View / size / bounds of the last frame: a stroke frame redraws only its rect while it is unchanged. */
  private sceneKey = "";
  private overlayRequest = 0;
  private pixelRatio = 1;
  private noteTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  /** Last value written to `--cps-tool-cursor`. */
  private cursorValue = "";
  /** The pan / busy cursor variables have been written for the current palette. */
  private stateCursorsSet = false;
  /** Selection outline animation (redraws only while the stage is visible). */
  private readonly ants = new MarchingAnts(() => {
    // rAF pauses in background tabs; a hidden stage ends the loop until the next render.
    if (this.isVisible()) this.requestOverlay();
  });
  /** Pointer hover position, stage CSS px (`null` = outside). */
  hover: Point | null = null;
  /** Alt held: the cursor is that of `tools.resolve(true)` (temporary eyedropper). */
  altDown = false;
  /** Ctrl/Cmd held: the cursor is that of `tools.resolve(alt, true)` (temporary layer Move). */
  ctrlDown = false;
  /** Shift held (selection-mode cursor badge). */
  shiftDown = false;
  /** Selection-mode badge on the cursor (kept fixed during a drag). */
  private badge: CursorBadge | null = null;
  /** Move cursor kind (cut / copy / outline / move; kept fixed during a drag). */
  private moveKind: MoveCursorKind | null = null;
  /** Web around the maximum paint area (one per stage / editor instance). */
  private readonly cobweb = new CobwebBackdrop(() => this.requestRender());
  private readonly webClick: WebClick;
  /** Maximum paint area in stage CSS px at the last render. */
  private capCss: Rect | null = null;
  /** Called after every full render (DOM overlays that follow the view, e.g. the text editor). */
  onRendered: (() => void) | null = null;

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
    this.webClick = new WebClick(stage, (p) => this.onWeb(p), () => this.cobweb.regrow());
  }

  /** Whether the stage is attached and has a non-zero layout size. */
  isVisible(): boolean {
    return this.stage.isConnected && this.stage.clientWidth > 0 && this.stage.clientHeight > 0;
  }

  /**
   * Schedule a redraw on the next animation frame (coalesced).
   * @param hint - `"stroke"`: only the live stroke changed, so the frame may
   *   redraw just the area it refreshed; anything else redraws everything.
   */
  requestRender(hint?: RenderHint): void {
    if (hint !== "stroke") this.fullPending = true;
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
    this.fullPending = true;
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
   * `tools.resolve(altDown, ctrlDown)` (Ctrl = temporary layer Move, else
   * Alt = temporary eyedropper). Synchronous, so Alt/Ctrl down/up updates the cursor without pointer movement. Selection tools
   * with a selection add the Shift/Alt mode badge (`cursors.ts`). Written to the
   * `--cps-tool-cursor` property so the pan/loading class cursors still win.
   * @returns The tool in effect, or `null` without a session.
   */
  syncCursor(): Tool | null {
    const session = this.session();
    const dragTool = this.getDragTool();
    const inSelection = session !== null && dragTool === null && this.hoverInSelection(session);
    const press = { shift: this.shiftDown, inSelection };
    const tool = session ? (dragTool ?? session.tools.resolve(this.altDown, this.ctrlDown, press)) : null;
    // Selection-mode badge: follows the modifiers between drags; during a
    // drag (or a pending polygonal lasso) the one from pointer-down stays.
    const locked = dragTool !== null || (tool?.pending?.() ?? false);
    if (!locked) {
      this.moveKind = tool && session ? moveCursorKind({ toolId: tool.id, alt: this.altDown, inSelection, floatActive: session.editor.float.active }) : null;
      this.badge = cursorBadge({
        combinesSelection: tool?.combinesSelection ?? false,
        hasSelection: session?.editor.selection.active ?? false,
        shift: this.shiftDown,
        alt: this.altDown,
      });
    }
    const value = !tool || !session ? "crosshair" : this.moveKind ? moveCursorCss(this.moveKind, this.moveBlocked(tool, session)) : this.toolCss(tool, session);
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
    this.webClick.dispose();
    this.cobweb.dispose();
    this.canvas.width = this.canvas.height = 0;
    this.overlay.width = this.overlay.height = 0;
  }

  // ── Internals ───────────────────────────────────────────────────────────

  /**
   * CSS cursor of a (non-move) tool with its badges: the selection mode (or
   * Alt on the eyedropper: background slot), and for pixel tools
   * `ban` while the edit gate would refuse.
   */
  private toolCss(tool: Tool, session: EditorSession): string {
    // A tool's own Ctrl gesture (Text: Ctrl+drag moves) shows its cursor while Ctrl is held.
    if (this.ctrlDown && tool.ctrlCursor && this.getDragTool() === null) return cssCursor({ kind: "icon", icon: tool.ctrlCursor });
    const cursor = this.toolCursor(tool, session);
    if (cursor.kind === "ring") return cssCursor(cursor, {}, cursor.diameter * session.editor.view.current.scale);
    const extras = this.cursorExtras(tool, session);
    return cssCursor(cursor, cursor.ban ? { ...extras, ban: true } : extras);
  }

  /**
   * Whether the Move layer drag would be refused (`ban`): not for a float or
   * the outline drag, and not when the press picks the layer under the
   * pointer (Ctrl or Auto-select without a selection; known only at the click).
   */
  private moveBlocked(tool: Tool, session: EditorSession): boolean {
    const { editor } = session;
    if (this.moveKind === "outline" || editor.float.active) return false;
    const picks = (this.ctrlDown || tool.options?.get("autoSelect") === true) && !editor.selection.active;
    return !picks && editor.layerMove.blocked();
  }

  /** Badges of the tool in effect now. */
  private cursorExtras(tool: Tool, session: EditorSession): CursorExtras {
    const target = tool.editsPixels ? session.editor.editTarget(tool.editsPixels) : null;
    // The eyedropper writes the background: Alt with the tool itself, or any
    // eyedropper while the background picker is open (`colors.sampleSlot`).
    const toBg =
      tool.id === "eyedropper" &&
      (session.editor.colors.sampleSlot === "bg" || (tool === session.tools.active && this.altDown));
    const mode = this.badge ?? (toBg ? "bgSlot" : null);
    return { mode, ban: target?.blocked ?? false };
  }

  /**
   * Read the `--cps-cursor-*` colours; on a change rebuild the cursors
   * (data URLs can't use CSS variables) and the pan / busy cursor variables.
   */
  private syncPalette(): void {
    const style = getComputedStyle(this.stage);
    const read = (name: string): string => style.getPropertyValue(name).trim();
    const changed = setCursorPalette({
      fg: read(CURSOR_PALETTE_VARS.fg),
      halo: read(CURSOR_PALETTE_VARS.halo),
      ban: read(CURSOR_PALETTE_VARS.ban),
      accent: read(CURSOR_PALETTE_VARS.accent),
    });
    if (!changed && this.stateCursorsSet) return;
    this.stateCursorsSet = true;
    const states = stateCursors();
    this.stage.style.setProperty("--cps-cursor-grab", states.grab);
    this.stage.style.setProperty("--cps-cursor-grabbing", states.grabbing);
    this.stage.style.setProperty("--cps-cursor-busy", states.busy);
    this.cursorValue = "";
  }

  /** The tool's cursor, per hover position for tools with `cursorAt` (Free Transform zones, regions). */
  private toolCursor(tool: Tool, session: EditorSession | null): ToolCursor {
    if (!session || !this.hover || !tool.cursorAt) return tool.cursor();
    const { editor } = session;
    const at = imageToDoc(editor.frameMap, stageToDoc(editor.view.current, this.hover));
    return tool.cursorAt(editor, at, { shift: this.shiftDown });
  }

  /** Whether the hover point is inside the selection (the press test, `selectionMove.hit`). */
  private hoverInSelection(session: EditorSession): boolean {
    const { editor } = session;
    if (!this.hover || !editor.selection.active) return false;
    const doc = imageToDoc(editor.frameMap, stageToDoc(editor.view.current, this.hover));
    return editor.selectionMove.hit(doc.x, doc.y);
  }

  /** Whether a stage CSS point is on the web (inside the stage, outside the cap). */
  private onWeb(p: Point): boolean {
    const cap = this.capCss;
    const size = this.stageSize();
    if (!cap || p.x < 0 || p.y < 0 || p.x > size.width || p.y > size.height) return false;
    return p.x < cap.x || p.y < cap.y || p.x > cap.x + cap.width || p.y > cap.y + cap.height;
  }

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
    const full = this.fullPending;
    this.fullPending = false;
    this.syncBackingStore();
    const { editor } = session;
    const view = editor.view.current;
    const paintArea = boundsCap(editor.doc.frame);
    this.capCss = docRectToStage(view, layerPlacement(editor.frameMap, paintArea));
    // Building the lists refreshes the live stroke preview (`strokeRefreshed`).
    const layers = editor.compositeLayers();
    const masks = editor.maskOverlays();
    // Live stroke frame on an unchanged scene: redraw only what the stroke
    // refreshed, so the cost follows the brush, not the stage size.
    const key = this.frameKey(session);
    const changed = !full && key === this.sceneKey ? editor.strokeRefreshed : null;
    const clip = changed ? stageDirtyRect(changed, view, editor.frameMap, this.pixelRatio, this.canvas) : null;
    this.sceneKey = key;
    if (!changed || clip) {
      composite({
        ctx: this.ctx,
        cssSize: this.stageSize(),
        pixelRatio: this.pixelRatio,
        view,
        imageSize: editor.imageSize,
        map: editor.frameMap,
        bounds: editor.bounds,
        background: editor.background,
        backgroundHidden: !backgroundShown(editor.doc.backgroundVisible !== false, editor.solo),
        layers,
        masks,
        paintArea,
        cobweb: this.cobweb,
        ...(clip ? { clip } : {}),
      });
    }
    this.stage.classList.toggle("cps-loading", editor.loading);
    this.syncPalette();
    // Drawn here: a pending overlay-only frame would repeat it.
    if (this.overlayRequest) cancelAnimationFrame(this.overlayRequest);
    this.overlayRequest = 0;
    this.drawOverlay();
    this.onRendered?.();
  }

  /** What a partial frame relies on being unchanged since the last frame. */
  private frameKey(session: EditorSession): string {
    const { editor } = session;
    const v = editor.view.current;
    const b = editor.bounds;
    const m = editor.frameMap;
    const i = editor.imageSize;
    return [this.canvas.width, this.canvas.height, this.pixelRatio, v.scale, v.offsetX, v.offsetY,
      b.x, b.y, b.width, b.height, m.scale, m.offsetX, m.offsetY, i.width, i.height].join(",");
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
    // Marching ants (selection + in-progress marquee) are drawn regardless of hover,
    // but not on the Outputs tab: regions are a separate space and the selection is out of reach there.
    const regionMode = session?.tools.active.id === REGION_TOOL_ID;
    if (session && !regionMode) this.ants.draw(ctx, session.editor, session.editor.view.current, pr, overlay?.kind === "selection" ? overlay.shape : null);
    if (session) drawRegionOverlay(ctx, session.editor, pr, regionMode);
    if (session) drawTransformOverlay(ctx, session.editor, pr);
    const panning = this.stage.classList.contains("cps-panning") || this.stage.classList.contains("cps-pan-ready");
    if (!session || !tool || !hover || panning) return;
    if (overlay?.kind === "loupe") {
      drawLoupe(ctx, hover.x * pr, hover.y * pr, pr, overlay);
      return;
    }
    const cursor = tool.cursor();
    if (cursor.kind !== "ring") return;
    const radius = Math.max(1, (cursor.diameter * session.editor.view.current.scale * pr) / 2);
    const target = tool.editsPixels ? session.editor.editTarget(tool.editsPixels) : null;
    const indicators = { glyph: cursor.glyph, ban: target?.blocked ?? false };
    drawRingCursor(ctx, hover.x * pr, hover.y * pr, radius, pr, indicators, () => this.requestOverlay());
  }
}
