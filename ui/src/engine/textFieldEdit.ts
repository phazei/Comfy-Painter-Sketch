/**
 * Unlinked W / H field edits of a TEXT transform session
 * (SPEC "Free Transform and flips"), pure
 * over the session parameters. Text can only scale uniformly, so with Link
 * off a W or H field session previews linked (uniform) while it is open;
 * when it ends the requested non-uniform value is resolved here: uniform ->
 * nothing to do, else the caller reverts to the start and asks to rasterize
 * (`transformOps.ts`). On Yes the requested scale is re-applied to the new
 * pixel session ({@link rescaleFromText}).
 */

import type { FrameMap } from "./frameMap";
import { isUniform } from "./textTransform";
import { fieldValue, withField } from "./transformFields";
import type { TransformField } from "./transformFields";
import type { TransformParams } from "./transformMath";

/** An open unlinked W / H field session. */
export interface TextFieldEdit {
  key: "w" | "h";
  /** Parameters when the field session started. */
  before: TransformParams;
}

/** A requested non-uniform field change, waiting for the rasterize prompt. */
export interface TextFieldRequest {
  before: TransformParams;
  want: TransformParams;
}

/**
 * Whether a field is a scale field.
 * @param key - Field.
 * @returns `true` for W / H.
 */
export function isScaleField(key: TransformField): key is "w" | "h" {
  return key === "w" || key === "h";
}

/**
 * What an ended field session asked for.
 * @param edit - The field session.
 * @param current - Parameters now (the uniform preview).
 * @param map - Document -> image map.
 * @returns The non-uniform request, or `null` if the result is uniform (keep the preview).
 */
export function endTextFieldEdit(edit: Readonly<TextFieldEdit>, current: Readonly<TransformParams>, map: FrameMap): TextFieldRequest | null {
  const want = withField(edit.before, map, edit.key, fieldValue(current, map, edit.key), false);
  if (!want || isUniform(want)) return null;
  return { before: { ...edit.before }, want };
}

/**
 * Parameters of the pixel session that replaced a rasterized text session,
 * with the requested W / H applied as ratios to the text scale (exact for
 * unrotated text; rotated text is scaled along the document axes).
 * @param p - Pixel session parameters (after rasterize, the text scale baked in).
 * @param req - The request.
 * @returns New parameters.
 */
export function rescaleFromText(p: Readonly<TransformParams>, req: Readonly<TextFieldRequest>): TransformParams {
  const kx = req.before.sx !== 0 ? req.want.sx / req.before.sx : 1;
  const ky = req.before.sy !== 0 ? req.want.sy / req.before.sy : 1;
  return { ...p, sx: p.sx * kx, sy: p.sy * ky };
}
