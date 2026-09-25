/**
 * Eyedropper loupe (Photoshop's sampling ring): a ring around the pointer,
 * top half the sampled colour, bottom half the colour before the drag, with
 * grey outlines so it reads on any background. Drawn on the stage overlay
 * canvas for a {@link ToolOverlay} of kind `"loupe"`.
 */

import type { ToolOverlay } from "../tools/types";

/** Ring radii in CSS px. */
const OUTER = 34;
const INNER = 22;

/**
 * Draw the loupe centred on a point.
 * @param ctx - Overlay context (identity transform, backing px).
 * @param x - Centre x, backing px.
 * @param y - Centre y, backing px.
 * @param pr - Backing px per CSS px.
 * @param overlay - Loupe colours.
 */
export function drawLoupe(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  pr: number,
  overlay: Extract<ToolOverlay, { kind: "loupe" }>,
): void {
  const outer = OUTER * pr;
  const inner = INNER * pr;
  const half = (from: number, to: number, color: string): void => {
    ctx.beginPath();
    ctx.arc(x, y, outer, from, to);
    ctx.arc(x, y, inner, to, from, true);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
  };
  ctx.save();
  half(Math.PI, Math.PI * 2, overlay.color);
  half(0, Math.PI, overlay.previous);
  ctx.lineWidth = Math.max(1, pr);
  ctx.strokeStyle = "rgba(128, 128, 128, 0.9)";
  for (const r of [outer, inner]) {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}
