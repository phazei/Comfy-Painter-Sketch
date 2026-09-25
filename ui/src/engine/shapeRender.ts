/**
 * Rasterizes a {@link ShapeSpec} (`shapes.ts`) with Canvas 2D: anti-aliased,
 * fully opaque (the stroke buffer applies the tool opacity once at commit,
 * so a fill and its stroke never stack alpha). Lines use round caps;
 * rectangles use mitred corners; the stroke is centred on the box edge and
 * drawn over the fill.
 */

import type { Point } from "../geometry/rect";
import { crispRect, isDrawableShape, lineGeometry } from "./shapes";
import type { BoxShape, LineShape, ShapeSpec } from "./shapes";

/**
 * Draw a shape.
 * @param ctx - Target context.
 * @param shape - Shape in document coords.
 * @param origin - Document point at the context's (0, 0).
 * @param colorOverride - Paint every part in this colour (mask coverage), or `null`.
 */
export function renderShape(ctx: CanvasRenderingContext2D, shape: ShapeSpec, origin: Point, colorOverride: string | null): void {
  if (!isDrawableShape(shape)) return;
  ctx.save();
  ctx.translate(-origin.x, -origin.y);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  if (shape.kind === "line") drawLine(ctx, shape, colorOverride);
  else drawBox(ctx, shape, colorOverride);
  ctx.restore();
}

function drawLine(ctx: CanvasRenderingContext2D, line: LineShape, colorOverride: string | null): void {
  const geo = lineGeometry(line);
  if (!geo) return;
  const color = colorOverride ?? line.color;
  if (geo.shaft) {
    const [a, b] = geo.shaft;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.lineWidth = line.width;
    ctx.lineCap = "round";
    ctx.strokeStyle = color;
    ctx.stroke();
  }
  ctx.fillStyle = color;
  for (const head of geo.heads) {
    const [first, ...rest] = head;
    if (!first) continue;
    ctx.beginPath();
    ctx.moveTo(first.x, first.y);
    for (const p of rest) ctx.lineTo(p.x, p.y);
    ctx.closePath();
    ctx.fill();
  }
}

function drawBox(ctx: CanvasRenderingContext2D, box: BoxShape, colorOverride: string | null): void {
  const stroke = box.paint !== "fill" && box.strokeWidth > 0;
  const fill = box.paint !== "stroke";
  const path = (strokeWidth: number): void => {
    ctx.beginPath();
    if (box.kind === "rect") {
      const r = crispRect(box.rect, strokeWidth);
      ctx.rect(r.x, r.y, r.width, r.height);
    } else {
      const { x, y, width, height } = box.rect;
      ctx.ellipse(x + width / 2, y + height / 2, width / 2, height / 2, 0, 0, Math.PI * 2);
    }
  };
  if (fill) {
    path(stroke ? box.strokeWidth : 0);
    ctx.fillStyle = colorOverride ?? box.fillColor;
    ctx.fill();
  }
  if (stroke) {
    path(box.strokeWidth);
    ctx.lineWidth = box.strokeWidth;
    ctx.lineJoin = "miter";
    ctx.strokeStyle = colorOverride ?? box.strokeColor;
    ctx.stroke();
  }
}
