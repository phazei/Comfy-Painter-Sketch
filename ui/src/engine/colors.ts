/**
 * Foreground / background colour state (SPEC "Color"): the brush paints the
 * foreground; `X` swaps, `D` resets to black/white. Session-scoped UI state,
 * never saved in the document. Colours are normalized `#rrggbb`.
 */

import { Emitter } from "./emitter";

/** Which swatch. */
export type ColorSlot = "fg" | "bg";

/** Current colours. */
export interface ColorPair {
  fg: string;
  bg: string;
}

/** Colour state events. */
export interface ColorEvents {
  [key: string]: unknown;
  /** Either colour changed. */
  change: Readonly<ColorPair>;
}

/** Photoshop defaults (`D`). */
export const DEFAULT_COLORS: Readonly<ColorPair> = { fg: "#000000", bg: "#ffffff" };

/**
 * Normalize a CSS hex colour to lowercase `#rrggbb`.
 * @param value - `#rgb`, `#rrggbb` (with or without `#`), any case.
 * @returns Normalized colour, or `null` if not a valid hex colour.
 */
export function normalizeHex(value: string): string | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim());
  const hex = m?.[1];
  if (!hex) return null;
  const full = hex.length === 3 ? [...hex].map((c) => c + c).join("") : hex;
  return `#${full.toLowerCase()}`;
}

/**
 * FG/BG colours with change events.
 */
export class ColorState {
  readonly events = new Emitter<ColorEvents>();
  private pair: ColorPair;

  /**
   * @param initial - Starting colours (defaults to black/white).
   */
  constructor(initial: Readonly<ColorPair> = DEFAULT_COLORS) {
    this.pair = { fg: normalizeHex(initial.fg) ?? DEFAULT_COLORS.fg, bg: normalizeHex(initial.bg) ?? DEFAULT_COLORS.bg };
  }

  /** Foreground colour (`#rrggbb`). */
  get fg(): string {
    return this.pair.fg;
  }

  /** Background colour (`#rrggbb`). */
  get bg(): string {
    return this.pair.bg;
  }

  /** Both colours (copy). */
  get current(): ColorPair {
    return { ...this.pair };
  }

  /**
   * Set one colour; invalid values are ignored.
   * @param slot - Foreground or background.
   * @param value - Hex colour.
   */
  set(slot: ColorSlot, value: string): void {
    const hex = normalizeHex(value);
    if (!hex || hex === this.pair[slot]) return;
    this.pair = { ...this.pair, [slot]: hex };
    this.emit();
  }

  /** Swap foreground and background (`X`). */
  swap(): void {
    if (this.pair.fg === this.pair.bg) return;
    this.pair = { fg: this.pair.bg, bg: this.pair.fg };
    this.emit();
  }

  /** Reset to black foreground, white background (`D`). */
  reset(): void {
    if (this.pair.fg === DEFAULT_COLORS.fg && this.pair.bg === DEFAULT_COLORS.bg) return;
    this.pair = { ...DEFAULT_COLORS };
    this.emit();
  }

  private emit(): void {
    this.events.emit("change", { ...this.pair });
  }
}
