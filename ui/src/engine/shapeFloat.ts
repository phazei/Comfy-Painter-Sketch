/**
 * Shapes straight into Free Transform (SPEC "Tools" > shapes): when a shape
 * drag ends, the shape becomes a float on the CURRENT target surface (paint
 * layer, or the cmask under Quick Mask; never a new layer) and a Free
 * Transform session starts on it at once, reusing the float / session
 * machinery of image inserts (`sourceInsert.ts`, `floatOps.ts`,
 * `transformOps.ts`).
 *
 * - The float holds the shape ALONE: the stroke buffer composited at the
 *   tool opacity and through the selection clip onto a transparent surface
 *   (`StrokeBuffer.compositeInto`). The selection clip is applied here, when
 *   the shape becomes the float -- a transformed shape keeps the clipped
 *   pixels, it is not clipped again at commit. The float is independent of
 *   the selection (`FloatState.shape`): commit and cancel leave it alone.
 * - Exactness: the layer result of a direct commit (today's pixels) is
 *   computed now and kept as `FloatState.exact`; the layer goes back to its
 *   previous pixels while floating. A commit at the start matrix writes
 *   exactly those bytes (`floatCommit.ts`), so an untouched commit is
 *   pixel-identical to the old direct rasterization; a transformed one
 *   resamples the shape pixels once, like any session.
 * - Commit (Enter, check button, any settle / tool switch) = ONE patch step
 *   (it joins a preceding text-layer rasterize step, `rasterize.ts`); cancel
 *   (Esc, x, Ctrl+Z) = the shape goes away, no history.
 * - The session box is the shape's axis-aligned pixel bounds.
 */

import { intersectRect, isEmptyRect } from "../geometry/rect";
import type { Rect } from "../geometry/rect";
import type { EditorState } from "./editorState";
import type { FloatOps } from "./floatOps";
import type { FloatState } from "./floatLift";
import { selectionExtent } from "./selection";
import { createSurface, releaseSurface } from "./surface";

/**
 * Shape-stroke ending over a shared {@link EditorState}.
 */
export class ShapeFloatOps {
  /**
   * @param s - Shared editor state.
   * @param float - Float commands (the session runs on a float).
   */
  constructor(
    private readonly s: EditorState,
    private readonly float: FloatOps,
  ) {}

  /**
   * End the current shape stroke as a float in a Free Transform session (see
   * module doc). A shape that changes no pixel ends without anything.
   * @returns `true` if a session runs.
   */
  end(): boolean {
    const s = this.s;
    const layerId = s.strokeLayerId;
    if (!s.stroke.active || !layerId) return false;
    const sel = s.selection.current;
    // Same clipped rect as a direct commit (`PaintOps.endStroke`).
    const rect = sel ? intersectRect(s.stroke.touched, selectionExtent(sel, s.store.bounds)) : s.stroke.touched;
    const before = isEmptyRect(rect) ? null : s.store.read(layerId, rect);
    if (!before) {
      s.cancelStroke();
      return false;
    }
    const r = before.rect;
    const alone = createSurface(r.width, r.height);
    s.stroke.compositeInto(alone, r);
    s.stroke.commit(s.store.ensure(layerId));
    s.strokeLayerId = null;
    const after = s.store.read(layerId, r);
    // The layer keeps its previous pixels while the shape floats.
    s.store.write(layerId, r.x, r.y, before.data);
    s.runtime.bump(layerId);
    const shape = alone.ctx.getImageData(0, 0, r.width, r.height);
    releaseSurface(alone);
    if (!after || sameBytes(before.data.data, after.data.data)) {
      s.afterEdit();
      return false;
    }
    const area = alphaBox(shape.data, r) ?? r;
    const pixels = cropPixels(shape, r, area);
    const surface = createSurface(area.width, area.height);
    surface.ctx.putImageData(pixels, 0, 0);
    const f: FloatState = {
      layerId,
      area,
      original: before.data,
      holeRect: r,
      pixels,
      surface,
      dx: 0, dy: 0, selBefore: null, selBase: null, xf: null, baked: null, dragBase: null, preview: null,
      inserted: true,
      shape: true,
      exact: { rect: r, data: after.data },
    };
    if (!this.float.adoptInserted(f)) return false;
    return this.float.transform.enter();
  }
}

/** Document rect of the non-transparent pixels of `px` (over `rect`), or `null`. */
function alphaBox(px: Uint8ClampedArray, rect: Rect): Rect | null {
  let x0 = rect.width;
  let y0 = rect.height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < rect.height; y++) {
    for (let x = 0; x < rect.width; x++) {
      if (px[(y * rect.width + x) * 4 + 3] === 0) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return x1 < 0 ? null : { x: rect.x + x0, y: rect.y + y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}

/** The part of `image` (over `rect`) inside `area` (a sub-rect). */
function cropPixels(image: ImageData, rect: Rect, area: Rect): ImageData {
  if (area.width === rect.width && area.height === rect.height) return image;
  const out = new Uint8ClampedArray(area.width * area.height * 4);
  for (let y = 0; y < area.height; y++) {
    const s = ((area.y - rect.y + y) * rect.width + (area.x - rect.x)) * 4;
    out.set(image.data.subarray(s, s + area.width * 4), y * area.width * 4);
  }
  return new ImageData(out, area.width, area.height);
}

function sameBytes(a: Uint8ClampedArray, b: Uint8ClampedArray): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
