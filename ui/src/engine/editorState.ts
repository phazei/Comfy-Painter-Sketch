/**
 * Mutable state shared by the editor core modules (`frameOps.ts`,
 * `paintOps.ts`, `docIO.ts`, `layerDisplay.ts`), plus the few helpers they
 * all need. Internal to `engine/`: the public surface is `Editor`.
 */

import { DEFAULT_MASK_STYLE } from "../document/create";
import type { MaskStyle } from "../document/create";
import { IMAGE_MASK_ID } from "../document/imageMask";
import { layerMaskKey, maskOwner } from "../document/layerMask";
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
import { ImageMaskPixels } from "./imageMask";
import { KeptOriginals } from "./keptOriginal";
import { initMaskSurfaces, LayerMaskState, surfaceKeys } from "./layerMask";
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
  /** Pre-transform originals per layer (memory only; `keptOriginal.ts`). */
  readonly kept = new KeptOriginals();
  /** Current selection (session state, not saved); strokes are clipped to it. */
  readonly selection = new SelectionState(() => this.events.emit("selection", undefined));
  /** Image Mask coverage (image px; metadata is `doc.imageMask`). */
  readonly imageMask = new ImageMaskPixels();
  /** Layer masks: targets, Alt view, mask swatches, display caches (`layerMask.ts`). */
  readonly layerMasks = new LayerMaskState();
  /** Solo (view only; not saved/undoable, ignored by outputs). */
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
   * Current mask: the last selected mask row, what Quick Mask paints
   * into (UI state, not saved). `null` or a deleted id = the top-most mask.
   */
  currentMaskId: string | null = null;
  /**
   * Last real cmask (never the Image/Input Mask row): what "To mask" adds to
   * and where "New mask" inserts. Selecting the read-only row changes
   * `currentMaskId` but keeps this, so those commands never land on a row
   * that refuses every edit. Write both through {@link setCurrentMask}.
   */
  lastCmaskId: string | null = null;
  /**
   * A read-only SOURCE row is the selection (the Background row; UI state,
   * not saved, not in history). Wins over `target`: every pixel edit is
   * refused (`rasterize.ts` `editBlockNote`) and no lmask is targeted.
   * Cleared by any other selection: `setActiveLayer`, `selectMask`,
   * `setPaintTarget`, and an insert that activates a new layer.
   */
  sourceSelected: "background" | null = null;
  /** Selected output row/region (session-only). */
  selectedRegionId: string | null = null;
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
   * Commit a floating selection, if any (`floatOps.ts` installs it). Called
   * before every other edit / history action -- the float's central hook.
   */
  settleFloat: () => void = () => undefined;
  /** Store key of the floating selection (layer id or lmask key), or `null` (`floatOps.ts` installs it). */
  floatKey: () => string | null = () => null;
  /** Commit an open text edit, if any (`textOps.ts` installs it; Free Transform calls it first). */
  commitTextEdit: () => void = () => undefined;
  /**
   * Live display of a layer with its floating selection (hole + float at
   * its offset), or `null` when the layer has no float (`floatOps.ts`).
   */
  floatPreview: (layerId: string) => HTMLCanvasElement | null = () => null;
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
    initMaskSurfaces(this);
    this.stroke.setClip(() => this.selection.clipCanvas(this.store.bounds));
    this.syncViewFrame();
    // A solo ends when its layer (or the Image Mask row) goes (every layer-list change emits `layers`).
    this.events.on("layers", () => {
      const rows = this.doc.imageMask ? [...this.doc.layers, this.doc.imageMask] : this.doc.layers;
      this.solo.set(pruneSolo(this.solo.current, rows));
    });
    // Kept originals (layers and their lmasks) die with their layer and with any other edit of it.
    this.events.on("layers", () => this.kept.prune(surfaceKeys(this.doc.layers)));
    this.events.on("change", () => {
      for (const key of surfaceKeys(this.doc.layers)) if (this.kept.has(key)) this.kept.get(key, this.runtime.revision(key));
    });
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

  /**
   * The document may adopt a new frame: no paint or text, and no history
   * step since the newest Clear (or ever) other than selection changes.
   * Output metadata edits (regions, Main options) count as content, like
   * `hasDocumentContent`; Clear resets them.
   */
  get isEmpty(): boolean {
    if (this.runtime.hasPaint || this.doc.layers.some((l) => l.kind === "text")) return false;
    return this.history.since((e) => e.kind === "clear").newer.every((e) => e.kind === "selection");
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
   * @param within - Chunked growth stops here too (painting: `paintLimit`).
   */
  ensureBounds(need: Rect, chunked: boolean, within?: Rect): void {
    const current = this.store.bounds;
    if (containsRect(current, need)) return;
    const next = chunked ? growBounds(current, need, this.doc.frame, undefined, within) : unionRect(current, need);
    if (containsRect(next, current) && (next.width !== current.width || next.height !== current.height)) this.setBounds(next);
  }

  /**
   * Shrink the bounds back to `base` after a float grew them only to show
   * itself (`FloatState.boundsBase`): nothing outside `base` holds pixels
   * then. Ignored unless `base` lies inside the current bounds.
   * @param base - Bounds before the float.
   */
  restoreBounds(base: Rect): void {
    const current = this.store.bounds;
    if (!containsRect(current, base) || (base.width === current.width && base.height === current.height)) return;
    this.setBounds(base);
  }

  /** Re-base every surface to `next` and mark every layer for re-upload. */
  private setBounds(next: Rect): void {
    this.store.rebase(next);
    this.stroke.rebase(next);
    this.doc.bounds = { ...next };
    for (const layer of this.doc.layers) {
      this.runtime.resized(layer.id);
      // A mask's new area holds its `outside` value: always a new file (and a new cache).
      // Its pixels are unchanged, so a valid kept original stays valid.
      if (layer.layerMask) {
        const key = layerMaskKey(layer.id);
        const kept = this.kept.get(key, this.runtime.revision(key));
        this.runtime.touch(key);
        if (kept) kept.revision = this.runtime.revision(key);
      }
    }
  }

  /**
   * The current mask layer, adding a default one (not dirty, no history)
   * when the document has none -- older documents with no mask layer get one lazily.
   * @returns The mask layer.
   */
  ensureMask(): Layer {
    return this.ensureMaskFor(this.currentMaskId);
  }

  /**
   * The last real cmask ({@link lastCmaskId}; the Image/Input Mask row never
   * counts), adding a default one like {@link ensureMask} when the document
   * has none. "To mask" and "New mask" use this.
   * @returns The cmask layer.
   */
  ensureCmask(): Layer {
    return this.ensureMaskFor(this.lastCmaskId);
  }

  /**
   * Set the current mask; a real cmask id also becomes {@link lastCmaskId}.
   * @param id - Mask id, the Image/Input Mask id, or `null` (top-most).
   */
  setCurrentMask(id: string | null): void {
    this.currentMaskId = id;
    if (id !== IMAGE_MASK_ID) this.lastCmaskId = id;
  }

  private ensureMaskFor(id: string | null): Layer {
    const { layer, created } = ensureMaskLayer(this.doc, this.maskStyle, id);
    if (created) {
      this.store.ensure(layer.id);
      this.runtime.reset(layer.id, false);
      this.events.emit("change", undefined);
      this.events.emit("mask", undefined);
    }
    return layer;
  }

  /**
   * Id of the layer the floating selection belongs to (the owner of an
   * lmask float), or `null` without a float. View changes (eyes, solo, lmask
   * on/off) commit the float only when they touch this layer.
   * @returns Layer id or `null`.
   */
  floatLayerId(): string | null {
    const key = this.floatKey();
    return key === null ? null : (maskOwner(key) ?? key);
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
