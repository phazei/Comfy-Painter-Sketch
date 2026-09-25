/**
 * Painting operations of the editor core: the Quick Mask paint target
 * (decision 6), strokes (brush dabs or one shape) through the stroke buffer, and undo/redo of
 * dirty-rect patches (decision 10). Patches are in document coords;
 * re-applying one first widens bounds to cover it. Structural layer entries
 * are applied by `layerHistory.ts`, Move-tool translate entries by
 * `layerTranslate.ts`, text entries by `textLayer.ts`; group entries
 * (rasterize + edit) apply their parts in order. Strokes pass the pixel-edit
 * gate of `rasterize.ts` first (lock / hidden / text layers).
 */

import { targetLayer } from "../document/masks";
import type { PaintTarget } from "../document/masks";
import { intersectRect, isEmptyRect, roundOutRect, unionRect } from "../geometry/rect";
import type { Point, Rect } from "../geometry/rect";
import type { Dab } from "./brush";
import { renderShape } from "./shapeRender";
import { shapeBounds } from "./shapes";
import type { ShapeSpec } from "./shapes";
import { MASK_STROKE_COLOR } from "./editorTypes";
import type { HistoryEntry } from "./editorTypes";
import type { EditorState } from "./editorState";
import type { FrameOps } from "./frameOps";
import { applyLayersEntry } from "./layerHistory";
import { applyTranslateEntry } from "./layerTranslate";
import { preparePixelEdit } from "./rasterize";
import { applyTextEntry } from "./textLayer";
import type { StampCache } from "./stampCache";
import type { StrokeStyle } from "./stroke";

/**
 * Paint target, stroke and history operations over a shared {@link EditorState}.
 */
export class PaintOps {
  /**
   * @param s - Shared editor state.
   * @param frames - Frame operations (Clear snapshots for undo).
   * @param stamps - Dab stamp cache.
   */
  constructor(
    private readonly s: EditorState,
    private readonly frames: FrameOps,
    private readonly stamps: StampCache,
  ) {}

  // ── Quick Mask / paint target ───────────────────────────────────────────

  /**
   * Switch the paint target. Targeting the mask adds a default mask layer to
   * documents that have none.
   * @param target - New target.
   */
  setPaintTarget(target: PaintTarget): void {
    const s = this.s;
    if (target === s.target) return;
    if (s.stroke.active) s.cancelStroke();
    if (target === "mask") s.ensureMask();
    s.target = target;
    s.events.emit("mask", undefined);
  }

  /**
   * Show or hide the mask layer (adds one if missing).
   * @param visible - Visibility.
   */
  setMaskVisible(visible: boolean): void {
    const s = this.s;
    const layer = s.ensureMask();
    if (layer.visible === visible) return;
    if (s.stroke.active && s.strokeLayerId === layer.id) s.cancelStroke();
    layer.visible = visible;
    s.events.emit("mask", undefined);
    s.events.emit("change", undefined);
    s.events.emit("render", undefined);
  }

  // ── Strokes ─────────────────────────────────────────────────────────────

  /**
   * Start a stroke on the paint target (mask strokes paint white coverage).
   * @param style - Stroke appearance.
   * @param maxDiameter - Largest dab diameter this stroke can produce, document px.
   * @returns `false` if painting is not possible (loading, locked, hidden).
   */
  beginStroke(style: StrokeStyle, maxDiameter: number): boolean {
    const s = this.s;
    if (s.loading || s.stroke.active) return false;
    const layer = s.target === "mask" ? s.ensureMask() : targetLayer(s.doc, "paint");
    if (!layer) return false;
    // A rasterize prompt silently ends this press (see rasterize.ts); the next stroke joins it.
    if (preparePixelEdit(s, layer) !== "proceed") return false;
    const strokeStyle = layer.kind === "mask" ? { ...style, color: MASK_STROKE_COLOR } : style;
    s.strokeLayerId = layer.id;
    s.strokeDiameter = Math.max(1, maxDiameter);
    s.stroke.begin(s.store.ensure(layer.id), s.store.bounds, strokeStyle);
    s.events.emit("history", undefined);
    return true;
  }

  /**
   * Add dabs to the current stroke, growing bounds when they go off-frame.
   * @param dabs - Dabs in document coords.
   */
  addDabs(dabs: readonly Dab[]): void {
    const s = this.s;
    if (!s.stroke.active || dabs.length === 0) return;
    let need: Rect = { x: 0, y: 0, width: 0, height: 0 };
    for (const dab of dabs) {
      const r = dab.size / 2 + 1;
      need = unionRect(need, { x: dab.x - r, y: dab.y - r, width: r * 2, height: r * 2 });
    }
    s.ensureBounds(need, true);
    s.stroke.addDabs(dabs, this.stamps, s.strokeDiameter);
    s.events.emit("render", undefined);
  }

  /**
   * Replace the current stroke's content with one shape (live preview;
   * shape tools call this on every move). Grows bounds like dabs do; on a
   * mask target every part paints white coverage.
   * @param shape - Shape in document coords.
   */
  drawShape(shape: ShapeSpec): void {
    const s = this.s;
    const layerId = s.strokeLayerId;
    if (!s.stroke.active || !layerId) return;
    const need = shapeBounds(shape);
    if (!isEmptyRect(need)) s.ensureBounds(need, true);
    const isMask = s.doc.layers.find((l) => l.id === layerId)?.kind === "mask";
    const rect = intersectRect(roundOutRect(need), s.store.bounds);
    s.stroke.replaceContent(rect, (ctx, origin) => renderShape(ctx, shape, origin, isMask ? MASK_STROKE_COLOR : null));
    s.events.emit("render", undefined);
  }

  /**
   * Commit the stroke to its layer as one undo step.
   * @param end - Where the stroke ended, document coords.
   */
  endStroke(end: Point | null): void {
    const s = this.s;
    const layerId = s.strokeLayerId;
    if (!s.stroke.active || !layerId) return;
    const rect = s.stroke.touched;
    const surface = s.store.ensure(layerId);
    if (isEmptyRect(rect)) {
      s.stroke.cancel();
    } else {
      const before = s.store.read(layerId, rect);
      s.stroke.commit(surface);
      const after = s.store.read(layerId, rect);
      if (before && after) {
        const bytes = before.data.data.byteLength + after.data.data.byteLength;
        s.history.push({ kind: "patch", layerId, x: before.rect.x, y: before.rect.y, before: before.data, after: after.data, bytes });
        s.runtime.touch(layerId);
      }
    }
    s.strokeLayerId = null;
    if (end) s.lastStrokeEnd = { ...end };
    s.afterEdit();
  }

  // ── Undo / redo ─────────────────────────────────────────────────────────

  /** Undo the last operation (no-op while stroking; cancels a Move drag preview). */
  undo(): void {
    const s = this.s;
    if (!s.history.canUndo || s.stroke.active) return;
    s.movePreview = null;
    const entry = s.history.undo();
    if (entry) this.applyEntry(entry, "before");
    s.afterEdit();
  }

  /** Redo the last undone operation (no-op while stroking; cancels a Move drag preview). */
  redo(): void {
    const s = this.s;
    if (!s.history.canRedo || s.stroke.active) return;
    s.movePreview = null;
    const entry = s.history.redo();
    if (entry) this.applyEntry(entry, "after");
    s.afterEdit();
  }

  private applyEntry(entry: HistoryEntry, side: "before" | "after"): void {
    const s = this.s;
    if (entry.kind === "clear") {
      this.frames.applySnapshot(side === "before" ? entry.before : entry.after);
      s.lastStrokeEnd = null;
      return;
    }
    if (entry.kind === "layers") {
      applyLayersEntry(s, entry, side === "after");
      return;
    }
    if (entry.kind === "selection") {
      s.selection.set(side === "before" ? entry.before : entry.after);
      return;
    }
    if (entry.kind === "translate") {
      applyTranslateEntry(s, entry, side === "after");
      return;
    }
    if (entry.kind === "text") {
      applyTextEntry(s, entry, side === "after");
      return;
    }
    if (entry.kind === "group") {
      const parts = side === "after" ? entry.entries : [...entry.entries].reverse();
      for (const part of parts) this.applyEntry(part, side);
      return;
    }
    if (!s.doc.layers.some((l) => l.id === entry.layerId)) return;
    const data = side === "before" ? entry.before : entry.after;
    s.ensureBounds({ x: entry.x, y: entry.y, width: data.width, height: data.height }, false);
    s.store.write(entry.layerId, entry.x, entry.y, data);
    s.runtime.touch(entry.layerId);
  }
}
