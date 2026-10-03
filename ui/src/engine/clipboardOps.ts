/**
 * Copy / cut / paste on the editor core (SPEC "Clipboard and drop"),
 * exposed as `Editor.clipboard`. The
 * engine only produces and consumes pixels; the system clipboard, clipspace
 * and the internal clipboard live in the UI (`ui/clipboardActions.ts`).
 *
 * - {@link ClipboardOps.copy}: the current edit layer's selected pixels
 *   (coverage-weighted alpha), or its whole content without a selection,
 *   trimmed to the non-transparent bbox. A mask copies as an OPAQUE
 *   grayscale image (white = masked; what other apps expect). `merged` =
 *   what is visible incl. the image, within the selection or the image area.
 *   The read-only SOURCE rows copy too (reading isn't editing): the
 *   Background row what it shows, the Image / Input Mask row its coverage as
 *   gray. Cut on them is refused like any edit.
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
 * - Layer masks: with the pixels targeted, copy takes the masked
 *   result (layer x the shown part of its enabled lmask) and cut clears the
 *   layer's pixels only (the lmask stays). With the lmask targeted, copy /
 *   cut act on the lmask like on a mask layer: grayscale, cut reveals
 *   (clears to black). Paste makes a new paint layer (as with a mask layer
 *   current) -- except in the lmask-only view (Alt+click), where every
 *   paste / drop goes INTO the viewed lmask ({@link ClipboardOps.paste}):
 *   luminance x alpha (`imageToMaskGray`) as an lmask float at the normal
 *   placement (move, then commit / cancel like any lmask float; the dropped
 *   selection is part of its step), or -- past the paint area -- in a Free
 *   Transform session on that float.
 *
 * Every command settles a floating selection first.
 */

import { createPaintLayer } from "../document/create";
import { isPaintLike, paintInsertIndex } from "../document/layerList";
import { layerMaskKey } from "../document/layerMask";
import { activeEditLayer } from "../document/masks";
import type { Layer } from "../document/types";
import { frameRect, intersectRect, isEmptyRect, roundOutRect, unionRect } from "../geometry/rect";
import type { Point, Rect, Size } from "../geometry/rect";
import { boundsCap } from "./bounds";
import { applyCoverage, cropToCap, imageToMaskGray, maskToGray, pasteRect, pastedLayerName, unionMaskCoverage } from "./clipboardMath";
import { readDocRegion, sceneFor, visibleScene } from "./docComposite";
import { coverageInDoc } from "./imageMask";
import { IMAGE_MASK_ID } from "../document/imageMask";
import type { EditorState } from "./editorState";
import type { FloatState } from "./floatLift";
import type { FloatOps } from "./floatOps";
import { documentMap, imageRectToDoc } from "./frameMap";
import { selectedSurfaceKey, targetedMaskLayer } from "./layerMask";
import type { EditKind } from "./layerMask";
import { applyMaskAlpha, maskFloatSurfaces } from "./layerMaskCarry";
import type { LayerOps } from "./layerOps";
import { layerContentRect } from "./layerTranslate";
import { LOCKED_LAYER_NOTE } from "./editorTypes";
import { editBlockNote, preparePixelEdit } from "./rasterize";
import { coverageFor, eraseCoverage, selectionExtent } from "./selection";
import { recordSelectionMove } from "./selectionFollow";
import { shownOnStage } from "./solo";
import { holeAt } from "./sourceInsert";
import { createSurface, releaseSurface } from "./surface";
import { paramsMatrix, transformedAabb, translation } from "./transformMath";
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
  /** The new layer (or, pasted into the lmask-only view, the layer owning the lmask). */
  layerId: string;
  name: string;
  /** Pasted into the viewed lmask as an lmask float, no new layer. */
  intoMask?: true;
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
   * @param float - Float commands (pastes into the lmask-only view float on the lmask).
   */
  constructor(
    private readonly s: EditorState,
    private readonly layers: LayerOps,
    private readonly paintTargetOff: () => void,
    private readonly insertPlaced: (pixels: ImageData, name: string, rect: Rect) => string | null,
    private readonly float: FloatOps,
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
    const clip = merged ? this.copyMerged() : this.copyCurrent();
    if (clip !== undefined && !clip) s.events.emit("note", NOTHING_TO_COPY_NOTE);
    return clip ?? null;
  }

  /**
   * Copy of the selected row: the read-only SOURCE rows copy what they show
   * (reading isn't editing), any other layer its pixels through the gate.
   * @returns Pixels, `null` when empty, `undefined` when refused (note sent).
   */
  private copyCurrent(): ClipImage | null | undefined {
    const s = this.s;
    if (s.sourceSelected === "background") return this.copyBackground();
    const layer = this.editLayer();
    if (layer?.id === IMAGE_MASK_ID) return this.copyImageMask(layer);
    // Copying a layer you can't see is refused like an edit (locked is fine to copy).
    const block = layer ? editBlockNote(s, layer, this.kind(layer)) : null;
    if (block && block !== LOCKED_LAYER_NOTE) {
      s.events.emit("note", block);
      return undefined;
    }
    return this.copyLayer(layer);
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
    if (!layer || preparePixelEdit(s, layer, this.kind(layer)) === "blocked") return null;
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
   * Ctrl+V / drop: a new paint layer holding `source` -- or, in the
   * lmask-only view, an lmask float on the viewed lmask ({@link pasteIntoMask}).
   * @param source - Decoded image (ImageBitmap, canvas, ...).
   * @param size - Its pixel size.
   * @param docPerSource - Document px per source px (`1 / imageScale` for image px).
   * @param at - Centre point or top-left, document coords.
   * @returns What happened, or `null` (loading / nothing fits / blocked).
   */
  paste(source: CanvasImageSource, size: Size, docPerSource: number, at: PastePlacement): PasteResult | null {
    const s = this.s;
    if (s.loading || size.width <= 0 || size.height <= 0) return null;
    s.settleFloat();
    if (s.stroke.active) s.cancelStroke();
    const full = pasteRect(size, docPerSource, at);
    const { rect, cropped } = cropToCap(full, unionRect(boundsCap(s.doc.frame), s.store.bounds));
    const viewed = targetedMaskLayer(s);
    if (viewed && s.layerMasks.view === viewed.id) return this.pasteIntoMask(viewed, source, size, full, cropped ? null : rect);
    if (cropped) return this.pasteInTransform(source, size, full);
    if (!rect) return null;
    const resampled = full.width !== size.width || full.height !== size.height;
    const data = drawSource(source, rect, full, resampled);
    const index = s.target === "mask" ? topPaintIndex(s.doc.layers) : paintInsertIndex(s.doc);
    if (s.target === "mask") this.paintTargetOff();
    const layer = createPaintLayer(pastedLayerName(s.doc.layers));
    const id = this.layers.addWithPixels(layer, index, { x: rect.x, y: rect.y, data });
    if (!id) return null;
    // The paste is the layer's kept original (identity placement).
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
    const pixels = drawSource(source, { x: 0, y: 0, ...size }, { x: 0, y: 0, ...size }, false);
    const name = pastedLayerName(this.s.doc.layers);
    const id = this.insertPlaced(pixels, name, full);
    if (!id) return null;
    this.s.events.emit("note", PASTE_TRANSFORM_NOTE);
    return { layerId: id, name, transform: true, resampled: full.width !== size.width || full.height !== size.height };
  }

  /**
   * A paste in the lmask-only view: the image as lmask values
   * (`imageToMaskGray`) floating on the viewed lmask at `rect`, or -- past
   * the paint area (`rect` null) -- the full image in a Free Transform
   * session (native size at `full`, cropped on commit), like an oversized
   * paste. The float always lands on commit (it has no lift position); the
   * selection is dropped now and joins the commit's step (cancel brings it back).
   */
  private pasteIntoMask(layer: Layer, source: CanvasImageSource, size: Size, full: Rect, rect: Rect | null): PasteResult | null {
    const s = this.s;
    if (preparePixelEdit(s, layer, "paint") === "blocked" || this.float.active || this.float.transform.active) return null;
    const key = layerMaskKey(layer.id);
    const resampled = full.width !== size.width || full.height !== size.height;
    const pixels = rect ? drawSource(source, rect, full, resampled) : drawSource(source, { x: 0, y: 0, ...size }, { x: 0, y: 0, ...size }, false);
    imageToMaskGray(pixels.data);
    const f = rect ? this.maskFloatAt(key, pixels, rect) : this.maskFloatPlaced(key, pixels, full);
    if (!f) return null;
    const sel = s.selection.current;
    f.inserted = true;
    f.onEnd = (landed) => {
      if (landed) recordSelectionMove(s, sel, s.selection.current, true);
      else s.selection.set(sel);
    };
    s.selection.set(null);
    if (!this.float.adoptInserted(f)) return null;
    // The float shows at once (lmask-only view / masked composite caches follow the revision).
    s.runtime.bump(key);
    if (!rect) {
      this.float.transform.enter();
      s.events.emit("note", PASTE_TRANSFORM_NOTE);
    }
    s.events.emit("render", undefined);
    return { layerId: layer.id, name: layer.name, transform: !rect, resampled, intoMask: true };
  }

  /** lmask float of gray `pixels` at `rect` (inside the cap; the bounds grow to it). */
  private maskFloatAt(key: string, pixels: ImageData, rect: Rect): FloatState | null {
    const s = this.s;
    s.ensureBounds(rect, true);
    const read = s.store.read(key, rect);
    if (!read || read.rect.width !== rect.width || read.rect.height !== rect.height) return null;
    return maskFloat(key, pixels, { ...rect }, read.data, null);
  }

  /** lmask float of the full gray `pixels` through a Free Transform matrix placing them at `full`. */
  private maskFloatPlaced(key: string, pixels: ImageData, full: Rect): FloatState | null {
    const s = this.s;
    const { width: w, height: h } = pixels;
    const params = { cx: full.x + full.width / 2, cy: full.y + full.height / 2, sx: full.width / w, sy: full.height / h, angle: 0 };
    const m = paramsMatrix(params, w, h);
    s.ensureBounds(transformedAabb(m, w, h), true);
    const hole = holeAt(s.store.bounds, params);
    const read = s.store.read(key, hole);
    if (!read) return null;
    return { ...maskFloat(key, pixels, { x: 0, y: 0, width: w, height: h }, read.data, m), holeRect: read.rect, params };
  }

  /** Layer copy/cut act on: the current mask under Quick Mask, else the active paint-like layer. */
  private editLayer(): Layer | undefined {
    const s = this.s;
    return activeEditLayer(s.doc, s.target, s.currentMaskId);
  }

  /** Gate kind: copy / cut of a targeted lmask is a mask-aware edit (lmask-only view exception). */
  private kind(layer: Layer): EditKind {
    return selectedSurfaceKey(this.s, layer) === layer.id ? "whole" : "paint";
  }

  /** Document area of a layer copy: the selection extent, or the content bbox (of the targeted lmask). */
  private layerArea(layer: Layer): Rect | null {
    const s = this.s;
    const sel = s.selection.current;
    const area = sel ? selectionExtent(sel, s.store.bounds) : layerContentRect(s, selectedSurfaceKey(s, layer));
    return isEmptyRect(area) ? null : area;
  }

  private copyLayer(layer: Layer | undefined): ClipImage | null {
    const s = this.s;
    if (!layer) return null;
    const key = selectedSurfaceKey(s, layer);
    const gray = layer.kind === "mask" || key !== layer.id;
    const area = this.layerArea(layer);
    const read = area ? s.store.read(key, area) : null;
    if (!read) return null;
    const sel = s.selection.current;
    const coverage = sel ? coverageFor(sel, read.rect) : null;
    const px = read.data.data;
    // The pixels as shown: through the layer's enabled lmask.
    const lm = gray ? undefined : layer.layerMask;
    const mask = lm?.enabled ? s.store.read(layerMaskKey(layer.id), read.rect) : null;
    if (lm && mask) applyMaskAlpha(px, mask.data.data, lm.invert);
    const any = gray ? maskToGray(px, coverage) : applyCoverage(px, coverage);
    if (!any) return null;
    // A mask copy keeps the selection's shape (opaque black outside the mask).
    return gray ? this.clip(read.data, read.rect) : this.trimmed(read.data, read.rect);
  }

  /** The image rect (doc coords) or the selection's extent within it + the paint area; empty when nothing. */
  private imageArea(): Rect {
    const s = this.s;
    const image = roundOutRect(imageRectToDoc(documentMap(s.doc, s.imageSize), frameRect(s.imageSize)));
    const sel = s.selection.current;
    return sel ? selectionExtent(sel, unionRect(image, s.store.bounds)) : image;
  }

  private copyMerged(): ClipImage | null {
    const s = this.s;
    const area = this.imageArea();
    if (isEmptyRect(area)) return null;
    if (s.target === "mask") return this.copyMergedMasks(area);
    return this.copyScene(visibleScene(s), area);
  }

  /** The Background row: what the background shows (image or fill), within the selection. */
  private copyBackground(): ClipImage | null {
    const area = this.imageArea();
    if (isEmptyRect(area)) return null;
    return this.copyScene(sceneFor(visibleScene(this.s), "background"), area);
  }

  /** A scene read over `area`, coverage-weighted by the selection, trimmed. */
  private copyScene(scene: Parameters<typeof readDocRegion>[0], area: Rect): ClipImage | null {
    const sel = this.s.selection.current;
    const data = readDocRegion(scene, area);
    if (!data) return null;
    if (!applyCoverage(data.data, sel ? coverageFor(sel, area) : null)) return null;
    return this.trimmed(data, area);
  }

  /**
   * The Image / Input Mask row: its effective coverage (invert applied,
   * 0 outside the image, like its Ctrl+click selection) as opaque gray,
   * within the selection -- the same format as a mask layer copy.
   */
  private copyImageMask(layer: Layer): ClipImage | null {
    const s = this.s;
    const area = this.imageArea();
    const plane = s.imageMask.coverage;
    if (isEmptyRect(area) || !plane) return null;
    const size = s.imageMask.size;
    const coverage = coverageInDoc(plane, size, documentMap(s.doc, size), area, layer.invert === true);
    const data = new ImageData(area.width, area.height);
    for (let i = 0; i < coverage.length; i++) data.data[i * 4 + 3] = coverage[i] as number;
    const sel = s.selection.current;
    if (!maskToGray(data.data, sel ? coverageFor(sel, area) : null)) return null;
    return this.clip(data, area);
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

  /** Clear the selected (or all) pixels of `area` on a layer (or its targeted lmask: reveal) as one patch. */
  private clearArea(layer: Layer, area: Rect): void {
    const s = this.s;
    const key = selectedSurfaceKey(s, layer);
    const before = s.store.read(key, area);
    if (!before) return;
    const rect = intersectRect(before.rect, area);
    const sel = s.selection.current;
    const coverage = sel ? coverageFor(sel, rect) : new Uint8Array(rect.width * rect.height).fill(255);
    const next = new ImageData(new Uint8ClampedArray(before.data.data), before.data.width, before.data.height);
    eraseCoverage(next.data, { x: 0, y: 0, width: rect.width, height: rect.height }, coverage, rect.width);
    s.store.write(key, rect.x, rect.y, next);
    const after = s.store.read(key, rect);
    if (after) {
      const bytes = before.data.data.byteLength + after.data.data.byteLength;
      s.history.push({ kind: "patch", layerId: key, x: rect.x, y: rect.y, before: before.data, after: after.data, bytes });
    }
    s.runtime.touch(key);
    s.afterEdit();
  }
}

/** Pixels over `rect` of `source` drawn at `full` (document px; smoothed when resampled). */
function drawSource(source: CanvasImageSource, rect: Rect, full: Rect, resampled: boolean): ImageData {
  const surface = createSurface(rect.width, rect.height);
  surface.ctx.imageSmoothingEnabled = resampled;
  surface.ctx.imageSmoothingQuality = "high";
  surface.ctx.drawImage(source, full.x - rect.x, full.y - rect.y, full.width, full.height);
  const data = surface.ctx.getImageData(0, 0, rect.width, rect.height);
  releaseSurface(surface);
  return data;
}

/** An lmask float of gray pixels (value in RGB, coverage in alpha) over `area`, nothing lifted. */
function maskFloat(key: string, pixels: ImageData, area: Rect, original: ImageData, xf: FloatState["xf"]): FloatState {
  const shown = maskFloatSurfaces(pixels.data, pixels.width, pixels.height);
  return {
    layerId: key, area, original, pixels, surface: shown.value, cover: shown.cover,
    dx: 0, dy: 0, selBefore: null, selBase: null, xf, baked: null, dragBase: null, preview: null,
  };
}

/** Index above the top-most paint-like layer (paste while a mask is current). */
function topPaintIndex(layers: readonly Layer[]): number {
  for (let i = layers.length - 1; i >= 0; i--) if (isPaintLike(layers[i] as Layer)) return i + 1;
  const firstMask = layers.findIndex((l) => l.kind === "mask");
  return firstMask >= 0 ? firstMask : layers.length;
}
