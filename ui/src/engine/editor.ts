/**
 * Editor core facade: owns the document, layer pixels, undo history, the
 * stroke buffer, the view and the FG/BG colours. UI and tools talk to it
 * through this API; it has no DOM UI dependencies (it only creates
 * offscreen canvases). The work is split over:
 *
 * - `editorBase.ts`  -- base class: core state construction + the
 *   background/frame, restore bookkeeping and stroke forwarding sections
 * - `editorState.ts` -- shared mutable state + common helpers
 * - `frameOps.ts`    -- background, frame adoption, Clear (+ snapshots)
 * - `paintOps.ts`    -- Quick Mask target, strokes, undo/redo
 * - `docIO.ts`       -- restore/upload bookkeeping (persistence)
 * - `layerDisplay.ts`-- compositor display lists + mask tint caches
 * - `layerRuntime.ts`-- per-layer dirty/version/revision bookkeeping
 * - `layerOps.ts`    -- layer list commands (exposed as {@link Editor.layerOps})
 * - `pixelOps.ts`    -- bucket fill + eyedropper sampling ({@link Editor.pixelOps})
 * - `editorMaskOps.ts` -- Quick Mask / paint target delegation
 * - `moveOps.ts`     -- layer Move tool ({@link Editor.layerMove})
 * - `textOps.ts`     -- text layers ({@link Editor.text}; `textLayer.ts`,
 *   `textRender.ts`, rasterize gate `rasterize.ts`)
 *
 * Coordinates (decision 4): pixels, bounds, patches and dabs are in DOCUMENT
 * (frame) coords, never resampled; the view fits the current image and the
 * document is drawn through {@link Editor.frameMap} (frame fit + Move-tool
 * placement, `placementOps.ts`; not undoable). History (decision 10):
 * dirty-rect patches, Clear = full snapshots. Masks (decisions 5/6) are
 * ordinary layers whose alpha is coverage; Quick Mask picks the paint target.
 */

import type { MaskStyle } from "../document/create";
import type { PaintTarget } from "../document/masks";
import type { Layer, PainterDocument } from "../document/types";
import { cloneDocument } from "../document/serialize";
import type { Point, Rect, Size } from "../geometry/rect";
import type { ColorState } from "./colors";
import type { CompositeLayer, FrameBackground, MaskOverlay } from "./compositor";
import { EditorBase } from "./editorBase";
import type { FrameSource, LayerRuntime } from "./editorTypes";
import { documentMap } from "./frameMap";
import type { FrameMap } from "./frameMap";
import { LayerOps } from "./layerOps";
import type { LayerStore } from "./layerStore";
import { EditorMaskOps } from "./editorMaskOps";
import { LayerMoveOps } from "./moveOps";
import { PixelOps } from "./pixelOps";
import { PlacementOps } from "./placementOps";
import { SelectionOps } from "./selectionOps";
import { TextOps } from "./textOps";
import { toggleSolo } from "./solo";
import type { SoloIds } from "./solo";

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
export class Editor extends EditorBase {
  /** Layer list commands (add/delete/duplicate/reorder/rename/visibility/lock/opacity/active). */
  readonly layerOps: LayerOps;
  /** Paint-bucket fill and eyedropper sampling. */
  readonly pixelOps: PixelOps;
  /** Move-tool placement of the whole drawing (not undoable). */
  readonly placement: PlacementOps;
  /** Layer Move tool (V): move the active layer's content (undoable). */
  readonly layerMove: LayerMoveOps;
  /** Selection (session state, undoable) and its pixel commands. */
  readonly selection: SelectionOps;
  /** Text tool: create / edit / commit text layers (M6b). */
  readonly text: TextOps;

  private readonly maskOps: EditorMaskOps;

  /**
   * @param doc - Document (copied).
   * @param source - Origin of its frame size.
   * @param store - Existing pixels (for clones); a blank store is created otherwise.
   * @param colors - Colour state to start from (forks copy their source's).
   */
  constructor(doc: PainterDocument, source: FrameSource, store?: LayerStore, colors?: ColorState) {
    // Core state, frames, paint, io and display first (`editorBase.ts`).
    super(doc, source, store, colors);
    this.layerOps = new LayerOps(this.s);
    this.pixelOps = new PixelOps(this.s);
    this.placement = new PlacementOps(this.s);
    this.layerMove = new LayerMoveOps(this.s);
    this.selection = new SelectionOps(this.s);
    this.maskOps = new EditorMaskOps(this.s, this.paint);
    this.text = new TextOps(this.s, this.layerOps);
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
  hiddenMaskHasContent(): boolean { return this.maskOps.hiddenMaskHasContent(); }

  /** Background drawn under the paint. */
  get background(): FrameBackground {
    return this.s.background;
  }

  /** Size of what the view shows: the current image (or widget-sized fill), else `doc.frame`. */
  get imageSize(): Size {
    return this.s.imageSize;
  }

  /**
   * Document -> image transform: frame fit + Move-tool placement, same as
   * Python's `_layout` (see `frameMap.ts` {@link documentMap}).
   */
  get frameMap(): FrameMap {
    return documentMap(this.s.doc, this.s.imageSize);
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

  /** Soloed layer ids (view only, `solo.ts`; not saved, not undoable, no effect on outputs). */
  get solo(): Readonly<SoloIds> { return this.s.solo.current; }

  /**
   * Solo a paint/text layer or mask (replaces its group's solo), or end it if it is the active solo.
   * @param layerId - Layer id (unknown ids are ignored).
   */
  toggleSolo(layerId: string): void {
    const layer = this.s.doc.layers.find((l) => l.id === layerId);
    if (layer) this.s.solo.set(toggleSolo(this.s.solo.current, layer));
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

  /** Toggle between the paint layer and the current mask. */
  togglePaintTarget(): void { this.maskOps.togglePaintTarget(); }

  /**
   * Make a mask the current mask and turn Quick Mask on (mask row click).
   * @param layerId - Mask layer id.
   * @returns `false` if it is not a mask layer.
   */
  selectMask(layerId: string): boolean { return this.maskOps.selectMask(layerId); }

  /**
   * Show or hide the mask layer (adds one if missing). Hidden mask layers are
   * also excluded from the `MASK` output (saved-file contract).
   * @param visible - Visibility.
   */
  setMaskVisible(visible: boolean): void { this.maskOps.setMaskVisible(visible); }

  /**
   * Where a lazily added mask layer (documents without one) gets its colour
   * and opacity; read only when a mask is created. Existing masks never change.
   * @param style - Provider (the session reads the user's settings).
   */
  setMaskStyleProvider(style: () => Readonly<MaskStyle>): void { this.s.maskStyle = style; }

  // ── Background / frame ──────────────────────────────────────────────────
  // ── Undo / redo ─────────────────────────────────────────────────────────

  /** Undo the last operation; with a text edit open: commit it, then undo it (a no-op edit just closes). */
  undo(): void { if (!this.text.editing || this.text.commit()) this.paint.undo(); }

  /** Redo the last undone operation (an open text edit is committed first). */
  redo(): void { this.text.commit(); this.paint.redo(); }

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
    copy.s.maskStyle = this.s.maskStyle;
    copy.s.currentMaskId = this.s.currentMaskId;
    copy.setBackground(this.s.background, this.s.backgroundSize);
    return copy;
  }

  /** Estimated memory held (pixels + history; mask tint caches excluded). */
  get bytes(): number {
    return this.s.store.bytes + this.s.history.totalBytes + this.s.selection.bytes;
  }

  /** Release everything. */
  dispose(): void {
    this.s.stroke.dispose();
    this.s.store.dispose();
    this.display.dispose();
    this.pixelOps.dispose();
    this.s.selection.dispose();
    this.s.history.clear();
    this.events.clear();
    this.colors.events.clear();
  }
}
