/**
 * "What the user sees", rendered in DOCUMENT coordinates, for tools that
 * sample all layers (paint bucket, eyedropper): the background (image or
 * fill) mapped through the inverse frame map (decision 4 -- the image may
 * have a different size than `doc.frame`), then visible paint layers bottom
 * -> top at their opacity (Normal blend). Mask tints are not included: they
 * are display-only. Outside the image rect and the paint bounds the result
 * is transparent.
 *
 * Uses offscreen canvases (`willReadFrequently`, since every render is read
 * back); no DOM UI.
 */

import type { Rect, Size } from "../geometry/rect";
import type { CompositeLayer, FrameBackground } from "./compositor";
import type { FrameMap } from "./frameMap";

/** Scene description in document terms. */
export interface DocCompositeInput {
  background: FrameBackground;
  /** Size of the image the background is drawn at (image px). */
  imageSize: Size;
  /** Document -> image transform. */
  map: FrameMap;
  /** Paint bounds (document coords); every layer source is sized to it. */
  bounds: Rect;
  /** Visible paint layers, bottom -> top. */
  layers: readonly CompositeLayer[];
}

/**
 * Draw the scene for a document rect into a context whose (0,0) is `rect`'s
 * top-left, 1 canvas px per document px.
 * @param ctx - Target context (cleared first, `rect`-sized).
 * @param input - Scene.
 * @param rect - Integer document rect.
 */
export function drawDocRegion(ctx: CanvasRenderingContext2D, input: DocCompositeInput, rect: Rect): void {
  const { map, imageSize, bounds } = input;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  ctx.clearRect(0, 0, rect.width, rect.height);
  // Image rect in document coords: inverse of `image = offset + doc * s`.
  const bx = -map.offsetX / map.scale - rect.x;
  const by = -map.offsetY / map.scale - rect.y;
  const bw = imageSize.width / map.scale;
  const bh = imageSize.height / map.scale;
  if (input.background.kind === "image") {
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(input.background.image, bx, by, bw, bh);
  } else {
    ctx.fillStyle = input.background.color;
    ctx.fillRect(bx, by, bw, bh);
  }
  for (const layer of input.layers) {
    if (layer.opacity <= 0) continue;
    ctx.globalAlpha = layer.opacity;
    ctx.drawImage(layer.source, bounds.x - rect.x, bounds.y - rect.y);
  }
  ctx.globalAlpha = 1;
}

/**
 * Render and read back a document rect of the scene.
 * @param input - Scene.
 * @param rect - Integer document rect (non-empty).
 * @param scratch - Reusable canvas (resized as needed); a temporary one otherwise.
 * @returns Straight-alpha pixels of `rect`, or `null` if no 2D context is available.
 */
export function readDocRegion(input: DocCompositeInput, rect: Rect, scratch?: HTMLCanvasElement): ImageData | null {
  const canvas = scratch ?? document.createElement("canvas");
  if (canvas.width !== rect.width) canvas.width = rect.width;
  if (canvas.height !== rect.height) canvas.height = rect.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  drawDocRegion(ctx, input, rect);
  const data = ctx.getImageData(0, 0, rect.width, rect.height);
  if (!scratch) canvas.width = canvas.height = 0;
  return data;
}
