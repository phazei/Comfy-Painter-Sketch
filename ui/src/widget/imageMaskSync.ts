/**
 * M13a Image Mask, widget side: reads the background source's alpha
 * (`/view?...&channel=a`, `viewUrl.ts` `withAlphaChannel`) into the
 * editor (`Editor.imageMask`), and restores the row's saved file.
 *
 * Rules (SPEC "Image Mask / Input Mask"):
 * - Only an upstream `/view` file is read (LoadImage-style). While the
 *   background comes from our own executed preview (RGB; only ever from a
 *   run with the same upstream link) the row is kept as it is; other
 *   upstream previews (blob / `<img>` URLs) carry no file: no row.
 * - The row belongs to its source: disconnected, an upstream without an
 *   image, a failed load or another source loading removes it (and its
 *   manifest entry); it is kept while its own key (re)loads and at startup
 *   until the first lookup (page reload restores it from its file).
 * - Once per source key per session, after the session's restore: a row
 *   already made from this key (or restored from its file) is not read
 *   again, so a reload does not refetch; a changed key reads again.
 * - M13b: while `mask` is connected this module is not used (`inputMaskSync.ts`
 *   owns the row); after a disconnect an Input Mask row is read again from the
 *   image's alpha (or removed when there is nothing to read).
 * - Any pixel alpha < 255 -> the row (coverage 255 - alpha, uploaded through
 *   the normal dirty-upload path, so only when the source changes). Fully
 *   opaque, no alpha or a failed read -> no row; failures are console-only
 *   (like background load failures).
 */

import { api } from "@comfy/scripts/api.js";

import { createSurface, releaseSurface } from "../engine/surface";
import type { Editor } from "../engine/editor";
import { log } from "../log";
import { HttpError } from "./failures";
import { imageMaskAction } from "./backgroundRule";
import type { BackgroundStatus } from "./backgroundRule";
import type { LoadedBackground } from "./handoff";
import type { EditorSession } from "./sessions";
import { parseAnnotatedFilename, viewUrl } from "./viewUrl";

/** Source key last handled per session (reads are not repeated for it). */
const handled = new WeakMap<EditorSession, string>();
/** Read in flight per session (queueing waits for it). */
const pending = new WeakMap<EditorSession, Promise<void>>();

/**
 * The background may have changed: apply the row rule (`backgroundRule.ts`
 * `imageMaskAction`) -- keep, remove (row + manifest entry), or read the
 * alpha if this session has not handled the source yet. Cheap when nothing
 * changed (poll-safe).
 * @param session - Attached session.
 * @param status - Background status (`BackgroundLoader.status`; `none` while disconnected).
 */
export function syncImageMask(session: EditorSession, status: BackgroundStatus): void {
  if (!session.alive) return;
  let action = imageMaskAction(status, session.editor.imageMask.info?.sourceKey);
  // M13b: an Input Mask row left from a disconnected `mask` has no file to
  // keep: back to the image's alpha (read) or no row (settings go with it).
  if (action === "keep" && session.editor.imageMask.isInput && status.kind !== "unresolved") action = "remove";
  if (action === "keep") return;
  if (action === "remove" || status.kind !== "loaded") {
    // A later return of the same source reads it again; an in-flight read is discarded.
    handled.delete(session);
    session.editor.imageMask.remove();
    return;
  }
  const background = status.background;
  if (handled.get(session) === background.key) return;
  handled.set(session, background.key);
  const run: Promise<void> = session.ready
    .then(() => readAlpha(session, background))
    .catch((error: unknown) => log.warn("Could not apply the image's transparency:", error))
    .finally(() => {
      if (pending.get(session) === run) pending.delete(session);
    });
  pending.set(session, run);
}

/**
 * Forget the source read last (M13b: the Input Mask took the row over), so
 * the image's alpha is read again when `mask` is disconnected; an alpha read
 * in flight is discarded.
 * @param session - Session.
 */
export function forgetImageMaskSource(session: EditorSession): void {
  handled.delete(session);
}

/**
 * Resolves when no alpha read is in flight for the session (queue time: the
 * manifest must include a row that is about to appear).
 * @param session - Session.
 * @returns Promise that never rejects.
 */
export function imageMaskReady(session: EditorSession): Promise<void> {
  return pending.get(session) ?? Promise.resolve();
}

/**
 * Load the row's saved file (session restore). A missing, unreadable or
 * wrongly sized file only logs: the source's alpha is read again instead.
 * @param editor - Fresh editor of the session.
 * @param isAlive - `false` once the session was released.
 * @returns Resolves when settled (never rejects).
 */
export async function restoreImageMask(editor: Editor, isAlive: () => boolean): Promise<void> {
  const file = editor.imageMask.info?.file;
  const item = file ? parseAnnotatedFilename(file, "input") : null;
  if (!item) return;
  try {
    const pixels = await fetchPixels(viewUrl(item, (route) => api.apiURL(route)));
    if (isAlive() && !editor.imageMask.restore(pixels.data, { width: pixels.width, height: pixels.height })) {
      log.warn("Image Mask file does not match its size; reading the image again:", file);
    }
  } catch (error) {
    if (isAlive()) log.warn("Could not restore the Image Mask; reading the image again:", file, error);
  }
}

/** Read and apply one source's alpha (after the session restored its files). */
async function readAlpha(session: EditorSession, background: LoadedBackground): Promise<void> {
  const mask = session.editor.imageMask;
  if (!session.alive || (mask.info?.sourceKey === background.key && mask.hasPixels)) return;
  if (!background.alphaUrl) {
    mask.remove();
    return;
  }
  let pixels: ImageData | null = null;
  try {
    pixels = await fetchPixels(background.alphaUrl);
  } catch (error) {
    log.warn("Could not read the image's transparency:", background.alphaUrl, error);
  }
  // A newer source took over meanwhile: its own read decides.
  if (!session.alive || handled.get(session) !== background.key) return;
  const { width, height } = background.size;
  if (pixels && pixels.width === width && pixels.height === height) mask.setFromAlpha(background.key, background.size, pixels.data);
  else mask.remove();
}

/**
 * Download and decode an image to RGBA pixels (exact values: no premultiply,
 * no colour conversion; also the M13b Input Mask reads).
 * @param url - Image URL.
 * @returns The pixels.
 * @throws {HttpError} / network / decode errors.
 */
export async function fetchPixels(url: string): Promise<ImageData> {
  const response = await fetch(url);
  if (!response.ok) throw new HttpError(response.status, response.statusText);
  const bitmap = await createImageBitmap(await response.blob(), { premultiplyAlpha: "none", colorSpaceConversion: "none" });
  try {
    const surface = createSurface(bitmap.width, bitmap.height);
    surface.ctx.drawImage(bitmap, 0, 0);
    const data = surface.ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    releaseSurface(surface);
    return data;
  } finally {
    bitmap.close();
  }
}
