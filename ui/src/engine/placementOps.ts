/**
 * Whole-drawing placement of the editor core (SPEC M5 Move tool), exposed as
 * {@link Editor.placement}. Placement is document metadata composed into the
 * frame map (`frameMap.ts` / {@link documentMap}); pixels are never touched.
 *
 * NOT undoable: changes never enter the history, so Ctrl+Z always undoes
 * paint. A committed change emits `change` (widget value update; nothing is
 * dirty, so nothing uploads); live drag updates only redraw. Clear resets
 * the placement as part of its own (undoable) snapshot (`frameOps.ts`).
 */

import { IDENTITY_PLACEMENT, isIdentityPlacement, normalizePlacement } from "../document/placement";
import type { Placement } from "../document/types";
import type { Point } from "../geometry/rect";
import type { EditorState } from "./editorState";
import { placementImageOffset, scalePlacementAt, translatePlacement } from "./placementMath";

/**
 * Placement commands over a shared {@link EditorState}.
 */
export class PlacementOps {
  /**
   * @param s - Shared editor state.
   */
  constructor(private readonly s: EditorState) {}

  /** Current placement (a copy; identity when unset). */
  get current(): Placement {
    return { ...(this.s.doc.placement ?? IDENTITY_PLACEMENT) };
  }

  /** Whether the drawing is moved or scaled. */
  get isMoved(): boolean {
    return !isIdentityPlacement(this.s.doc.placement);
  }

  /** Current offset in image px (options bar X / Y). */
  get imageOffset(): Point {
    const s = this.s;
    return placementImageOffset(this.current, s.doc.frame, s.imageSize);
  }

  /**
   * Replace the placement (normalized: finite, scale clamped).
   * @param next - New placement.
   * @param commit - `true` (default): also update the widget value
   *   (`change`); `false` for live drag frames (redraw only).
   */
  set(next: Readonly<Placement>, commit = true): void {
    const s = this.s;
    const p = normalizePlacement(next);
    const before = s.doc.placement;
    const same = before ? before.x === p.x && before.y === p.y && before.scale === p.scale : isIdentityPlacement(p);
    if (!same) {
      if (isIdentityPlacement(p)) delete s.doc.placement;
      else s.doc.placement = p;
      s.events.emit("placement", undefined);
      s.events.emit("render", undefined);
    }
    if (commit) this.commit();
  }

  /** Publish the current placement to the widget value (end of a drag). */
  commit(): void {
    this.s.events.emit("change", undefined);
  }

  /**
   * Move by an image-px delta (arrow nudges).
   * @param dx - Image px.
   * @param dy - Image px.
   * @param commit - See {@link set}.
   */
  translateImage(dx: number, dy: number, commit = true): void {
    const s = this.s;
    this.set(translatePlacement(this.current, s.doc.frame, s.imageSize, dx, dy), commit);
  }

  /**
   * Multiply the scale around an image point (kept fixed).
   * @param factor - Scale multiplier.
   * @param anchor - Image point.
   * @param commit - See {@link set}.
   */
  scaleAt(factor: number, anchor: Point, commit = true): void {
    const s = this.s;
    this.set(scalePlacementAt(this.current, s.doc.frame, s.imageSize, factor, anchor), commit);
  }

  /** Back to identity ("Reset position"). */
  reset(): void {
    this.set(IDENTITY_PLACEMENT);
  }
}
