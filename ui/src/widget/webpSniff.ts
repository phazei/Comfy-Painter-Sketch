/**
 * Pure byte sniffing for encoded layer images (saved-file contract, Format).
 *
 * A WebP file is a RIFF container: `"RIFF" <u32 size> "WEBP"` then chunks of
 * `<fourcc> <u32 LE size> <payload, padded to even length>`. The image data
 * chunk tells the codec:
 * - `VP8L`: lossless (simple file, or inside `VP8X` extended files);
 * - `VP8 `: lossy (with `VP8X` + `ALPH` when it has alpha);
 * - `ANMF`: animation frames (never produced for a canvas; rejected).
 *
 * Used only to verify that the browser actually produced a WebP blob for lossy
 * paint layers (browsers without WebP encoding silently return PNG).
 */

/** What an encoded blob turned out to be. */
export type WebpKind = "lossless" | "lossy" | "invalid";

/** RIFF header size before the first chunk. */
const HEADER = 12;

/**
 * Classify WebP bytes as lossless (VP8L), lossy (VP8) or not a usable WebP.
 *
 * @param bytes - Encoded file bytes.
 * @returns The kind; anything malformed, truncated or animated is `"invalid"`.
 */
export function sniffWebp(bytes: Uint8Array): WebpKind {
  if (bytes.length < HEADER + 8 || fourcc(bytes, 0) !== "RIFF" || fourcc(bytes, 8) !== "WEBP") return "invalid";
  let offset = HEADER;
  while (offset + 8 <= bytes.length) {
    const id = fourcc(bytes, offset);
    const size = readU32(bytes, offset + 4);
    if (id === "VP8L") return "lossless";
    if (id === "VP8 ") return "lossy";
    if (id === "ANMF" || id === "ANIM") return "invalid";
    offset += 8 + size + (size & 1);
  }
  return "invalid";
}

/**
 * Whether an encoder result is a valid WebP blob (lossy or lossless).
 * Used to confirm the browser produced WebP for lossy paint layers; if not,
 * the caller falls back to PNG.
 *
 * @param mimeType - `Blob.type` returned by `canvas.toBlob` (browsers without
 *   WebP encoding silently return PNG).
 * @param bytes - Encoded bytes.
 * @returns `true` to keep the WebP, `false` to fall back to PNG.
 */
export function acceptWebp(mimeType: string, bytes: Uint8Array): boolean {
  if (mimeType !== "image/webp") return false;
  const kind = sniffWebp(bytes);
  return kind === "lossy" || kind === "lossless";
}

function fourcc(bytes: Uint8Array, at: number): string {
  return String.fromCharCode(bytes[at] ?? 0, bytes[at + 1] ?? 0, bytes[at + 2] ?? 0, bytes[at + 3] ?? 0);
}

function readU32(bytes: Uint8Array, at: number): number {
  return ((bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8) | ((bytes[at + 2] ?? 0) << 16) | ((bytes[at + 3] ?? 0) << 24)) >>> 0;
}
