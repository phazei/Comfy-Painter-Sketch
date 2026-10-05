/**
 * Selection commands of the editor core (SPEC "Selection"), exposed as
 * {@link Editor.selection}:
 *
 * - {@link SelectionOps.apply}: combine a tool's new coverage with the current
 *   selection (replace / add / subtract / intersect). Every selection change
 *   (new, select all, deselect, invert) is ONE `selection` history entry
 *   holding the before/after coverage (cropped, so small), so Ctrl+Z after a
 *   wrong marquee restores the previous selection (Photoshop keeps selection
 *   steps in its history too).
 * - Pixel commands on the paint target (Quick Mask aware), one
 *   undo patch each: clear (Delete/Backspace; paint: destination-out, mask:
 *   remove coverage), fill (Alt/Ctrl+Backspace; on the mask: add coverage),
 *   and "selection to mask" (adds the coverage to the mask layer, or hides
 *   it on a targeted layer mask).
 *
 * The selection lives in document coords; `selectAll` converts the current
 * image rect to document coords via {@link imageRectToDoc} so it always
 * selects exactly the visible background (image or fill), regardless of
 * frame size, Move-tool placement, or upstream image changes.
 */

import { IMAGE_MASK_ID } from "../document/imageMask";
import { targetLayer } from "../document/masks";
import type { Layer } from "../document/types";
import { intersectRect, isEmptyRect, unionRect } from "../geometry/rect";
import type { Rect } from "../geometry/rect";
import { boundsCap } from "./bounds";
import { MASK_STROKE_COLOR } from "./editorTypes";
import type { EditorState } from "./editorState";
import { imageAreaInDoc, paintLimit } from "./imageArea";
import { imageMaskSelection } from "./imageMaskOps";
import { targetedMaskLayer } from "./layerMask";
import { paintMaskArea } from "./layerMaskOps";
import { blendCoverage, hexToRgb } from "./pixelColor";
import { preparePixelEdit } from "./rasterize";
import {
  clipSelection,
  combineSelection,
  coverageFor,
  eraseCoverage,
  hardenSelection,
  invertSelection,
  rectSelection,
  selectionBytes,
  selectionExtent,
  selectionFromAlpha,
  selectionsEqual,
} from "./selection";
import type { Selection, SelectionMode } from "./selection";
import type { Contour } from "./selectionOutline";

/** Note when a command needs a selection. */
const NO_SELECTION_NOTE = "Nothing is selected.";
/** Note when Ctrl+click loads a fully transparent layer. */
const EMPTY_LAYER_NOTE = "The layer has no pixels.";

/**
 * Selection state changes + selection pixel commands over a shared {@link EditorState}.
 */
export class SelectionOps {
  /**
   * @param s - Shared editor state.
   */
  constructor(private readonly s: EditorState) {}

  // ── Read access ─────────────────────────────────────────────────────────

  /** Current selection (`null` = none: painting is not clipped). */
  get current(): Selection | null {
    return this.s.selection.current;
  }

  /** Whether a selection exists. */
  get active(): boolean {
    return this.s.selection.current !== null;
  }

  /** Bumped on every selection change (UI cache key). */
  get revision(): number {
    return this.s.selection.revision;
  }

  /**
   * Cached marching-ants outline: closed contours (flat corner lists), in
   * document coords. An inverted selection also outlines the current image
   * area in document coords (Photoshop's ants along the canvas edge), so the
   * ants follow the image boundary rather than `doc.frame` when the image
   * has a different aspect ratio or a Move-tool placement.
   * @returns Contours, or `null` without a selection.
   */
  outline(): readonly Contour[] | null {
    return this.s.selection.outline(this.imageRectInDoc());
  }

  /**
   * Largest document area a selection may cover (the bounds growth cap plus
   * the current bounds); tools need not clip, {@link apply} does.
   */
  get limit(): Rect {
    return unionRect(boundsCap(this.s.doc.frame), this.s.store.bounds);
  }

  // ── Selection changes (one history entry each) ──────────────────────────

  /**
   * Combine new coverage with the current selection, as one undo step.
   * @param next - Tool coverage in document coords (`null` = selects nothing).
   * @param mode - Photoshop mode from the modifiers at drag start.
   * @returns `true` if the selection changed.
   */
  apply(next: Selection | null, mode: SelectionMode): boolean {
    return this.change(combineSelection(this.current, clipSelection(next, this.limit), mode));
  }

  /**
   * Ctrl+A: select the current image area (the background as shown -- the
   * upstream image rect, or the `width x height` fill when no image is
   * connected). The image rect `{0,0,W,H}` is converted to document coords
   * via {@link imageRectToDoc} so the result is correct regardless of the
   * frame size, Move-tool placement, or upstream image changes. Bounds are
   * grown to cover the image rect first (like the bucket fill) so the whole
   * image area is paintable after selecting it.
   * @returns `true` if the selection changed.
   */
  selectAll(): boolean {
    const imageRect = this.imageRectInDoc();
    this.s.ensureBounds(imageRect, true);
    const sel = rectSelection(intersectRect(imageRect, this.limit));
    return this.change(sel);
  }

  /**
   * Ctrl+D: drop the selection.
   * @returns `true` if there was one.
   */
  deselect(): boolean {
    return this.change(null);
  }

  /**
   * Shift+F7 / options-bar "Invert": invert (no-op without a selection).
   * @returns `true` if the selection changed.
   */
  invert(): boolean {
    return this.change(invertSelection(this.current));
  }

  /**
   * Ctrl+click on a layer row (Photoshop's thumbnail Ctrl+click): the layer's
   * pixels become the selection, combined by `mode`. The selection is hard:
   * full strength wherever the alpha is > 0 (soft edges are not kept as
   * partial coverage). A cmask uses its raw coverage (the Subtract mode
   * does not change it). Works on hidden layers; does not change the
   * current layer, Quick Mask or solo. An empty layer notes and leaves the
   * selection unchanged.
   * @param layerId - Paint, text or mask layer id.
   * @param mode - Combination mode.
   * @returns `true` if the selection changed.
   */
  fromLayer(layerId: string, mode: SelectionMode): boolean {
    const s = this.s;
    if (s.loading || s.stroke.active) return false;
    if (layerId === IMAGE_MASK_ID && s.doc.imageMask) {
      // The Image Mask's image-px coverage, resampled into document coords.
      const sel = imageMaskSelection(s);
      if (sel) return this.apply(sel, mode);
      s.events.emit("note", EMPTY_LAYER_NOTE);
      return false;
    }
    const layer = s.doc.layers.find((l) => l.id === layerId);
    if (!layer) return false;
    // A float is part of the layer's pixels: settle it before reading.
    s.settleFloat();
    const px = s.store.read(layer.id, s.store.bounds);
    const alpha = px ? selectionFromAlpha(px.data.data, px.rect) : null;
    if (!alpha) {
      s.events.emit("note", EMPTY_LAYER_NOTE);
      return false;
    }
    // Full strength wherever the alpha is > 0: lifting then takes
    // the pixels whole, so a move leaves no residue and keeps exact alpha.
    return this.apply(hardenSelection(alpha), mode);
  }

  // ── Pixel commands (one undo patch each) ────────────────────────────────

  /**
   * Delete/Backspace: clear the selected pixels of the paint target (on the
   * mask target this removes mask coverage; on a targeted layer mask it
   * clears the white too, i.e. reveals).
   * @returns `true` if pixels changed.
   */
  clearSelected(): boolean {
    const layer = this.editableTarget();
    if (layer && this.onLayerMask(layer)) return paintMaskArea(this.s, layer, 1, true, false);
    return layer ? this.editPixels(layer, (px, rect, cov, stride) => eraseCoverage(px, rect, cov, stride)) : false;
  }

  /**
   * Alt+Backspace (FG) / Ctrl+Backspace (BG): fill the selection on the paint
   * target (on the mask target: add coverage, colour ignored). On a targeted
   * layer mask the colour is ignored and the `slot` mask swatch decides, as
   * for the brush / bucket: white = hide, black = reveal.
   * @param color - CSS hex colour.
   * @param slot - Which swatch the key uses (`fg` = Alt, `bg` = Ctrl).
   * @returns `true` if pixels changed.
   */
  fillSelected(color: string, slot: "fg" | "bg" = "fg"): boolean {
    const layer = this.editableTarget();
    if (!layer) return false;
    if (this.onLayerMask(layer)) {
      const fgWhite = this.s.layerMasks.fgWhite;
      return paintMaskArea(this.s, layer, 1, true, slot === "fg" ? fgWhite : !fgWhite);
    }
    const rgb = hexToRgb(layer.kind === "mask" ? MASK_STROKE_COLOR : color);
    return this.editPixels(layer, (px, rect, cov, stride) => blendCoverage(px, rect, cov, stride, rgb, 1), true);
  }

  /**
   * "Selection to mask": with a layer mask targeted, hide the selection
   * on that lmask (white, soft coverage kept, through the edit gate so the
   * lmask-only view exception applies); otherwise add the selection coverage
   * to the last real cmask (`ensureCmask`: never the read-only Image/Input
   * Mask row, even while that row is current; a mask layer is added if
   * missing). A selected Background row doesn't refuse it: the cmask is
   * named explicitly, not "the current row".
   * @returns `true` if pixels changed.
   */
  toMask(): boolean {
    const s = this.s;
    if (!this.ready()) return false;
    const lmaskLayer = targetedMaskLayer(s);
    if (lmaskLayer) return this.canEdit(lmaskLayer) && paintMaskArea(s, lmaskLayer, 1, true, true);
    const layer = s.ensureCmask();
    // Names its target itself: a selected Background row doesn't refuse it.
    if (preparePixelEdit(s, layer, "paint", true) === "blocked") return false;
    const white = hexToRgb(MASK_STROKE_COLOR);
    return this.editPixels(layer, (px, rect, cov, stride) => blendCoverage(px, rect, cov, stride, white, 1), true);
  }

  // ── Internals ───────────────────────────────────────────────────────────

  private change(next: Selection | null): boolean {
    const s = this.s;
    if (s.loading || s.stroke.active) return false;
    s.settleFloat();
    const before = s.selection.current;
    if (selectionsEqual(before, next)) return false;
    s.history.push({ kind: "selection", before, after: next, bytes: selectionBytes(before) + selectionBytes(next) });
    s.selection.set(next);
    s.events.emit("history", undefined);
    return true;
  }

  /** Not loading/stroking and a selection exists (notes otherwise). */
  private ready(): boolean {
    const s = this.s;
    if (s.loading || s.stroke.active) return false;
    if (!s.selection.current) {
      s.events.emit("note", NO_SELECTION_NOTE);
      return false;
    }
    return true;
  }

  /** Whether pixel commands on `layer` go to its targeted layer mask. */
  private onLayerMask(layer: Layer): boolean {
    return targetedMaskLayer(this.s)?.id === layer.id;
  }

  private editableTarget(): Layer | null {
    const s = this.s;
    if (!this.ready()) return null;
    const layer = s.target === "mask" ? s.ensureMask() : targetLayer(s.doc, "paint");
    return layer && this.canEdit(layer) ? layer : null;
  }

  /**
   * The shared pixel-edit gate (`rasterize.ts`): lock/visibility notes, and a
   * text layer is rasterized first (the edit joins that undo step).
   */
  private canEdit(layer: Layer): boolean {
    return preparePixelEdit(this.s, layer) !== "blocked";
  }

  /**
   * Run a coverage pixel op over the selection extent of a layer and record
   * one patch. Bounds first grow (chunked, capped) to cover a normal
   * selection; an inverted one covers the whole bounds. `paints` (fills):
   * only the image area inside the draw area (`imageArea.ts`), and growth
   * stops there; clearing reaches everything selected.
   */
  private editPixels(
    layer: Layer,
    op: (px: Uint8ClampedArray, rect: Rect, coverage: Uint8Array, stride: number) => void,
    paints = false,
  ): boolean {
    const s = this.s;
    const sel = s.selection.current;
    if (!sel) return false;
    const limit = paints ? paintLimit(s) : null;
    if (!sel.outside) {
      if (limit) s.ensureBounds(intersectRect(sel.rect, limit), true, limit);
      else s.ensureBounds(sel.rect, true);
    }
    const extent = selectionExtent(sel, s.store.bounds);
    const area = limit ? intersectRect(extent, limit) : extent;
    if (isEmptyRect(area)) return false;
    const before = s.store.read(layer.id, area);
    if (!before) return false;
    const rect = intersectRect(before.rect, area);
    const coverage = coverageFor(sel, rect);
    const next = new ImageData(new Uint8ClampedArray(before.data.data), before.data.width, before.data.height);
    op(next.data, { x: 0, y: 0, width: rect.width, height: rect.height }, coverage, rect.width);
    s.store.write(layer.id, rect.x, rect.y, next);
    // Re-read so the patch holds exactly what the canvas stores (premultiplied round trip).
    const after = s.store.read(layer.id, rect);
    if (after) {
      const bytes = before.data.data.byteLength + after.data.data.byteLength;
      s.history.push({ kind: "patch", layerId: layer.id, x: rect.x, y: rect.y, before: before.data, after: after.data, bytes });
    }
    s.runtime.touch(layer.id);
    s.afterEdit();
    return true;
  }

  /** The image area in document coords (`imageArea.ts`). */
  private imageRectInDoc(): Rect {
    return imageAreaInDoc(this.s);
  }
}
