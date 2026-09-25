/**
 * Draws the scene to the display canvas. The view transform maps IMAGE
 * coordinates (the current background, or `doc.frame` when there is none) to
 * the stage; layers are drawn through the document -> image map (decision 4)
 * into the same integer rect Python places them in, so preview and output
 * agree. Order: neutral surround, transparency checker + background inside
 * the image rect, visible paint layers bottom -> top at their opacity (Normal
 * blend, decision 11), then a dim veil over paint outside the image and the
 * image outline.
 *
 * Canvas 2D only; no DOM UI.
 */

import { containsRect, frameRect } from "../geometry/rect";
import type { Rect, Size } from "../geometry/rect";
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
  /** Visible layers, bottom -> top, each sized to `bounds`. */
  layers: readonly CompositeLayer[];
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

  if (input.background.kind === "image") {
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
  for (const layer of input.layers) {
    if (layer.opacity <= 0) continue;
    ctx.globalAlpha = layer.opacity;
    ctx.drawImage(layer.source, placed.x, placed.y, placed.width, placed.height);
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
