/**
 * Thumbnail refresh pass of the layers panel (`layersPanel.ts` runs it
 * through a `RefreshThrottle`): every row's thumbnail is redrawn only when
 * its cache key changes -- pixel revision, document geometry, image size,
 * Align-drawing placement and, for an lmask, its invert. cmask thumbnails
 * are raw coverage.
 */

import type { Editor } from "../engine/editor";
import { imageRectToDoc } from "../engine/frameMap";
import { refreshImageMaskThumb } from "./imageMaskRow";
import type { LayerRow } from "./layerRow";

/**
 * Stable short keys for background images (object identity -> "imgN").
 */
export class ImageKeys {
  private readonly keys = new WeakMap<object, number>();
  private counter = 0;

  /**
   * Key of an image object.
   * @param image - Any object.
   * @returns `img<n>`, stable for the object's lifetime.
   */
  of(image: object): string {
    let id = this.keys.get(image);
    if (id === undefined) {
      id = ++this.counter;
      this.keys.set(image, id);
    }
    return `img${id}`;
  }
}

/**
 * Redraw the thumbnails whose pixels or geometry changed.
 * @param editor - Bound editor.
 * @param rows - Rows by layer id.
 * @param backgroundId - Id of the Background row.
 * @param imageKeys - Key source for background images.
 */
export function refreshLayerThumbs(editor: Editor, rows: ReadonlyMap<string, LayerRow>, backgroundId: string, imageKeys: ImageKeys): void {
  const doc = editor.doc;
  const bounds = editor.bounds;
  const imageSize = editor.imageSize;
  // Use the full document->image map (frame fit + Move-tool placement) so
  // thumbnails show each layer as it sits over the current image, matching
  // the Background thumbnail framing. imageRectToDoc maps the image footprint
  // back to document coords; subtracting bounds gives canvas-pixel coords.
  const fmap = editor.frameMap;
  const imgInDoc = imageRectToDoc(fmap, { x: 0, y: 0, width: imageSize.width, height: imageSize.height });
  const region = { x: imgInDoc.x - bounds.x, y: imgInDoc.y - bounds.y, width: imgInDoc.width, height: imgInDoc.height };
  // Placement is encoded in fmap; include it in the cache key so a placement
  // change (x/y/scale) invalidates without waiting for a pixel revision bump.
  const placement = doc.placement;
  const placementKey = placement ? `${placement.x},${placement.y},${placement.scale}` : "0,0,1";
  const geometry = `${bounds.x},${bounds.y},${bounds.width},${bounds.height}|${imageSize.width}x${imageSize.height}|${placementKey}`;
  for (const layer of doc.layers) {
    const row = rows.get(layer.id);
    if (!row) continue;
    // cmask thumbnails show raw coverage (Subtract is a badge, not a flip).
    const mask = layer.kind === "mask";
    const key = `${editor.layerOps.revision(layer.id)}|${geometry}`;
    row.thumb.update(key, imageSize, { kind: "layer", canvas: editor.layerCanvas(layer.id), region, mask, invert: false });
    // The layer mask thumbnail (grayscale, invert applied), same framing and throttle.
    const lm = layer.layerMask;
    const maskCanvas = lm ? editor.layerMask.canvas(layer.id) : null;
    if (lm && maskCanvas && row.maskSlot) {
      const maskKey = `${editor.layerMask.revision(layer.id)}|${geometry}|${lm.invert}`;
      row.maskSlot.thumb.update(maskKey, imageSize, { kind: "layer", canvas: maskCanvas, region, mask: true, invert: lm.invert });
    }
  }
  if (doc.imageMask) refreshImageMaskThumb(editor, rows.get(doc.imageMask.id));
  const bg = rows.get(backgroundId);
  if (bg) {
    const background = editor.background;
    const id = background.kind === "fill" ? background.color : imageKeys.of(background.image);
    bg.thumb.update(`${id}|${imageSize.width}x${imageSize.height}`, imageSize, { kind: "background", background, size: imageSize });
  }
}
