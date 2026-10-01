/**
 * Image Mask pixels (`document/imageMask.ts`, SPEC "Layers" > "Image Mask /
 * Input Mask row"): the coverage plane in
 * IMAGE px (one byte per pixel, `255 - alpha` of the background file) plus
 * the pure conversions around it:
 *
 * - {@link coverageFromAlpha}: `/view?channel=a` pixels -> coverage, or
 *   `null` when fully opaque (no row);
 * - {@link maskFilePixels} / {@link coverageFromMaskFile}: the saved-file
 *   format of every mask (white RGB, alpha = coverage, PNG);
 * - {@link coverageInDoc}: resample into a document rect through the frame
 *   map (Ctrl+click selection, Duplicate);
 * - Input Mask: {@link coverageFromGray} (Python's mask preview) and
 *   {@link resampleCoverage} (to the image size).
 *
 * {@link ImageMaskPixels} is the per-editor state (`EditorState.imageMask`):
 * coverage arrays are never mutated once set (a fork shares them), the
 * display canvas is built lazily. Not undoable: the coverage follows the
 * background source, like the background itself.
 */

import type { Rect, Size } from "../geometry/rect";
import type { FrameMap } from "./frameMap";
import { createSurface, releaseSurface } from "./surface";
import type { Surface } from "./surface";

// ── Conversions (pure) ────────────────────────────────────────────────────────

/**
 * Coverage of an image's alpha as LoadImage's MASK polarity: `255 - alpha`.
 * @param rgba - RGBA pixels (`/view?channel=a`: alpha in the A channel).
 * @returns Coverage per pixel, or `null` when every alpha is 255 (opaque).
 */
export function coverageFromAlpha(rgba: Uint8ClampedArray): Uint8Array | null {
  const n = rgba.length >> 2;
  const out = new Uint8Array(n);
  let any = false;
  for (let i = 0; i < n; i++) {
    const c = 255 - (rgba[i * 4 + 3] as number);
    out[i] = c;
    if (c) any = true;
  }
  return any ? out : null;
}

/**
 * Coverage of a grayscale mask preview (the Input Mask, Python
 * `UI.PreviewMask`): the gray value is the coverage (red channel read).
 * @param rgba - RGBA pixels of the preview.
 * @returns Coverage per pixel.
 */
export function coverageFromGray(rgba: Uint8ClampedArray): Uint8Array {
  const out = new Uint8Array(rgba.length >> 2);
  for (let i = 0; i < out.length; i++) out[i] = rgba[i * 4] as number;
  return out;
}

/**
 * Resample a coverage plane to another size (bilinear, pixel centres, edge
 * clamped; like Python's mask resize to the image).
 * @param coverage - Plane, `from` sized.
 * @param from - Its size.
 * @param to - Target size.
 * @returns The plane itself when the sizes match, else a new `to`-sized plane.
 */
export function resampleCoverage(coverage: Uint8Array, from: Size, to: Size): Uint8Array {
  if (from.width === to.width && from.height === to.height) return coverage;
  const { width: w, height: h } = from;
  const sx = w / to.width;
  const sy = h / to.height;
  const out = new Uint8Array(to.width * to.height);
  for (let y = 0; y < to.height; y++) {
    const fy = Math.min(h - 1, Math.max(0, (y + 0.5) * sy - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(h - 1, y0 + 1);
    const ty = fy - y0;
    for (let x = 0; x < to.width; x++) {
      const fx = Math.min(w - 1, Math.max(0, (x + 0.5) * sx - 0.5));
      const x0 = Math.floor(fx);
      const x1 = Math.min(w - 1, x0 + 1);
      const tx = fx - x0;
      const top = (coverage[y0 * w + x0] as number) * (1 - tx) + (coverage[y0 * w + x1] as number) * tx;
      const bottom = (coverage[y1 * w + x0] as number) * (1 - tx) + (coverage[y1 * w + x1] as number) * tx;
      out[y * to.width + x] = Math.round(top * (1 - ty) + bottom * ty);
    }
  }
  return out;
}

/**
 * Mask-file pixels for a coverage plane (saved-file contract: RGB white,
 * alpha = coverage).
 * @param coverage - Coverage per pixel.
 * @returns RGBA pixels.
 */
export function maskFilePixels(coverage: Uint8Array): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(coverage.length * 4).fill(255);
  for (let i = 0; i < coverage.length; i++) out[i * 4 + 3] = coverage[i] as number;
  return out;
}

/**
 * Coverage stored in mask-file pixels (their alpha).
 * @param rgba - RGBA pixels of a restored file.
 * @returns Coverage per pixel.
 */
export function coverageFromMaskFile(rgba: Uint8ClampedArray): Uint8Array {
  const out = new Uint8Array(rgba.length >> 2);
  for (let i = 0; i < out.length; i++) out[i] = rgba[i * 4 + 3] as number;
  return out;
}

/**
 * Resample image-px coverage into a document rect: each document pixel
 * centre is mapped to the image (`map`) and sampled bilinearly (edge
 * clamped); centres outside the image are 0 (also when inverted: the Image
 * Mask only covers the image).
 * @param coverage - Coverage plane, `size` sized.
 * @param size - Image size of the plane.
 * @param map - Document -> image map for that image size.
 * @param rect - Integer document rect to fill.
 * @param invert - Return the effective coverage (`255 - c` inside the image).
 * @returns Coverage over `rect`, row-major.
 */
export function coverageInDoc(coverage: Uint8Array, size: Size, map: FrameMap, rect: Rect, invert: boolean): Uint8Array {
  const { width: w, height: h } = size;
  const out = new Uint8Array(Math.max(0, rect.width * rect.height));
  for (let y = 0; y < rect.height; y++) {
    const cy = map.offsetY + (rect.y + y + 0.5) * map.scale;
    if (cy < 0 || cy >= h) continue;
    const fy = Math.max(0, cy - 0.5);
    const y0 = Math.min(h - 1, Math.floor(fy));
    const y1 = Math.min(h - 1, y0 + 1);
    const ty = fy - y0;
    for (let x = 0; x < rect.width; x++) {
      const cx = map.offsetX + (rect.x + x + 0.5) * map.scale;
      if (cx < 0 || cx >= w) continue;
      const fx = Math.max(0, cx - 0.5);
      const x0 = Math.min(w - 1, Math.floor(fx));
      const x1 = Math.min(w - 1, x0 + 1);
      const tx = fx - x0;
      const top = (coverage[y0 * w + x0] as number) * (1 - tx) + (coverage[y0 * w + x1] as number) * tx;
      const bottom = (coverage[y1 * w + x0] as number) * (1 - tx) + (coverage[y1 * w + x1] as number) * tx;
      const v = Math.round(top * (1 - ty) + bottom * ty);
      out[y * rect.width + x] = invert ? 255 - v : v;
    }
  }
  return out;
}

// ── State ─────────────────────────────────────────────────────────────────────

let revisionCounter = 0;

/**
 * Coverage plane + upload bookkeeping of one editor's Image Mask.
 */
export class ImageMaskPixels {
  private plane: Uint8Array | null = null;
  private dims: Size = { width: 0, height: 0 };
  private surface: Surface | null = null;
  /** Coverage differs from the uploaded file. */
  dirty = false;
  /** Bumped on every coverage change (an upload of an older version can't mark it clean). */
  version = 0;
  /** Display cache key (tint, thumbnail); globally unique. */
  revision = 0;
  /** Input Mask only: no coverage yet, it arrives with a run (row hint). */
  waiting = false;

  /** Coverage plane (treat as immutable), or `null` when none is loaded. */
  get coverage(): Uint8Array | null {
    return this.plane;
  }

  /** Image size of the plane. */
  get size(): Size {
    return { ...this.dims };
  }

  /**
   * Replace the coverage.
   * @param coverage - New plane (`size` sized; not copied, never mutated).
   * @param size - Its image size.
   * @param dirty - Needs uploading (a new source) or not (restored from its file).
   */
  set(coverage: Uint8Array, size: Size, dirty: boolean): void {
    this.drop();
    this.plane = coverage;
    this.dims = { width: size.width, height: size.height };
    this.dirty = dirty;
  }

  /** Forget the coverage (row removed). */
  clear(): void {
    this.drop();
    this.dirty = false;
  }

  /**
   * Display canvas (mask-file pixels), built on first use.
   * @returns The canvas, or `null` without coverage.
   */
  canvas(): HTMLCanvasElement | null {
    const plane = this.plane;
    if (!plane) return null;
    if (!this.surface) {
      const { width, height } = this.dims;
      this.surface = createSurface(width, height);
      this.surface.ctx.putImageData(new ImageData(maskFilePixels(plane), width, height), 0, 0);
    }
    return this.surface.canvas;
  }

  /**
   * Take over another editor's state (fork; the plane is shared, it is immutable).
   * @param other - Source.
   */
  copyFrom(other: ImageMaskPixels): void {
    this.drop();
    this.plane = other.plane;
    this.dims = other.size;
    this.dirty = other.dirty;
    this.waiting = other.waiting;
  }

  /** Bytes held (plane + display canvas). */
  get bytes(): number {
    const n = this.dims.width * this.dims.height;
    return (this.plane ? n : 0) + (this.surface ? n * 4 : 0);
  }

  /** Release the display canvas. */
  dispose(): void {
    if (this.surface) releaseSurface(this.surface);
    this.surface = null;
  }

  /** New revision / version, no canvas, no plane. */
  private drop(): void {
    this.dispose();
    this.plane = null;
    this.waiting = false;
    this.version++;
    this.revision = ++revisionCounter;
  }
}
