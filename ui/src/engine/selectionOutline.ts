/**
 * Marching-ants outline of a selection (decision 7): the boundary between
 * selected and unselected pixels at the 50% threshold (coverage >= 128), as
 * closed contours on the pixel grid in document coords.
 *
 * Built marching-squares style: every unit pixel edge becomes a directed
 * edge with the selected pixel on its right, the edges are chained vertex to
 * vertex into closed loops, and only the corners are kept (colinear runs
 * merged), so a rectangle is one contour of 4 corners and a hole is its own
 * contour. Stroking each contour as one continuous subpath lets the dash
 * pattern flow along diagonal / curved edges (thousands of separate 1 px
 * segments would each restart the dash and make the edge pulse).
 *
 * Saddles (two selected pixels touching only at a corner) turn towards the
 * selected side, so diagonal neighbours get separate contours.
 *
 * Computed once per selection change (callers cache it); the UI turns it
 * into a `Path2D`. Pure, no DOM.
 */

import { isEmptyRect, unionRect } from "../geometry/rect";
import type { Rect } from "../geometry/rect";
import type { Selection } from "./selection";

/** Coverage at or above this counts as selected for the outline. */
export const OUTLINE_THRESHOLD = 128;

/** One closed contour: flat corner list `[x0, y0, x1, y1, ...]` in document coords (implicitly closed). */
export type Contour = Float64Array;

// Directions (bit flags per grid vertex, y down).
const E = 1;
const S = 2;
const W = 4;
const N = 8;

/**
 * Outline contours of a selection.
 *
 * An inverted selection (`outside` 255) covers everything outside its
 * bbox; pass `area` (the image frame) to also outline where that ends
 * (Photoshop shows ants along the canvas edge), otherwise only the edges
 * inside the bbox (the holes) are returned.
 * @param sel - Selection.
 * @param area - Integer document rect that bounds an inverted selection's outside coverage.
 * @returns Closed contours (empty when there is no edge).
 */
export function outlineContours(sel: Selection, area?: Rect): Contour[] {
  const { rect, data } = sel;
  const outsideIn = sel.outside >= OUTLINE_THRESHOLD;
  // Domain: the grid we scan. Beyond it every pixel reads as `beyond`.
  const bounded = outsideIn && area !== undefined && !isEmptyRect(area);
  const dom = bounded ? unionRect(rect, area) : rect;
  const beyond = outsideIn && !bounded;
  const w = dom.width;
  const h = dom.height;
  if (w <= 0 || h <= 0) return [];

  if (!bounded && isUniform(data)) {
    // Rect marquee fast path: a solid block has exactly its border as edges.
    if (((data[0] as number) >= OUTLINE_THRESHOLD) === beyond) return [];
    return [rectContour(dom)];
  }

  // Padded 0/1 grid of the domain (1 px border = `beyond`).
  const gw = w + 2;
  const grid = new Uint8Array(gw * (h + 2));
  if (beyond) grid.fill(1);
  const ox = rect.x - dom.x;
  const oy = rect.y - dom.y;
  if (bounded) {
    // Inside the domain but outside the bbox: selected (inverted outside).
    for (let y = 0; y < h; y++) grid.fill(1, (y + 1) * gw + 1, (y + 1) * gw + 1 + w);
  }
  for (let y = 0; y < rect.height; y++) {
    const src = y * rect.width;
    const dst = (y + oy + 1) * gw + ox + 1;
    for (let x = 0; x < rect.width; x++) grid[dst + x] = (data[src + x] as number) >= OUTLINE_THRESHOLD ? 1 : 0;
  }

  // Directed edges, selected pixel on the right: out-bits per vertex.
  const vw = w + 1;
  const out = new Uint8Array(vw * (h + 1));
  for (let vy = 0; vy <= h; vy++) {
    const above = vy * gw + 1; // grid row vy - 1 (padded row vy)
    const below = above + gw; // grid row vy
    const v = vy * vw;
    for (let px = 0; px < w; px++) {
      const a = grid[above + px] as number;
      const b = grid[below + px] as number;
      if (a === b) continue;
      if (b) addBit(out, v + px, E); // top edge of a selected pixel, eastward
      else addBit(out, v + px + 1, W); // bottom edge, westward
    }
  }
  for (let py = 0; py < h; py++) {
    const row = (py + 1) * gw; // padded index of pixel (-1, py)
    for (let vx = 0; vx <= w; vx++) {
      const l = grid[row + vx] as number;
      const r = grid[row + vx + 1] as number;
      if (l === r) continue;
      if (r) addBit(out, (py + 1) * vw + vx, N); // left edge, northward
      else addBit(out, py * vw + vx, S); // right edge, southward
    }
  }

  // Chain. The raster-first vertex with edges left always has exactly one
  // (it has no edge going up or left), so it is a safe corner to start at.
  const contours: Contour[] = [];
  const pts: number[] = [];
  for (let start = 0; start < out.length; start++) {
    if (out[start] === 0) continue;
    pts.length = 0;
    let v = start;
    let dir = 0;
    for (;;) {
      const bits = out[v] as number;
      if (bits === 0) break;
      const next = dir === 0 ? lowestBit(bits) : pick(bits, dir);
      out[v] = bits & ~next;
      if (next !== dir) pts.push(dom.x + (v % vw), dom.y + ((v / vw) | 0));
      dir = next;
      v += dir === E ? 1 : dir === W ? -1 : dir === S ? vw : -vw;
    }
    // Back at the start vertex (a corner: arrived going N, left going E).
    if (pts.length >= 8) contours.push(Float64Array.from(pts));
  }
  return contours;
}

/**
 * Next direction at a vertex: turn right (towards the selected side), else
 * straight, else left.
 */
function pick(bits: number, dir: number): number {
  const right = dir === N ? E : dir << 1;
  if (bits & right) return right;
  if (bits & dir) return dir;
  const left = dir === E ? N : dir >> 1;
  if (bits & left) return left;
  return lowestBit(bits);
}

function addBit(out: Uint8Array, i: number, bit: number): void {
  out[i] = (out[i] as number) | bit;
}

function lowestBit(bits: number): number {
  return bits & -bits;
}

function rectContour(r: Rect): Contour {
  const x1 = r.x + r.width;
  const y1 = r.y + r.height;
  return Float64Array.from([r.x, r.y, x1, r.y, x1, y1, r.x, y1]);
}

function isUniform(data: Uint8Array): boolean {
  const first = data[0];
  for (let i = 1; i < data.length; i++) if (data[i] !== first) return false;
  return true;
}
