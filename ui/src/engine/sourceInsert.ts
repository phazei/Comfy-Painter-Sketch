/**
 * Insert an image source as a new layer in Free Transform
 * (SPEC "Image sources and the Images panel"), exposed as `Editor.insert`.
 *
 * Unlike a paste, the pixels never land in the layer first: an empty paint
 * layer is added (the paste's placement rules -- above the current paint
 * layer, Quick Mask off, selection dropped in the same step), and the source
 * becomes a float over it whose pixels are the FULL source (1 source px =
 * 1 image px through the float matrix) with no lift position. The transform
 * session then starts at once:
 *
 * - Large sources start scaled to fit the image area ({@link fitScale}),
 *   small ones at native size (snapped to whole px, so a plain commit is an
 *   exact copy); placed by `pastePlacement.ts` (selection, else image area /
 *   view centre; clamped into the image area, whole-px top-left). The commit resamples once from
 *   the full source, so nothing is lost to the start scale or to the
 *   paint-area cap (only what finally lands outside the cap is cropped).
 * - Commit (Enter, the check button, any settle) = ONE undo step: the layer
 *   add and the transform patch are joined (`HistoryStack.joinSince`).
 * - Cancel (Esc, x, Ctrl+Z) undoes the add and drops it from the redo side:
 *   no layer, no step, the previous selection back.
 */

import { createPaintLayer } from "../document/create";
import { frameRect } from "../geometry/rect";
import type { Rect, Size } from "../geometry/rect";
import { imageLayerName } from "./clipboardMath";
import type { EditorState } from "./editorState";
import type { FloatOps } from "./floatOps";
import type { FloatState } from "./floatLift";
import { documentMap, imageRectToDoc } from "./frameMap";
import { pasteContext, pasteTopLeft } from "./pastePlacement";
import type { PasteContext } from "./pastePlacement";
import type { LayerOps } from "./layerOps";
import { recordSelectionMove } from "./selectionFollow";
import { createSurface } from "./surface";
import { paramsMatrix, transformedAabb } from "./transformMath";
import type { TransformParams } from "./transformMath";

/**
 * Start scale of an inserted source, in image px per source px: 1 when it
 * fits the image area, else the largest scale that fits it (aspect kept).
 * @param source - Source size, px.
 * @param area - Image area size, image px.
 * @returns Scale in (0, 1].
 */
export function fitScale(source: Size, area: Size): number {
  if (source.width <= 0 || source.height <= 0 || area.width <= 0 || area.height <= 0) return 1;
  return Math.min(1, area.width / source.width, area.height / source.height);
}

/**
 * Start parameters of an inserted source (see module doc).
 * @param source - Source size, px.
 * @param imageArea - Image area in document coords.
 * @param docPerImage - Document px per image px (1 / frame-map scale).
 * @param place - Placement context (its `original` is ignored: rule 2 never applies).
 * @returns Session parameters for a `source`-sized float.
 */
export function insertParams(source: Size, imageArea: Rect, docPerImage: number, place: Omit<PasteContext, "imageArea" | "original">): TransformParams {
  const k = fitScale(source, { width: imageArea.width / docPerImage, height: imageArea.height / docPerImage });
  const t = k * docPerImage;
  const w = source.width * t;
  const h = source.height * t;
  // Whole-px top-left (at native size a plain commit is an exact copy).
  const tl = pasteTopLeft({ width: w, height: h }, { ...place, imageArea, original: null });
  return { cx: tl.x + w / 2, cy: tl.y + h / 2, sx: t, sy: t, angle: 0 };
}

/**
 * Image-source insertion over a shared {@link EditorState}.
 */
export class SourceInsertOps {
  /**
   * @param s - Shared editor state.
   * @param layers - Layer commands (undoable add + solo rule).
   * @param float - Float commands (the session runs on a float).
   * @param paintTargetOff - Turns Quick Mask off.
   * @param undo - Undo one history step (`PaintOps.undo`).
   */
  constructor(
    private readonly s: EditorState,
    private readonly layers: LayerOps,
    private readonly float: FloatOps,
    private readonly paintTargetOff: () => void,
    private readonly undo: () => void,
  ) {}

  /**
   * New layer holding `pixels` in a Free Transform session (see module doc).
   * @param pixels - Full-resolution source pixels (straight alpha).
   * @param name - Layer name (source file name); default "Image N" (next free N).
   * @returns `true` if the session runs.
   */
  insert(pixels: ImageData, name?: string): boolean {
    return this.start(pixels, name?.trim() || imageLayerName(this.s.doc.layers), (place, area, docPerImage) =>
      insertParams({ width: pixels.width, height: pixels.height }, area, docPerImage, place),
    ) !== null;
  }

  /**
   * An oversized paste (SPEC "Clipboard and drop"): the same session, at native
   * size and the paste's own placement (`pastePlacement.ts`, no fit scaling).
   * @param pixels - Full source pixels (straight alpha).
   * @param name - Layer name ("Pasted N").
   * @param rect - Placed document rect of the whole paste (`pasteRect`).
   * @returns The new layer id if the session runs, else `null`.
   */
  insertPlaced(pixels: ImageData, name: string, rect: Rect): string | null {
    const sx = rect.width / pixels.width;
    const sy = rect.height / pixels.height;
    return this.start(pixels, name, () => ({ cx: rect.x + rect.width / 2, cy: rect.y + rect.height / 2, sx, sy, angle: 0 }));
  }

  /** Shared body of {@link insert} / {@link insertPlaced}. */
  private start(pixels: ImageData, name: string, paramsFor: (place: Omit<PasteContext, "imageArea" | "original">, area: Rect, docPerImage: number) => TransformParams): string | null {
    const s = this.s;
    if (s.loading || pixels.width <= 0 || pixels.height <= 0) return null;
    s.settleFloat();
    s.commitTextEdit();
    if (s.stroke.active) s.cancelStroke();
    if (this.float.active || this.float.transform.active) return null;
    if (s.target === "mask") this.paintTargetOff();
    const layer = createPaintLayer(name);
    const id = this.layers.addLayer(layer);
    if (!id) return null;
    const map = documentMap(s.doc, s.imageSize);
    const sel = s.selection.current;
    const place = pasteContext({ selection: sel, view: s.view.current, stage: s.view.stageSize, map, imageSize: s.imageSize }, null);
    if (sel) {
      s.selection.set(null);
      recordSelectionMove(s, sel, null, true);
    }
    const step = s.history.mergeTarget();

    const docPerImage = 1 / map.scale;
    const area = imageRectToDoc(map, frameRect(s.imageSize));
    const { width: w, height: h } = pixels;
    const params = paramsFor(place, area, docPerImage);
    const m = paramsMatrix(params, w, h);
    s.ensureBounds(transformedAabb(m, w, h), true);
    const surface = createSurface(w, h);
    surface.ctx.putImageData(pixels, 0, 0);
    const f: FloatState = {
      layerId: id,
      area: { x: 0, y: 0, width: w, height: h },
      // The layer is empty: a 1 px transparent "hole" inside the bounds keeps the commit patch small.
      original: new ImageData(1, 1),
      holeRect: holeAt(s.store.bounds, params),
      params,
      pixels,
      surface,
      dx: 0, dy: 0, selBefore: null, selBase: null, xf: m, baked: null, dragBase: null, preview: null,
      inserted: true,
      onEnd: (landed) => this.ended(id, step, landed),
    };
    if (!this.float.adoptInserted(f)) return null;
    return this.float.transform.enter() ? id : null;
  }

  /** The inserted float ended: join its steps, or remove the layer without a trace. */
  private ended(layerId: string, step: ReturnType<EditorState["history"]["mergeTarget"]>, landed: boolean): void {
    const s = this.s;
    if (!step) return;
    if (landed) {
      s.history.joinSince(step);
      return;
    }
    if (s.history.mergeTarget() !== step) return;
    this.undo();
    s.history.dropRedo();
    s.kept.drop(layerId);
    s.events.emit("history", undefined);
  }
}

/**
 * 1 px "hole" of a float without a lift position: at the session centre,
 * clamped into the bounds (keeps the commit patch small).
 * @param bounds - Paint bounds.
 * @param p - Session parameters.
 * @returns Document rect.
 */
export function holeAt(bounds: Rect, p: TransformParams): Rect {
  const clamp = (v: number, lo: number, size: number): number => Math.min(lo + size - 1, Math.max(lo, Math.floor(v)));
  return { x: clamp(p.cx, bounds.x, bounds.width), y: clamp(p.cy, bounds.y, bounds.height), width: 1, height: 1 };
}
