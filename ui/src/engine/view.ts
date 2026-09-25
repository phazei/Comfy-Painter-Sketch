/**
 * View state: the document -> stage transform plus "fit mode". While in fit
 * mode (the default) the view re-fits whenever the stage or frame changes;
 * any manual zoom/pan/Ctrl+1 leaves fit mode until Ctrl+0 or a "Fit" button
 * press. On resize in non-fit mode the image point at the stage centre is kept
 * fixed and the offset is clamped so the image cannot go fully off-screen.
 */

import type { Point, Size } from "../geometry/rect";
import { clampOffset, clampZoom, fitView, panBy, wheelZoomFactor, zoomAt } from "./viewport";
import type { ViewTransform } from "./viewport";

/**
 * Mutable view state for one editor.
 */
export class ViewState {
  private transform: ViewTransform = { scale: 1, offsetX: 0, offsetY: 0 };
  private fitting = true;
  private stage: Size = { width: 0, height: 0 };
  private frame: Size = { width: 1, height: 1 };
  /** On-screen px per stage CSS px (graph zoom). */
  private displayScale = 1;

  /**
   * @param onChange - Called after every user view command (fit, 100%, zoom,
   *   pan) so the owner can repaint; never called from {@link setStage} /
   *   {@link setFrame}, which run inside a render.
   */
  constructor(private readonly onChange: () => void = () => {}) {}

  /** Current transform. */
  get current(): ViewTransform {
    return this.transform;
  }

  /** Whether the view follows "fit to stage". */
  get isFitting(): boolean {
    return this.fitting;
  }

  /**
   * Update stage size / graph zoom. In fit mode the view re-fits. In non-fit
   * mode the image point that was at the previous stage centre stays at the
   * new stage centre (resize keeps the canvas centred), then the offset is
   * clamped so the image stays on-screen.
   *
   * @param stage - Stage CSS size.
   * @param displayScale - Ancestor scale (graph zoom).
   * @returns `true` if the transform changed.
   */
  setStage(stage: Size, displayScale: number): boolean {
    const prev = this.stage;
    this.stage = { ...stage };
    this.displayScale = displayScale > 0 ? displayScale : 1;
    if (this.fitting) return this.refit();
    // Keep the image point that was at the old centre at the new centre.
    if (prev.width > 0 && prev.height > 0 && stage.width > 0 && stage.height > 0) {
      const dx = (stage.width - prev.width) / 2;
      const dy = (stage.height - prev.height) / 2;
      this.transform = clampOffset(panBy(this.transform, dx, dy), this.frame, this.stage);
      return true;
    }
    return false;
  }

  /**
   * Update the frame size. In fit mode the view re-fits; in non-fit mode the
   * offset is clamped so the image stays on-screen.
   *
   * @param frame - Document frame size.
   * @returns `true` if the transform changed.
   */
  setFrame(frame: Size): boolean {
    this.frame = { ...frame };
    if (this.fitting) return this.refit();
    // Clamp after frame change so any shrunk image does not vanish.
    const clamped = clampOffset(this.transform, this.frame, this.stage);
    const changed =
      clamped.offsetX !== this.transform.offsetX || clamped.offsetY !== this.transform.offsetY;
    this.transform = clamped;
    return changed;
  }

  /** Enter fit mode and re-fit (Ctrl+0 / Fit button). */
  fit(): void {
    this.fitting = true;
    this.refit();
    this.onChange();
  }

  /**
   * 100% (Ctrl+1): one document pixel per on-screen pixel, centred on the
   * stage centre's document point.
   */
  actualPixels(): void {
    const centre = { x: this.stage.width / 2, y: this.stage.height / 2 };
    this.setTransform(zoomAt(this.transform, 1 / this.displayScale, centre));
  }

  /**
   * Zoom by a wheel delta around a stage point.
   * @param deltaPx - Wheel delta in px (positive = out).
   * @param anchor - Stage point under the cursor.
   */
  wheelZoom(deltaPx: number, anchor: Point): void {
    this.setTransform(zoomAt(this.transform, this.transform.scale * wheelZoomFactor(deltaPx), anchor));
  }

  /**
   * Zoom by a factor around the stage centre (Ctrl +/-).
   * @param factor - Multiplier.
   */
  zoomBy(factor: number): void {
    const centre = { x: this.stage.width / 2, y: this.stage.height / 2 };
    this.setTransform(zoomAt(this.transform, clampZoom(this.transform.scale * factor), centre));
  }

  /**
   * Pan by stage px.
   * @param dx - Stage px.
   * @param dy - Stage px.
   */
  pan(dx: number, dy: number): void {
    this.setTransform(panBy(this.transform, dx, dy));
  }

  private setTransform(next: ViewTransform): void {
    this.fitting = false;
    this.transform = clampOffset(next, this.frame, this.stage);
    this.onChange();
  }

  private refit(): boolean {
    if (this.stage.width <= 0 || this.stage.height <= 0) return false;
    const next = fitView(this.frame, this.stage);
    const changed =
      next.scale !== this.transform.scale ||
      next.offsetX !== this.transform.offsetX ||
      next.offsetY !== this.transform.offsetY;
    this.transform = next;
    return changed;
  }
}