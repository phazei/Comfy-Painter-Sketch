/**
 * The editor's current selection (session state, not saved in the document)
 * plus the caches derived from it: the marching-ants outline (computed once
 * per change) and the stroke clip canvas (alpha = coverage over the current
 * bounds, rebuilt when the selection or the bounds change). Internal to
 * `engine/`; tools and UI go through `Editor.selection` (`selectionOps.ts`).
 */

import { rectEquals } from "../geometry/rect";
import type { Rect } from "../geometry/rect";
import { coverageFor } from "./selection";
import type { Selection } from "./selection";
import { outlineContours } from "./selectionOutline";
import type { Contour } from "./selectionOutline";
import { createSurface, releaseSurface } from "./surface";
import type { Surface } from "./surface";

/**
 * Current selection + derived caches.
 */
export class SelectionState {
  private sel: Selection | null = null;
  private rev = 0;
  private outlineCache: { rev: number; frame: Rect; contours: readonly Contour[] } | null = null;
  private clip: { rev: number; bounds: Rect; surface: Surface } | null = null;

  /**
   * @param onChange - Called after every change (emits the editor `selection` event).
   */
  constructor(private readonly onChange: () => void) {}

  /** Current selection (`null` = none: everything editable). */
  get current(): Selection | null {
    return this.sel;
  }

  /** Bumped on every change (cache key for the UI). */
  get revision(): number {
    return this.rev;
  }

  /**
   * Replace the selection (no history; `selectionOps.ts` records it).
   * @param sel - New selection or `null`.
   */
  set(sel: Selection | null): void {
    if (sel === this.sel) return;
    this.sel = sel;
    this.rev++;
    this.onChange();
  }

  /**
   * Cached outline contours of the current selection.
   * @param frame - Image frame rect (bounds an inverted selection's outline).
   * @returns Closed contours in document coords, or `null` without a selection.
   */
  outline(frame: Rect): readonly Contour[] | null {
    if (!this.sel) return null;
    const cached = this.outlineCache;
    if (cached && cached.rev === this.rev && rectEquals(cached.frame, frame)) return cached.contours;
    const contours = outlineContours(this.sel, frame);
    this.outlineCache = { rev: this.rev, frame: { ...frame }, contours };
    return contours;
  }

  /**
   * Clip mask for strokes: a canvas sized to `bounds` whose alpha is the
   * selection coverage (used with `destination-in`).
   * @param bounds - Current paint bounds.
   * @returns The canvas, or `null` without a selection.
   */
  clipCanvas(bounds: Rect): HTMLCanvasElement | null {
    const sel = this.sel;
    if (!sel) return null;
    const cached = this.clip;
    if (cached && cached.rev === this.rev && rectEquals(cached.bounds, bounds)) return cached.surface.canvas;
    this.releaseClip();
    const surface = createSurface(bounds.width, bounds.height);
    const coverage = coverageFor(sel, bounds);
    const image = surface.ctx.createImageData(surface.canvas.width, surface.canvas.height);
    const px = image.data;
    for (let i = 0; i < coverage.length; i++) px[i * 4 + 3] = coverage[i] as number;
    surface.ctx.putImageData(image, 0, 0);
    this.clip = { rev: this.rev, bounds: { ...bounds }, surface };
    return surface.canvas;
  }

  /**
   * Selection coverage over `area` for the bucket fill's `clip` seam.
   * @param area - Integer document rect (the bounds).
   * @returns Coverage bytes, or `undefined` without a selection.
   */
  coverage(area: Rect): Uint8Array | undefined {
    return this.sel ? coverageFor(this.sel, area) : undefined;
  }

  /** Estimated bytes held (selection + clip canvas). */
  get bytes(): number {
    const clip = this.clip?.surface.canvas;
    return (this.sel?.data.byteLength ?? 0) + (clip ? clip.width * clip.height * 4 : 0);
  }

  /** Release caches (keeps the selection). */
  dispose(): void {
    this.releaseClip();
    this.outlineCache = null;
  }

  private releaseClip(): void {
    if (this.clip) releaseSurface(this.clip.surface);
    this.clip = null;
  }
}
