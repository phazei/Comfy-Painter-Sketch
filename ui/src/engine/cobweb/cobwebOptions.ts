/**
 * Options and worker message types for the cobweb backdrop (port of the
 * user's reference generator `temp.cobweb-backdrop.js`). Pure data; shared by
 * the growth core, the rasterizer, the worker and the main-thread host.
 */

// ── Options ───────────────────────────────────────────────────────────────────

/** RGB triple, 0..255. */
export type Rgb = readonly [number, number, number];

/** Webbing draped across acute forks. */
export interface DrapeOptions {
  /** Degrees; wider forks get no webbing. */
  maxAngle: number;
  /** Steps along each arm (one step = `step` gen units). */
  length: number;
  /** Fraction of `margin` before drapes begin. */
  start: number;
  /** Fraction of `margin` to reach full strength. */
  ramp: number;
}

/** All generator options (gen units: the rect's long side is `genSize`). */
export interface CobwebOptions {
  /** Strand colour at the rect edge. */
  color: Rgb;
  /** Webbing colour. */
  drapeColor: Rgb;
  /** Long side of the rect in generation units. */
  genSize: number;
  /** How far strands reach past the rect edge (gen units). */
  margin: number;
  /** Gen units between starting strands along the edge. */
  seedSpacing: number;
  /** Growth step length (gen units). */
  step: number;
  /** Fuse distance (gen units). */
  join: number;
  /** Chance per step that a strand forks. */
  branch: number;
  maxNodes: number;
  maxTips: number;
  /** Stroke width in screen px at the edge and at full distance. */
  lineWidth: readonly [number, number];
  drape: DrapeOptions;
  seed: number;
  /** Main-thread mode: growth time per frame (ms), non-animated growth. */
  budgetMs: number;
  /** Animated growth: growth steps per frame (~16 ms); higher = faster. */
  stepsPerFrame: number;
  /** Wait after a zoom before restroking (ms). */
  rasterDelayMs: number;
  /** Safety cap; the bitmap drops resolution beyond this many px. */
  maxBitmapPixels: number;
  /** Extra rastered area around the view, as a fraction of it. */
  panPad: number;
}

/** Growth step length; the drape length below is derived from it. */
const STEP = 1.7;

/**
 * Defaults: the reference's, with the user's drape settings (maxAngle 160,
 * length 80 gen units = 80 screen px when the rect's long side shows at
 * `genSize` px, start 0.03, ramp 0.12).
 */
export const COBWEB_DEFAULTS: CobwebOptions = {
  color: [88, 80, 112],
  drapeColor: [120, 110, 156],
  genSize: 600,
  margin: 700,
  seedSpacing: 7,
  step: STEP,
  join: 5.5,
  branch: 0.052,
  maxNodes: 70000,
  maxTips: 1400,
  lineWidth: [1.3, 0.5],
  drape: { maxAngle: 160, length: Math.round(80 / STEP), start: 0.03, ramp: 0.12 },
  seed: 1,
  budgetMs: 6,
  stepsPerFrame: 2,
  rasterDelayMs: 120,
  maxBitmapPixels: 16e6,
  panPad: 0.5,
};

/** Partial options (drape may be partial too). */
export type CobwebOverrides = Partial<Omit<CobwebOptions, "drape">> & { drape?: Partial<DrapeOptions> };

/**
 * Merge overrides into a base option set.
 * @param base - Base options.
 * @param o - Overrides.
 * @returns New options.
 */
export function mergeCobwebOptions(base: CobwebOptions, o: CobwebOverrides = {}): CobwebOptions {
  return { ...base, ...o, drape: { ...base.drape, ...(o.drape ?? {}) } };
}

// ── Geometry ──────────────────────────────────────────────────────────────────

/** Region in gen units. */
export interface GenRegion {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * Gen-space size of a rect with this aspect (long side = `genSize`).
 * @param genSize - Long side in gen units.
 * @param aspect - Width / height.
 * @returns Gen width and height.
 */
export function genExtent(genSize: number, aspect: number): { gw: number; gh: number } {
  const gw = aspect >= 1 ? genSize : genSize * aspect;
  return { gw, gh: gw / aspect };
}

// ── Worker protocol ───────────────────────────────────────────────────────────

/** Raster request: zoom `k` (screen units per gen unit), ratio `pr`, region `reg`. */
export interface ViewRequest {
  k: number;
  pr: number;
  reg: GenRegion;
}

/** Main -> worker. */
export type ToWorker =
  | ({ type: "start"; gen: number; opts: CobwebOptions; aspect: number; animate: boolean } & ViewRequest)
  | ({ type: "view"; gen: number } & ViewRequest);

/** Worker -> main. */
export interface FromWorker {
  gen: number;
  reg: GenRegion;
  done: boolean;
  bitmap: ImageBitmap;
}
