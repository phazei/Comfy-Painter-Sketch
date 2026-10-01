/**
 * Thumbnail click in the Images panel (SPEC "Image sources and the Images panel"): load the
 * full source image and hand its pixels to `Editor.insert` (new layer in
 * Free Transform, `engine/sourceInsert.ts`).
 *
 * Sources are used at full resolution up to {@link MAX_SOURCE_SIDE} per side;
 * larger ones are downscaled once on load (the float keeps the pixels, and
 * its display canvas, in memory for the whole session) with a note.
 */

import type { Editor } from "../engine/editor";
import type { Size } from "../geometry/rect";
import { log } from "../log";
import { decodeUrl } from "./pasteSources";

/** Largest source side kept at full resolution, px. */
export const MAX_SOURCE_SIDE = 8192;

/** Note when a source could not be loaded. */
export const SOURCE_LOAD_FAILED_NOTE = "Could not load the image.";

/**
 * Size a source is inserted at: unchanged up to `max` per side, else scaled
 * down proportionally so the long side is `max`.
 * @param size - Source size, px.
 * @param max - Largest side, px.
 * @returns Integer size (at least 1 x 1).
 */
export function cappedSourceSize(size: Size, max: number = MAX_SOURCE_SIDE): Size {
  const long = Math.max(size.width, size.height);
  if (long <= max) return { width: size.width, height: size.height };
  const k = max / long;
  return { width: Math.max(1, Math.round(size.width * k)), height: Math.max(1, Math.round(size.height * k)) };
}

/**
 * Load `url` and insert it into `editor` as a new layer in Free Transform.
 * @param editor - Target editor (checked again after the async load).
 * @param url - Source URL.
 * @param current - Returns the editor shown now (the session may change while loading).
 * @param name - Layer name (source file name), else "Image N".
 * @returns `true` if a session started.
 */
export async function insertSourceUrl(editor: Editor, url: string, current: () => Editor | null, name?: string): Promise<boolean> {
  const bitmap = await decodeUrl(url);
  if (!bitmap) {
    log.warn("Could not load the image source:", url);
    editor.events.emit("note", SOURCE_LOAD_FAILED_NOTE);
    return false;
  }
  try {
    if (current() !== editor) return false;
    const size = cappedSourceSize({ width: bitmap.width, height: bitmap.height });
    const canvas = document.createElement("canvas");
    canvas.width = size.width;
    canvas.height = size.height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return false;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, 0, 0, size.width, size.height);
    const pixels = ctx.getImageData(0, 0, size.width, size.height);
    canvas.width = canvas.height = 0;
    if (size.width !== bitmap.width) {
      editor.events.emit("note", `Image reduced to ${size.width} x ${size.height} px (max ${MAX_SOURCE_SIDE} px per side).`);
    }
    return editor.insert.insert(pixels, name);
  } finally {
    bitmap.close();
  }
}
