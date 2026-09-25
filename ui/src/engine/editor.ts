/**
 * Editor core: owns the document, layer pixels, undo history, the stroke
 * buffer and the view. UI and tools talk to it through this API; it has no
 * DOM UI dependencies (it only creates offscreen canvases).
 *
 * Coordinates (decision 4): layer pixels, bounds, history patches, dabs and
 * the Shift+click line start are all in DOCUMENT (frame) coordinates and are
 * never resampled. The view fits the current *image* (the background); the
 * document is drawn onto it through {@link Editor.frameMap}, a pure function
 * of `doc.frame` and the image size, so flipping upstream images is lossless
 * and creates no history.
 *
 * History (decision 10): patches in document coords, so growing `bounds` is
 * transparent to history -- bounds only grow while painting and growth itself
 * is not an undo step (the extra area is transparent and invisible in the
 * output). Re-applying a patch first widens bounds to cover its rect if
 * needed. The one operation that replaces frame/bounds wholesale is Clear,
 * recorded as a `clear` entry holding a full snapshot of the prior state.
 *
 * Masks (decisions 5/6): mask layers are ordinary layers whose alpha is
 * coverage. The paint target (Quick Mask, UI state, not saved) picks whether
 * strokes go to the active paint layer or the mask; everything else (history,
 * bounds, Clear, uploads) is layer-generic. Mask layers are displayed through
 * cached tints ({@link MaskTint}) above all paint.
 */

import { ensureMaskLayer, findMaskLayer, maskDisplayColor, targetLayer } from "../document/masks";
import type { PaintTarget } from "../document/masks";
import type { Layer, PainterDocument } from "../document/types";
import { cloneDocument } from "../document/serialize";
import { containsRect, frameRect, isEmptyRect, unionRect } from "../geometry/rect";
import type { Point, Rect, Size } from "../geometry/rect";
import { growBounds } from "./bounds";
import type { Dab } from "./brush";
import type { CompositeLayer, FrameBackground, MaskOverlay } from "./compositor";
import { Emitter } from "./emitter";
import { frameMap } from "./frameMap";
import type { FrameMap } from "./frameMap";
import { HistoryStack } from "./history";
import { LayerStore } from "./layerStore";
import { MaskTint } from "./maskTint";
import { StampCache } from "./stampCache";
import { StrokeBuffer } from "./stroke";
import type { StrokeStyle } from "./stroke";
import { ViewState } from "./view";

// ── Types ─────────────────────────────────────────────────────────────────────

/** Where the document frame size came from. */
export type FrameSource = "widgets" | "image" | "document";

/** Per-layer runtime bookkeeping (not saved). */
export interface LayerRuntime {
  /** Pixels differ from the uploaded `file`. */
  dirty: boolean;
  /** Bumped on every pixel change (lets uploads detect concurrent edits). */
  version: number;
  /** Layer has ever held paint (an empty document may adopt a new frame). */
  hasContent: boolean;
}

/** Full document geometry + pixels (Clear undo). */
interface DocSnapshot {
  frame: Size;
  bounds: Rect;
  source: FrameSource;
  /** Per-layer pixels covering `bounds`; `null` = every layer empty. */
  pixels: Map<string, ImageData> | null;
}

/** One undoable operation. */
export type HistoryEntry =
  | { kind: "patch"; layerId: string; x: number; y: number; before: ImageData; after: ImageData; bytes: number }
  | { kind: "clear"; before: DocSnapshot; after: DocSnapshot; bytes: number };

/** Editor events. */
export interface EditorEvents {
  [key: string]: unknown;
  /** Pixels, background or view changed: redraw the stage. */
  render: undefined;
  /** Document content/metadata changed: re-emit widget value, schedule upload. */
  change: undefined;
  /** Undo/redo availability changed. */
  history: undefined;
  /** Transient user-facing note. */
  note: string;
  /** Paint target or mask layer state (visibility, existence) changed. */
  mask: undefined;
}

/** Stroke colour on mask layers: coverage lives in alpha, RGB kept white. */
const MASK_STROKE_COLOR = "#ffffff";

/** Note shown when a hidden mask layer blocks painting or is queued while hidden. */
export const HIDDEN_MASK_NOTE = "The mask is hidden; show it to output it.";

// ═══════════════════════════════════════════════════════════════════════════
// Editor
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Editing state for one document (lives in the session, outlives node
 * instances).
 */
export class Editor {
  readonly events = new Emitter<EditorEvents>();
  readonly view = new ViewState();
  readonly stamps = new StampCache();

  private docState: PainterDocument;
  private readonly store: LayerStore;
  private readonly history = new HistoryStack<HistoryEntry>();
  private readonly stroke = new StrokeBuffer();
  private readonly runtime = new Map<string, LayerRuntime>();
  private backgroundState: FrameBackground = { kind: "fill", color: "#ffffff" };
  private backgroundSize: Size | null = null;
  private frameSourceState: FrameSource;
  private strokeLayerId: string | null = null;
  private strokeDiameter = 1;
  private loadingCount = 0;
  private pendingBackgroundSize: Size | null = null;
  private target: PaintTarget = "paint";
  private readonly tints = new Map<string, MaskTint>();
  /** Per-layer pixel revision (tint cache key); globally monotonic. */
  private readonly revisions = new Map<string, number>();
  private revisionCounter = 0;

  /** Where the previous stroke ended, document coords (Shift+click line start). */
  lastStrokeEnd: Point | null = null;

  /**
   * @param doc - Document (copied).
   * @param source - Origin of its frame size.
   * @param store - Existing pixels (for clones); a blank store is created otherwise.
   */
  constructor(doc: PainterDocument, source: FrameSource, store?: LayerStore) {
    this.docState = cloneDocument(doc);
    this.frameSourceState = source;
    this.store = store ?? new LayerStore(doc.bounds);
    for (const layer of doc.layers) {
      this.store.ensure(layer.id);
      this.runtime.set(layer.id, { dirty: false, version: 0, hasContent: layer.file !== null });
    }
    this.syncViewFrame();
  }

  // ── Read access ─────────────────────────────────────────────────────────

  /** Current document (treat as read-only). */
  get doc(): Readonly<PainterDocument> {
    return this.docState;
  }

  /** Where the frame size came from. */
  get frameSource(): FrameSource {
    return this.frameSourceState;
  }

  /** Undo available. */
  get canUndo(): boolean {
    return this.history.canUndo && !this.stroke.active;
  }

  /** Redo available. */
  get canRedo(): boolean {
    return this.history.canRedo && !this.stroke.active;
  }

  /** Layer files are being restored; painting is disabled. */
  get loading(): boolean {
    return this.loadingCount > 0;
  }

  /** Whether any layer has ever held paint. */
  get hasPaint(): boolean {
    for (const r of this.runtime.values()) if (r.hasContent) return true;
    return false;
  }

  /** Whether any layer needs uploading. */
  get dirty(): boolean {
    for (const r of this.runtime.values()) if (r.dirty) return true;
    return false;
  }

  /**
   * Whether any mask layer is currently hidden AND has ever held paint
   * (non-empty pixels). Used at queue time to warn the user their mask will
   * not be included in the MASK output.
   * @returns `true` if a hidden-but-painted mask exists.
   */
  hiddenMaskHasContent(): boolean {
    for (const layer of this.docState.layers) {
      if (layer.kind !== "mask" || layer.visible) continue;
      const rt = this.runtime.get(layer.id);
      if (rt?.hasContent) return true;
    }
    return false;
  }

  /** Background drawn under the paint. */
  get background(): FrameBackground {
    return this.backgroundState;
  }

  /**
   * Size of what the view shows: the background image, or `doc.frame` when
   * there is no image (disconnected -> `background` fill, s = 1).
   */
  get imageSize(): Size {
    const size = this.backgroundSize;
    if (this.backgroundState.kind === "image" && size) return { ...size };
    return { ...this.docState.frame };
  }

  /** Document -> image transform (same as Python's frame-mismatch placement). */
  get frameMap(): FrameMap {
    return frameMap(this.docState.frame, this.imageSize);
  }

  /**
   * Runtime state of a layer.
   * @param layerId - Layer id.
   * @returns Bookkeeping or `undefined`.
   */
  layerRuntime(layerId: string): Readonly<LayerRuntime> | undefined {
    return this.runtime.get(layerId);
  }

  /**
   * Canvas of a layer (for export/upload).
   * @param layerId - Layer id.
   * @returns The canvas.
   */
  layerCanvas(layerId: string): HTMLCanvasElement {
    return this.store.ensure(layerId).canvas;
  }

  /** Current paint bounds (document coords). */
  get bounds(): Rect {
    return this.store.bounds;
  }

  /**
   * Visible layers to composite, using the live stroke preview for the layer
   * being painted.
   * @returns Bottom -> top layers.
   */
  compositeLayers(): CompositeLayer[] {
    const out: CompositeLayer[] = [];
    for (const layer of this.docState.layers) {
      if (!layer.visible || layer.kind === "mask") continue;
      const surface = this.store.ensure(layer.id);
      const source =
        this.strokeLayerId === layer.id && this.stroke.active ? this.stroke.updatePreview(surface).canvas : surface.canvas;
      out.push({ source, opacity: layer.opacity });
    }
    return out;
  }

  /**
   * Visible mask layers as tinted overlays (drawn above all paint). Uses the
   * live stroke preview for the mask being painted and re-tints only the
   * region the stroke dirtied since the last frame.
   * @returns Bottom -> top overlays.
   */
  maskOverlays(): MaskOverlay[] {
    const out: MaskOverlay[] = [];
    const bounds = this.store.bounds;
    for (const layer of this.docState.layers) {
      if (!layer.visible || layer.kind !== "mask") continue;
      const surface = this.store.ensure(layer.id);
      const stroking = this.strokeLayerId === layer.id && this.stroke.active;
      const source = stroking ? this.stroke.updatePreview(surface).canvas : surface.canvas;
      let tint = this.tints.get(layer.id);
      if (!tint) {
        tint = new MaskTint();
        this.tints.set(layer.id, tint);
      }
      const color = maskDisplayColor(layer);
      const invert = layer.invert === true;
      const key = { bounds, color, invert, revision: this.revisions.get(layer.id) ?? 0 };
      const canvas = tint.update(source, key, stroking ? this.stroke.lastRefreshed : null);
      out.push({ tint: canvas, color, opacity: layer.opacity, invert });
    }
    return out;
  }

  // ── Quick Mask / paint target ───────────────────────────────────────────

  /** What brush/eraser strokes paint into (UI state, not saved). */
  get paintTarget(): PaintTarget {
    return this.target;
  }

  /** The mask layer Quick Mask edits, if the document has one. */
  get maskLayer(): Readonly<Layer> | undefined {
    return findMaskLayer(this.docState);
  }

  /**
   * Switch the paint target (Quick Mask, `Q`). Targeting the mask adds a
   * default mask layer to documents that have none.
   * @param target - New target.
   */
  setPaintTarget(target: PaintTarget): void {
    if (target === this.target) return;
    if (this.stroke.active) this.cancelStroke();
    if (target === "mask") this.ensureMask();
    this.target = target;
    this.events.emit("mask", undefined);
  }

  /** Toggle between the paint layer and the mask. */
  togglePaintTarget(): void {
    this.setPaintTarget(this.target === "mask" ? "paint" : "mask");
  }

  /**
   * Show or hide the mask layer (adds one if missing). Hidden mask layers are
   * also excluded from the `MASK` output (saved-file contract).
   * @param visible - Visibility.
   */
  setMaskVisible(visible: boolean): void {
    const layer = this.ensureMask();
    if (layer.visible === visible) return;
    if (this.stroke.active && this.strokeLayerId === layer.id) this.cancelStroke();
    layer.visible = visible;
    this.events.emit("mask", undefined);
    this.events.emit("change", undefined);
    this.events.emit("render", undefined);
  }

  // ── Background / frame ──────────────────────────────────────────────────

  /**
   * Set what is drawn under the paint. The view re-fits to the new image size
   * (in fit mode); layer pixels are untouched.
   * @param background - Image or fill.
   * @param imageSize - Natural size when `background` is an image.
   */
  setBackground(background: FrameBackground, imageSize: Size | null): void {
    this.backgroundState = background;
    this.backgroundSize = background.kind === "image" && imageSize ? { ...imageSize } : null;
    this.syncViewFrame();
    this.events.emit("render", undefined);
  }

  /**
   * A new background image size arrived. An empty document (no paint, no
   * history) adopts it; otherwise nothing changes -- the document is simply
   * drawn through {@link frameMap} (decision 4). Deferred while layer files
   * are loading.
   * @param size - Image size.
   */
  handleBackgroundSize(size: Size): void {
    if (this.loading) {
      this.pendingBackgroundSize = { ...size };
      return;
    }
    const frame = this.docState.frame;
    if (size.width === frame.width && size.height === frame.height) {
      this.frameSourceState = "image";
      return;
    }
    if (this.isEmpty) this.adoptFrame(size, "image");
  }

  /**
   * Adopt `size` only for an empty document whose frame came from widgets
   * (the `width`/`height` widgets apply to fresh documents only).
   * @param size - Widget frame size.
   */
  handleWidgetFrame(size: Size): void {
    if (this.loading || !this.isEmpty || this.frameSourceState !== "widgets") return;
    const frame = this.docState.frame;
    if (size.width !== frame.width || size.height !== frame.height) this.adoptFrame(size, "widgets");
  }

  /**
   * Replace the frame of an empty document (no history).
   * @param size - New frame.
   * @param source - Origin of the size.
   */
  adoptFrame(size: Size, source: FrameSource): void {
    if (this.stroke.active) this.cancelStroke();
    const frame = { width: Math.round(size.width), height: Math.round(size.height) };
    this.docState.frame = frame;
    this.docState.bounds = frameRect(frame);
    this.frameSourceState = source;
    this.store.reset(this.docState.bounds);
    for (const layer of this.docState.layers) {
      this.store.ensure(layer.id);
      layer.file = null;
      this.runtime.set(layer.id, { dirty: false, version: 0, hasContent: false });
      this.bumpRevision(layer.id);
    }
    this.history.clear();
    this.lastStrokeEnd = null;
    this.syncViewFrame();
    this.events.emit("history", undefined);
    this.events.emit("change", undefined);
    this.events.emit("render", undefined);
  }

  /**
   * Clear all paint (every layer, masks included; the layer list is kept) and
   * reset the frame to the current image size (or the current fallback frame
   * when no image is shown). One undoable step that restores the full prior
   * state; the snapshot counts against the history memory cap.
   */
  clear(): void {
    if (this.loading) return;
    if (this.stroke.active) this.cancelStroke();
    const size = this.imageSize;
    const frame = { width: Math.max(1, Math.round(size.width)), height: Math.max(1, Math.round(size.height)) };
    const source: FrameSource = this.backgroundState.kind === "image" && this.backgroundSize ? "image" : this.frameSourceState;
    const before = this.captureSnapshot();
    const after: DocSnapshot = { frame, bounds: frameRect(frame), source, pixels: null };
    this.applySnapshot(after);
    this.history.push({ kind: "clear", before, after, bytes: snapshotBytes(before) });
    this.lastStrokeEnd = null;
    this.afterEdit();
  }

  // ── Restore bookkeeping (persistence) ───────────────────────────────────

  /** Mark the start of an async layer restore (disables painting). */
  beginLoading(): void {
    this.loadingCount++;
  }

  /** Mark the end of an async layer restore; applies a deferred frame change. */
  endLoading(): void {
    this.loadingCount = Math.max(0, this.loadingCount - 1);
    this.events.emit("render", undefined);
    if (!this.loading && this.pendingBackgroundSize) {
      const size = this.pendingBackgroundSize;
      this.pendingBackgroundSize = null;
      this.handleBackgroundSize(size);
    }
  }

  /**
   * Draw a restored PNG into a layer (not an undo step, not dirty).
   * @param layerId - Layer id.
   * @param image - Decoded PNG (sized to `bounds`).
   */
  restoreLayerPixels(layerId: string, image: CanvasImageSource): void {
    const surface = this.store.ensure(layerId);
    surface.ctx.clearRect(0, 0, surface.canvas.width, surface.canvas.height);
    surface.ctx.drawImage(image, 0, 0);
    this.bumpRevision(layerId);
    this.events.emit("render", undefined);
  }

  /**
   * Record a finished upload.
   * @param layerId - Layer id.
   * @param version - Layer version that was uploaded.
   * @param file - Stored file reference (`null` for an empty layer).
   */
  markUploaded(layerId: string, version: number, file: string | null): void {
    const layer = this.docState.layers.find((l) => l.id === layerId);
    const rt = this.runtime.get(layerId);
    if (!layer || !rt) return;
    layer.file = file;
    if (rt.version === version) rt.dirty = false;
    this.events.emit("change", undefined);
  }

  // ── Strokes ─────────────────────────────────────────────────────────────

  /**
   * Start a stroke on the paint target: the active paint layer, or the mask
   * layer in Quick Mask mode (where the brush colour is replaced by white so
   * coverage lands in alpha; opacity/flow/hardness work unchanged).
   * @param style - Stroke appearance.
   * @param maxDiameter - Largest dab diameter this stroke can produce, document px.
   * @returns `false` if painting is not possible (loading, locked, hidden).
   */
  beginStroke(style: StrokeStyle, maxDiameter: number): boolean {
    if (this.loading || this.stroke.active) return false;
    const layer = this.target === "mask" ? this.ensureMask() : targetLayer(this.docState, "paint");
    if (!layer || layer.locked) return false;
    if (!layer.visible) {
      this.events.emit("note", layer.kind === "mask" ? HIDDEN_MASK_NOTE : "The layer is hidden.");
      return false;
    }
    const strokeStyle = layer.kind === "mask" ? { ...style, color: MASK_STROKE_COLOR } : style;
    this.strokeLayerId = layer.id;
    this.strokeDiameter = Math.max(1, maxDiameter);
    this.stroke.begin(this.store.ensure(layer.id), this.store.bounds, strokeStyle);
    this.events.emit("history", undefined);
    return true;
  }

  /**
   * Add dabs to the current stroke, growing bounds when they go off-frame.
   * @param dabs - Dabs in document coords.
   */
  addDabs(dabs: readonly Dab[]): void {
    if (!this.stroke.active || dabs.length === 0) return;
    let need: Rect = { x: 0, y: 0, width: 0, height: 0 };
    for (const dab of dabs) {
      const r = dab.size / 2 + 1;
      need = unionRect(need, { x: dab.x - r, y: dab.y - r, width: r * 2, height: r * 2 });
    }
    this.ensureBounds(need, true);
    this.stroke.addDabs(dabs, this.stamps, this.strokeDiameter);
    this.events.emit("render", undefined);
  }

  /**
   * Commit the stroke to its layer as one undo step.
   * @param end - Where the stroke ended, document coords (for Shift+click lines).
   */
  endStroke(end: Point | null): void {
    const layerId = this.strokeLayerId;
    if (!this.stroke.active || !layerId) return;
    const rect = this.stroke.touched;
    const surface = this.store.ensure(layerId);
    if (isEmptyRect(rect)) {
      this.stroke.cancel();
    } else {
      const before = this.store.read(layerId, rect);
      this.stroke.commit(surface);
      const after = this.store.read(layerId, rect);
      if (before && after) {
        const bytes = before.data.data.byteLength + after.data.data.byteLength;
        this.history.push({ kind: "patch", layerId, x: before.rect.x, y: before.rect.y, before: before.data, after: after.data, bytes });
        this.touchLayer(layerId);
      }
    }
    this.strokeLayerId = null;
    if (end) this.lastStrokeEnd = { ...end };
    this.afterEdit();
  }

  /** Abort the current stroke. */
  cancelStroke(): void {
    this.stroke.cancel();
    // The mask tint may hold the discarded preview: rebuild it from the layer.
    if (this.strokeLayerId) this.bumpRevision(this.strokeLayerId);
    this.strokeLayerId = null;
    this.events.emit("history", undefined);
    this.events.emit("render", undefined);
  }

  // ── Undo / redo ─────────────────────────────────────────────────────────

  /** Undo the last operation. */
  undo(): void {
    if (!this.canUndo) return;
    const entry = this.history.undo();
    if (entry) this.applyEntry(entry, "before");
    this.afterEdit();
  }

  /** Redo the last undone operation. */
  redo(): void {
    if (!this.canRedo) return;
    const entry = this.history.redo();
    if (entry) this.applyEntry(entry, "after");
    this.afterEdit();
  }

  // ── Cloning / teardown ──────────────────────────────────────────────────

  /**
   * Independent copy with a new document id (used when a node is duplicated
   * while its source is still live). History is not copied.
   * @param docId - New id.
   * @returns New editor.
   */
  fork(docId: string): Editor {
    const doc = cloneDocument(this.docState);
    doc.docId = docId;
    const copy = new Editor(doc, this.frameSourceState, this.store.clone());
    for (const [id, rt] of this.runtime) copy.runtime.set(id, { ...rt });
    copy.setBackground(this.backgroundState, this.backgroundSize);
    return copy;
  }

  /** Estimated memory held (pixels + history; mask tint caches excluded). */
  get bytes(): number {
    return this.store.bytes + this.history.totalBytes;
  }

  /** Release everything. */
  dispose(): void {
    this.stroke.dispose();
    this.store.dispose();
    for (const tint of this.tints.values()) tint.dispose();
    this.tints.clear();
    this.history.clear();
    this.stamps.clear();
    this.events.clear();
  }

  // ── Internals ───────────────────────────────────────────────────────────

  /** No paint ever and nothing in history that depends on the frame. */
  private get isEmpty(): boolean {
    return !this.hasPaint && !this.history.canUndo && !this.history.canRedo;
  }

  /** The view fits the image, not the document frame. */
  private syncViewFrame(): void {
    this.view.setFrame(this.imageSize);
  }

  private captureSnapshot(): DocSnapshot {
    const pixels = new Map<string, ImageData>();
    for (const layer of this.docState.layers) pixels.set(layer.id, this.store.snapshot(layer.id));
    return { frame: { ...this.docState.frame }, bounds: this.store.bounds, source: this.frameSourceState, pixels };
  }

  private applySnapshot(state: DocSnapshot): void {
    this.docState.frame = { ...state.frame };
    this.docState.bounds = { ...state.bounds };
    this.frameSourceState = state.source;
    this.store.reset(state.bounds);
    for (const layer of this.docState.layers) {
      const data = state.pixels?.get(layer.id);
      if (data) this.store.write(layer.id, state.bounds.x, state.bounds.y, data);
      else this.store.ensure(layer.id);
      this.touchLayer(layer.id);
    }
    this.syncViewFrame();
  }

  private applyEntry(entry: HistoryEntry, side: "before" | "after"): void {
    if (entry.kind === "clear") {
      this.applySnapshot(side === "before" ? entry.before : entry.after);
      this.lastStrokeEnd = null;
      return;
    }
    if (!this.docState.layers.some((l) => l.id === entry.layerId)) return;
    const data = side === "before" ? entry.before : entry.after;
    this.ensureBounds({ x: entry.x, y: entry.y, width: data.width, height: data.height }, false);
    this.store.write(entry.layerId, entry.x, entry.y, data);
    this.touchLayer(entry.layerId);
  }

  /**
   * Grow bounds to cover `need`. Chunked + capped for strokes; exact and
   * uncapped when re-applying history.
   */
  private ensureBounds(need: Rect, chunked: boolean): void {
    const current = this.store.bounds;
    if (containsRect(current, need)) return;
    const next = chunked ? growBounds(current, need, this.docState.frame) : unionRect(current, need);
    if (containsRect(next, current) && (next.width !== current.width || next.height !== current.height)) {
      this.store.rebase(next);
      this.stroke.rebase(next);
      this.docState.bounds = { ...next };
    }
  }

  private touchLayer(layerId: string): void {
    this.bumpRevision(layerId);
    const rt = this.runtime.get(layerId);
    if (!rt) return;
    rt.dirty = true;
    rt.version++;
    rt.hasContent = true;
  }

  /** Committed pixels of a layer changed (invalidates its mask tint). */
  private bumpRevision(layerId: string): void {
    this.revisions.set(layerId, ++this.revisionCounter);
  }

  /**
   * The mask layer, adding a default one (not dirty, no history) when the
   * document has none -- documents saved before M2 get one lazily.
   */
  private ensureMask(): Layer {
    const { layer, created } = ensureMaskLayer(this.docState);
    if (created) {
      this.store.ensure(layer.id);
      this.runtime.set(layer.id, { dirty: false, version: 0, hasContent: false });
      this.events.emit("change", undefined);
      this.events.emit("mask", undefined);
    }
    return layer;
  }

  private afterEdit(): void {
    this.events.emit("history", undefined);
    this.events.emit("change", undefined);
    this.events.emit("render", undefined);
  }
}

function snapshotBytes(state: DocSnapshot): number {
  let bytes = 0;
  if (state.pixels) for (const data of state.pixels.values()) bytes += data.data.byteLength;
  return bytes;
}
