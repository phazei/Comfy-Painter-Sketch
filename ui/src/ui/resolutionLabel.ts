/**
 * Image-area size label ("1024 x 768") centred just under the image-area
 * rectangle on the stage overlay canvas. Follows pan/zoom (drawn with every
 * overlay pass); the font is a fixed on-screen size (graph zoom divided out)
 * and the label is skipped when it would not fit fully inside the stage.
 */

import type { Editor } from "../engine/editor";
import { docRectToStage } from "../engine/viewport";
import { frameRect } from "../geometry/rect";

/** Font size, screen px. */
const FONT_PX = 10;
/** Gap between the image area's bottom edge and the text, screen px. */
const GAP_PX = 4;

/**
 * Draw the label.
 * @param ctx - Overlay canvas context (identity transform, backing px).
 * @param editor - Live editor.
 * @param pixelRatio - Backing px per stage CSS px.
 */
export function drawResolutionLabel(ctx: CanvasRenderingContext2D, editor: Editor, pixelRatio: number): void {
  const { width, height } = editor.imageSize;
  if (width <= 0 || height <= 0) return;
  const px = pixelRatio / (editor.view.graphScale || 1);
  const area = docRectToStage(editor.view.current, frameRect(editor.imageSize));
  const text = `${width} x ${height}`;
  const x = (area.x + area.width / 2) * pixelRatio;
  const y = (area.y + area.height) * pixelRatio + GAP_PX * px;
  ctx.save();
  ctx.font = `${FONT_PX * px}px sans-serif`;
  const half = ctx.measureText(text).width / 2;
  const bottom = y + (FONT_PX + 2) * px;
  if (y < 0 || bottom > ctx.canvas.height || x - half < 0 || x + half > ctx.canvas.width) {
    ctx.restore();
    return;
  }
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.globalAlpha = 0.55;
  ctx.lineJoin = "round";
  ctx.lineWidth = 3 * px;
  ctx.strokeStyle = "#000000";
  ctx.strokeText(text, x, y);
  ctx.fillStyle = "#ffffff";
  ctx.fillText(text, x, y);
  ctx.restore();
}
