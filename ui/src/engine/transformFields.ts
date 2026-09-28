/**
 * Options-bar fields of a Free Transform session (SPEC M11), pure over the
 * session parameters: X / Y = box centre in IMAGE px (through the document
 * map), W / H = unsigned scale fractions, angle in degrees.
 */

import { docToImage, imageToDoc } from "./frameMap";
import type { FrameMap } from "./frameMap";
import { normalizeAngle } from "./transformMath";
import type { TransformParams } from "./transformMath";

/** Option-bar fields of a session. */
export type TransformField = "x" | "y" | "w" | "h" | "angle";

/**
 * A field's value.
 * @param p - Session parameters.
 * @param map - Document -> image map.
 * @param key - Field.
 * @returns Value in the field's unit.
 */
export function fieldValue(p: Readonly<TransformParams>, map: FrameMap, key: TransformField): number {
  const centre = docToImage(map, { x: p.cx, y: p.cy });
  switch (key) {
    case "x":
      return centre.x;
    case "y":
      return centre.y;
    case "w":
      return Math.abs(p.sx);
    case "h":
      return Math.abs(p.sy);
    case "angle":
      return (normalizeAngle(p.angle) * 180) / Math.PI;
  }
}

/**
 * Parameters with one field set (flips are kept).
 * @param p - Session parameters.
 * @param map - Document -> image map.
 * @param key - Field.
 * @param value - New value (field unit).
 * @param linked - W / H keep the ratio.
 * @returns New parameters, or `null` for an invalid value.
 */
export function withField(p: Readonly<TransformParams>, map: FrameMap, key: TransformField, value: number, linked: boolean): TransformParams | null {
  if (!Number.isFinite(value)) return null;
  const next = { ...p };
  if (key === "x" || key === "y") {
    const img = docToImage(map, { x: p.cx, y: p.cy });
    const doc = imageToDoc(map, key === "x" ? { x: value, y: img.y } : { x: img.x, y: value });
    next.cx = doc.x;
    next.cy = doc.y;
  } else if (key === "w" || key === "h") {
    if (value <= 0) return null;
    const old = Math.abs(key === "w" ? p.sx : p.sy);
    const k = old > 0 ? value / old : 1;
    if (key === "w" || linked) next.sx *= k;
    if (key === "h" || linked) next.sy *= k;
  } else {
    next.angle = normalizeAngle((value * Math.PI) / 180);
  }
  return next;
}
