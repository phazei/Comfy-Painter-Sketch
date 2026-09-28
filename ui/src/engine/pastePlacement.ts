/**
 * Where a pasted / inserted item lands (Photoshop's rule, measured by the
 * maintainer). Pure: plain rects in document coords, unit-testable.
 *
 * {@link pasteTopLeft}, first match wins:
 * 1. A selection exists -> centred on its bounding box (even off screen; never resized).
 * 2. The item is our own copy from this editor's document -> its original position.
 * 3. The whole image area is visible in the view -> centre of the image area.
 * 4. Else -> centre of the view.
 * Then ALWAYS {@link clampIntoArea} (inside the image area; centred on an axis
 * where it is larger) and snapped to whole document pixels.
 */

import { frameRect } from "../geometry/rect";
import type { Point, Rect, Size } from "../geometry/rect";
import { imageRectToDoc } from "./frameMap";
import type { FrameMap } from "./frameMap";
import type { Selection } from "./selection";
import type { ViewTransform } from "./viewport";

/** Inputs of {@link pasteTopLeft} (document coords). */
export interface PasteContext {
  /** Selection bounding box, or `null` without a selection. */
  selection: Rect | null;
  /** Original top-left of our own copy from this document, else `null`. */
  original: Point | null;
  /** The image area (background / output rect). */
  imageArea: Rect;
  /** The visible stage rect, or `null` when unknown (treated as fully visible). */
  view: Rect | null;
}

const EPS = 1e-6;

/**
 * Clamp a top-left so an item of `size` lies inside `area` (centred on an
 * axis where it is larger), snapped to whole pixels.
 * @param topLeft - Wanted top-left.
 * @param size - Item size, document px.
 * @param area - Image area.
 * @returns Integer top-left.
 */
export function clampIntoArea(topLeft: Point, size: Size, area: Rect): Point {
  const axis = (v: number, len: number, lo: number, span: number): number => {
    if (len > span) return Math.round(lo + (span - len) / 2);
    const min = Math.ceil(lo - EPS);
    const max = Math.floor(lo + span - len + EPS);
    return Math.min(Math.max(Math.round(v), min), Math.max(min, max)) + 0; // + 0: no -0
  };
  return { x: axis(topLeft.x, size.width, area.x, area.width), y: axis(topLeft.y, size.height, area.y, area.height) };
}

/**
 * Top-left of a pasted item (see module doc).
 * @param size - Item size, document px.
 * @param ctx - Selection / original / image area / view.
 * @returns Integer top-left, document px.
 */
export function pasteTopLeft(size: Size, ctx: PasteContext): Point {
  const centreOn = (r: Rect): Point => ({ x: r.x + r.width / 2 - size.width / 2, y: r.y + r.height / 2 - size.height / 2 });
  let at: Point;
  if (ctx.selection) at = centreOn(ctx.selection);
  else if (ctx.original) at = ctx.original;
  else if (!ctx.view || contains(ctx.view, ctx.imageArea)) at = centreOn(ctx.imageArea);
  else at = centreOn(ctx.view);
  return clampIntoArea(at, size, ctx.imageArea);
}

/**
 * Image area in document coords.
 * @param imageSize - Current image size.
 * @param map - `editor.frameMap` / `documentMap(...)`.
 * @returns Rect.
 */
export function imageAreaDoc(imageSize: Size, map: FrameMap): Rect {
  return imageRectToDoc(map, frameRect(imageSize));
}

/**
 * Visible stage rect in document coords (the view content is image px).
 * @param view - View transform.
 * @param stage - Stage CSS size.
 * @param map - Frame map.
 * @returns Rect, or `null` for an unsized stage.
 */
export function viewRectDoc(view: ViewTransform, stage: Size, map: FrameMap): Rect | null {
  if (!(stage.width > 0 && stage.height > 0 && view.scale > 0)) return null;
  const r = { x: -view.offsetX / view.scale, y: -view.offsetY / view.scale, width: stage.width / view.scale, height: stage.height / view.scale };
  return imageRectToDoc(map, r);
}

/**
 * Bounding box of a selection (an inverted selection covers everything: the image area).
 * @param sel - Selection or `null`.
 * @param imageArea - Image area.
 * @returns Rect or `null`.
 */
export function selectionBox(sel: Selection | null, imageArea: Rect): Rect | null {
  if (!sel) return null;
  if (sel.outside > 0 || sel.rect.width <= 0 || sel.rect.height <= 0) return imageArea;
  return sel.rect;
}

/**
 * Paste context of an editor.
 * @param e - Selection, view, frame map and image size.
 * @param original - Top-left of our own copy from this document, else `null`.
 * @returns Context.
 */
export function pasteContext(
  e: { selection: Selection | null; view: ViewTransform; stage: Size; map: FrameMap; imageSize: Size },
  original: Point | null,
): PasteContext {
  const imageArea = imageAreaDoc(e.imageSize, e.map);
  return { selection: selectionBox(e.selection, imageArea), original, imageArea, view: viewRectDoc(e.view, e.stage, e.map) };
}

function contains(outer: Rect, inner: Rect): boolean {
  return (
    inner.x >= outer.x - EPS &&
    inner.y >= outer.y - EPS &&
    inner.x + inner.width <= outer.x + outer.width + EPS &&
    inner.y + inner.height <= outer.y + outer.height + EPS
  );
}
