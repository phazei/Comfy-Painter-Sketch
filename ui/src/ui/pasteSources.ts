/**
 * Browser side of pasting (SPEC M10 Clipboard): reading the system clipboard
 * (the `paste` event's data, or `navigator.clipboard.read()` from the rail
 * button), image files of a drop, ComfyUI's clipspace, decoding, and image
 * fingerprints. The source ORDER is the pure `pasteChoice.ts`.
 *
 * Clipspace is read only through `app` ({@link clipspaceImageUrl}):
 * `ComfyApp.clipspace` is a static class member, so `app.constructor.clipspace`;
 * every field is narrowed at runtime.
 *
 * Decoding uses `createImageBitmap` (off the main thread where supported).
 */

import { api } from "@comfy/scripts/api.js";
import { app } from "@comfy/scripts/app.js";

import { log } from "../log";
import type { Clipspace } from "../types/comfy";
import { viewUrl } from "../widget/viewUrl";
import { imageUrlFromDrop, SIGNATURE_SIDE } from "./pasteChoice";
import type { ImageSignature } from "./pasteChoice";
// ── Browser helpers ───────────────────────────────────────────────────────────

/**
 * Fingerprint of a decoded image (draws it to a tiny canvas).
 * @param source - Image.
 * @param width - Its width, px.
 * @param height - Its height, px.
 * @returns Signature, or `null` without a 2D context.
 */
export function imageSignature(source: CanvasImageSource, width: number, height: number): ImageSignature | null {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = SIGNATURE_SIDE;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(source, 0, 0, SIGNATURE_SIDE, SIGNATURE_SIDE);
  const thumb = ctx.getImageData(0, 0, SIGNATURE_SIDE, SIGNATURE_SIDE).data;
  canvas.width = canvas.height = 0;
  return { width, height, thumb };
}

/**
 * Image files of a `paste` / `drop` data transfer, in order.
 * @param data - Data transfer (`null` = none).
 * @returns Image files.
 */
export function imageFiles(data: DataTransfer | null): File[] {
  if (!data) return [];
  const files: File[] = [];
  for (const item of Array.from(data.items)) {
    if (item.kind !== "file" || !item.type.startsWith("image/")) continue;
    const file = item.getAsFile();
    if (file) files.push(file);
  }
  if (files.length === 0) {
    for (const file of Array.from(data.files)) if (file.type.startsWith("image/")) files.push(file);
  }
  return files;
}

/**
 * Types of a drag as seen on `dragenter` / `dragover` / `drop`.
 * @param data - Data transfer.
 * @returns `types` and the MIME type of every file item.
 */
export function dragTypes(data: DataTransfer | null): { types: string[]; fileTypes: string[] } {
  if (!data) return { types: [], fileTypes: [] };
  const fileTypes = Array.from(data.items)
    .filter((item) => item.kind === "file")
    .map((item) => item.type);
  return { types: Array.from(data.types), fileTypes };
}

/**
 * Image URL of a dropped web-page drag (read on `drop` only).
 * @param data - Data transfer.
 * @returns URL, or `null`.
 */
export function droppedImageUrl(data: DataTransfer | null): string | null {
  if (!data) return null;
  const uris = data.getData("text/uri-list") || data.getData("text/x-moz-url");
  return imageUrlFromDrop(uris, data.getData("text/html"));
}

/** Outcome of {@link fetchImageBlob}. */
export type FetchedImage = { blob: Blob } | { error: "blocked" | "not-image" };

/**
 * Load a dragged image URL (http(s), `data:`, `blob:`) the way ComfyUI's
 * graph drop does (`fetch` -> blob). A cross-origin image without CORS
 * headers (or another origin's `blob:` URL) rejects: `"blocked"`.
 * @param url - Image URL.
 * @returns The blob, or why not.
 */
export async function fetchImageBlob(url: string): Promise<FetchedImage> {
  let blob: Blob;
  try {
    const response = await fetch(url, { credentials: "omit" });
    if (!response.ok) {
      log.warn(`Could not fetch the dragged image (HTTP ${response.status}):`, url);
      return { error: "blocked" };
    }
    blob = await response.blob();
  } catch (error) {
    log.warn("Could not fetch the dragged image (CORS or network):", url, error);
    return { error: "blocked" };
  }
  // Some servers send a generic type; the decoder has the last word.
  return blob.type === "" || blob.type.startsWith("image/") || blob.type === "application/octet-stream" ? { blob } : { error: "not-image" };
}

/**
 * Read an image from the async clipboard API (rail button; a user gesture,
 * the browser may ask for permission).
 * @returns The image blob, or `null` (no image, API missing, or refused).
 */
export async function readSystemImage(): Promise<Blob | null> {
  const clipboard = navigator.clipboard;
  if (!clipboard || typeof clipboard.read !== "function") return null;
  try {
    for (const item of await clipboard.read()) {
      const type = item.types.find((t) => t.startsWith("image/"));
      if (type) return await item.getType(type);
    }
  } catch (error) {
    log.warn("Clipboard read unavailable:", error);
  }
  return null;
}

/**
 * URL of the current ComfyUI clipspace image, read only through `app`
 * (`ComfyApp.clipspace` is static: `app.constructor.clipspace`).
 * @returns URL, or `null` when empty / unreachable.
 */
export function clipspaceImageUrl(): string | null {
  const ctor: unknown = app.constructor;
  if (typeof ctor !== "function" || !("clipspace" in ctor)) return null;
  const clip = ctor.clipspace as Clipspace | null | undefined;
  if (!clip || typeof clip !== "object") return null;
  const index = typeof clip.selectedIndex === "number" && clip.selectedIndex >= 0 ? clip.selectedIndex : 0;
  const img = Array.isArray(clip.imgs) ? clip.imgs[index] ?? clip.imgs[0] : undefined;
  if (img instanceof HTMLImageElement && img.src) return img.src;
  const item = Array.isArray(clip.images) ? clip.images[index] ?? clip.images[0] : undefined;
  if (item && typeof item === "object" && typeof item.filename === "string" && item.filename) {
    return viewUrl(item, (route) => api.apiURL(route));
  }
  return null;
}

/**
 * Decode an image blob.
 * @param blob - Image data.
 * @returns Bitmap, or `null` if it can't be decoded.
 */
export async function decodeBlob(blob: Blob): Promise<ImageBitmap | null> {
  try {
    return await createImageBitmap(blob);
  } catch (error) {
    log.warn("Could not decode the pasted image:", error);
    return null;
  }
}

/**
 * Fetch and decode an image URL (clipspace).
 * @param url - Image URL.
 * @returns Bitmap, or `null`.
 */
export async function decodeUrl(url: string): Promise<ImageBitmap | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    return await decodeBlob(await response.blob());
  } catch (error) {
    log.warn("Could not load the clipspace image:", error);
    return null;
  }
}
