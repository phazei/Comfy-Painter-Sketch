/**
 * Encode a layer canvas for upload (saved-file contract, Format).
 *
 * - Masks: always PNG (lossless; browser lossless WebP was ~2x the PNG size).
 * - Paint layers: quality setting `PainterSketch.PaintQuality` (50-100).
 *   - Below 100: lossy WebP at `quality / 100`; if the browser doesn't return
 *     `image/webp`, falls back to PNG.
 *   - Exactly 100: PNG (Chrome lossless WebP measured ~2x the PNG size; no benefit).
 *
 * The file extension follows the format actually produced.
 */

import type { LayerKind } from "../document/types";
import type { LayerFileExt } from "./contentHash";
import { acceptWebp } from "./webpSniff";

/** An encoded layer ready for upload. */
export interface EncodedLayer {
  blob: Blob;
  bytes: Uint8Array;
  ext: LayerFileExt;
}

/**
 * Encode a layer canvas as the appropriate format per the saved-file contract:
 * masks → PNG; paint quality < 100 → lossy WebP (PNG if WebP unavailable);
 * paint quality = 100 → PNG.
 *
 * @param canvas - Layer canvas (straight alpha, `bounds` sized).
 * @param kind - Layer kind.
 * @param paintQuality - Paint quality setting, 50..100.
 * @returns Blob, its bytes and the matching extension.
 * @throws If even PNG encoding fails.
 */
export async function encodeLayer(canvas: HTMLCanvasElement, kind: LayerKind, paintQuality: number): Promise<EncodedLayer> {
  // Masks are always PNG; paint at exactly 100 is PNG too.
  if (kind === "mask" || paintQuality >= 100) {
    const png = await toBlob(canvas, "image/png");
    if (!png) throw new Error("image encoding failed");
    return { blob: png, bytes: new Uint8Array(await png.arrayBuffer()), ext: "png" };
  }

  // Paint below 100: attempt lossy WebP, verify it really is WebP, else PNG.
  const webp = await toBlob(canvas, "image/webp", paintQuality / 100);
  if (webp) {
    const bytes = new Uint8Array(await webp.arrayBuffer());
    if (acceptWebp(webp.type, bytes)) return { blob: webp, bytes, ext: "webp" };
  }
  const png = await toBlob(canvas, "image/png");
  if (!png) throw new Error("image encoding failed");
  return { blob: png, bytes: new Uint8Array(await png.arrayBuffer()), ext: "png" };
}

/** `canvas.toBlob` as a promise; `null` when the encoder produced nothing. */
function toBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}
