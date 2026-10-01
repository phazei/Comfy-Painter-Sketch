/**
 * Image Mask (SPEC "Layers" > "Image Mask / Input Mask row"): the fixed mask row made
 * from the background image's alpha (coverage = 255 - alpha, LoadImage's MASK
 * polarity). Unlike mask layers its pixels are CURRENT-IMAGE px (the file is
 * exactly `width x height`, the upstream image's size); it is never painted,
 * moved, renamed, reordered or deleted.
 *
 * Saved as the optional manifest field `imageMask` (additive, written only
 * while the row exists; missing = no row):
 *
 *   imageMask?: { file, visible, color, opacity, invert, sourceKey, width, height }
 *
 * In the editor it is a `Layer`-shaped record with the fixed id
 * {@link IMAGE_MASK_ID} that is never part of `layers`, so the generic mask
 * settings (eye, colour, invert, overlay opacity, solo) apply to it as they
 * are. Reading lives in `parse.ts` (shared guards).
 *
 * Input Mask: while the node's `mask` input is connected the same
 * record holds the row's settings, with `file: null` (Python has the tensor)
 * and a `sourceKey` starting with {@link INPUT_MASK_KEY_PREFIX}; its size is
 * the image's. Same manifest shape, no version bump. The name is not saved:
 * it follows the source ({@link INPUT_MASK_NAME} / {@link IMAGE_MASK_NAME}).
 */

import type { Size } from "../geometry/rect";
import type { MaskStyle } from "./create";
import type { Layer, PainterDocument } from "./types";

/** Id of the Image Mask row (never a layer id: layer ids are base36). */
export const IMAGE_MASK_ID = "\u0000image-mask";

/** Row name while it shows the image's alpha. */
export const IMAGE_MASK_NAME = "Image Mask";

/** Row name while the `mask` input is connected. */
export const INPUT_MASK_NAME = "Input Mask";

/** `sourceKey` prefix of an Input Mask record (image source keys never start with it). */
export const INPUT_MASK_KEY_PREFIX = "mask:";

/**
 * Whether a record's source is the `mask` input rather than the image's alpha.
 * @param sourceKey - Record `sourceKey`.
 * @returns `true` for Input Mask keys.
 */
export function isInputMaskKey(sourceKey: string): boolean {
  return sourceKey.startsWith(INPUT_MASK_KEY_PREFIX);
}

/** The Image Mask record (`PainterDocument.imageMask`). */
export interface ImageMask extends Layer {
  kind: "mask";
  /** `ImageSource.key` of the background the coverage was read from. */
  sourceKey: string;
  /** Image px size of the coverage (and of the file). */
  width: number;
  height: number;
}

/**
 * A new Image Mask record (visible, not inverted, no file yet), named after its source.
 * @param sourceKey - Background source key (an Input Mask key while `mask` is connected).
 * @param size - Image size.
 * @param style - Overlay colour + opacity.
 * @returns The record.
 */
export function createImageMask(sourceKey: string, size: Size, style: Readonly<MaskStyle>): ImageMask {
  return {
    id: IMAGE_MASK_ID,
    name: isInputMaskKey(sourceKey) ? INPUT_MASK_NAME : IMAGE_MASK_NAME,
    kind: "mask",
    visible: true,
    locked: false,
    opacity: style.opacity,
    blendMode: "normal",
    file: null,
    color: style.color,
    invert: false,
    sourceKey,
    width: size.width,
    height: size.height,
  };
}

/**
 * A layer of the document by id, including the Image Mask row.
 * @param doc - Document.
 * @param id - Layer id or {@link IMAGE_MASK_ID}.
 * @returns The layer / Image Mask record, or `undefined`.
 */
export function findAnyLayer(doc: Readonly<PainterDocument>, id: string): Layer | undefined {
  return id === IMAGE_MASK_ID ? doc.imageMask : doc.layers.find((l) => l.id === id);
}

/**
 * Manifest form of the record (stable key order, no fixed fields).
 * @param mask - Record.
 * @returns Plain object for `imageMask`.
 */
export function serializeImageMask(mask: Readonly<ImageMask>): Record<string, unknown> {
  return {
    file: mask.file,
    visible: mask.visible,
    ...(mask.color !== undefined ? { color: mask.color } : {}),
    opacity: mask.opacity,
    invert: mask.invert === true,
    sourceKey: mask.sourceKey,
    width: mask.width,
    height: mask.height,
  };
}
