/**
 * Colour picker popover (SPEC "Colour").
 *
 * Usage: call {@link openColorPicker} with a {@link PopoverHost} and options;
 * it opens a popover and returns the {@link PopoverHandle}.
 *
 * Layout (wheel box {@link WHEEL_SIZE} px wide):
 * - Optional title.
 * - Colour wheel (`colorWheel.ts`): hue ring around a fixed saturation/value
 *   triangle; the new (top) / original (bottom, click reverts) swatch in the
 *   left gap; three harmony circles (partner, current, partner) in the
 *   top-right gap; the harmony button (Analogous / Triadic /
 *   Split-complementary) in the top-right corner.
 * - Value row (`colorFields.ts`): Hex / RGB / HSV / HSL fields and the format
 *   button.
 * - Up to 10 recent colours (`recentColors.ts`).
 *
 * Keyboard:
 * - Esc closes and keeps the current colour (same as clicking outside); it
 *   never reverts. Only the swatch's original half reverts.
 * - Enter in a field applies the value; the picker stays open.
 * - Typing in the fields does NOT trigger editor shortcuts (keyboard.ts
 *   recognises `<input type=text>` as a text field and lets keys through).
 *
 * Clicking the same swatch again closes the picker; another swatch (FG vs BG)
 * switches to a picker for it. A press on the stage that closes the picker
 * does not paint (`popover.ts`).
 *
 * Every close commits (click outside, Esc, programmatic close): `onCommit`
 * runs if the colour changed, then `onClose`.
 *
 * Pointer / wheel events inside stay inside: the popover is inside the editor
 * root whose isolation guard already stops propagation to the graph.
 */

import type { PopoverHandle, PopoverHost, PopoverOptions } from "./popover";
import { hexToHsv, hsvToHex, type Hsv } from "./colorMath";
import { createColorFields } from "./colorFields";
import { createColorWheel } from "./colorWheel";
import { WHEEL_SIZE } from "./colorWheelGeometry";
import { renderRecentColors, saveRecentColor } from "./recentColors";
import { normalizeHex } from "../engine/colors";

export { getRecentColors } from "./recentColors";

/** First-time hue for black, white and greys (purple; they have no hue). */
export const GREY_HUE = 260;

/** `localStorage` key of the last hue a picker closed with. */
const LAST_HUE_KEY = "PainterSketch.colorLastHue";

/**
 * Hue a picker opened on black, white or a grey starts with: the hue the
 * last picker closed with (any picker), else {@link GREY_HUE}.
 * @returns Hue in [0, 360).
 */
function lastHue(): number {
  try {
    const value = Number(window.localStorage.getItem(LAST_HUE_KEY) ?? Number.NaN);
    return Number.isFinite(value) && value >= 0 && value < 360 ? value : GREY_HUE;
  } catch {
    return GREY_HUE;
  }
}

/** Remember the hue a picker closed with. */
function saveLastHue(hue: number): void {
  try {
    window.localStorage.setItem(LAST_HUE_KEY, String(Math.round(hue * 100) / 100));
  } catch {
    // Storage blocked: greys open at the default hue.
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

/** Options for {@link openColorPicker}. */
export interface ColorPickerOptions {
  /** Starting colour (`#rrggbb`). */
  initial: string;
  /** Optional title shown above the picker. */
  title?: string;
  /**
   * Called while the user drags / types – live preview.
   * @param hex - Current colour.
   */
  onInput: (hex: string) => void;
  /**
   * Called once when the picker closes with a changed colour (click outside,
   * Esc, or programmatic close). Optional.
   * @param hex - Committed colour.
   */
  onCommit?: (hex: string) => void;
  /** Called on every close, including an unchanged colour (metadata transactions). */
  onClose?: () => void;
  /**
   * Follow changes made elsewhere (the eyedropper) while open: called on
   * open with a listener for the new colour; returns the unsubscribe.
   */
  follow?: (onExternal: (hex: string) => void) => () => void;
  /** Stage presses that keep the picker open (see {@link PopoverOptions.keepOpenOn}). */
  keepOpenOn?: PopoverOptions["keepOpenOn"];
}

/**
 * Open the colour picker popover.
 * @param host    - The popover host of the editor where the picker should appear.
 * @param anchor  - Element to attach the popover to.
 * @param opts    - Initial colour, title, and live/commit callbacks.
 * @returns The {@link PopoverHandle} (call `.close()` to close
 *   programmatically), or `null` when a picker was already open for this
 *   anchor: a second click on a swatch closes its picker (committing).
 */
export function openColorPicker(host: PopoverHost, anchor: HTMLElement, opts: ColorPickerOptions): PopoverHandle | null {
  if (host.closeAnchoredAt(anchor)) return null;
  const initial = normalizeHex(opts.initial) ?? "#000000";
  // Black, white and greys have no hue (the conversion says 0 = red): start
  // the ring at the last hue used instead (first time: purple).
  const opened = hexToHsv(initial) ?? { h: 0, s: 0, v: 0 };
  let hsv: Hsv = opened.s === 0 ? { ...opened, h: lastHue() } : opened;
  let current = initial;

  /** Set the colour; `fromFields` skips rewriting the field being typed in. */
  const setHsv = (next: Hsv, fromFields = false): void => {
    hsv = next;
    current = hsvToHex(hsv);
    wheel.update();
    if (!fromFields) fields.sync();
    opts.onInput(current);
  };

  /** Set a hex colour (recents, revert); greys keep the current hue. */
  const setHex = (hex: string): void => {
    const next = hexToHsv(hex);
    if (!next) return;
    setHsv(next.s === 0 || next.v === 0 ? { ...next, h: hsv.h } : next);
  };

  // ── Build DOM ────────────────────────────────────────────────────────────

  const root = document.createElement("div");
  root.className = "cps-picker";
  root.style.width = `${WHEEL_SIZE}px`;

  if (opts.title) {
    const title = document.createElement("div");
    title.className = "cps-picker-title";
    title.textContent = opts.title;
    root.appendChild(title);
  }

  const wheel = createColorWheel({
    getHsv: () => hsv,
    original: initial,
    onChange: (next) => setHsv(next),
    onRevert: () => setHex(initial),
  });
  const fields = createColorFields(
    () => hsv,
    (next) => setHsv(next, true),
  );
  const recentsEl = document.createElement("div");
  recentsEl.className = "cps-picker-recents";

  root.append(wheel.element, fields.element, recentsEl);

  // The canvas needs a layout size: draw once the popover is in the DOM.
  requestAnimationFrame(() => {
    wheel.layout();
    fields.sync();
    renderRecentColors(recentsEl, setHex);
  });

  // External changes (eyedropper): show them, without echoing onInput.
  const unfollow = opts.follow?.((hex) => {
    const normalized = normalizeHex(hex);
    if (!normalized || normalized === current) return;
    const next = hexToHsv(normalized);
    if (!next) return;
    hsv = next.s === 0 || next.v === 0 ? { ...next, h: hsv.h } : next;
    current = normalized;
    wheel.update();
    fields.sync();
  });

  // ── Open the popover ──────────────────────────────────────────────────────
  // Esc is handled by the popover element (closes); every close commits.

  return host.open(root, {
    anchor,
    placement: "below",
    ...(opts.keepOpenOn ? { keepOpenOn: opts.keepOpenOn } : {}),
    onClose: () => {
      unfollow?.();
      saveLastHue(hsv.h);
      if (current !== initial) {
        saveRecentColor(current);
        opts.onCommit?.(current);
      }
      opts.onClose?.();
    },
  });
}
