/**
 * Free Transform hit zones and cursor choice (SPEC "Free Transform and flips"), pure: which handle /
 * zone a press lands in and which resize cursor a handle shows for the
 * current rotation / flips. Matrix and drag math live in `transformMath.ts`.
 */

import type { Point } from "../geometry/rect";
import { apply, HANDLES, invert, transformedCorners } from "./transformMath";
import type { Affine, HandleDir } from "./transformMath";

/** What a press at a point would do. */
export type TransformHit =
  | { kind: "move" }
  | { kind: "scale"; handle: number }
  | { kind: "rotate" }
  | { kind: "outside" };

/** Resize cursor axes (native CSS cursors). */
export type ResizeAxis = "ns" | "ew" | "nwse" | "nesw";

/**
 * Document position of a handle (or the centre for `{0, 0}`).
 * @param m - Float-local -> document matrix.
 * @param w - Float width.
 * @param h - Float height.
 * @param dir - Handle direction.
 * @returns Document point.
 */
export function handlePoint(m: Affine, w: number, h: number, dir: HandleDir): Point {
  return apply(m, { x: ((dir.hx + 1) * w) / 2, y: ((dir.hy + 1) * h) / 2 });
}

// ── Hit zones ─────────────────────────────────────────────────────────────────

/**
 * What a press at `at` does: a handle (within `handleTol`), inside the box
 * (move), just outside a corner (within `rotateTol`: rotate), or nothing.
 * @param m - Float-local -> document matrix.
 * @param w - Float width.
 * @param h - Float height.
 * @param at - Document point.
 * @param handleTol - Handle grab radius, document px.
 * @param rotateTol - Rotate zone reach beyond a corner, document px.
 * @returns Hit.
 */
export function hitTransform(m: Affine, w: number, h: number, at: Point, handleTol: number, rotateTol: number): TransformHit {
  let best = -1;
  let bestDist = handleTol;
  HANDLES.forEach((dir, i) => {
    const p = handlePoint(m, w, h, dir);
    const dist = Math.hypot(p.x - at.x, p.y - at.y);
    if (dist <= bestDist) {
      best = i;
      bestDist = dist;
    }
  });
  if (best >= 0) return { kind: "scale", handle: best };
  const inv = invert(m);
  if (!inv) return { kind: "outside" };
  const local = apply(inv, at);
  if (local.x >= 0 && local.y >= 0 && local.x <= w && local.y <= h) return { kind: "move" };
  for (const corner of transformedCorners(m, w, h)) {
    if (Math.hypot(corner.x - at.x, corner.y - at.y) <= handleTol + rotateTol) return { kind: "rotate" };
  }
  return { kind: "outside" };
}

/**
 * Resize cursor for a handle: the handle's on-screen direction from the
 * centre, binned into 4 axes (45 deg sectors), so rotated boxes get the
 * matching diagonal / straight cursor.
 * @param m - Matrix.
 * @param w - Float width.
 * @param h - Float height.
 * @param handle - Handle index ({@link HANDLES}).
 * @returns Cursor axis.
 */
export function resizeAxis(m: Affine, w: number, h: number, handle: number): ResizeAxis {
  const dir = HANDLES[handle] ?? { hx: 1, hy: 0 };
  const centre = handlePoint(m, w, h, { hx: 0, hy: 0 });
  const p = handlePoint(m, w, h, dir);
  let deg = (Math.atan2(p.y - centre.y, p.x - centre.x) * 180) / Math.PI;
  deg = ((deg % 180) + 180) % 180;
  if (deg < 22.5 || deg >= 157.5) return "ew";
  if (deg < 67.5) return "nwse";
  if (deg < 112.5) return "ns";
  return "nesw";
}
