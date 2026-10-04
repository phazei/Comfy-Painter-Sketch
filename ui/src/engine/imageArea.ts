/**
 * Where painting may land. The *image area* is the background image's rect
 * (what Ctrl+0 centres; the `width x height` fill without an image) in
 * document coords; the *draw area* is the bounds cap inside the cobwebs.
 * Brush, eraser, shapes, lines, the bucket and selection fills paint only
 * where the two overlap ({@link paintLimit}): paint outside the image never
 * reaches the outputs, so it is not drawn and never grows the layers.
 * Move, transforms, paste and text still grow the paint area up to the cap
 * (content placed or scaled into it).
 */

import { frameRect, intersectRect, roundOutRect } from "../geometry/rect";
import type { Rect } from "../geometry/rect";
import { boundsCap } from "./bounds";
import type { EditorState } from "./editorState";
import { documentMap, imageRectToDoc } from "./frameMap";

/**
 * The image area in document coords (rounded out to whole pixels; includes
 * the Move-tool placement through {@link documentMap}).
 * @param s - Editor state.
 * @returns Integer document rect.
 */
export function imageAreaInDoc(s: EditorState): Rect {
  return roundOutRect(imageRectToDoc(documentMap(s.doc, s.imageSize), frameRect(s.imageSize)));
}

/**
 * Where painting may land: the image area inside the draw area.
 * @param s - Editor state.
 * @returns Integer document rect; empty when the image lies outside the draw area.
 */
export function paintLimit(s: EditorState): Rect {
  return intersectRect(imageAreaInDoc(s), boundsCap(s.doc.frame));
}
