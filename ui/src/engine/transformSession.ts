/**
 * Free Transform session state (SPEC M11) and its handle drags, pure: the
 * parameters a drag in progress asks for (`transformOps.ts` shows them).
 */

import type { Point } from "../geometry/rect";
import type { FloatState } from "./floatOps";
import type { Selection } from "./selection";
import type { TextTransform } from "./textTransform";
import type { TransformHit } from "./transformHit";
import { rotateDrag, scaleDrag } from "./transformMath";
import type { Affine, TransformParams } from "./transformMath";

/** A running session. */
export interface Session {
  /** The float it belongs to (the session ends when the float does); `null` for text. */
  float: Readonly<FloatState> | null;
  /** Text layer session (M11b), or `null` for pixels. */
  text: TextTransform | null;
  /** Box size (float-local / unrotated text box), px. */
  w: number;
  h: number;
  params: TransformParams;
  /** Matrix and selection at session start (identity = exactly these). */
  startM: Affine;
  startSel: Selection | null;
}

/** A handle drag in progress. */
export interface TransformDrag {
  hit: TransformHit;
  start: TransformParams;
  from: Point;
}

/**
 * Parameters of a drag at a pointer position.
 * @param drag - The drag.
 * @param w - Session box width, px.
 * @param h - Session box height, px.
 * @param at - Pointer, document px.
 * @param mods - Shift (free scale / 15 deg snap) and Alt (around the centre).
 * @param proportional - Proportion lock (Shift inverts it).
 * @returns New parameters (the start ones for `outside`).
 */
export function dragParams(
  drag: Readonly<TransformDrag>,
  w: number,
  h: number,
  at: Point,
  mods: { shift: boolean; alt: boolean },
  proportional: boolean,
): TransformParams {
  const { hit, start, from } = drag;
  switch (hit.kind) {
    case "move":
      // Whole document px: a pure move stays pixel-exact.
      return { ...start, cx: start.cx + Math.round(at.x - from.x), cy: start.cy + Math.round(at.y - from.y) };
    case "scale":
      return scaleDrag(start, w, h, hit.handle, at, { proportional: proportional !== mods.shift, fromCentre: mods.alt });
    case "rotate":
      return rotateDrag(start, from, at, mods.shift);
    case "outside":
      return start;
  }
}
