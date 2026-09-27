/**
 * Match image resolution (SPEC "Drawing resolution"): resample every paint and
 * mask layer once so the frame becomes what it would be if it were set from
 * the current image, keeping the drawing exactly where it is on the image.
 * Text layers re-render from scaled `textData`. Not undoable: history is
 * cleared. Geometry in `drawingResolution.ts` (pure, tested).
 */

import type { FrameSource } from "./editorTypes";
import type { EditorState } from "./editorState";
import { imageFits, matchGeometry, resolutionInfo, scaleTextData } from "./drawingResolution";
import type { ResolutionInfo } from "./drawingResolution";
import { renderTextLayer } from "./textLayer";

/**
 * Resolution check + Match image resolution over a shared {@link EditorState}.
 */
export class ResolutionOps {
  /**
   * @param s - Shared editor state.
   */
  constructor(private readonly s: EditorState) {}

  /**
   * Current mismatch against the image, or `null` when no image size is known.
   * @returns Ratio and label numbers.
   */
  info(): ResolutionInfo | null {
    const s = this.s;
    if (!s.backgroundSize) return null;
    return resolutionInfo(s.doc, s.imageSize);
  }

  /**
   * Whether the image area fits the maximum paint area (`imageFits`);
   * `true` when no image size is known.
   * @returns Fit state.
   */
  fits(): boolean {
    const s = this.s;
    if (!s.backgroundSize) return true;
    return imageFits({ frame: s.doc.frame, bounds: s.store.bounds, placement: s.doc.placement }, s.imageSize);
  }

  /**
   * What the notice should show: `null` for nothing (also for an empty
   * document, which adopts the image size anyway, and while loading);
   * `"resolution"` when the ratio is too high (takes precedence; Match fixes
   * the shape too); `"fit"` when only the image's shape doesn't fit.
   * @returns Notice case.
   */
  notice(): { kind: "resolution" | "fit"; info: ResolutionInfo } | null {
    const s = this.s;
    const info = this.info();
    if (!info || s.loading || s.isEmpty) return null;
    if (info.mismatch) return { kind: "resolution", info };
    return this.fits() ? null : { kind: "fit", info };
  }

  /**
   * Whether Match image resolution would crop content (bounds side limit).
   * @returns `true` if some paint would be cut off.
   */
  wouldCrop(): boolean {
    const s = this.s;
    return matchGeometry({ frame: s.doc.frame, bounds: s.store.bounds, placement: s.doc.placement }, s.imageSize).cropped;
  }

  /**
   * Resample to the image resolution (never lowers resolution; no-op unless
   * {@link notice} applies). Callers settle floats / open edits first.
   * @returns `true` if the document changed.
   */
  match(): boolean {
    const s = this.s;
    if (!this.notice()) return false;
    if (s.stroke.active) s.cancelStroke();
    const g = matchGeometry({ frame: s.doc.frame, bounds: s.store.bounds, placement: s.doc.placement }, s.imageSize);
    const { factor, tx, ty } = g.transform;
    s.store.resample(g.bounds, factor, tx, ty);
    s.stroke.rebase(g.bounds);
    s.doc.frame = { ...g.frame };
    s.doc.bounds = { ...g.bounds };
    if (g.placement) s.doc.placement = { ...g.placement };
    else delete s.doc.placement;
    const source: FrameSource = s.background.kind === "image" ? "image" : "widgets";
    s.frameSource = source;
    for (const layer of s.doc.layers) {
      if (layer.kind !== "text" || !layer.textData) continue;
      layer.textData = scaleTextData(layer.textData, g.transform);
      renderTextLayer(s, layer);
    }
    for (const layer of s.doc.layers) {
      if (s.runtime.get(layer.id)?.hasContent) s.runtime.touch(layer.id);
      else s.runtime.bump(layer.id);
    }
    s.history.clear();
    s.selection.set(null); // document coords changed meaning
    s.lastStrokeEnd = null;
    s.syncViewFrame();
    s.events.emit("placement", undefined);
    s.events.emit("layers", undefined);
    s.afterEdit();
    return true;
  }
}
