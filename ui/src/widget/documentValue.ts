/**
 * The `document` widget value: the versioned layer manifest as a JSON string.
 *
 * M0 only round-trips the string. M1 adds parsing/migration (in `document/`)
 * and uploads dirty layer PNGs inside {@link serializeDocumentValue} before
 * the manifest is sent with the prompt.
 */

/**
 * Coerce whatever the frontend hands to `setValue` into the stored string.
 * Saved workflows always hold a string, but other code paths (clipboard,
 * old workflows, extensions) might pass an object or nullish value.
 *
 * @param value - Incoming widget value.
 * @returns The string to store (`""` means "no document yet").
 */
export function normalizeDocumentValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return "";
    }
  }
  return String(value);
}

/**
 * Produce the value sent to the backend when the prompt is queued.
 *
 * Seam for M1: upload dirty layer PNGs to `input/painter-sketch/` via
 * `POST /upload/image`, then return the manifest referencing them. In M0 the
 * stored string is returned unchanged.
 *
 * @param current - The current stored document string.
 * @returns The document string to serialize.
 */
export async function serializeDocumentValue(current: string): Promise<string> {
  return current;
}
