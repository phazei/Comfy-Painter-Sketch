/**
 * Text layer data (SPEC M6b, decision 12): what a `kind: "text"` layer keeps
 * so it stays editable. The layer's pixels are still saved like paint (the
 * frontend rasterizes; Python never renders text).
 *
 * Anchor convention (document / frame px): `(x, y)` is on the BASELINE of
 * the FIRST line; `x` is that line's left edge (`align: "left"`), centre
 * (`"center"`) or right edge (`"right"`). Further lines sit `lineHeight x
 * size` below. `size` is the font size in document px.
 *
 * Values are treated as immutable: every edit stores a new object, so the
 * layout cache (`engine/textRender.ts`) can key on identity and history
 * records may share them safely.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

/** Horizontal alignment of every line to the anchor. */
export type TextAlign = "left" | "center" | "right";

/** Editable text of a text layer (document coords). */
export interface TextData {
  /** Lines separated by `\n`. */
  text: string;
  /** Anchor x (see module doc). */
  x: number;
  /** Anchor y: baseline of the first line. */
  y: number;
  /** Font family name (a CSS generic like `sans-serif`, or a family name). */
  font: string;
  /** Font size, document px. */
  size: number;
  /** `#rrggbb`. */
  color: string;
  bold: boolean;
  italic: boolean;
  align: TextAlign;
  /** Line spacing as a multiple of `size` (default {@link DEFAULT_LINE_HEIGHT}). */
  lineHeight?: number;
}

/** Default line spacing (multiple of the font size). */
export const DEFAULT_LINE_HEIGHT = 1.25;

/** Font size limits, document px. */
export const MIN_TEXT_SIZE = 1;
export const MAX_TEXT_SIZE = 4096;

/** Longest accepted text / font name (characters). */
export const MAX_TEXT_LENGTH = 10000;
export const MAX_FONT_LENGTH = 100;

/** Defaults for missing cosmetic fields. */
export const DEFAULT_TEXT_STYLE = {
  font: "sans-serif",
  size: 48,
  color: "#000000",
  bold: false,
  italic: false,
  align: "left" as TextAlign,
};

const ALIGNS: ReadonlySet<string> = new Set<TextAlign>(["left", "center", "right"]);

// ── Validation ────────────────────────────────────────────────────────────────

/**
 * Read stored text data leniently. The essentials (`text` string, finite
 * `x`/`y`) must be present; cosmetic fields fall back to defaults.
 * @param value - Stored `textData`.
 * @returns Normalized data, or `null` when unusable (the layer is then kept
 *   as a plain raster layer).
 */
export function readTextData(value: unknown): TextData | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const text = v["text"];
  const x = v["x"];
  const y = v["y"];
  if (typeof text !== "string" || !isFiniteNumber(x) || !isFiniteNumber(y)) return null;
  const font = typeof v["font"] === "string" ? cleanFontName(v["font"]) : "";
  const size = v["size"];
  const color = v["color"];
  const align = v["align"];
  const data: TextData = {
    text: text.slice(0, MAX_TEXT_LENGTH),
    x,
    y,
    font: font || DEFAULT_TEXT_STYLE.font,
    size: isFiniteNumber(size) ? clampSize(size) : DEFAULT_TEXT_STYLE.size,
    color: typeof color === "string" && /^#[0-9a-f]{6}$/i.test(color) ? color.toLowerCase() : DEFAULT_TEXT_STYLE.color,
    bold: v["bold"] === true,
    italic: v["italic"] === true,
    align: typeof align === "string" && ALIGNS.has(align) ? (align as TextAlign) : DEFAULT_TEXT_STYLE.align,
  };
  const lineHeight = v["lineHeight"];
  if (isFiniteNumber(lineHeight) && lineHeight > 0) data.lineHeight = Math.min(10, lineHeight);
  return data;
}

/**
 * Stable-key-order plain object for the manifest.
 * @param data - Text data.
 * @returns JSON-ready record.
 */
export function serializeTextData(data: TextData): Record<string, unknown> {
  const out: Record<string, unknown> = {
    text: data.text,
    x: data.x,
    y: data.y,
    font: data.font,
    size: data.size,
    color: data.color,
    bold: data.bold,
    italic: data.italic,
    align: data.align,
  };
  if (data.lineHeight !== undefined) out["lineHeight"] = data.lineHeight;
  return out;
}

/**
 * Whether two text data values render identically.
 * @param a - First.
 * @param b - Second.
 * @returns `true` if every field matches.
 */
export function sameTextData(a: Readonly<TextData>, b: Readonly<TextData>): boolean {
  return (
    a.text === b.text &&
    a.x === b.x &&
    a.y === b.y &&
    a.font === b.font &&
    a.size === b.size &&
    a.color === b.color &&
    a.bold === b.bold &&
    a.italic === b.italic &&
    a.align === b.align &&
    (a.lineHeight ?? DEFAULT_LINE_HEIGHT) === (b.lineHeight ?? DEFAULT_LINE_HEIGHT)
  );
}

/**
 * Trim a font name typed by the user (whitespace collapsed, length capped).
 * @param font - Raw name.
 * @returns Clean name (may be empty).
 */
export function cleanFontName(font: string): string {
  return font.replace(/\s+/g, " ").trim().slice(0, MAX_FONT_LENGTH);
}

/**
 * Clamp a font size to the supported range.
 * @param size - Document px.
 * @returns Clamped size.
 */
export function clampSize(size: number): number {
  return Math.min(MAX_TEXT_SIZE, Math.max(MIN_TEXT_SIZE, size));
}

// ── Naming ────────────────────────────────────────────────────────────────────

/** Characters of the text used for an automatic layer name. */
export const TEXT_NAME_LENGTH = 20;

/** Name of a text layer whose text is still empty. */
export const EMPTY_TEXT_NAME = "Text";

/**
 * Automatic layer name for a text: its first ~20 characters, whitespace
 * (incl. line breaks) collapsed, "..." when cut.
 * @param text - Layer text.
 * @returns Name (`"Text"` for blank text).
 */
export function nameFromText(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return EMPTY_TEXT_NAME;
  const chars = [...flat];
  if (chars.length <= TEXT_NAME_LENGTH) return flat;
  return `${chars.slice(0, TEXT_NAME_LENGTH).join("").trimEnd()}\u2026`;
}

/**
 * Name a text layer gets on commit: follows the text unless the user renamed
 * it (i.e. its name is no longer the automatic name of the previous text).
 * @param currentName - Layer name now.
 * @param previousText - Text before the edit.
 * @param nextText - Committed text.
 * @returns Name to store.
 */
export function commitName(currentName: string, previousText: string, nextText: string): string {
  return currentName === nameFromText(previousText) ? nameFromText(nextText) : currentName;
}

// ── Recent fonts ──────────────────────────────────────────────────────────────

/** Recent fonts kept (localStorage `PainterSketch.recentFonts`). */
export const MAX_RECENT_FONTS = 5;

/**
 * Move a font to the front of a recent list (deduplicated, case-insensitive).
 * @param list - Current list, newest first.
 * @param font - Font just used.
 * @param max - Length cap.
 * @returns New list.
 */
export function pushRecentFont(list: readonly string[], font: string, max = MAX_RECENT_FONTS): string[] {
  const clean = cleanFontName(font);
  if (!clean) return [...list];
  const key = clean.toLowerCase();
  return [clean, ...list.filter((f) => f.toLowerCase() !== key)].slice(0, max);
}

/**
 * Parse a stored recent-font list.
 * @param raw - `localStorage` value.
 * @returns Valid names, newest first.
 */
export function parseRecentFonts(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    let out: string[] = [];
    for (const entry of [...value].reverse()) if (typeof entry === "string") out = pushRecentFont(out, entry);
    return out;
  } catch {
    return [];
  }
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
