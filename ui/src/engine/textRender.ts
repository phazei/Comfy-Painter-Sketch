/**
 * Text rendering for text layers (SPEC M6b): canvas 2D `font` strings,
 * multi-line layout with alignment, and drawing into a layer canvas.
 *
 * - {@link layoutText} is pure (the text measurer is injected), so line
 *   placement, the edit box and the ink bbox are unit-testable.
 * - Vertical metrics follow CSS: every line box is `lineHeight` tall and its
 *   baseline sits `halfLeading + fontAscent` below the box top, so the
 *   `<textarea>` overlay (`ui/textOverlay.ts`, same font string and line
 *   height) puts its caret exactly over the canvas glyphs.
 * - {@link textLayout} caches layouts per `TextData` object (text data is
 *   immutable, see `document/textData.ts`).
 *
 * Anchor: `(x, y)` = first line's baseline at its left / centre / right edge.
 */

import { DEFAULT_LINE_HEIGHT } from "../document/textData";
import type { TextData } from "../document/textData";
import { roundOutRect, unionRect } from "../geometry/rect";
import type { Point, Rect } from "../geometry/rect";

// ── Types ─────────────────────────────────────────────────────────────────────

/** Metrics of one measured line (canvas `TextMetrics` subset), px. */
export interface LineMetrics {
  /** Advance width. */
  width: number;
  /** Ink extent left of the pen position (`actualBoundingBoxLeft`). */
  left: number;
  /** Ink extent right of the pen position (`actualBoundingBoxRight`). */
  right: number;
  /** Ink above / below the baseline. */
  ascent: number;
  descent: number;
  /** Font (not ink) ascent / descent: the CSS line-box metrics. */
  fontAscent: number;
  fontDescent: number;
}

/** Measures one line in the layout's font. */
export type MeasureText = (line: string) => LineMetrics;

/** One placed line. */
export interface LaidOutLine {
  text: string;
  /** Pen x (left edge of the advance box), document px. */
  x: number;
  /** Baseline y, document px. */
  baseline: number;
  width: number;
}

/** Result of {@link layoutText}. */
export interface TextLayout {
  lines: LaidOutLine[];
  /** Line box height, document px. */
  lineHeight: number;
  /** Edit box (all line boxes, widest line), document px: the textarea and hit area. */
  box: Rect;
  /** Integer rect covering every painted pixel (ink + advance boxes, padded). */
  bbox: Rect;
}

/** CSS generic families (never quoted, always "available"). */
const GENERIC_FAMILIES: ReadonlySet<string> = new Set([
  "serif",
  "sans-serif",
  "monospace",
  "cursive",
  "fantasy",
  "system-ui",
  "ui-serif",
  "ui-sans-serif",
  "ui-monospace",
  "ui-rounded",
  "math",
  "emoji",
]);

/** Anti-aliasing margin around the ink bbox, px. */
const INK_PAD = 2;

// ── Font strings ──────────────────────────────────────────────────────────────

/**
 * Whether a font name is a CSS generic family.
 * @param font - Family name.
 * @returns `true` for `sans-serif`, `serif`, `monospace`, ...
 */
export function isGenericFamily(font: string): boolean {
  return GENERIC_FAMILIES.has(font.trim().toLowerCase());
}

/**
 * CSS `font-family` value: generic families bare, named families quoted
 * (quotes/backslashes escaped) with a `sans-serif` fallback, so any typed
 * name gives a valid font string.
 * @param font - Family name.
 * @returns Font family list.
 */
export function cssFontFamily(font: string): string {
  const name = font.trim();
  if (!name) return "sans-serif";
  if (isGenericFamily(name)) return name.toLowerCase();
  return `"${name.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}", sans-serif`;
}

/**
 * Canvas / CSS `font` shorthand for text data (size in document px).
 * @param td - Font fields.
 * @returns E.g. `italic bold 48px "Georgia", sans-serif`.
 */
export function fontString(td: Pick<TextData, "font" | "size" | "bold" | "italic">): string {
  const style = td.italic ? "italic " : "";
  const weight = td.bold ? "bold " : "";
  return `${style}${weight}${roundPx(td.size)}px ${cssFontFamily(td.font)}`;
}

/**
 * Line box height of text data, document px.
 * @param td - Size and line spacing.
 * @returns Height.
 */
export function lineHeightPx(td: Pick<TextData, "size" | "lineHeight">): number {
  return td.size * (td.lineHeight ?? DEFAULT_LINE_HEIGHT);
}

/**
 * Whether a font can be used as named (`document.fonts.check`); generic
 * families always can. Without the Font Loading API the answer is "yes".
 * @param font - Family name.
 * @returns `false` when the browser reports the font as unavailable.
 */
export function isFontAvailable(font: string): boolean {
  if (!font.trim() || isGenericFamily(font)) return true;
  const fonts = typeof document !== "undefined" ? document.fonts : undefined;
  if (!fonts || typeof fonts.check !== "function") return true;
  try {
    return fonts.check(`12px ${cssFontFamily(font).replace(/, sans-serif$/, "")}`);
  } catch {
    return true;
  }
}

// ── Layout (pure) ─────────────────────────────────────────────────────────────

/**
 * Place the lines of a text.
 * @param td - Text data.
 * @param measure - Line measurer in `td`'s font.
 * @returns Lines, edit box and ink bbox in document coords.
 */
export function layoutText(td: Readonly<TextData>, measure: MeasureText): TextLayout {
  const lineHeight = lineHeightPx(td);
  const texts = td.text.split("\n");
  const metrics = texts.map((t) => measure(t));
  const first = metrics[0] ?? measure("");
  const fontAscent = first.fontAscent;
  const halfLeading = (lineHeight - (fontAscent + first.fontDescent)) / 2;
  const maxWidth = Math.max(0, ...metrics.map((m) => m.width));
  const lines: LaidOutLine[] = [];
  let ink: Rect | null = null;
  for (let i = 0; i < texts.length; i++) {
    const text = texts[i] ?? "";
    const m = metrics[i] ?? first;
    const baseline = td.y + i * lineHeight;
    const x = alignedX(td, m.width);
    lines.push({ text, x, baseline, width: m.width });
    if (!text) continue;
    const left = Math.min(x, x - m.left);
    const right = Math.max(x + m.width, x + m.right);
    const top = baseline - Math.max(m.ascent, m.fontAscent);
    const bottom = baseline + Math.max(m.descent, m.fontDescent);
    const r = { x: left, y: top, width: right - left, height: bottom - top };
    ink = ink ? unionRect(ink, r) : r;
  }
  const box: Rect = {
    x: alignedX(td, maxWidth),
    y: td.y - halfLeading - fontAscent,
    width: maxWidth,
    height: lineHeight * texts.length,
  };
  const inkRect: Rect = ink ?? { x: box.x, y: box.y, width: 0, height: 0 };
  const bbox =
    inkRect.width > 0 && inkRect.height > 0
      ? roundOutRect({
          x: inkRect.x - INK_PAD,
          y: inkRect.y - INK_PAD,
          width: inkRect.width + INK_PAD * 2,
          height: inkRect.height + INK_PAD * 2,
        })
      : { x: Math.floor(box.x), y: Math.floor(box.y), width: 0, height: 0 };
  return { lines, lineHeight, box, bbox };
}

/** Pen x of a line of `width` for the anchor + alignment. */
function alignedX(td: Pick<TextData, "x" | "align">, width: number): number {
  if (td.align === "center") return td.x - width / 2;
  if (td.align === "right") return td.x - width;
  return td.x;
}

// ── Canvas ────────────────────────────────────────────────────────────────────

let scratch: CanvasRenderingContext2D | null = null;

/** Shared measuring context. */
function measureContext(): CanvasRenderingContext2D | null {
  if (!scratch && typeof document !== "undefined") scratch = document.createElement("canvas").getContext("2d");
  return scratch;
}

/**
 * Canvas-backed measurer for a text's font.
 * @param td - Font fields.
 * @returns Measurer (a size-proportional estimate without a canvas).
 */
export function canvasMeasure(td: Pick<TextData, "font" | "size" | "bold" | "italic">): MeasureText {
  const ctx = measureContext();
  const size = td.size;
  if (!ctx) {
    return (line) => {
      const width = line.length * size * 0.55;
      return { width, left: 0, right: width, ascent: size * 0.8, descent: size * 0.2, fontAscent: size * 0.9, fontDescent: size * 0.25 };
    };
  }
  const font = fontString(td);
  return (line) => {
    ctx.font = font;
    const m = ctx.measureText(line);
    // Font-box metrics are per font; measure a probe so empty lines have them too.
    const probe = line ? m : ctx.measureText("Hg");
    return {
      width: m.width,
      left: m.actualBoundingBoxLeft ?? 0,
      right: m.actualBoundingBoxRight ?? m.width,
      ascent: m.actualBoundingBoxAscent ?? size * 0.8,
      descent: m.actualBoundingBoxDescent ?? size * 0.2,
      fontAscent: probe.fontBoundingBoxAscent ?? size * 0.9,
      fontDescent: probe.fontBoundingBoxDescent ?? size * 0.25,
    };
  };
}

const layoutCache = new WeakMap<Readonly<TextData>, TextLayout>();

/**
 * Layout of text data measured on a canvas (cached per `TextData` object).
 * @param td - Text data (immutable).
 * @returns Layout.
 */
export function textLayout(td: Readonly<TextData>): TextLayout {
  let layout = layoutCache.get(td);
  if (!layout) {
    layout = layoutText(td, canvasMeasure(td));
    layoutCache.set(td, layout);
  }
  return layout;
}

/**
 * Draw text (anti-aliased, straight source-over) into a context whose pixel
 * (0, 0) is document point `origin`.
 * @param ctx - Target context (a layer canvas).
 * @param td - Text data.
 * @param origin - Document position of the canvas's top-left pixel.
 * @returns The painted area, document coords (integer rect).
 */
export function drawText(ctx: CanvasRenderingContext2D, td: Readonly<TextData>, origin: Point): Rect {
  const layout = textLayout(td);
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  ctx.font = fontString(td);
  ctx.fillStyle = td.color;
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  for (const line of layout.lines) {
    if (line.text) ctx.fillText(line.text, line.x - origin.x, line.baseline - origin.y);
  }
  ctx.restore();
  return layout.bbox;
}

/** Font sizes are kept to 1/100 px in the font string. */
function roundPx(size: number): number {
  return Math.round(size * 100) / 100;
}
