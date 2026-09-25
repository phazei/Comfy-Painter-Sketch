/**
 * Pure helpers for the file cleanup setting: the layer-file reference pattern
 * (shared with the server, `nodes/cleanup.py` `REFERENCE_RE`), reference
 * extraction, response narrowing and the user-facing texts.
 */

// ── Reference pattern ────────────────────────────────────────────────────────

/**
 * Source of the reference pattern. Must equal `REFERENCE_RE` in
 * `nodes/cleanup.py` (a test compares them). Matches `painter-sketch/ps-...`
 * with a plain, JSON-escaped (`\/`, `\\`) or URL-encoded (`%2F`) separator, so
 * names inside the double-encoded manifest string are found without parsing.
 */
export const REFERENCE_SOURCE = String.raw`painter-sketch(?:[\\/]|%2f){1,8}(ps-[a-z0-9]+-[0-9a-f]+\.(?:png|webp))`;

/**
 * Add every layer file name referenced in `text` to `into`.
 *
 * @param text - Raw text (workflow JSON, a draft, a widget value, ...).
 * @param into - Set receiving lower-cased file names (no directory).
 * @returns `into`, for chaining.
 */
export function extractReferences(text: string, into: Set<string> = new Set()): Set<string> {
  for (const match of text.matchAll(new RegExp(REFERENCE_SOURCE, "gi"))) {
    const name = match[1];
    if (name) into.add(name.toLowerCase());
  }
  return into;
}

// ── Server responses ─────────────────────────────────────────────────────────

/** File count + byte total pair used in stats responses. */
export interface FileStat {
  count: number;
  bytes: number;
}

/** Response of `POST /painter-sketch/cleanup` with `{mode:"stats"}`. */
export interface StatsResponse {
  /** All candidate files (matching name pattern, regular, not symlinked). */
  all: FileStat;
  /** Candidate files whose mtime is older than 24 h. */
  old: FileStat;
}

/** Response of `POST /painter-sketch/cleanup` (dry-run or real run). */
export interface CleanupResponse {
  /** Files that would be (dry run) / were deleted. */
  count: number;
  /** Their total size in bytes. */
  bytes: number;
  /** Deleted file names (real run only). */
  deleted?: string[];
  /** Workflow files that could not be scanned, files that could not be deleted. */
  errors?: string[];
  /** All candidate files at the time of the request (same as stats mode). */
  all: FileStat;
  /** Candidate files older than 24 h at the time of the request. */
  old: FileStat;
}

/**
 * Narrow an unknown JSON body to a {@link StatsResponse}.
 *
 * @param value - Parsed response body.
 * @returns Whether it has the expected shape.
 */
export function isStatsResponse(value: unknown): value is StatsResponse {
  if (typeof value !== "object" || value === null) return false;
  const { all, old } = value as Record<string, unknown>;
  return isFileStat(all) && isFileStat(old);
}

/**
 * Narrow an unknown JSON body to a {@link CleanupResponse}.
 *
 * @param value - Parsed response body.
 * @returns Whether it has the expected shape.
 */
export function isCleanupResponse(value: unknown): value is CleanupResponse {
  if (typeof value !== "object" || value === null) return false;
  const { count, bytes, errors, all, old } = value as Record<string, unknown>;
  return (
    typeof count === "number" &&
    typeof bytes === "number" &&
    isFileStat(all) &&
    isFileStat(old) &&
    (errors === undefined || (Array.isArray(errors) && errors.every((e) => typeof e === "string")))
  );
}

function isFileStat(value: unknown): value is FileStat {
  if (typeof value !== "object" || value === null) return false;
  const { count, bytes } = value as Record<string, unknown>;
  return typeof count === "number" && typeof bytes === "number";
}

// ── Texts ────────────────────────────────────────────────────────────────────

/**
 * Human-readable byte size (`"820 B"`, `"12.3 KB"`, `"4.5 MB"`, `"1.2 GB"`; 1 KB = 1024 B).
 *
 * @param bytes - Size in bytes.
 * @returns Formatted size.
 */
export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return unit === 0 ? `${Math.round(value)} B` : `${value.toFixed(1)} ${units[unit]}`;
}

/**
 * `"1 file"` / `"N files"`.
 *
 * @param count - Number of files.
 * @returns Counted noun.
 */
export function fileCount(count: number): string {
  return `${count} ${count === 1 ? "file" : "files"}`;
}

/**
 * Confirm-dialog text for the dry-run result (SPEC "Settings").
 *
 * When `dry.old.count` is 0, returns `null` (caller shows a toast instead).
 * When `dry.count` is 0 but there are old files, signals nothing to delete.
 *
 * @param dry - Dry-run response.
 * @returns Dialog text, or `null` when `dry.count === 0`.
 */
export function confirmText(dry: CleanupResponse): string | null {
  if (dry.count === 0) return null;
  let text =
    `${dry.count} of the ${fileCount(dry.old.count)} older than 24 h (${formatBytes(dry.bytes)}) are unused and will be deleted. ` +
    "This affects all workflows.";
  const skipped = dry.errors?.length ?? 0;
  if (skipped) {
    text +=
      `\n\nWarning: ${fileCount(skipped)} in the workflows folders could not be scanned ` +
      "(too large or unreadable); layer files used only there would be deleted.";
  }
  return text;
}
