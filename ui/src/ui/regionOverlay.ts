/**
 * Region outlines on the stage overlay canvas (SPEC "Outputs and regions
 * (editor)", design handoff "Region overlay on the canvas"). In region mode:
 * solid boxes (1.5 px `#b8bbc0`; the selected one 2 px `#f2f2f2` with eight
 * handles), each with a 1 px dark halo and a number badge at the top-left;
 * the image border 2 px `#f2f2f2` while Main is selected. Outside region
 * mode: subdued -- thin, dashed, translucent, small number, no handles and no
 * selection highlight. Hidden regions are not drawn. Image -> stage mapping
 * uses `docRectToStage` (the view transform is in image px).
 */

import type { Editor } from "../engine/editor";
import { REGION_HANDLES, regionHandlePoint } from "../engine/regionGeometry";
import { docRectToStage } from "../engine/viewport";
import type { ViewTransform } from "../engine/viewport";
import { frameRect } from "../geometry/rect";
import type { Rect } from "../geometry/rect";

/** Selected region / Main border (the selection ring colour). */
const SELECTED_COLOR = "#f2f2f2";

/** Idle region box in region mode. */
const IDLE_COLOR = "#b8bbc0";

/** Halo under boxes and handles. */
const HALO_COLOR = "rgba(0, 0, 0, 0.5)";

/** Badge text colour. */
const BADGE_TEXT = "#111111";

/** Monospace stack of the number badge. */
const MONO_FONT = "ui-monospace, Consolas, Menlo, monospace";

/** Approximate advance of one monospace digit, in em. */
const MONO_ADVANCE_EM = 0.6;

/** Handle square side, screen px. */
const HANDLE_PX = 7;

// ── Style decision (pure) ─────────────────────────────────────────────────────

/** How one region outline is drawn. */
export interface RegionOutlineStyle {
  /** Outline width, screen px. */
  lineWidth: number;
  /** Dash pattern, screen px (empty = solid). */
  dash: number[];
  /** Global alpha of the outline. */
  alpha: number;
  /** Global alpha of the number. */
  labelAlpha: number;
  /** Outline and badge colour. */
  color: string;
  /** Draw a dark halo under the outline. */
  halo: boolean;
  /** Number font size, screen px. */
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
    return {
      lineWidth: 1, dash: [4, 4], alpha: 0.3, labelAlpha: 0.45, color: "#ffffff",
      halo: false, labelPx: 10, badge: false, handles: false,
    };
  }
  return {
    lineWidth: selected ? 2 : 1.5,
    dash: [],
    alpha: 1,
    labelAlpha: 1,
    color: selected ? SELECTED_COLOR : IDLE_COLOR,
    halo: true,
    labelPx: 11,
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
    // 1 px on each side of the line.
    ctx.strokeStyle = HALO_COLOR;
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
  ctx.globalAlpha = style.labelAlpha;
  ctx.textBaseline = "top";
  if (style.badge) {
    // Badge flush with the box's outer top-left corner: padding 1 x 6 px.
    ctx.font = `500 ${style.labelPx * px}px ${MONO_FONT}`;
    const outer = (style.lineWidth / 2) * px;
    const x = box.x - outer;
    const y = box.y - outer;
    const width = (text.length * MONO_ADVANCE_EM * style.labelPx + 12) * px;
    const height = (Math.ceil(style.labelPx * 1.2) + 2) * px;
    ctx.fillStyle = style.color;
    ctx.fillRect(x, y, width, height);
    ctx.fillStyle = BADGE_TEXT;
    ctx.fillText(text, x + 6 * px, y + 2 * px);
    return;
  }
  // Dark outline under the light text so the number reads on white too.
  ctx.font = `${style.labelPx * px}px ${MONO_FONT}`;
  const x = box.x + 3 * px;
  const y = box.y + 2 * px;
  ctx.lineJoin = "round";
  ctx.lineWidth = 3 * px;
  ctx.strokeStyle = "#000000";
  ctx.strokeText(text, x, y);
  ctx.fillStyle = style.color;
  ctx.fillText(text, x, y);
}

/** Eight screen-sized handles of the selected region: light squares with a 1 px dark halo. */
function drawHandles(ctx: CanvasRenderingContext2D, view: ViewTransform, rect: Rect, pixelRatio: number, px: number): void {
  ctx.globalAlpha = 1;
  ctx.lineWidth = px;
  const half = (HANDLE_PX / 2) * px;
  // Halo stroke centred half a pixel outside the square.
  const ring = half + px / 2;
  for (const handle of REGION_HANDLES) {
    const p = regionHandlePoint(rect, handle);
    const at = backingRect(view, { x: p.x, y: p.y, width: 0, height: 0 }, pixelRatio);
    ctx.fillStyle = SELECTED_COLOR;
    ctx.fillRect(at.x - half, at.y - half, 2 * half, 2 * half);
    ctx.strokeStyle = "rgba(0, 0, 0, 0.6)";
    ctx.strokeRect(at.x - ring, at.y - ring, 2 * ring, 2 * ring);
  }
}
