/**
 * Image Mask row commands (SPEC "Layers" > "Image Mask / Input Mask row"),
 * exposed as
 * `Editor.imageMask`. The record is `doc.imageMask` (`document/imageMask.ts`),
 * the coverage `EditorState.imageMask` (`imageMask.ts`).
 *
 * - The widget feeds it: {@link ImageMaskOps.setFromAlpha} when the
 *   background source's alpha has been read (a fully opaque image removes the
 *   row), {@link ImageMaskOps.restore} from the saved file, and while
 *   the `mask` input is connected {@link ImageMaskOps.setInput} (the "Input
 *   Mask": no file, never uploaded; `widget/inputMaskSync.ts`). None is an
 *   undo step: the row follows the source like the background does. Eye,
 *   colour, invert and overlay opacity go through `layerOps` like any mask
 *   (same undo rules); pixel edits are refused (`rasterize.ts`).
 * - It is shown and output only over an image of exactly its size
 *   ({@link imageMaskApplies}, Python skips a stale file the same way).
 * - Ctrl+click ({@link imageMaskSelection}) and {@link ImageMaskOps.duplicate}
 *   resample the image-px coverage into document coords.
 */

import { copyLayerName, canAddMask } from "../document/layerList";
import { createMaskLayer } from "../document/create";
import { createImageMask, IMAGE_MASK_ID, isInputMaskKey } from "../document/imageMask";
import type { ImageMask } from "../document/imageMask";
import { maskDisplayColor } from "../document/masks";
import { nextMaskStyle } from "../defaults/maskDefaults";
import { frameRect, intersectRect, isEmptyRect, roundOutRect, unionRect } from "../geometry/rect";
import type { Rect, Size } from "../geometry/rect";
import { boundsCap } from "./bounds";
import type { EditorState } from "./editorState";
import { documentMap, imageRectToDoc } from "./frameMap";
import type { FrameMap } from "./frameMap";
import { coverageFromAlpha, coverageFromMaskFile, coverageInDoc, maskFilePixels } from "./imageMask";
import { emitLayerEvents } from "./layerHistory";
import { insertLayer, readyCheck } from "./layerOpsHelpers";
import { hardenSelection, selectionFromCoverage } from "./selection";
import type { Selection } from "./selection";

/**
 * Image Mask commands over a shared {@link EditorState}.
 */
export class ImageMaskOps {
  /**
   * @param s - Shared editor state.
   */
  constructor(private readonly s: EditorState) {}

  /** The row's record, if the row exists. */
  get info(): Readonly<ImageMask> | undefined {
    return this.s.doc.imageMask;
  }

  /** Coverage is loaded (a restored or read source; `false` after a failed restore). */
  get hasPixels(): boolean {
    return this.s.doc.imageMask !== undefined && this.s.imageMask.coverage !== null;
  }

  /** Display cache key (changes with the coverage). */
  get revision(): number {
    return this.s.imageMask.revision;
  }

  /** The coverage needs uploading. */
  get dirty(): boolean {
    return this.s.doc.imageMask !== undefined && this.s.imageMask.dirty;
  }

  /** Coverage version (pass back to {@link markUploaded}). */
  get version(): number {
    return this.s.imageMask.version;
  }

  /**
   * Mask-file pixels (white, alpha = coverage), image-sized: display + upload.
   * @returns The canvas, or `null` without coverage.
   */
  canvas(): HTMLCanvasElement | null {
    return this.s.doc.imageMask ? this.s.imageMask.canvas() : null;
  }

  /**
   * The background's alpha arrived (`/view?channel=a`, keyed by its source):
   * show or replace the row (settings of an existing row are kept, the file
   * is uploaded again), or remove it when every pixel is opaque.
   * @param sourceKey - Background `ImageSource.key`.
   * @param size - Image size.
   * @param rgba - Its pixels (alpha channel read).
   * @returns `true` if the row exists afterwards.
   */
  setFromAlpha(sourceKey: string, size: Size, rgba: Uint8ClampedArray): boolean {
    const coverage = rgba.length === size.width * size.height * 4 ? coverageFromAlpha(rgba) : null;
    if (!coverage) {
      this.remove();
      return false;
    }
    const s = this.s;
    const prev = s.doc.imageMask;
    const used = s.doc.layers.filter((l) => l.kind === "mask").map((l) => l.color);
    const style = prev ? { color: maskDisplayColor(prev), opacity: prev.opacity } : nextMaskStyle(used, s.maskStyle());
    const next = createImageMask(sourceKey, size, style);
    if (prev) {
      next.visible = prev.visible;
      next.invert = prev.invert === true;
    }
    s.doc.imageMask = next;
    s.imageMask.set(coverage, size, true);
    this.changed();
    return true;
  }

  /** The row shows the `mask` input ("Input Mask"). */
  get isInput(): boolean {
    const mask = this.s.doc.imageMask;
    return mask !== undefined && isInputMaskKey(mask.sourceKey);
  }

  /** The Input Mask has no coverage until a run delivers it (row hint). */
  get waiting(): boolean {
    return this.isInput && this.s.imageMask.waiting;
  }

  /**
   * Show the `mask` input as the row ("Input Mask"): settings of an
   * existing row are kept, no file (Python has the tensor), never uploaded.
   * Not an undo step.
   * @param sourceKey - Input Mask key (`INPUT_MASK_KEY_PREFIX`...).
   * @param size - Image size (the coverage is already resampled to it).
   * @param coverage - Coverage, or `null` for none (no mask / not loaded yet).
   * @param waiting - `null` coverage because a run has to deliver it.
   */
  setInput(sourceKey: string, size: Size, coverage: Uint8Array | null, waiting: boolean): void {
    const s = this.s;
    const prev = s.doc.imageMask;
    const used = s.doc.layers.filter((l) => l.kind === "mask").map((l) => l.color);
    const style = prev ? { color: maskDisplayColor(prev), opacity: prev.opacity } : nextMaskStyle(used, s.maskStyle());
    const next = createImageMask(sourceKey, size, style);
    if (prev) {
      next.visible = prev.visible;
      next.invert = prev.invert === true;
    }
    s.doc.imageMask = next;
    if (coverage && coverage.length === size.width * size.height) s.imageMask.set(coverage, size, false);
    else s.imageMask.clear();
    s.imageMask.waiting = !coverage && waiting;
    this.changed();
  }

  /**
   * The row's saved file loaded (not dirty, no event storm).
   * @param rgba - File pixels.
   * @param size - File size (must match the record, else it is ignored).
   * @returns `true` if the coverage was taken.
   */
  restore(rgba: Uint8ClampedArray, size: Size): boolean {
    const mask = this.s.doc.imageMask;
    if (!mask || this.isInput || size.width !== mask.width || size.height !== mask.height || rgba.length !== size.width * size.height * 4) return false;
    this.s.imageMask.set(coverageFromMaskFile(rgba), size, false);
    this.s.events.emit("layers", undefined);
    this.s.events.emit("render", undefined);
    return true;
  }

  /** Remove the row (opaque / unreadable source). */
  remove(): void {
    const s = this.s;
    if (!s.doc.imageMask) return;
    delete s.doc.imageMask;
    s.imageMask.clear();
    if (s.currentMaskId === IMAGE_MASK_ID) s.currentMaskId = null;
    this.changed();
  }

  /**
   * Record a finished upload of the coverage. An upload of an older version
   * (the source changed meanwhile) is ignored: that file shows another image.
   * @param version - {@link version} that was uploaded.
   * @param file - Stored file reference.
   */
  markUploaded(version: number, file: string | null): void {
    const mask = this.s.doc.imageMask;
    if (!mask || this.s.imageMask.version !== version) return;
    mask.file = file;
    this.s.imageMask.dirty = false;
    this.s.events.emit("change", undefined);
  }

  /**
   * Whether {@link duplicate} would add a mask now.
   * @returns `true` with coverage and below the mask limit.
   */
  canDuplicate(): boolean {
    return this.hasPixels && canAddMask(this.s.doc.layers);
  }

  /**
   * Duplicate: an ordinary, editable mask layer with the coverage (resampled
   * into document coords) and the row's settings except the colour (the next
   * free palette colour, like a new mask), at the bottom of the mask
   * stack (right above this row). It becomes the current mask; one undo step.
   * @returns New mask id, or `null` if not possible.
   */
  duplicate(): string | null {
    const s = this.s;
    const mask = s.doc.imageMask;
    const coverage = s.imageMask.coverage;
    if (!mask || !coverage || !canAddMask(s.doc.layers) || !readyCheck(s)) return null;
    const { rect, map } = imageMaskArea(s, mask);
    if (isEmptyRect(rect)) return null;
    const data = new ImageData(maskFilePixels(coverageInDoc(coverage, s.imageMask.size, map, rect, false)), rect.width, rect.height);
    // Next free palette colour (like "New mask"; the row's own colour counts as used).
    const used = [...s.doc.layers.filter((l) => l.kind === "mask").map((l) => l.color), maskDisplayColor(mask)];
    const layer = createMaskLayer(copyLayerName(mask.name, s.doc.layers), { color: nextMaskStyle(used, s.maskStyle()).color, opacity: mask.opacity });
    layer.visible = mask.visible;
    layer.invert = mask.invert === true;
    const first = s.doc.layers.findIndex((l) => l.kind === "mask");
    s.currentMaskId = layer.id;
    insertLayer(s, layer, first >= 0 ? first : s.doc.layers.length, { x: rect.x, y: rect.y, data }, false);
    const solo = s.solo.current;
    if (solo.paint !== null || solo.mask !== null) s.solo.set({ ...solo, mask: layer.id });
    return layer.id;
  }

  /** Row, coverage or display changed. */
  private changed(): void {
    emitLayerEvents(this.s);
    this.s.events.emit("change", undefined);
    this.s.events.emit("render", undefined);
  }
}

/**
 * Whether the Image Mask belongs to what is shown: an image background of
 * exactly its size (a widget fill or another image = stale, like Python).
 * @param s - Editor state.
 * @returns `true` if it is drawn (eye / solo permitting).
 */
export function imageMaskApplies(s: EditorState): boolean {
  const mask = s.doc.imageMask;
  const size = s.imageSize;
  return !!mask && s.background.kind === "image" && size.width === mask.width && size.height === mask.height;
}

/**
 * Ctrl+click on the row: the effective coverage (invert applied, only over
 * the image) in document coords, hard like every layer -> selection.
 * @param s - Editor state.
 * @returns Selection, or `null` when nothing is covered.
 */
export function imageMaskSelection(s: EditorState): Selection | null {
  const mask = s.doc.imageMask;
  const coverage = s.imageMask.coverage;
  if (!mask || !coverage) return null;
  const { rect, map } = imageMaskArea(s, mask);
  if (isEmptyRect(rect)) return null;
  return hardenSelection(selectionFromCoverage(coverageInDoc(coverage, s.imageMask.size, map, rect, mask.invert === true), rect));
}

/** The mask's image rect in document coords (clipped to the paint-area cap) and the map for its size. */
function imageMaskArea(s: EditorState, mask: Readonly<ImageMask>): { rect: Rect; map: FrameMap } {
  const size = { width: mask.width, height: mask.height };
  const map = documentMap(s.doc, size);
  const limit = unionRect(boundsCap(s.doc.frame), s.store.bounds);
  return { rect: intersectRect(roundOutRect(imageRectToDoc(map, frameRect(size))), limit), map };
}
