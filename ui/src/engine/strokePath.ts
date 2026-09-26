/**
 * Stroke path planning for the brush engine (`dabMask.ts`): consecutive dabs
 * become straight segments, each standing for a run of evenly spaced dabs
 * (straight runs are merged so a segment can carry many dabs). Every dab
 * belongs to exactly one segment, so compositing the segments composites
 * each dab once. Pure.
 */

import type { Dab } from "./brush";

/**
 * One straight piece of a stroke path: from `a` to `b`, standing for
 * `intervals` dab steps. Dab `k` of the run sits at
 * `a + (b - a) * k / intervals`, with size / flow / cap interpolated; the
 * segment owns dabs `1..intervals` (dab 0 is the previous segment's end).
 * `intervals` 0 = a single dab at `a` (the stroke's first).
 */
export interface Segment {
  a: Dab;
  b: Dab;
  intervals: number;
}

/** Straight runs of dabs are merged into one segment while every dab stays this close to its place on it, px. */
const MERGE_TOLERANCE = 0.35;

/**
 * Whether dabs `i..j` can be one segment: `j` is within 4 radii of `i`, and
 * every dab between them sits within {@link MERGE_TOLERANCE} of where an
 * evenly spaced run from `i` to `j` would put it (on the chord, at the right
 * distance along it).
 */
function canMerge(pts: readonly Dab[], i: number, j: number): boolean {
  const a = pts[i] as Dab;
  const b = pts[j] as Dab;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len > 2 * Math.max(4, a.size, b.size)) return false;
  if (len < 1e-6) return false;
  for (let k = i + 1; k < j; k++) {
    const p = pts[k] as Dab;
    const rx = p.x - a.x;
    const ry = p.y - a.y;
    if (Math.abs(rx * dy - ry * dx) / len > MERGE_TOLERANCE) return false;
    if (Math.abs((rx * dx + ry * dy) / len - (len * (k - i)) / (j - i)) > MERGE_TOLERANCE) return false;
  }
  return true;
}

/**
 * Turn consecutive dabs into segments: every pair of consecutive dabs is one
 * interval, and straight runs are merged into one segment while every
 * intermediate dab stays within {@link MERGE_TOLERANCE} of the chord (up to
 * 4 radii, so pressure changes stay close to linear).
 * @param prev - Last dab of the previous batch (`null` at stroke start: the first dab is a single stamp).
 * @param dabs - New dabs, in order.
 * @returns Segments.
 */
export function planSegments(prev: Dab | null, dabs: readonly Dab[]): Segment[] {
  const out: Segment[] = [];
  const pts: Dab[] = prev ? [prev, ...dabs] : [...dabs];
  if (!prev && pts[0]) out.push({ a: pts[0], b: pts[0], intervals: 0 });
  let i = 0;
  while (i < pts.length - 1) {
    const start = pts[i] as Dab;
    let j = i + 1;
    while (j + 1 < pts.length && canMerge(pts, i, j + 1)) j++;
    const end = pts[j] as Dab;
    if (Math.hypot(end.x - start.x, end.y - start.y) < 1e-6) out.push({ a: end, b: end, intervals: 0 });
    else out.push({ a: start, b: end, intervals: j - i });
    i = j;
  }
  return out;
}
