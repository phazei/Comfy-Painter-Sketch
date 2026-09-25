/**
 * Content hash for layer PNG file names. A small non-cryptographic 53-bit
 * hash (cyrb53) is used instead of `crypto.subtle`, which is unavailable on
 * plain-http LAN origins. Collisions only matter within one document's
 * uploads, where 53 bits is ample.
 */

/**
 * Hash bytes to a 14-character lowercase hex string.
 *
 * @param bytes - Data to hash.
 * @param seed - Optional seed.
 * @returns Hex digest.
 */
export function contentHash(bytes: Uint8Array, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] ?? 0;
    h1 = Math.imul(h1 ^ b, 2654435761);
    h2 = Math.imul(h2 ^ b, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const value = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  return value.toString(16).padStart(14, "0");
}

/**
 * Upload file name for a layer PNG.
 *
 * @param docId - Document id (prefix for traceability in `input/`).
 * @param hash - Content hash from {@link contentHash}.
 * @returns e.g. `ps-abcd1234-0123456789abcd.png`.
 */
export function layerFileName(docId: string, hash: string): string {
  const prefix = docId.replace(/[^a-z0-9]/gi, "").slice(0, 8) || "doc";
  return `ps-${prefix}-${hash}.png`;
}
