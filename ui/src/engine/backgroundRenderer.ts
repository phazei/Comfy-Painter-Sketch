/**
 * Draws the stage for M0: a neutral surround, and the image frame fitted
 * inside it (letterboxed). The frame shows either the background image over a
 * transparency checker, or a solid fill when no image is available.
 *
 * Canvas 2D only; no DOM UI. Later milestones replace this with the layer
 * compositor, which will draw the same background as its bottom layer.
 */

import { fitContain } from "./viewport";
import type { Size } from "./viewport";

// ── Types ─────────────────────────────────────────────────────────────────────

/** What the frame currently shows. */
export type FrameContent =
  | { kind: "image"; image: CanvasImageSource; size: Size }
  | { kind: "fill"; color: string; size: Size };

/** Visual constants for the stage. */
export interface StageStyle {
  surround: string;
  checkerLight: string;
  checkerDark: string;
  /** Checker cell size in CSS px. */
  checkerCell: number;
  /** Inset between the stage edge and the frame, in CSS px. */
  padding: number;
  frameOutline: string;
}

/** Default stage look (neutral grey surround, light checker). */
export const DEFAULT_STAGE_STYLE: StageStyle = {
  surround: "#1e1e1e",
  checkerLight: "#cfcfcf",
  checkerDark: "#a8a8a8",
  checkerCell: 8,
  padding: 8,
  frameOutline: "rgba(0, 0, 0, 0.6)",
};

// ── Rendering ─────────────────────────────────────────────────────────────────

/**
 * Render the stage into `ctx`.
 *
 * @param ctx - Target context; its canvas backing store is in device pixels.
 * @param cssSize - Stage size in CSS pixels.
 * @param pixelRatio - Backing pixels per CSS pixel.
 * @param content - Frame content to draw.
 * @param style - Visual constants.
 */
export function renderStage(
  ctx: CanvasRenderingContext2D,
  cssSize: Size,
  pixelRatio: number,
  content: FrameContent,
  style: StageStyle = DEFAULT_STAGE_STYLE,
): void {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = style.surround;
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);

  ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  const fit = fitContain(content.size, cssSize, style.padding);
  if (fit.width <= 0 || fit.height <= 0) return;

  if (content.kind === "image") {
    drawChecker(ctx, fit.x, fit.y, fit.width, fit.height, style);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(content.image, fit.x, fit.y, fit.width, fit.height);
  } else {
    ctx.fillStyle = content.color;
    ctx.fillRect(fit.x, fit.y, fit.width, fit.height);
  }

  ctx.strokeStyle = style.frameOutline;
  ctx.lineWidth = 1 / pixelRatio;
  ctx.strokeRect(fit.x, fit.y, fit.width, fit.height);
}

/** Fill a rect with a two-tone checker (transparency indicator). */
function drawChecker(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  style: StageStyle,
): void {
  const cell = style.checkerCell;
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, width, height);
  ctx.clip();
  ctx.fillStyle = style.checkerLight;
  ctx.fillRect(x, y, width, height);
  ctx.fillStyle = style.checkerDark;
  const cols = Math.ceil(width / cell);
  const rows = Math.ceil(height / cell);
  for (let row = 0; row < rows; row++) {
    for (let col = row % 2; col < cols; col += 2) {
      ctx.fillRect(x + col * cell, y + row * cell, cell, cell);
    }
  }
  ctx.restore();
}
