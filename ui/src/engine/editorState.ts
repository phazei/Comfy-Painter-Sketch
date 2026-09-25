/**
 * Mutable state shared by the editor core modules (`frameOps.ts`,
 * `paintOps.ts`, `docIO.ts`, `layerDisplay.ts`), plus the few helpers they
 * all need. Internal to `engine/`: the public surface is `Editor`.
 */

import { ensureMaskLayer } from "../document/masks";
import type { PaintTarget } from "../document/masks";
import type { Layer, PainterDocument } from "../document/types";
import { cloneDocument } from "../document/serialize";
import { containsRect, unionRect } from "../geometry/rect";
import type { Point, Rect, Size } from "../geometry/rect";
import { growBounds } from "./bounds";
import type { FrameBackground } from "./compositor";
import type { EditorEvents, FrameSource, HistoryEntry } from "./editorTypes";
import { Emitter } from "./emitter";
import { HistoryStack } from "./history";
import { LayerRuntimeTable } from "./layerRuntime";
import { LayerStore } from "./layerStore";
import { StrokeBuffer } from "./stroke";
import { ViewState } from "./view";

/**
 * Document, pixels, history, stroke and view state of one editor.
 */
export class EditorState {
  readonly events = new Emitter<EditorEvents>();
  readonly view = new ViewState();
  readonly history = new HistoryStack<HistoryEntry>();
  readonly stroke = new StrokeBuffer();
  readonly runtime = new LayerRuntimeTable();
  readonly store: LayerStore;

  doc: PainterDocument;
  frameSource: FrameSource;
  background: FrameBackground = { kind: "fill", color: "#ffffff" };
  /**
   * Size of the current image: the background image's natural size, or the
   * `width` x `height` widgets under a fill. `null` = unknown (use `doc.frame`).
   */
  backgroundSize: Size | null = null;
  loadingCount = 0;
  /** Background size that arrived while loading (applied afterwards). */
  pendingBackgroundSize: Size | null = null;
  /** Quick Mask paint target (UI state, not saved). */
  target: PaintTarget = "paint";
  /** Layer the current stroke paints into. */
  strokeLayerId: string | null = null;
  /** Largest dab diameter of the current stroke, document px. */
  strokeDiameter = 1;
  /** Where the previous stroke ended, document coords. */
  lastStrokeEnd: Point | null = null;

  /**
   * @param doc - Document (copied).
   * @param source - Origin of its frame size.
   * @param store - Existing pixels (for clones); a blank store is created otherwise.
   */
  constructor(doc: PainterDocument, source: FrameSource, store?: LayerStore) {
    this.doc = cloneDocument(doc);
    this.frameSource = source;
    this.store = store ?? new LayerStore(doc.bounds);
    for (const layer of doc.layers) {
      this.store.ensure(layer.id);
      this.runtime.reset(layer.id, layer.file !== null);
    }
    this.syncViewFrame();
  }

  /** Layer files are being restored. */
  get loading(): boolean {
    return this.loadingCount > 0;
  }

  /** Size the view shows: the current image (image or widget-sized fill), else `doc.frame`. */
  get imageSize(): Size {
    const size = this.backgroundSize;
    return size ? { ...size } : { ...this.doc.frame };
  }

  /** No paint ever and nothing in history that depends on the frame. */
  get isEmpty(): boolean {
    return !this.runtime.hasPaint && !this.history.canUndo && !this.history.canRedo;
  }

  /** The view fits the image, not the document frame. */
  syncViewFrame(): void {
    this.view.setFrame(this.imageSize);
  }

  /**
   * Grow bounds to cover `need`. Chunked + capped for strokes; exact and
   * uncapped when re-applying history.
   * @param need - Document rect that must be covered.
   * @param chunked - Stroke growth (256 px chunks, capped).
   */
  ensureBounds(need: Rect, chunked: boolean): void {
    const current = this.store.bounds;
    if (containsRect(current, need)) return;
    const next = chunked ? growBounds(current, need, this.doc.frame) : unionRect(current, need);
    if (containsRect(next, current) && (next.width !== current.width || next.height !== current.height)) {
      this.store.rebase(next);
      this.stroke.rebase(next);
      this.doc.bounds = { ...next };
    }
  }

  /**
   * The mask layer, adding a default one (not dirty, no history) when the
   * document has none -- documents saved before M2 get one lazily.
   * @returns The mask layer.
   */
  ensureMask(): Layer {
    const { layer, created } = ensureMaskLayer(this.doc);
    if (created) {
      this.store.ensure(layer.id);
      this.runtime.reset(layer.id, false);
      this.events.emit("change", undefined);
      this.events.emit("mask", undefined);
    }
    return layer;
  }

  /** Abort the current stroke (its preview may be cached in a mask tint). */
  cancelStroke(): void {
    this.stroke.cancel();
    if (this.strokeLayerId) this.runtime.bump(this.strokeLayerId);
    this.strokeLayerId = null;
    this.events.emit("history", undefined);
    this.events.emit("render", undefined);
  }

  /** Notify history, content and render listeners after an edit. */
  afterEdit(): void {
    this.events.emit("history", undefined);
    this.events.emit("change", undefined);
    this.events.emit("render", undefined);
  }
}
