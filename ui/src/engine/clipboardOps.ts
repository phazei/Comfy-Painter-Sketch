/**
 * Copy / cut / paste on the editor core (SPEC "Floating selections +
 * clipboard (M10)", Clipboard block), exposed as `Editor.clipboard`. The
 * engine only produces and consumes pixels; the system clipboard, clipspace
 * and the internal clipboard live in the UI (`ui/clipboardActions.ts`).
 *
 * - {@link ClipboardOps.copy}: the current edit layer's selected pixels
 *   (coverage-weighted alpha), or its whole content without a selection,
 *   trimmed to the non-transparent bbox. A mask copies as an OPAQUE
 *   grayscale image (white = masked; what other apps expect). `merged` =
 *   what is visible incl. the image, within the selection or the image area.
 * - {@link ClipboardOps.cut}: copy + clear the same pixels (one patch, via
 *   the `preparePixelEdit` gate; a text layer is rasterized first, same step).
 * - {@link ClipboardOps.paste}: a new ordinary paint layer above the current
 *   paint layer (the top-most paint layer when a mask is current), Quick
 *   Mask off, one `layers` undo entry holding the pixels. A paste reaching
 *   past the paint-area cap instead starts like an image-source insert
 *   (`sourceInsert.ts`, native size, same placement) and crops on commit. The new layer takes over solo (`LayerOps.addWithPixels`).
 *   An active selection is dropped (Photoshop), in the same undo step.
 * - Copy merged under Quick Mask: the visible masks' effective union as
 *   grayscale (same format as a single-mask copy).
 *
 * Every command settles a floating selection first.
 */

import { createPaintLayer } from "../document/create";
import { isPaintLike, paintInsertIndex } from "../document/layerList";
import { activeEditLayer } from "../document/masks";
import type { Layer } from "../document/types";
import { frameRect, intersectRect, isEmptyRect, roundOutRect, unionRect } from "../geometry/rect";
import type { Point, Rect, Size } from "../geometry/rect";
import { boundsCap } from "./bounds";
import { applyCoverage, cropToCap, maskToGray, pasteRect, pastedLayerName, unionMaskCoverage } from "./clipboardMath";
import { readDocRegion, visibleScene } from "./docComposite";
import type { EditorState } from "./editorState";
import { documentMap, imageRectToDoc } from "./frameMap";
import type { LayerOps } from "./layerOps";
import { layerContentRect } from "./layerTranslate";
import { LOCKED_LAYER_NOTE } from "./editorTypes";
import { editBlockNote, preparePixelEdit } from "./rasterize";
import { coverageFor, eraseCoverage, selectionExtent } from "./selection";
import { recordSelectionMove } from "./selectionFollow";
import { shownOnStage } from "./solo";
import { createSurface, releaseSurface } from "./surface";
import { translation } from "./transformMath";
import { alphaBounds } from "./translateMath";

/** Note when a copy/cut finds no pixels. */
export const NOTHING_TO_COPY_NOTE = "Nothing to copy.";

/** Note when a paste reaches past the paint area and starts in Free Transform. */
export const PASTE_TRANSFORM_NOTE = "Paste is larger than the paint area -- placed in Free Transform. Commit to crop, Esc to cancel.";

/** Pixels on their way to a clipboard. */
export interface ClipImage {
  /** Straight-alpha pixels. */
  data: ImageData;
  /** Document rect they came from (paste in place). */
  rect: Rect;
  /** Image px per document px when copied (frame map scale). */
  imageScale: number;
}

/** Where a paste lands. */
export type PastePlacement = { centre: Point } | { topLeft: Point };

/** What {@link ClipboardOps.paste} did. */
export interface PasteResult {
  layerId: string;
  name: string;
  /** The paste reached past the paint-area cap: it runs in a Free Transform session (nothing cropped yet). */
  transform: boolean;
  /** The pixels were resampled once (source px != document px). */
  resampled: boolean;
}

/**
 * Clipboard commands over a shared {@link EditorState}.
 */
export class ClipboardOps {
  /**
   * @param s - Shared editor state.
   * @param layers - Layer commands (undoable insert + solo rule).
   * @param paintTargetOff - Turns Quick Mask off (`Editor.setPaintTarget("paint")`).
   * @param insertPlaced - `SourceInsertOps.insertPlaced` (oversized pastes).
   */
  constructor(
    private readonly s: EditorState,
    private readonly layers: LayerOps,
    private readonly paintTargetOff: () => void,
    private readonly insertPlaced: (pixels: ImageData, name: string, rect: Rect) => string | null,
  ) {}

  /** Image px per document px (the frame map scale). */
  get imageScale(): number {
    return documentMap(this.s.doc, this.s.imageSize).scale;
  }

  /**
   * Ctrl+C / Ctrl+Shift+C.
   * @param merged - Copy what is visible (all layers + the image) instead of the current layer.
   * @returns Pixels, or `null` (note "Nothing to copy." when empty).
   */
  copy(merged: boolean): ClipImage | null {
    const s = this.s;
    if (s.loading || s.stroke.active) return null;
    s.settleFloat();
    const layer = merged ? undefined : this.editLayer();
    // Copying a layer you can't see is refused like an edit (locked is fine to copy).
    const block = layer ? editBlockNote(s, layer) : null;
    if (block && block !== LOCKED_LAYER_NOTE) {
      s.events.emit("note", block);
      return null;
    }
    const clip = merged ? this.copyMerged() : this.copyLayer(layer);
    if (!clip) s.events.emit("note", NOTHING_TO_COPY_NOTE);
    return clip;
  }

  /**
   * Ctrl+X: copy the current layer's selected pixels (whole content without
   * a selection) and clear them, as one undo step.
   * @returns The copied pixels, or `null` if nothing was cut.
   */
  cut(): ClipImage | null {
    const s = this.s;
    if (s.loading || s.stroke.active) return null;
    s.settleFloat();
    const layer = this.editLayer();
    if (!layer || preparePixelEdit(s, layer) === "blocked") return null;
    const area = this.layerArea(layer);
    const clip = area ? this.copyLayer(layer) : null;
    if (!clip || !area) {
      s.events.emit("note", NOTHING_TO_COPY_NOTE);
      return null;
    }
    this.clearArea(layer, area);
    return clip;
  }

  /**
   * Ctrl+V / drop: a new paint layer holding `source`.
   * @param source - Decoded image (ImageBitmap, canvas, ...).
   * @param size - Its pixel size.
   * @param docPerSource - Document px per source px (`1 / imageScale` for image px).
   * @param at - Centre point or top-left, document coords.
   * @returns What happened, or `null` (loading / nothing fits).
   */
  paste(source: CanvasImageSource, size: Size, docPerSource: number, at: PastePlacement): PasteResult | null {
    const s = this.s;
    if (s.loading || size.width <= 0 || size.height <= 0) return null;
    s.settleFloat();
    if (s.stroke.active) s.cancelStroke();
    const full = pasteRect(size, docPerSource, at);
    const { rect, cropped } = cropToCap(full, unionRect(boundsCap(s.doc.frame), s.store.bounds));
    if (cropped) return this.pasteInTransform(source, size, full);
    if (!rect) return null;
    const resampled = full.width !== size.width || full.height !== size.height;
    const surface = createSurface(rect.width, rect.height);
    surface.ctx.imageSmoothingEnabled = resampled;
    surface.ctx.imageSmoothingQuality = "high";
    surface.ctx.drawImage(source, full.x - rect.x, full.y - rect.y, full.width, full.height);
    const data = surface.ctx.getImageData(0, 0, rect.width, rect.height);
    releaseSurface(surface);
    const index = s.target === "mask" ? topPaintIndex(s.doc.layers) : paintInsertIndex(s.doc);
    if (s.target === "mask") this.paintTargetOff();
    const layer = createPaintLayer(pastedLayerName(s.doc.layers));
    const id = this.layers.addWithPixels(layer, index, { x: rect.x, y: rect.y, data });
    if (!id) return null;
    // M11b: the paste is the layer's kept original (identity placement).
    s.kept.keep(id, { pixels: data, area: { ...rect }, m: translation(rect.x, rect.y), revision: s.runtime.revision(id) });
    // Photoshop: a paste drops the selection, in the same undo step.
    const sel = s.selection.current;
    if (sel) {
      s.selection.set(null);
      recordSelectionMove(s, sel, null, true);
    }
    return { layerId: id, name: layer.name, transform: false, resampled };
  }

  // ── Internals ───────────────────────────────────────────────────────────

  /** A paste reaching past the paint-area cap: new layer in Free Transform on the full image (crop on commit). */
  private pasteInTransform(source: CanvasImageSource, size: Size, full: Rect): PasteResult | null {
    const surface = createSurface(size.width, size.height);
    surface.ctx.drawImage(source, 0, 0);
    const pixels = surface.ctx.getImageData(0, 0, size.width, size.height);
    releaseSurface(surface);
    const name = pastedLayerName(this.s.doc.layers);
    const id = this.insertPlaced(pixels, name, full);
    if (!id) return null;
    this.s.events.emit("note", PASTE_TRANSFORM_NOTE);
    return { layerId: id, name, transform: true, resampled: full.width !== size.width || full.height !== size.height };
  }

  /** Layer copy/cut act on: the current mask under Quick Mask, else the active paint-like layer. */
  private editLayer(): Layer | undefined {
    const s = this.s;
    return activeEditLayer(s.doc, s.target, s.currentMaskId);
  }

  /** Document area of a layer copy: the selection extent, or the content bbox. */
  private layerArea(layer: Layer): Rect | null {
    const s = this.s;
    const sel = s.selection.current;
    const area = sel ? selectionExtent(sel, s.store.bounds) : layerContentRect(s, layer.id);
    return isEmptyRect(area) ? null : area;
  }

  private copyLayer(layer: Layer | undefined): ClipImage | null {
    const s = this.s;
    if (!layer) return null;
    const area = this.layerArea(layer);
    const read = area ? s.store.read(layer.id, area) : null;
    if (!read) return null;
    const sel = s.selection.current;
    const coverage = sel ? coverageFor(sel, read.rect) : null;
    const px = read.data.data;
    const any = layer.kind === "mask" ? maskToGray(px, coverage) : applyCoverage(px, coverage);
    if (!any) return null;
    // A mask copy keeps the selection's shape (opaque black outside the mask).
    return layer.kind === "mask" ? this.clip(read.data, read.rect) : this.trimmed(read.data, read.rect);
  }

  private copyMerged(): ClipImage | null {
    const s = this.s;
    const map = documentMap(s.doc, s.imageSize);
    const image = roundOutRect(imageRectToDoc(map, frameRect(s.imageSize)));
    const sel = s.selection.current;
    const area = sel ? selectionExtent(sel, unionRect(image, s.store.bounds)) : image;
    if (isEmptyRect(area)) return null;
    if (s.target === "mask") return this.copyMergedMasks(area);
    const data = readDocRegion(visibleScene(s), area);
    if (!data) return null;
    if (!applyCoverage(data.data, sel ? coverageFor(sel, area) : null)) return null;
    return this.trimmed(data, area);
  }

  /**
   * Copy merged with Quick Mask on: the union of the visible masks' effective
   * coverage (per-mask invert applied, like the MASK output) as opaque
   * grayscale -- the same format as a single-mask copy -- within the selection.
   */
  private copyMergedMasks(area: Rect): ClipImage | null {
    const s = this.s;
    const union = new Uint8Array(area.width * area.height);
    for (const layer of s.doc.layers) {
      if (layer.kind !== "mask" || !shownOnStage(layer, s.solo.current)) continue;
      const read = s.store.read(layer.id, area);
      unionMaskCoverage(union, area, read?.rect ?? null, read?.data.data ?? new Uint8ClampedArray(0), layer.invert === true);
    }
    const data = new ImageData(area.width, area.height);
    for (let i = 0; i < union.length; i++) data.data[i * 4 + 3] = union[i] as number;
    const sel = s.selection.current;
    if (!maskToGray(data.data, sel ? coverageFor(sel, area) : null)) return null;
    return this.clip(data, area);
  }

  /** Crop to the non-transparent bbox. */
  private trimmed(data: ImageData, rect: Rect): ClipImage | null {
    const local = alphaBounds(data.data, data.width, data.height);
    if (isEmptyRect(local)) return null;
    if (local.width === data.width && local.height === data.height) return this.clip(data, rect);
    const out = new ImageData(local.width, local.height);
    for (let y = 0; y < local.height; y++) {
      const src = ((local.y + y) * data.width + local.x) * 4;
      out.data.set(data.data.subarray(src, src + local.width * 4), y * local.width * 4);
    }
    return this.clip(out, { x: rect.x + local.x, y: rect.y + local.y, width: local.width, height: local.height });
  }

  private clip(data: ImageData, rect: Rect): ClipImage {
    return { data, rect: { ...rect }, imageScale: this.imageScale };
  }

  /** Clear the selected (or all) pixels of `area` on a layer as one patch. */
  private clearArea(layer: Layer, area: Rect): void {
    const s = this.s;
    const before = s.store.read(layer.id, area);
    if (!before) return;
    const rect = intersectRect(before.rect, area);
    const sel = s.selection.current;
    const coverage = sel ? coverageFor(sel, rect) : new Uint8Array(rect.width * rect.height).fill(255);
    const next = new ImageData(new Uint8ClampedArray(before.data.data), before.data.width, before.data.height);
    eraseCoverage(next.data, { x: 0, y: 0, width: rect.width, height: rect.height }, coverage, rect.width);
    s.store.write(layer.id, rect.x, rect.y, next);
    const after = s.store.read(layer.id, rect);
    if (after) {
      const bytes = before.data.data.byteLength + after.data.data.byteLength;
      s.history.push({ kind: "patch", layerId: layer.id, x: rect.x, y: rect.y, before: before.data, after: after.data, bytes });
    }
    s.runtime.touch(layer.id);
    s.afterEdit();
  }
}

/** Index above the top-most paint-like layer (paste while a mask is current). */
function topPaintIndex(layers: readonly Layer[]): number {
  for (let i = layers.length - 1; i >= 0; i--) if (isPaintLike(layers[i] as Layer)) return i + 1;
  const firstMask = layers.findIndex((l) => l.kind === "mask");
  return firstMask >= 0 ? firstMask : layers.length;
}
