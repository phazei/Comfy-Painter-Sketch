/**
 * Free Transform handles on the stage overlay canvas (SPEC "Free Transform and flips"): the
 * transformed box outline (dark halo under a light line), 8 square handles
 * and a small centre mark, all in screen-constant sizes and drawn crisp in
 * screen space (the box corners are mapped document -> image -> stage ->
 * backing px; nothing is drawn through a scaled transform).
 */

import type { Editor } from "../engine/editor";
import { docToImage } from "../engine/frameMap";
import { handlePoint } from "../engine/transformHit";
import { HANDLES, transformedCorners } from "../engine/transformMath";
import type { Point } from "../geometry/rect";

/** Handle square side, screen px. */
const HANDLE_PX = 7;
/** Centre mark radius, screen px. */
const CENTRE_PX = 3.5;

/**
 * Draw the handle box of a running session (nothing otherwise).
 * @param ctx - Overlay context (identity transform, backing px).
 * @param editor - Live editor.
 * @param pixelRatio - Backing px per stage CSS px.
 */
export function drawTransformOverlay(ctx: CanvasRenderingContext2D, editor: Editor, pixelRatio: number): void {
  const box = editor.float.transform.box();
  if (!box) return;
  const view = editor.view.current;
  const map = editor.frameMap;
  const toBacking = (p: Point): Point => {
    const img = docToImage(map, p);
    return { x: (img.x * view.scale + view.offsetX) * pixelRatio, y: (img.y * view.scale + view.offsetY) * pixelRatio };
  };
  // Screen-constant sizes: backing px per on-screen px (graph zoom included).
  const px = pixelRatio / editor.view.graphScale;
  const corners = transformedCorners(box.m, box.w, box.h).map(toBacking);
  ctx.save();
  ctx.globalAlpha = 1;
  ctx.setLineDash([]);
  ctx.lineJoin = "miter";
  outline(ctx, corners, "#111111", 3 * px);
  outline(ctx, corners, "#ffffff", px);
  ctx.lineWidth = px;
  const half = (HANDLE_PX / 2) * px;
  for (const dir of HANDLES) {
    const p = toBacking(handlePoint(box.m, box.w, box.h, dir));
    const x = Math.round(p.x - half) + 0.5;
    const y = Math.round(p.y - half) + 0.5;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(x, y, 2 * half, 2 * half);
    ctx.strokeStyle = "#111111";
    ctx.strokeRect(x, y, 2 * half, 2 * half);
  }
  const c = toBacking(handlePoint(box.m, box.w, box.h, { hx: 0, hy: 0 }));
  ctx.beginPath();
  ctx.arc(c.x, c.y, CENTRE_PX * px, 0, Math.PI * 2);
  ctx.strokeStyle = "#111111";
  ctx.lineWidth = 3 * px;
  ctx.stroke();
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = px;
  ctx.stroke();
  ctx.restore();
}

/** Closed polygon stroke. */
function outline(ctx: CanvasRenderingContext2D, pts: readonly Point[], color: string, width: number): void {
  ctx.beginPath();
  pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
  ctx.closePath();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.stroke();
}
