/**
 * Draws the scene to the display canvas. The view transform maps IMAGE
 * coordinates (the current background, or `doc.frame` when there is none) to
 * the stage; layers are drawn through the document -> image map (`frameMap.ts`)
 * into the same integer rect Python places them in, so preview and output
 * agree (SPEC "Canvas, view and fullscreen"). Order: neutral surround,
 * transparency checker + background inside the image rect (unless the
 * background eye is off), visible paint layers bottom -> top at their opacity
 * (Normal blend only), visible mask layers as tinted overlays at their display
 * opacity, then a dim veil over paint outside the image and the image outline.
 * With `paintArea`: the grown cobweb backdrop (`cobweb/`) over the surround
 * outside the maximum paint area, clipped so it never shows inside it (right
 * after the surround fill, under everything else), and a crisp border around
 * it (drawn last).
 *
 * Canvas 2D only; no DOM UI.
 */

import { containsRect, frameRect } from "../geometry/rect";
import type { Point, Rect, Size } from "../geometry/rect";
import type { CobwebBackdrop } from "./cobweb/cobwebBackdrop";
import { docRectToImage, layerPlacement } from "./frameMap";
import type { FrameMap } from "./frameMap";
import { docRectToStage } from "./viewport";
import type { ViewTransform } from "./viewport";

// ── Types ─────────────────────────────────────────────────────────────────────

/** What sits under the paint inside the frame. */
export type FrameBackground = { kind: "image"; image: CanvasImageSource } | { kind: "fill"; color: string };

/** One layer to draw. */
export interface CompositeLayer {
  source: CanvasImageSource;
  opacity: number;
  /** Move-tool drag preview: draw shifted by this many document px. */
  offset?: Point;
}

/** One mask layer's overlay (already tinted, see `maskTint.ts`). */
export interface MaskOverlay {
  /** Tinted coverage sized to `bounds`. */
  tint: CanvasImageSource;
  /** Display colour (fills the image area outside the layer when inverted). */
  color: string;
  /** Display opacity 0..1. */
  opacity: number;
  /** Per-layer invert: the image area outside the layer's bounds is fully tinted. */
  invert: boolean;
  /** Move-tool drag preview: draw shifted by this many document px. */
  offset?: Point;
  /** Image px coverage (the Image Mask): drawn over the image rect, not through the frame map. */
  imageSpace?: boolean;
}

/** Everything needed for one frame. */
export interface CompositeInput {
  ctx: CanvasRenderingContext2D;
  /** Stage size in CSS px. */
  cssSize: Size;
  /** Backing px per CSS px. */
  pixelRatio: number;
  /** Image -> stage transform. */
  view: ViewTransform;
  /** Size of the image rect (background image, or `doc.frame` without one). */
  imageSize: Size;
  /** Document -> image transform. */
  map: FrameMap;
  /** Paint bounds, document coords. */
  bounds: Rect;
  background: FrameBackground;
  /** Background eye off (and not soloed): only the checker shows under the paint. */
  backgroundHidden?: boolean;
  /** Visible layers, bottom -> top, each sized to `bounds`. */
  layers: readonly CompositeLayer[];
  /** Visible mask overlays, drawn above every paint layer. */
  masks: readonly MaskOverlay[];
  /** Maximum paint area (`boundsCap(doc.frame)`), document coords: outlined, cobwebs outside. */
  paintArea?: Rect;
  /** Web grown around `paintArea` (one per stage). */
  cobweb?: CobwebBackdrop;
}

/** Visual constants. */
export const STAGE_STYLE = {
  surround: "#1e1e1e",
  checkerLight: "#cfcfcf",
  checkerDark: "#a8a8a8",
  checkerCell: 8,
  offFrameVeil: "rgba(30, 30, 30, 0.55)",
  frameOutline: "rgba(255, 255, 255, 0.55)",
  frameShadow: "rgba(0, 0, 0, 0.6)",
  capLine: "#000000",
  capGlow: "rgba(255, 255, 255, 0.18)",
} as const;

// ── Rendering ─────────────────────────────────────────────────────────────────

const checkerPatterns = new WeakMap<CanvasRenderingContext2D, CanvasPattern>();

/**
 * Render one frame.
 * @param input - Scene description.
 */
export function composite(input: CompositeInput): void {
  const { ctx, pixelRatio: pr, view, imageSize, map, bounds } = input;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  ctx.fillStyle = STAGE_STYLE.surround;
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  const capScreen = input.paintArea ? capStageRect(input, input.paintArea) : null;
  if (capScreen && input.paintArea && input.cobweb) drawCobwebs(ctx, capScreen, capExact(input, input.paintArea), input.cobweb, pr);

  const imageRect = frameRect(imageSize);
  const paintRect = docRectToImage(map, bounds);
  const frameScreen = scaleRect(docRectToStage(view, imageRect), pr);
  const boundsScreen = scaleRect(docRectToStage(view, paintRect), pr);

  // Checker in screen space (crisp at any zoom).
  const pattern = checkerPattern(ctx);
  if (pattern) {
    ctx.fillStyle = pattern;
    ctx.fillRect(frameScreen.x, frameScreen.y, frameScreen.width, frameScreen.height);
  }

  const k = view.scale * pr;
  ctx.setTransform(k, 0, 0, k, view.offsetX * pr, view.offsetY * pr);
  ctx.imageSmoothingEnabled = k < 2;
  ctx.imageSmoothingQuality = "high";

  if (input.backgroundHidden === true) {
    // Transparency: the checker drawn above stays visible.
  } else if (input.background.kind === "image") {
    ctx.drawImage(input.background.image, 0, 0, imageSize.width, imageSize.height);
  } else {
    ctx.fillStyle = input.background.color;
    ctx.fillRect(0, 0, imageSize.width, imageSize.height);
  }

  // Same integer rect as nodes/composite.py; resampled layers are smoothed
  // (Python uses bilinear), unscaled ones follow the zoom rule above.
  const placed = layerPlacement(map, bounds);
  const resampled = placed.width !== bounds.width || placed.height !== bounds.height;
  if (resampled) ctx.imageSmoothingEnabled = true;
  // A Move-tool drag previews a layer at shifted bounds (where it lands on commit).
  const at = (offset: Point | undefined): Rect =>
    offset ? layerPlacement(map, { ...bounds, x: bounds.x + offset.x, y: bounds.y + offset.y }) : placed;
  for (const layer of input.layers) {
    if (layer.opacity <= 0) continue;
    ctx.globalAlpha = layer.opacity;
    const r = at(layer.offset);
    ctx.drawImage(layer.source, r.x, r.y, r.width, r.height);
  }
  // Mask overlays: same placement; an inverted mask is also fully tinted over
  // the image outside the placed layer (Python: 0 there before invert).
  for (const mask of input.masks) {
    if (mask.opacity <= 0) continue;
    ctx.globalAlpha = mask.opacity;
    const r = mask.imageSpace ? imageRect : at(mask.offset);
    ctx.drawImage(mask.tint, r.x, r.y, r.width, r.height);
    if (mask.invert) {
      // (image rect) minus (placed rect); clip first because the placed rect
      // may stick out of the image on one axis.
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, imageSize.width, imageSize.height);
      ctx.clip();
      ctx.fillStyle = mask.color;
      ctx.beginPath();
      ctx.rect(0, 0, imageSize.width, imageSize.height);
      ctx.rect(r.x, r.y, r.width, r.height);
      ctx.fill("evenodd");
      ctx.restore();
    }
  }
  ctx.globalAlpha = 1;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const extends_ = !containsRect(inflateRect(imageRect, EPSILON), paintRect);
  if (extends_) {
    // Veil = paint area minus image rect (the paint area need not contain the
    // image when the document's aspect differs from the image's).
    ctx.save();
    ctx.beginPath();
    ctx.rect(boundsScreen.x, boundsScreen.y, boundsScreen.width, boundsScreen.height);
    ctx.clip();
    ctx.fillStyle = STAGE_STYLE.offFrameVeil;
    ctx.beginPath();
    ctx.rect(0, 0, ctx.canvas.width, ctx.canvas.height);
    ctx.rect(frameScreen.x, frameScreen.y, frameScreen.width, frameScreen.height);
    ctx.fill("evenodd");
    ctx.restore();
  }
  const lw = Math.max(1, Math.round(pr));
  ctx.lineWidth = lw;
  ctx.strokeStyle = extends_ ? STAGE_STYLE.frameOutline : STAGE_STYLE.frameShadow;
  ctx.strokeRect(frameScreen.x - lw / 2, frameScreen.y - lw / 2, frameScreen.width + lw, frameScreen.height + lw);
  if (capScreen) drawCapBorder(ctx, capScreen);
}

// ── Maximum paint area ────────────────────────────────────────────────────────

/** Paint-area cap in device px, unsnapped. */
function capExact(input: CompositeInput, cap: Rect): Rect {
  return scaleRect(docRectToStage(input.view, layerPlacement(input.map, cap)), input.pixelRatio);
}

/** Paint-area cap in device px, snapped to whole pixels (crisp edges). */
function capStageRect(input: CompositeInput, cap: Rect): Rect {
  const r = capExact(input, cap);
  const x0 = Math.round(r.x);
  const y0 = Math.round(r.y);
  return { x: x0, y: y0, width: Math.round(r.x + r.width) - x0, height: Math.round(r.y + r.height) - y0 };
}

/**
 * The cobweb backdrop around the cap (CSS-px units so line widths are screen
 * px), clipped to (stage minus cap): one `drawImage`.
 */
function drawCobwebs(ctx: CanvasRenderingContext2D, cap: Rect, exact: Rect, web: CobwebBackdrop, pr: number): void {
  const { width, height } = ctx.canvas;
  if (cap.x <= 0 && cap.y <= 0 && cap.x + cap.width >= width && cap.y + cap.height >= height) return;
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, width, height);
  ctx.rect(cap.x, cap.y, cap.width, cap.height);
  ctx.clip("evenodd");
  ctx.setTransform(pr, 0, 0, pr, 0, 0);
  // Unsnapped rect: its aspect must not jitter with zoom (that would regrow).
  const rect = { x: exact.x / pr, y: exact.y / pr, w: exact.width / pr, h: exact.height / pr };
  web.draw(ctx, rect, pr, { x: 0, y: 0, w: width / pr, h: height / pr });
  ctx.restore();
}

/** 1 device px black line just outside the cap, with a faint light line outside it. */
function drawCapBorder(ctx: CanvasRenderingContext2D, cap: Rect): void {
  ctx.lineWidth = 1;
  ctx.strokeStyle = STAGE_STYLE.capLine;
  ctx.strokeRect(cap.x - 0.5, cap.y - 0.5, cap.width + 1, cap.height + 1);
  ctx.strokeStyle = STAGE_STYLE.capGlow;
  ctx.strokeRect(cap.x - 1.5, cap.y - 1.5, cap.width + 3, cap.height + 3);
}

/** Tolerance (image px) for float error in the mapped paint rect. */
const EPSILON = 1e-6;

function inflateRect(r: Rect, d: number): Rect {
  return { x: r.x - d, y: r.y - d, width: r.width + d * 2, height: r.height + d * 2 };
}

function scaleRect(r: Rect, k: number): Rect {
  return { x: r.x * k, y: r.y * k, width: r.width * k, height: r.height * k };
}

function checkerPattern(ctx: CanvasRenderingContext2D): CanvasPattern | null {
  const cached = checkerPatterns.get(ctx);
  if (cached) return cached;
  const cell = STAGE_STYLE.checkerCell;
  const tile = document.createElement("canvas");
  tile.width = tile.height = cell * 2;
  const t = tile.getContext("2d");
  if (!t) return null;
  t.fillStyle = STAGE_STYLE.checkerLight;
  t.fillRect(0, 0, cell * 2, cell * 2);
  t.fillStyle = STAGE_STYLE.checkerDark;
  t.fillRect(cell, 0, cell, cell);
  t.fillRect(0, cell, cell, cell);
  const pattern = ctx.createPattern(tile, "repeat");
  if (pattern) checkerPatterns.set(ctx, pattern);
  return pattern;
}
