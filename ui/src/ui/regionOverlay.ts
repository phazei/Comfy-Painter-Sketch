/**
 * Region outlines on the stage overlay canvas (M9). In region mode: solid
 * outlines, number badges, the selected region highlighted with handles, and
 * the image border highlighted while Main is selected. Outside region mode:
 * subdued -- thin, dashed, translucent, small number, no handles and no
 * selection highlight. Image -> stage mapping uses `docRectToStage` (the
 * view transform is in image px).
 */

import type { Editor } from "../engine/editor";
import { REGION_HANDLES, regionHandlePoint } from "../engine/regionGeometry";
import { docRectToStage } from "../engine/viewport";
import type { ViewTransform } from "../engine/viewport";
import { frameRect } from "../geometry/rect";
import type { Rect } from "../geometry/rect";

/** Accent colour of the selected region / Main border. */
const SELECTED_COLOR = "#62d5ff";

/** Handle square side, screen px. */
const HANDLE_PX = 6;

// ── Style decision (pure) ─────────────────────────────────────────────────────

/** How one region outline is drawn. */
export interface RegionOutlineStyle {
  /** Outline width, screen px. */
  lineWidth: number;
  /** Dash pattern, screen px (empty = solid). */
  dash: number[];
  /** Global alpha. */
  alpha: number;
  /** Outline and badge colour. */
  color: string;
  /** Draw a dark halo under the outline. */
  halo: boolean;
  /** Number badge font size, screen px. */
  labelPx: number;
  /** Draw a filled badge behind the number. */
  badge: boolean;
  /** Draw resize handles. */
  handles: boolean;
}

/**
 * Outline style of a region.
 * @param regionMode - The Outputs tab (region mode) is active.
 * @param selected - The region is the selected output.
 * @returns Drawing style; outside region mode always subdued, ignoring selection.
 */
export function regionOutlineStyle(regionMode: boolean, selected: boolean): RegionOutlineStyle {
  if (!regionMode) {
    return { lineWidth: 1, dash: [4, 4], alpha: 0.3, color: "#ffffff", halo: false, labelPx: 9, badge: false, handles: false };
  }
  return {
    lineWidth: selected ? 2 : 1,
    dash: [],
    alpha: 1,
    color: selected ? SELECTED_COLOR : "#ffffff",
    halo: true,
    labelPx: 12,
    badge: true,
    handles: selected,
  };
}

/**
 * Whether the image border is highlighted (Main selected in region mode).
 * @param regionMode - Region mode active.
 * @param selectedId - Selected region id (null = Main).
 * @returns `true` to highlight the image border.
 */
export function highlightMainBorder(regionMode: boolean, selectedId: string | null): boolean {
  return regionMode && selectedId === null;
}

// ── Drawing ───────────────────────────────────────────────────────────────────

/**
 * Draw all visible regions (selected last, on top).
 * @param ctx - Overlay canvas context (identity transform, backing px).
 * @param editor - Live editor.
 * @param pixelRatio - Backing px per stage CSS px.
 * @param regionMode - Region mode active.
 */
export function drawRegionOverlay(ctx: CanvasRenderingContext2D, editor: Editor, pixelRatio: number, regionMode: boolean): void {
  const view = editor.view.current;
  // Screen-constant sizes: backing px per on-screen px (graph zoom included).
  const px = pixelRatio / editor.view.graphScale;
  const selectedId = editor.regionOps.selectedId;
  ctx.save();
  if (highlightMainBorder(regionMode, selectedId)) {
    strokeOutline(ctx, backingRect(view, frameRect(editor.imageSize), pixelRatio), regionOutlineStyle(true, true), px);
  }
  const regions = editor.doc.regions.filter((region) => region.visible);
  regions.sort((a, b) => Number(a.id === selectedId) - Number(b.id === selectedId));
  for (const region of regions) {
    const style = regionOutlineStyle(regionMode, region.id === selectedId);
    const box = backingRect(view, region.rect, pixelRatio);
    strokeOutline(ctx, box, style, px);
    drawLabel(ctx, box, String(region.slot), style, px);
    if (style.handles) drawHandles(ctx, view, region.rect, pixelRatio, px);
  }
  ctx.restore();
}

/** Image rect -> overlay backing-store rect. */
function backingRect(view: ViewTransform, rect: Rect, pixelRatio: number): Rect {
  const stage = docRectToStage(view, rect);
  return {
    x: stage.x * pixelRatio,
    y: stage.y * pixelRatio,
    width: stage.width * pixelRatio,
    height: stage.height * pixelRatio,
  };
}

/** Outline (optional dark halo underneath). */
function strokeOutline(ctx: CanvasRenderingContext2D, box: Rect, style: RegionOutlineStyle, px: number): void {
  ctx.globalAlpha = style.alpha;
  ctx.setLineDash(style.dash.map((d) => d * px));
  if (style.halo) {
    ctx.strokeStyle = "#111111";
    ctx.lineWidth = (style.lineWidth + 2) * px;
    ctx.strokeRect(box.x, box.y, box.width, box.height);
  }
  if (style.dash.length > 0) {
    // Two-tone dashes: dark dashes fill the gaps of the light ones, so the
    // outline stays visible on white and on black backgrounds.
    const period = style.dash.reduce((sum, d) => sum + d, 0) * px;
    ctx.strokeStyle = "#000000";
    ctx.lineWidth = style.lineWidth * px;
    ctx.lineDashOffset = period / 2;
    ctx.strokeRect(box.x, box.y, box.width, box.height);
    ctx.lineDashOffset = 0;
  }
  ctx.strokeStyle = style.color;
  ctx.lineWidth = style.lineWidth * px;
  ctx.strokeRect(box.x, box.y, box.width, box.height);
  ctx.setLineDash([]);
}

/** Slot number at the top-left corner (badge in region mode, plain text when subdued). */
function drawLabel(ctx: CanvasRenderingContext2D, box: Rect, text: string, style: RegionOutlineStyle, px: number): void {
  ctx.globalAlpha = style.alpha;
  ctx.font = `bold ${style.labelPx * px}px sans-serif`;
  ctx.textBaseline = "top";
  const inset = 2 * px;
  if (style.badge) {
    const side = (style.labelPx + 5) * px;
    ctx.fillStyle = style.color;
    ctx.fillRect(box.x + inset, box.y + inset, side, side);
    ctx.fillStyle = "#111111";
    ctx.fillText(text, box.x + inset + 4 * px, box.y + inset + 2 * px);
    return;
  }
  // Dark outline under the light text so the number reads on white too.
  const x = box.x + inset + px;
  const y = box.y + inset;
  ctx.lineJoin = "round";
  ctx.lineWidth = 3 * px;
  ctx.strokeStyle = "#000000";
  ctx.strokeText(text, x, y);
  ctx.fillStyle = style.color;
  ctx.fillText(text, x, y);
}

/** Eight screen-sized handles of the selected region. */
function drawHandles(ctx: CanvasRenderingContext2D, view: ViewTransform, rect: Rect, pixelRatio: number, px: number): void {
  ctx.globalAlpha = 1;
  ctx.lineWidth = px;
  const half = (HANDLE_PX / 2) * px;
  for (const handle of REGION_HANDLES) {
    const p = regionHandlePoint(rect, handle);
    const at = backingRect(view, { x: p.x, y: p.y, width: 0, height: 0 }, pixelRatio);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(at.x - half, at.y - half, 2 * half, 2 * half);
    ctx.strokeStyle = "#111111";
    ctx.strokeRect(at.x - half, at.y - half, 2 * half, 2 * half);
  }
}
