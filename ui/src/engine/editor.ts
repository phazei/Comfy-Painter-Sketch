/**
 * Editor core facade: owns the document, layer pixels, undo history, the
 * stroke buffer, the view and the FG/BG colours. UI and tools talk to it
 * through this API; it has no DOM UI dependencies (it only creates
 * offscreen canvases). The work is split over:
 *
 * - `editorState.ts` -- shared mutable state + common helpers
 * - `frameOps.ts`    -- background, frame adoption, Clear (+ snapshots)
 * - `paintOps.ts`    -- Quick Mask target, strokes, undo/redo
 * - `docIO.ts`       -- restore/upload bookkeeping (persistence)
 * - `layerDisplay.ts`-- compositor display lists + mask tint caches
 * - `layerRuntime.ts`-- per-layer dirty/version/revision bookkeeping
 * - `layerOps.ts`    -- layer list commands (exposed as {@link Editor.layerOps})
 * - `pixelOps.ts`    -- bucket fill + eyedropper sampling ({@link Editor.pixelOps})
 * - `editorMaskOps.ts` -- Quick Mask / paint target delegation
 *
 * Coordinates (decision 4): pixels, bounds, patches and dabs are in DOCUMENT
 * (frame) coords, never resampled; the view fits the current image and the
 * document is drawn through {@link Editor.frameMap}. History (decision 10):
 * dirty-rect patches, Clear = full snapshots. Masks (decisions 5/6) are
 * ordinary layers whose alpha is coverage; Quick Mask picks the paint target.
 */

import type { PaintTarget } from "../document/masks";
import type { Layer, PainterDocument } from "../document/types";
import { cloneDocument } from "../document/serialize";
import type { Point, Rect, Size } from "../geometry/rect";
import type { Dab } from "./brush";
import { ColorState } from "./colors";
import type { CompositeLayer, FrameBackground, MaskOverlay } from "./compositor";
import { DocIO } from "./docIO";
import type { EditorEvents, FrameSource, LayerRuntime } from "./editorTypes";
import { EditorState } from "./editorState";
import type { Emitter } from "./emitter";
import { frameMap } from "./frameMap";
import type { FrameMap } from "./frameMap";
import { FrameOps } from "./frameOps";
import { LayerDisplay } from "./layerDisplay";
import { LayerOps } from "./layerOps";
import type { LayerStore } from "./layerStore";
import { EditorMaskOps } from "./editorMaskOps";
import { PaintOps } from "./paintOps";
import { PixelOps } from "./pixelOps";
import type { ShapeSpec } from "./shapes";
import { StampCache } from "./stampCache";
import type { StrokeStyle } from "./stroke";
import type { ViewState } from "./view";

export type { EditorEvents, FrameSource, HistoryEntry, LayerRuntime } from "./editorTypes";
export type { LayerOps } from "./layerOps";
export { HIDDEN_MASK_NOTE } from "./editorTypes";

// ═══════════════════════════════════════════════════════════════════════════
// Editor
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Editing state for one document (lives in the session, outlives node
 * instances).
 */
export class Editor {
  readonly events: Emitter<EditorEvents>;
  readonly view: ViewState;
  readonly stamps = new StampCache();
  /** FG/BG colours (session-scoped, not saved). */
  readonly colors: ColorState;
  /** Layer list commands (add/delete/duplicate/reorder/rename/visibility/lock/opacity/active). */
  readonly layerOps: LayerOps;
  /** Paint-bucket fill and eyedropper sampling. */
  readonly pixelOps: PixelOps;

  private readonly s: EditorState;
  private readonly frames: FrameOps;
  private readonly paint: PaintOps;
  private readonly io: DocIO;
  private readonly display: LayerDisplay;
  private readonly maskOps: EditorMaskOps;

  /**
   * @param doc - Document (copied).
   * @param source - Origin of its frame size.
   * @param store - Existing pixels (for clones); a blank store is created otherwise.
   * @param colors - Colour state to start from (forks copy their source's).
   */
  constructor(doc: PainterDocument, source: FrameSource, store?: LayerStore, colors?: ColorState) {
    this.s = new EditorState(doc, source, store);
    this.events = this.s.events;
    this.view = this.s.view;
    this.colors = new ColorState(colors?.current);
    this.frames = new FrameOps(this.s);
    this.paint = new PaintOps(this.s, this.frames, this.stamps);
    this.io = new DocIO(this.s, (size) => this.frames.handleBackgroundSize(size));
    this.display = new LayerDisplay(this.s);
    this.layerOps = new LayerOps(this.s);
    this.pixelOps = new PixelOps(this.s);
    this.maskOps = new EditorMaskOps(this.s, this.paint);
  }

  // ── Read access ─────────────────────────────────────────────────────────

  /** Current document (treat as read-only). */
  get doc(): Readonly<PainterDocument> {
    return this.s.doc;
  }

  /** Where the frame size came from. */
  get frameSource(): FrameSource {
    return this.s.frameSource;
  }

  /** Undo available. */
  get canUndo(): boolean {
    return this.s.history.canUndo && !this.s.stroke.active;
  }

  /** Redo available. */
  get canRedo(): boolean {
    return this.s.history.canRedo && !this.s.stroke.active;
  }

  /** Layer files are being restored; painting is disabled. */
  get loading(): boolean {
    return this.s.loading;
  }

  /** Whether any layer has ever held paint. */
  get hasPaint(): boolean {
    return this.s.runtime.hasPaint;
  }

  /** Whether any layer needs uploading. */
  get dirty(): boolean {
    return this.s.runtime.dirty;
  }

  /**
   * Whether any mask layer is hidden AND has ever held paint (queue-time
   * warning: it will not be in the MASK output).
   * @returns `true` if a hidden-but-painted mask exists.
   */
  hiddenMaskHasContent(): boolean {
    for (const layer of this.s.doc.layers) {
      if (layer.kind !== "mask" || layer.visible) continue;
      if (this.s.runtime.get(layer.id)?.hasContent) return true;
    }
    return false;
  }

  /** Background drawn under the paint. */
  get background(): FrameBackground {
    return this.s.background;
  }

  /** Size of what the view shows: the current image (or widget-sized fill), else `doc.frame`. */
  get imageSize(): Size {
    return this.s.imageSize;
  }

  /** Document -> image transform (same as Python's frame-mismatch placement). */
  get frameMap(): FrameMap {
    return frameMap(this.s.doc.frame, this.s.imageSize);
  }

  /**
   * Runtime state of a layer.
   * @param layerId - Layer id.
   * @returns Bookkeeping or `undefined`.
   */
  layerRuntime(layerId: string): Readonly<LayerRuntime> | undefined {
    return this.s.runtime.get(layerId);
  }

  /**
   * Canvas of a layer (for export/upload).
   * @param layerId - Layer id.
   * @returns The canvas.
   */
  layerCanvas(layerId: string): HTMLCanvasElement {
    return this.s.store.ensure(layerId).canvas;
  }

  /** Current paint bounds (document coords). */
  get bounds(): Rect {
    return this.s.store.bounds;
  }

  /** Where the previous stroke ended, document coords (Shift+click line start). */
  get lastStrokeEnd(): Point | null {
    return this.s.lastStrokeEnd;
  }

  set lastStrokeEnd(point: Point | null) {
    this.s.lastStrokeEnd = point ? { ...point } : null;
  }

  /**
   * Visible layers to composite (live stroke preview for the painted layer).
   * @returns Bottom -> top layers.
   */
  compositeLayers(): CompositeLayer[] {
    return this.display.compositeLayers();
  }

  /**
   * Visible mask layers as tinted overlays (drawn above all paint).
   * @returns Bottom -> top overlays.
   */
  maskOverlays(): MaskOverlay[] {
    return this.display.maskOverlays();
  }

  // ── Quick Mask / paint target ───────────────────────────────────────────

  /** What brush/eraser strokes paint into (UI state, not saved). */
  get paintTarget(): PaintTarget { return this.maskOps.paintTarget; }

  /** The mask layer Quick Mask edits, if the document has one. */
  get maskLayer(): Readonly<Layer> | undefined { return this.maskOps.maskLayer; }

  /**
   * Switch the paint target (Quick Mask, `Q`); adds a mask layer if missing.
   * @param target - New target.
   */
  setPaintTarget(target: PaintTarget): void { this.maskOps.setPaintTarget(target); }

  /** Toggle between the paint layer and the mask. */
  togglePaintTarget(): void { this.maskOps.togglePaintTarget(); }

  /**
   * Show or hide the mask layer (adds one if missing). Hidden mask layers are
   * also excluded from the `MASK` output (saved-file contract).
   * @param visible - Visibility.
   */
  setMaskVisible(visible: boolean): void { this.maskOps.setMaskVisible(visible); }

  // ── Background / frame ──────────────────────────────────────────────────

  /**
   * Set what is drawn under the paint; layer pixels are untouched.
   * @param background - Image or fill.
   * @param imageSize - Current image size: the image's natural size, or the
   *   `width` x `height` widgets for a fill; `null` = show `doc.frame`.
   */
  setBackground(background: FrameBackground, imageSize: Size | null): void {
    this.frames.setBackground(background, imageSize);
  }

  /**
   * A new current-image size arrived (an empty document adopts it; a painted
   * one is only displayed through the frame map). Call after `setBackground`.
   * @param size - Current image size.
   */
  handleBackgroundSize(size: Size): void {
    this.frames.handleBackgroundSize(size);
  }

  /**
   * Replace the frame of an empty document (no history).
   * @param size - New frame.
   * @param source - Origin of the size.
   */
  adoptFrame(size: Size, source: FrameSource): void {
    this.frames.adoptFrame(size, source);
  }

  /** Clear all paint (masks included) and reset the frame; one undo step. */
  clear(): void {
    this.frames.clear();
  }

  // ── Restore bookkeeping (persistence) ───────────────────────────────────

  /** Mark the start of an async layer restore (disables painting). */
  beginLoading(): void { this.io.beginLoading(); }

  /** Mark the end of an async layer restore; applies a deferred frame change. */
  endLoading(): void { this.io.endLoading(); }

  /**
   * Draw a restored PNG into a layer (not an undo step, not dirty).
   * @param layerId - Layer id.
   * @param image - Decoded PNG (sized to `bounds`).
   */
  restoreLayerPixels(layerId: string, image: CanvasImageSource): void {
    this.io.restoreLayerPixels(layerId, image);
  }

  /**
   * Record a finished upload.
   * @param layerId - Layer id.
   * @param version - Layer version that was uploaded.
   * @param file - Stored file reference (`null` for an empty layer).
   */
  markUploaded(layerId: string, version: number, file: string | null): void {
    this.io.markUploaded(layerId, version, file);
  }

  // ── Strokes ─────────────────────────────────────────────────────────────

  /**
   * Start a stroke on the paint target.
   * @param style - Stroke appearance.
   * @param maxDiameter - Largest dab diameter this stroke can produce, document px.
   * @returns `false` if painting is not possible (loading, locked, hidden).
   */
  beginStroke(style: StrokeStyle, maxDiameter: number): boolean {
    return this.paint.beginStroke(style, maxDiameter);
  }

  /**
   * Add dabs to the current stroke.
   * @param dabs - Dabs in document coords.
   */
  addDabs(dabs: readonly Dab[]): void {
    this.paint.addDabs(dabs);
  }

  /**
   * Replace the current stroke's content with one shape (shape tools: live
   * preview on every move, rasterized into the layer by {@link endStroke}).
   * @param shape - Shape in document coords.
   */
  drawShape(shape: ShapeSpec): void {
    this.paint.drawShape(shape);
  }

  /**
   * Commit the stroke to its layer as one undo step.
   * @param end - Where the stroke ended, document coords (for Shift+click lines).
   */
  endStroke(end: Point | null): void {
    this.paint.endStroke(end);
  }

  /** Abort the current stroke. */
  cancelStroke(): void {
    this.s.cancelStroke();
  }

  // ── Undo / redo ─────────────────────────────────────────────────────────

  /** Undo the last operation. */
  undo(): void { this.paint.undo(); }

  /** Redo the last undone operation. */
  redo(): void { this.paint.redo(); }

  // ── Cloning / teardown ──────────────────────────────────────────────────

  /**
   * Independent copy with a new document id (node duplicated while its source
   * is still live). History is not copied.
   * @param docId - New id.
   * @returns New editor.
   */
  fork(docId: string): Editor {
    const doc = cloneDocument(this.s.doc);
    doc.docId = docId;
    const copy = new Editor(doc, this.s.frameSource, this.s.store.clone(), this.colors);
    copy.s.runtime.copyFrom(this.s.runtime);
    copy.setBackground(this.s.background, this.s.backgroundSize);
    return copy;
  }

  /** Estimated memory held (pixels + history; mask tint caches excluded). */
  get bytes(): number {
    return this.s.store.bytes + this.s.history.totalBytes;
  }

  /** Release everything. */
  dispose(): void {
    this.s.stroke.dispose();
    this.s.store.dispose();
    this.display.dispose();
    this.pixelOps.dispose();
    this.s.history.clear();
    this.stamps.clear();
    this.events.clear();
    this.colors.events.clear();
  }
}