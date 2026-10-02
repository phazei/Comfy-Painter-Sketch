/**
 * Pixel side of the layer Move tool
 * (SPEC "Moving (Move layer, Align drawing)") for paint and mask layers:
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
 * - A paint layer's lmask moves with it by the same delta, in the same entry:
 *   its content (`layerMaskCarry.maskContentRect`) shifts and the vacated
 *   part gets the mask's `outside` value, which is as lossless as the layer
 *   part (everything outside the content already holds that value).
 */

import { layerMaskKey } from "../document/layerMask";
import { intersectRect, isEmptyRect } from "../geometry/rect";
import type { Rect } from "../geometry/rect";
import { groupEntries } from "./editorTypes";
import type { HistoryEntry, TranslateEntry } from "./editorTypes";
import type { EditorState } from "./editorState";
import { MASK_WHITE } from "./layerMask";
import { maskContentRect } from "./layerMaskCarry";
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
 * {@link shiftRegion} on a layer mask: with `hide`, the vacated part turns
 * white (hidden, the mask's `outside`) and the moved content replaces what
 * it lands on; without, it is exactly `shiftRegion` (vacated = 0 = shown).
 * @param s - Editor state.
 * @param key - Mask store key.
 * @param from - Mask content to move (clipped to bounds).
 * @param dx - X shift, document px.
 * @param dy - Y shift, document px.
 * @param hide - The mask's `outside` is hide.
 */
export function shiftMaskRegion(s: EditorState, key: string, from: Rect, dx: number, dy: number, hide: boolean): void {
  if (!hide) return shiftRegion(s, key, from, dx, dy);
  const bounds = s.store.bounds;
  const src = intersectRect(from, bounds);
  if (isEmptyRect(src)) return;
  const surface = s.store.ensure(key);
  const lx = src.x - bounds.x;
  const ly = src.y - bounds.y;
  const tmp = createSurface(src.width, src.height);
  tmp.ctx.drawImage(surface.canvas, lx, ly, src.width, src.height, 0, 0, src.width, src.height);
  const ctx = surface.ctx;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  ctx.fillStyle = MASK_WHITE;
  ctx.fillRect(lx, ly, src.width, src.height);
  ctx.clearRect(lx + dx, ly + dy, src.width, src.height);
  ctx.drawImage(tmp.canvas, lx + dx, ly + dy);
  ctx.restore();
  releaseSurface(tmp);
}

/**
 * Translate a layer's content (and its lmask) and record it
 * (translate entry, merged by `gesture`, or patches when the bounds cap
 * clips). Callers check lock / visibility and emit the edit events.
 * @param s - Editor state.
 * @param layerId - Layer id.
 * @param dx - X shift, whole document px.
 * @param dy - Y shift, whole document px.
 * @param gesture - Merge key (nudges), or `undefined` for a separate entry.
 * @returns `true` if pixels moved.
 */
export function translateLayerPixels(s: EditorState, layerId: string, dx: number, dy: number, gesture?: string): boolean {
  const mask = s.doc.layers.find((l) => l.id === layerId)?.layerMask;
  const maskKey = layerMaskKey(layerId);
  const hide = mask?.outside === "hide";
  const content = layerContentRect(s, layerId);
  const maskContent = mask ? maskContentRect(s, layerId) : { x: 0, y: 0, width: 0, height: 0 };
  const plan = planTranslate(s.store.bounds, content, dx, dy, s.doc.frame);
  const mPlan = planTranslate(s.store.bounds, maskContent, dx, dy, s.doc.frame);
  if (plan.kind === "none" && mPlan.kind === "none") return false;
  if (plan.kind !== "none") s.ensureBounds(plan.target, true);
  if (mPlan.kind !== "none") s.ensureBounds(mPlan.target, true);
  const cache = cacheOf(s);
  const withMask = mPlan.kind !== "none";
  if (plan.kind !== "patch" && mPlan.kind !== "patch") {
    if (plan.kind === "translate") shiftRegion(s, layerId, content, dx, dy);
    if (withMask) shiftMaskRegion(s, maskKey, maskContent, dx, dy, hide);
    const merge = gesture ? s.history.mergeTarget() : undefined;
    if (merge?.kind === "translate" && merge.gesture === gesture && merge.layerId === layerId && (merge.mask !== undefined) === withMask) {
      mergeTranslate(merge, dx, dy);
      // Nudged back to the start: the (lossless) entry is a no-op, drop it.
      if (merge.dx === 0 && merge.dy === 0) s.history.discardNewest();
    } else {
      const entry: TranslateEntry = { kind: "translate", layerId, dx, dy, content, bytes: TRANSLATE_ENTRY_BYTES };
      if (withMask) entry.mask = maskContent;
      if (gesture) entry.gesture = gesture;
      s.history.push(entry);
    }
    if (plan.kind === "translate") {
      s.runtime.touch(layerId);
      cache.set(layerId, { revision: s.runtime.revision(layerId), rect: plan.target });
    }
    if (withMask) s.runtime.touch(maskKey);
    return true;
  }
  // The cap clips: record exactly what changed as patches (one step).
  const entries: HistoryEntry[] = [];
  if (plan.kind !== "none") {
    const e = shiftPatch(s, layerId, plan.region, () => shiftRegion(s, layerId, content, dx, dy));
    if (e) entries.push(e);
    cache.delete(layerId);
  }
  if (withMask) {
    const e = shiftPatch(s, maskKey, mPlan.region, () => shiftMaskRegion(s, maskKey, maskContent, dx, dy, hide));
    if (e) entries.push(e);
  }
  const [first, second] = entries;
  if (first) s.history.push(second ? groupEntries(first, second) : first);
  return first !== undefined;
}

/** Run `shift` on `key` and return the patch over `region` (touches the key). */
function shiftPatch(s: EditorState, key: string, region: Rect, shift: () => void): HistoryEntry | null {
  const before = s.store.read(key, intersectRect(region, s.store.bounds));
  if (!before) return null;
  shift();
  const after = s.store.read(key, before.rect);
  s.runtime.touch(key);
  if (!after) return null;
  const bytes = before.data.data.byteLength + after.data.data.byteLength;
  return { kind: "patch", layerId: key, x: before.rect.x, y: before.rect.y, before: before.data, after: after.data, bytes };
}

/**
 * Undo (`forward = false`) or redo a translate entry (with its lmask part).
 * @param s - Editor state.
 * @param entry - Entry.
 * @param forward - Redo direction.
 */
export function applyTranslateEntry(s: EditorState, entry: TranslateEntry, forward: boolean): void {
  const layer = s.doc.layers.find((l) => l.id === entry.layerId);
  if (!layer) return;
  if (!isEmptyRect(entry.content)) {
    const step = translateStep(entry, forward);
    s.ensureBounds(step.to, false);
    shiftRegion(s, entry.layerId, step.from, step.dx, step.dy);
    s.runtime.touch(entry.layerId);
    cacheOf(s).set(entry.layerId, { revision: s.runtime.revision(entry.layerId), rect: step.to });
  }
  if (entry.mask && layer.layerMask) {
    const key = layerMaskKey(layer.id);
    const step = translateStep({ dx: entry.dx, dy: entry.dy, content: entry.mask }, forward);
    s.ensureBounds(step.to, false);
    shiftMaskRegion(s, key, step.from, step.dx, step.dy, layer.layerMask.outside === "hide");
    s.runtime.touch(key);
  }
}
