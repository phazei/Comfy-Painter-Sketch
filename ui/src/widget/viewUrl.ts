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
