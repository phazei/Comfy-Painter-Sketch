/**
 * Mutable state shared by the editor core modules (`frameOps.ts`,
 * `paintOps.ts`, `docIO.ts`, `layerDisplay.ts`), plus the few helpers they
 * all need. Internal to `engine/`: the public surface is `Editor`.
 */

import { DEFAULT_MASK_STYLE } from "../document/create";
import type { MaskStyle } from "../document/create";
import { ensureMaskLayer } from "../document/masks";
import type { PaintTarget } from "../document/masks";
import type { Layer, PainterDocument } from "../document/types";
import { cloneDocument } from "../document/serialize";
import { containsRect, unionRect } from "../geometry/rect";
import type { Point, Rect, Size } from "../geometry/rect";
import { growBounds } from "./bounds";
import type { FrameBackground } from "./compositor";
import { groupEntries } from "./editorTypes";
import type { EditorEvents, FrameSource, HistoryEntry } from "./editorTypes";
import { Emitter } from "./emitter";
import { DEFAULT_HISTORY_BYTES, HistoryStack } from "./history";
import { LayerRuntimeTable } from "./layerRuntime";
import { LayerStore } from "./layerStore";
import { SelectionState } from "./selectionState";
import { pruneSolo, SoloState } from "./solo";
import { StrokeBuffer } from "./stroke";
import { ViewState } from "./view";

/**
 * Document, pixels, history, stroke and view state of one editor.
 */
export class EditorState {
  readonly events = new Emitter<EditorEvents>();
  /** View commands (Fit, Ctrl+0/1, zoom, pan) emit `render` themselves, whoever calls them. */
  readonly view = new ViewState(() => this.events.emit("render", undefined));
  readonly history = new HistoryStack<HistoryEntry>(DEFAULT_HISTORY_BYTES, groupEntries);
  readonly stroke = new StrokeBuffer();
  readonly runtime = new LayerRuntimeTable();
  readonly store: LayerStore;
  /** Current selection (session state, not saved); strokes are clipped to it. */
  readonly selection = new SelectionState(() => this.events.emit("selection", undefined));
  /** Solo (M8, view only; not saved/undoable, ignored by outputs). */
  readonly solo = new SoloState(() => {
    this.events.emit("solo", undefined);
    this.events.emit("render", undefined);
  });

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
  /**
   * Current mask (M8): the last selected mask row, what Quick Mask paints
   * into (UI state, not saved). `null` or a deleted id = the top-most mask.
   */
  currentMaskId: string | null = null;
  /** Layer the current stroke paints into. */
  strokeLayerId: string | null = null;
  /** Largest dab diameter of the current stroke, document px. */
  strokeDiameter = 1;
  /** Where the previous stroke ended, document coords. */
  lastStrokeEnd: Point | null = null;
  /**
   * Move-tool drag in progress: the layer is drawn offset by (dx, dy)
   * document px; pixels move only on commit (`moveOps.ts`).
   */
  movePreview: { layerId: string; dx: number; dy: number } | null = null;
  /**
   * Asks the user whether a text layer may be rasterized (`rasterize.ts`);
   * the UI installs a `window.confirm` (the engine has no DOM UI). Default: no.
   */
  confirmRasterize: () => boolean = () => false;
  /**
   * Style of a mask layer added lazily ({@link ensureMask}); the session
   * installs one that reads the user's settings. Default: built-in red, 50 %.
   */
  maskStyle: () => Readonly<MaskStyle> = () => DEFAULT_MASK_STYLE;

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
    this.stroke.setClip(() => this.selection.clipCanvas(this.store.bounds));
    this.syncViewFrame();
    // A solo ends when its layer is deleted (every layer-list change emits `layers`).
    this.events.on("layers", () => this.solo.set(pruneSolo(this.solo.current, this.doc.layers)));
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

  /** No paint ever and nothing in history that depends on the frame (selection steps don't count). */
  get isEmpty(): boolean {
    return !this.runtime.hasPaint && !this.history.some((entry) => entry.kind !== "selection");
  }

  /** The view fits the image, not the document frame. */
  syncViewFrame(): void {
    this.view.setFrame(this.imageSize);
  }

  /**
   * Grow bounds to cover `need`. Chunked + capped for strokes; exact and
   * uncapped when re-applying history. Every layer with content is marked
   * for re-upload: layer files are sized to `bounds`, and a file saved at
   * the old bounds would be restored at the wrong origin.
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
      for (const layer of this.doc.layers) this.runtime.resized(layer.id);
    }
  }

  /**
   * The current mask layer, adding a default one (not dirty, no history)
   * when the document has none -- documents saved before M2 get one lazily.
   * @returns The mask layer.
   */
  ensureMask(): Layer {
    const { layer, created } = ensureMaskLayer(this.doc, this.maskStyle, this.currentMaskId);
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
