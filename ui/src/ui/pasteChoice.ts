/**
 * Pure paste decisions (SPEC "Clipboard and drop"), kept free of `app` / DOM so they
 * are unit-testable; the browser side is `pasteSources.ts`.
 *
 * Source order of Ctrl+V and the Paste button's "System" mode
 * ({@link choosePasteSource}):
 * 1. a system clipboard image -- unless it is the PNG we wrote ourselves
 *    (same size + matching thumbnail, {@link signaturesMatch}), then the
 *    internal copy is used instead (exact pixels, knows its position);
 * 2. our internal copy (the system clipboard holds no image);
 * 3. the ComfyUI clipspace image;
 * 4. nothing.
 *
 * Ctrl+Shift+V (paste in place) uses only the internal copy and the
 * button's "Clipspace" mode only the clipspace; neither goes through here.
 */

/** A paste source. */
export type PasteSourceKind = "system" | "internal" | "clipspace" | "none";

/** What is available when a paste runs. */
export interface PasteFacts {
  /** The system clipboard holds an image. */
  systemImage: boolean;
  /** That image is the one we wrote on our last copy. */
  systemIsOurs: boolean;
  /** An internal clipboard exists. */
  internal: boolean;
  /** ComfyUI's clipspace holds an image. */
  clipspace: boolean;
}

/**
 * Pick the paste source (see module doc for the order).
 * @param f - Availability.
 * @returns Source to use.
 */
export function choosePasteSource(f: PasteFacts): PasteSourceKind {
  if (f.systemImage) return f.systemIsOurs && f.internal ? "internal" : "system";
  if (f.internal) return "internal";
  if (f.clipspace) return "clipspace";
  return "none";
}

/** Drag types that may carry an image from a web page. */
const URL_TYPES = ["text/uri-list", "text/x-moz-url", "text/html"];

/**
 * Whether the stage claims a drag on `dragenter` / `dragover` (only types and
 * file item MIME types are visible before the drop; Chrome may report a
 * file item's type as `""`):
 * 1. any `image/*` file item -> claim;
 * 2. any file item with a known non-image type (workflow JSON, ...) -> leave
 *    it to ComfyUI;
 * 3. otherwise claim when a URL / HTML type is present. An image dragged
 *    from a Chrome page carries `text/uri-list` + `text/html` and often
 *    `Files` too (the image itself, type possibly hidden until the drop);
 *    desktop file drags carry only `Files`, so unknown files stay ComfyUI's.
 * @param types - `dataTransfer.types`.
 * @param fileTypes - `type` of every `kind === "file"` item.
 * @returns `true` to claim (preventDefault, dropEffect "copy").
 */
export function shouldClaimDrag(types: readonly string[], fileTypes: readonly string[]): boolean {
  if (fileTypes.some((t) => t.startsWith("image/"))) return true;
  if (fileTypes.some((t) => t !== "")) return false;
  return URL_TYPES.some((t) => types.includes(t));
}

/** URL schemes a dragged image may be loaded from. */
const IMAGE_URL = /^(https?:|data:image\/|blob:)/i;

/**
 * Image URL of a drag from a web page (no files): the `<img src>` of the
 * dragged HTML (right even for a linked image, whose `text/uri-list` is the
 * link target), else the first `text/uri-list` / `text/x-moz-url` entry.
 * Only absolute http(s), `data:image/` and `blob:` URLs count.
 * @param uriList - `text/uri-list` (or `text/x-moz-url`) data, `""` if none.
 * @param html - `text/html` data, `""` if none.
 * @returns URL, or `null`.
 */
export function imageUrlFromDrop(uriList: string, html: string): string | null {
  const img = /<img\b[^>]*?\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(html);
  const src = img ? decodeEntities((img[1] ?? img[2] ?? img[3] ?? "").trim()) : "";
  if (IMAGE_URL.test(src)) return src;
  const first = uriList.split(/\r?\n/).map((line) => line.trim()).find((line) => line !== "" && !line.startsWith("#")) ?? "";
  return IMAGE_URL.test(first) ? first : null;
}

/** The few HTML entities that occur in attribute URLs. */
function decodeEntities(text: string): string {
  return text.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

/** Side of the thumbnails compared by {@link signaturesMatch}. */
export const SIGNATURE_SIDE = 16;

/** Image fingerprint: pixel size + a small RGBA thumbnail. */
export interface ImageSignature {
  width: number;
  height: number;
  /** `SIGNATURE_SIDE`² RGBA thumbnail. */
  thumb: Uint8ClampedArray;
}

/**
 * Whether two fingerprints describe the same image: equal size and a mean
 * per-channel difference within `tolerance` (the system clipboard may
 * re-encode our PNG; premultiplied round trips shift semi-transparent pixels).
 * @param a - First signature.
 * @param b - Second signature.
 * @param tolerance - Mean absolute difference allowed (0-255).
 * @returns `true` if they match.
 */
export function signaturesMatch(a: ImageSignature | null, b: ImageSignature | null, tolerance = 4): boolean {
  if (!a || !b || a.width !== b.width || a.height !== b.height || a.thumb.length !== b.thumb.length) return false;
  let sum = 0;
  for (let i = 0; i < a.thumb.length; i++) sum += Math.abs((a.thumb[i] as number) - (b.thumb[i] as number));
  return sum / Math.max(1, a.thumb.length) <= tolerance;
}
