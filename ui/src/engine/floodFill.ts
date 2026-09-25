/**
 * Pure flood fill on RGBA typed arrays (paint bucket; magic wand via `wand.ts`).
 * Produces a coverage mask (`Uint8Array`, 0-255) plus its bounding box; the
 * caller blends a colour through it (`coverageBlend.ts`).
 *
 * Matching is Photoshop-like: a pixel matches the seed when every channel
 * (R, G, B and alpha) differs by at most `tolerance` (0-255). Two fully
 * transparent pixels always match, whatever their (meaningless) RGB.
 *
 * Contiguous mode is a scanline fill with an explicit `Int32Array` stack --
 * no recursion, no string-keyed visited set (ComfySketch's was the slow
 * part). The coverage array doubles as the visited set: 0 = no match,
 * 1 = matching but not reached (yet), 255 = filled. Global mode just keeps
 * every match. Anti-alias adds a 1 px soft fringe outside the filled area
 * (3x3 box average of the hard mask, inside stays fully covered so the fill
 * still meets its boundary). `clip` (M5 selection) restricts and scales the
 * coverage. No DOM.
 */

import type { Rect } from "../geometry/rect";

// ── Types ─────────────────────────────────────────────────────────────────────

/** Flood fill parameters. */
export interface FloodFillOptions {
  /** Seed pixel x (buffer coords; floored). */
  x: number;
  /** Seed pixel y (buffer coords; floored). */
  y: number;
  /** Max per-channel difference to the seed colour, 0-255. */
  tolerance: number;
  /** `true`: only pixels connected to the seed (4-neighbourhood); `false`: every matching pixel. */
  contiguous: boolean;
  /** Soften the coverage edge by a 1 px fringe. */
  antiAlias: boolean;
  /** Optional selection coverage (same size as the buffer): 0 blocks, partial values scale. */
  clip?: Uint8Array;
}

/** Flood fill output. */
export interface FloodFillResult {
  /** Coverage per pixel (`width * height`), 0-255. */
  coverage: Uint8Array;
  /** Bounding box of non-zero coverage (buffer coords; empty when nothing filled). */
  bbox: Rect;
}

const EMPTY_RECT: Rect = { x: 0, y: 0, width: 0, height: 0 };
const MATCH = 1;
const FILLED = 255;

// ═══════════════════════════════════════════════════════════════════════════

/**
 * Flood fill a straight-alpha RGBA buffer from a seed pixel.
 *
 * @param data - RGBA pixels, `width * height * 4` bytes.
 * @param width - Buffer width in px.
 * @param height - Buffer height in px.
 * @param options - Seed, tolerance, mode, anti-alias and optional clip.
 * @returns Coverage mask and its bounding box.
 */
export function floodFill(data: Uint8ClampedArray, width: number, height: number, options: FloodFillOptions): FloodFillResult {
  const coverage = new Uint8Array(width * height);
  const sx = Math.floor(options.x);
  const sy = Math.floor(options.y);
  if (!(sx >= 0 && sy >= 0 && sx < width && sy < height) || data.length < width * height * 4) {
    return { coverage, bbox: { ...EMPTY_RECT } };
  }
  const seed = sy * width + sx;
  const clip = options.clip && options.clip.length === coverage.length ? options.clip : undefined;
  markMatches(data, coverage, seed, clampTolerance(options.tolerance), clip);
  if (coverage[seed] !== MATCH) return { coverage: new Uint8Array(width * height), bbox: { ...EMPTY_RECT } };

  let bbox = options.contiguous ? fillContiguous(coverage, width, height, seed) : keepAllMatches(coverage, width, height);
  if (options.antiAlias) bbox = addFringe(coverage, width, height, bbox, clip);
  if (clip) applyClip(coverage, width, bbox, clip);
  return { coverage, bbox };
}

// ── Passes ────────────────────────────────────────────────────────────────────

function clampTolerance(tolerance: number): number {
  return Number.isFinite(tolerance) ? Math.min(255, Math.max(0, Math.round(tolerance))) : 0;
}

/** Pass 1: `coverage[i] = MATCH` for every pixel within tolerance of the seed (and inside the clip). */
function markMatches(data: Uint8ClampedArray, coverage: Uint8Array, seed: number, tol: number, clip: Uint8Array | undefined): void {
  const p0 = seed * 4;
  const r = data[p0] ?? 0;
  const g = data[p0 + 1] ?? 0;
  const b = data[p0 + 2] ?? 0;
  const a = data[p0 + 3] ?? 0;
  const n = coverage.length;
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    if (clip && clip[i] === 0) continue;
    const pa = data[p + 3] as number;
    if (pa === 0 && a === 0) {
      coverage[i] = MATCH;
      continue;
    }
    const dr = (data[p] as number) - r;
    const dg = (data[p + 1] as number) - g;
    const db = (data[p + 2] as number) - b;
    const da = pa - a;
    if (dr <= tol && dr >= -tol && dg <= tol && dg >= -tol && db <= tol && db >= -tol && da <= tol && da >= -tol) {
      coverage[i] = MATCH;
    }
  }
}

/** Contiguous scanline fill: MATCH pixels reachable from `seed` become FILLED, the rest 0. */
function fillContiguous(coverage: Uint8Array, width: number, height: number, seed: number): Rect {
  let stack = new Int32Array(1024);
  let sp = 0;
  const push = (i: number): void => {
    if (sp === stack.length) {
      const grown = new Int32Array(stack.length * 2);
      grown.set(stack);
      stack = grown;
    }
    stack[sp++] = i;
  };
  /** Push the first pixel of every MATCH run in `[from, to]` (one row). */
  const scanRow = (from: number, to: number): void => {
    let inRun = false;
    for (let i = from; i <= to; i++) {
      if (coverage[i] === MATCH) {
        if (!inRun) push(i);
        inRun = true;
      } else {
        inRun = false;
      }
    }
  };

  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  push(seed);
  while (sp > 0) {
    const idx = stack[--sp] as number;
    if (coverage[idx] !== MATCH) continue;
    const y = (idx / width) | 0;
    const rowStart = y * width;
    const rowEnd = rowStart + width - 1;
    let l = idx;
    let r = idx;
    while (l > rowStart && coverage[l - 1] === MATCH) l--;
    while (r < rowEnd && coverage[r + 1] === MATCH) r++;
    coverage.fill(FILLED, l, r + 1);
    const xl = l - rowStart;
    const xr = r - rowStart;
    if (xl < minX) minX = xl;
    if (xr > maxX) maxX = xr;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (y > 0) scanRow(l - width, r - width);
    if (y < height - 1) scanRow(l + width, r + width);
  }
  // Unreached matches are not part of the fill.
  for (let i = 0; i < coverage.length; i++) if (coverage[i] === MATCH) coverage[i] = 0;
  return maxX < 0 ? { ...EMPTY_RECT } : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/** Global mode: every MATCH becomes FILLED. */
function keepAllMatches(coverage: Uint8Array, width: number, height: number): Rect {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    let rowMin = -1;
    let rowMax = -1;
    for (let x = 0; x < width; x++) {
      if (coverage[row + x] !== MATCH) continue;
      coverage[row + x] = FILLED;
      if (rowMin < 0) rowMin = x;
      rowMax = x;
    }
    if (rowMin < 0) continue;
    if (rowMin < minX) minX = rowMin;
    if (rowMax > maxX) maxX = rowMax;
    if (y < minY) minY = y;
    maxY = y;
  }
  return maxX < 0 ? { ...EMPTY_RECT } : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/**
 * Anti-alias: every uncovered pixel next to the fill gets the 3x3 box
 * average of the hard mask (n filled neighbours -> n/9). Fringe values stay
 * below 255, so they never count as filled neighbours themselves.
 * @returns The bbox grown to include the fringe.
 */
function addFringe(coverage: Uint8Array, width: number, height: number, bbox: Rect, clip: Uint8Array | undefined): Rect {
  if (bbox.width <= 0) return bbox;
  const x0 = Math.max(0, bbox.x - 1);
  const y0 = Math.max(0, bbox.y - 1);
  const x1 = Math.min(width - 1, bbox.x + bbox.width);
  const y1 = Math.min(height - 1, bbox.y + bbox.height);
  let minX = bbox.x;
  let minY = bbox.y;
  let maxX = bbox.x + bbox.width - 1;
  let maxY = bbox.y + bbox.height - 1;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const i = y * width + x;
      if (coverage[i] !== 0 || (clip && clip[i] === 0)) continue;
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx >= 0 && xx < width && coverage[yy * width + xx] === FILLED) n++;
        }
      }
      if (n === 0) continue;
      coverage[i] = Math.round((n * 255) / 9);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/** Scale coverage by a partial selection (inside the bbox; outside is already 0). */
function applyClip(coverage: Uint8Array, width: number, bbox: Rect, clip: Uint8Array): void {
  for (let y = bbox.y; y < bbox.y + bbox.height; y++) {
    for (let x = bbox.x; x < bbox.x + bbox.width; x++) {
      const i = y * width + x;
      const c = clip[i] as number;
      if (c < 255) coverage[i] = Math.round(((coverage[i] as number) * c) / 255);
    }
  }
}
