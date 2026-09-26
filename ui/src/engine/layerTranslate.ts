/**
 * Pixel side of the layer Move tool (SPEC M6a) for paint and mask layers:
 * shift a layer's content by whole document px and record it.
 *
 * - Bounds first grow (chunked, capped, like painting) to cover the moved
 *   content. If nothing is clipped the move is a pixel-free
 *   {@link TranslateEntry} (exactly reversible: an integer canvas-to-canvas
 *   copy is lossless); if the cap clips it, a normal before/after patch.
 * - Consecutive moves with the same gesture key (arrow nudges) on the same
 *   layer merge into one translate entry.
 * - Re-applying an entry grows bounds exactly (uncapped, like patches) to
 *   cover where the content lands, so undo/redo stays valid after any later
 *   bounds growth.
 * - The content bbox (alpha > 0) is cached per layer pixel revision, so
 *   repeated nudges don't re-read the whole layer.
 */

import { intersectRect, isEmptyRect } from "../geometry/rect";
import type { Rect } from "../geometry/rect";
import type { TranslateEntry } from "./editorTypes";
import type { EditorState } from "./editorState";
import { createSurface, releaseSurface } from "./surface";
import { alphaBounds, mergeTranslate, offsetRect, planTranslate, translateStep } from "./translateMath";

/** History cost of a translate entry (metadata only), bytes. */
export const TRANSLATE_ENTRY_BYTES = 128;

/** Content bbox cache per editor state: layer id -> (revision, doc rect). */
const contentCache = new WeakMap<EditorState, Map<string, { revision: number; rect: Rect }>>();

function cacheOf(s: EditorState): Map<string, { revision: number; rect: Rect }> {
  let cache = contentCache.get(s);
  if (!cache) {
    cache = new Map();
    contentCache.set(s, cache);
  }
  return cache;
}

/**
 * Bounding box of a layer's non-transparent pixels, document coords.
 * @param s - Editor state.
 * @param layerId - Layer id.
 * @returns Rect (zero-size for an empty layer).
 */
export function layerContentRect(s: EditorState, layerId: string): Rect {
  const cache = cacheOf(s);
  const revision = s.runtime.revision(layerId);
  const hit = cache.get(layerId);
  if (hit && hit.revision === revision) return { ...hit.rect };
  let rect: Rect = { x: 0, y: 0, width: 0, height: 0 };
  if (s.runtime.get(layerId)?.hasContent) {
    const bounds = s.store.bounds;
    const data = s.store.snapshot(layerId);
    const local = alphaBounds(data.data, data.width, data.height);
    if (!isEmptyRect(local)) rect = offsetRect(local, bounds.x, bounds.y);
  }
  cache.set(layerId, { revision, rect });
  return { ...rect };
}

/**
 * Move the pixels of `from` (document coords) by an integer delta on the
 * layer canvas; the vacated area becomes transparent, anything landing
 * outside the bounds is dropped.
 * @param s - Editor state.
 * @param layerId - Layer id.
 * @param from - Area to move (clipped to bounds).
 * @param dx - X shift, document px.
 * @param dy - Y shift, document px.
 */
export function shiftRegion(s: EditorState, layerId: string, from: Rect, dx: number, dy: number): void {
  const bounds = s.store.bounds;
  const src = intersectRect(from, bounds);
  if (isEmptyRect(src)) return;
  const surface = s.store.ensure(layerId);
  const lx = src.x - bounds.x;
  const ly = src.y - bounds.y;
  const tmp = createSurface(src.width, src.height);
  tmp.ctx.drawImage(surface.canvas, lx, ly, src.width, src.height, 0, 0, src.width, src.height);
  const ctx = surface.ctx;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  ctx.clearRect(lx, ly, src.width, src.height);
  ctx.drawImage(tmp.canvas, lx + dx, ly + dy);
  ctx.restore();
  releaseSurface(tmp);
}

/**
 * Translate a layer's content and record it (translate entry, merged by
 * `gesture`, or a patch when the bounds cap clips). Callers check lock /
 * visibility and emit the edit events.
 * @param s - Editor state.
 * @param layerId - Layer id.
 * @param dx - X shift, whole document px.
 * @param dy - Y shift, whole document px.
 * @param gesture - Merge key (nudges), or `undefined` for a separate entry.
 * @returns `true` if pixels moved.
 */
export function translateLayerPixels(s: EditorState, layerId: string, dx: number, dy: number, gesture?: string): boolean {
  const content = layerContentRect(s, layerId);
  const plan = planTranslate(s.store.bounds, content, dx, dy, s.doc.frame);
  if (plan.kind === "none") return false;
  s.ensureBounds(plan.target, true);
  const cache = cacheOf(s);
  if (plan.kind === "translate") {
    shiftRegion(s, layerId, content, dx, dy);
    const merge = gesture ? s.history.mergeTarget() : undefined;
    if (merge?.kind === "translate" && merge.gesture === gesture && merge.layerId === layerId) {
      mergeTranslate(merge, dx, dy);
      // Nudged back to the start: the (lossless) entry is a no-op, drop it.
      if (merge.dx === 0 && merge.dy === 0) s.history.discardNewest();
    } else {
      const entry: TranslateEntry = { kind: "translate", layerId, dx, dy, content, bytes: TRANSLATE_ENTRY_BYTES };
      if (gesture) entry.gesture = gesture;
      s.history.push(entry);
    }
    s.runtime.touch(layerId);
    cache.set(layerId, { revision: s.runtime.revision(layerId), rect: plan.target });
    return true;
  }
  // The cap clips: record exactly what changed as a patch.
  const region = intersectRect(plan.region, s.store.bounds);
  const before = s.store.read(layerId, region);
  if (!before) return false;
  shiftRegion(s, layerId, content, dx, dy);
  const after = s.store.read(layerId, before.rect);
  if (after) {
    const bytes = before.data.data.byteLength + after.data.data.byteLength;
    s.history.push({ kind: "patch", layerId, x: before.rect.x, y: before.rect.y, before: before.data, after: after.data, bytes });
  }
  s.runtime.touch(layerId);
  cache.delete(layerId);
  return true;
}

/**
 * Undo (`forward = false`) or redo a translate entry.
 * @param s - Editor state.
 * @param entry - Entry.
 * @param forward - Redo direction.
 */
export function applyTranslateEntry(s: EditorState, entry: TranslateEntry, forward: boolean): void {
  if (!s.doc.layers.some((l) => l.id === entry.layerId)) return;
  const step = translateStep(entry, forward);
  s.ensureBounds(step.to, false);
  shiftRegion(s, entry.layerId, step.from, step.dx, step.dy);
  s.runtime.touch(entry.layerId);
  cacheOf(s).set(entry.layerId, { revision: s.runtime.revision(entry.layerId), rect: step.to });
}
