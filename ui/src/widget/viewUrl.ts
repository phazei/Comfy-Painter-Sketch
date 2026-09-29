/**
 * Pure helpers for turning ComfyUI file references into `/view` queries.
 *
 * Kept free of `app`/`api` imports so they are unit-testable; the caller
 * supplies `api.apiURL` to turn a route into a full URL.
 *
 * Idea from ComfySketch's `getInputImageUrl` (LoadImage widget value -> /view)
 * and the frontend's `nodeOutputStore.buildImageUrls`.
 */

import type { NodeExecutionOutput, ResultItem } from "../types/comfy";

// ── Parsing ───────────────────────────────────────────────────────────────────

/** Folder types ComfyUI's `/view` route accepts. */
const FOLDER_TYPES = new Set(["input", "output", "temp"]);

/**
 * Parse a widget file value such as `"sub/dir/name.png [input]"` into a
 * `/view` result item. The trailing `[type]` annotation is optional.
 *
 * @param value - Raw widget value (LoadImage `image` combo, etc.).
 * @param defaultType - Folder type when no annotation is present.
 * @returns The result item, or `null` for empty / non-string values.
 */
export function parseAnnotatedFilename(value: unknown, defaultType = "input"): ResultItem | null {
  if (typeof value !== "string") return null;
  let path = value.trim();
  if (!path) return null;

  let type = defaultType;
  const annotation = /\s*\[([a-z]+)\]$/i.exec(path);
  if (annotation?.[1] && FOLDER_TYPES.has(annotation[1].toLowerCase())) {
    type = annotation[1].toLowerCase();
    path = path.slice(0, annotation.index).trim();
  }

  const normalized = path.replace(/\\/g, "/");
  const slash = normalized.lastIndexOf("/");
  const filename = slash >= 0 ? normalized.slice(slash + 1) : normalized;
  if (!filename) return null;
  const subfolder = slash >= 0 ? normalized.slice(0, slash) : "";
  return { filename, subfolder, type };
}

/**
 * First usable image reference in an execution output.
 *
 * @param output - A node's `ui` output (may be undefined).
 * @returns The first non-null image with a filename, or `null`.
 */
export function firstOutputImage(output: NodeExecutionOutput | undefined | null): ResultItem | null {
  const images = output?.images;
  if (!Array.isArray(images)) return null;
  for (const image of images) {
    if (image && typeof image.filename === "string" && image.filename) return image;
  }
  return null;
}

// ── Building ──────────────────────────────────────────────────────────────────

/**
 * Stable `/view` query string for a result item. Used both as the URL query
 * and as the change-detection key (it has no random cache-buster).
 *
 * @param item - File reference.
 * @returns e.g. `filename=a.png&subfolder=&type=input`.
 */
export function viewQuery(item: ResultItem): string {
  const params = new URLSearchParams();
  params.set("filename", item.filename ?? "");
  params.set("subfolder", item.subfolder ?? "");
  params.set("type", item.type ?? "output");
  return params.toString();
}

/**
 * Full `/view` URL for a result item.
 *
 * @param item - File reference.
 * @param apiURL - `api.apiURL`, which prefixes the API base path.
 * @param cacheBust - Extra query suffix such as `app.getRandParam()` (`&rand=...`).
 * @returns URL suitable for `Image.src`.
 */
export function viewUrl(item: ResultItem, apiURL: (route: string) => string, cacheBust = ""): string {
  return apiURL(`/view?${viewQuery(item)}${cacheBust}`);
}

/**
 * Ask ComfyUI's `/view` route for the opaque RGB image (`channel=rgb`),
 * replacing any existing `channel` param. `LoadImage` outputs the RGB of an
 * alpha file (alpha goes to MASK), so the editor background must not show
 * transparent pixels as holes. Server side (`server.py` `view_image`): without
 * `preview` it returns an RGB PNG; with `preview` it converts to RGB and keeps
 * the preview format. Other params keep their exact text; URLs whose path does
 * not end in `/view` (data:, blob:, anything else) are returned unchanged.
 *
 * @param url - Relative, absolute or api-prefixed URL.
 * @returns The URL with `channel=rgb`, or `url` itself when not a `/view` URL.
 */
export function withRgbChannel(url: string): string {
  return withViewChannel(url, "rgb", false) ?? url;
}

/**
 * Ask `/view` for the image's alpha (`channel=a`, M13a Image Mask). Server
 * side (`server.py` `view_image`): without `preview` it returns an RGBA PNG
 * with black RGB and the file's alpha in A (a file without an alpha channel:
 * 255 everywhere); with `preview` it would return the whole image as lossy
 * WebP, so `preview` is dropped. Same URL rules as {@link withRgbChannel}.
 *
 * @param url - Relative, absolute or api-prefixed URL.
 * @returns The alpha URL, or `null` when not a `/view` URL (blob / data previews carry no file).
 */
export function withAlphaChannel(url: string): string | null {
  return withViewChannel(url, "a", true);
}

/** `/view` URL with `channel` replaced (and `preview` dropped if asked), or `null` for other URLs. */
function withViewChannel(url: string, channel: string, dropPreview: boolean): string | null {
  const hashAt = url.indexOf("#");
  const beforeHash = hashAt >= 0 ? url.slice(0, hashAt) : url;
  const hash = hashAt >= 0 ? url.slice(hashAt) : "";
  const queryAt = beforeHash.indexOf("?");
  const path = queryAt >= 0 ? beforeHash.slice(0, queryAt) : beforeHash;
  if (!/(^|\/)view$/.test(path) || /^(data|blob):/i.test(path)) return null;
  const query = queryAt >= 0 ? beforeHash.slice(queryAt + 1) : "";
  const dropped = dropPreview ? /^(channel|preview)(=|$)/ : /^channel(=|$)/;
  const kept = query.split("&").filter((part) => part && !dropped.test(part));
  return `${path}?${[...kept, `channel=${channel}`].join("&")}${hash}`;
}
