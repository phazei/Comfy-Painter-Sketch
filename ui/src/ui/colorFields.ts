/**
 * Value row of the colour picker (`colorPicker.ts`, SPEC "Colour"): the
 * current colour as Hex, RGB, HSV or HSL in editable fields, with a format
 * button at the right that cycles the four. The format is remembered per
 * browser (`localStorage["PainterSketch.colorFormat"]`).
 *
 * Typing applies as soon as the fields parse; an unparsable field is marked
 * and the colour stays. Enter applies and leaves the field; Esc applies and
 * lets the popover close. ArrowUp / ArrowDown step a number field by 1
 * (Shift: 10). Leaving the row rewrites the fields from the colour.
 */

import { normalizeHex } from "../engine/colors";
import { hexToHsv, hslToHsv, hsvToHex, hsvToHsl, hsvToRgb, rgbToHsv, type Hsv } from "./colorMath";

/** Display format of the value row. */
export type ColorFormat = "hex" | "rgb" | "hsv" | "hsl";

/** Cycle order of the format button. */
export const COLOR_FORMATS: readonly ColorFormat[] = ["hex", "rgb", "hsv", "hsl"];

/** `localStorage` key of the chosen format. */
const FORMAT_KEY = "PainterSketch.colorFormat";

/** Field labels and maxima per numeric format. */
const CHANNELS: Readonly<Record<Exclude<ColorFormat, "hex">, ReadonlyArray<{ label: string; max: number }>>> = {
  rgb: [{ label: "R", max: 255 }, { label: "G", max: 255 }, { label: "B", max: 255 }],
  hsv: [{ label: "H", max: 360 }, { label: "S", max: 100 }, { label: "V", max: 100 }],
  hsl: [{ label: "H", max: 360 }, { label: "S", max: 100 }, { label: "L", max: 100 }],
};

// ═══════════════════════════════════════════════════════════════════════════
// Pure formatting / parsing
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Field texts of a colour in a format.
 * @param hsv - Colour.
 * @param format - Format.
 * @returns One string (hex, without `#`, upper case) or three numbers.
 */
export function formatColor(hsv: Hsv, format: ColorFormat): string[] {
  switch (format) {
    case "hex":
      return [hsvToHex(hsv).slice(1).toUpperCase()];
    case "rgb": {
      const { r, g, b } = hsvToRgb(hsv);
      return [r, g, b].map(String);
    }
    case "hsv":
      return [Math.round(hsv.h) % 360, Math.round(hsv.s * 100), Math.round(hsv.v * 100)].map(String);
    case "hsl": {
      const hsl = hsvToHsl(hsv);
      return [Math.round(hsl.h) % 360, Math.round(hsl.s * 100), Math.round(hsl.l * 100)].map(String);
    }
  }
}

/**
 * Parse field texts back to a colour. Greys keep `current`'s hue so the
 * triangle doesn't jump to red.
 * @param values - Field texts (one for hex, three otherwise).
 * @param format - Format.
 * @param current - The colour before the edit.
 * @returns The colour, or `null` if a field doesn't parse / is out of range.
 */
export function parseColor(values: readonly string[], format: ColorFormat, current: Hsv): Hsv | null {
  if (format === "hex") {
    const hex = normalizeHex(values[0] ?? "");
    const hsv = hex ? hexToHsv(hex) : null;
    return hsv ? keepHue(hsv, current) : null;
  }
  const channels = CHANNELS[format];
  const nums: number[] = [];
  for (let i = 0; i < channels.length; i++) {
    const text = (values[i] ?? "").trim();
    const value = Number(text);
    const max = channels[i]?.max ?? 0;
    if (text === "" || !Number.isFinite(value) || value < 0 || value > max) return null;
    nums.push(value);
  }
  const [a = 0, b = 0, c = 0] = nums;
  if (format === "rgb") return keepHue(rgbToHsv({ r: a, g: b, b: c }), current);
  if (format === "hsv") return { h: a % 360, s: b / 100, v: c / 100 };
  return hslToHsv({ h: a % 360, s: b / 100, l: c / 100 });
}

/**
 * Narrow a stored value to a format.
 * @param raw - Stored string.
 * @returns The format, or hex.
 */
export function parseFormat(raw: string | null): ColorFormat {
  return COLOR_FORMATS.find((f) => f === raw) ?? "hex";
}

function keepHue(hsv: Hsv, current: Hsv): Hsv {
  return hsv.s === 0 || hsv.v === 0 ? { ...hsv, h: current.h } : hsv;
}

// ═══════════════════════════════════════════════════════════════════════════
// Component
// ═══════════════════════════════════════════════════════════════════════════

/** Handle of the value row. */
export interface ColorFields {
  /** Row element (`.cps-picker-fields`). */
  readonly element: HTMLElement;
  /** Rewrite the fields from the current colour (a change from elsewhere). */
  sync(): void;
}

/**
 * Build the value row.
 * @param getHsv - Current colour.
 * @param onChange - A field edit produced a colour (the row is not re-synced).
 * @returns The row's handle.
 */
export function createColorFields(getHsv: () => Hsv, onChange: (hsv: Hsv) => void): ColorFields {
  const element = document.createElement("div");
  element.className = "cps-picker-fields";
  const inputsEl = document.createElement("div");
  inputsEl.className = "cps-picker-inputs";
  const formatButton = document.createElement("button");
  formatButton.type = "button";
  formatButton.className = "cps-picker-format";
  element.append(inputsEl, formatButton);

  let format = loadFormat();
  let inputs: HTMLInputElement[] = [];

  const apply = (): void => {
    const next = parseColor(
      inputs.map((input) => input.value),
      format,
      getHsv(),
    );
    for (const input of inputs) input.classList.toggle("cps-invalid", next === null);
    if (next) onChange(next);
  };

  const sync = (): void => {
    const texts = formatColor(getHsv(), format);
    inputs.forEach((input, i) => {
      input.value = texts[i] ?? "";
      input.classList.remove("cps-invalid");
    });
  };

  const build = (): void => {
    inputsEl.textContent = "";
    inputsEl.dataset["format"] = format;
    const cells = format === "hex" ? [{ label: "#", max: 0 }] : CHANNELS[format];
    inputs = cells.map((cell) => {
      const label = document.createElement("label");
      label.className = "cps-picker-field";
      const tag = document.createElement("span");
      tag.className = "cps-picker-field-label";
      tag.textContent = cell.label;
      const input = document.createElement("input");
      input.type = "text";
      input.className = "cps-picker-input";
      input.spellcheck = false;
      input.autocomplete = "off";
      if (format === "hex") input.maxLength = 7;
      else input.inputMode = "numeric";
      input.addEventListener("input", apply);
      input.addEventListener("keydown", (event) => keydown(event, input, cell.max));
      label.append(tag, input);
      inputsEl.appendChild(label);
      return input;
    });
    const next = COLOR_FORMATS[(COLOR_FORMATS.indexOf(format) + 1) % COLOR_FORMATS.length] ?? "hex";
    formatButton.textContent = format.toUpperCase();
    formatButton.title = `Show as ${next.toUpperCase()}`;
    sync();
  };

  const keydown = (event: KeyboardEvent, input: HTMLInputElement, max: number): void => {
    if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      apply();
      input.blur();
    } else if (event.key === "Escape") {
      // Apply what was typed; the popover closes (and commits) on the bubble.
      apply();
    } else if ((event.key === "ArrowUp" || event.key === "ArrowDown") && format !== "hex") {
      event.preventDefault();
      const step = (event.shiftKey ? 10 : 1) * (event.key === "ArrowUp" ? 1 : -1);
      const value = Math.round(Number(input.value) || 0) + step;
      input.value = String(Math.max(0, Math.min(max, value)));
      apply();
    }
  };

  // Leaving the row: show the colour as it is (normalises half-typed values).
  element.addEventListener("focusout", (event) => {
    if (!(event.relatedTarget instanceof Node && element.contains(event.relatedTarget))) sync();
  });

  formatButton.addEventListener("click", () => {
    format = COLOR_FORMATS[(COLOR_FORMATS.indexOf(format) + 1) % COLOR_FORMATS.length] ?? "hex";
    saveFormat(format);
    build();
  });

  build();
  return { element, sync };
}

// ── Storage ───────────────────────────────────────────────────────────────────

function loadFormat(): ColorFormat {
  try {
    return parseFormat(window.localStorage.getItem(FORMAT_KEY));
  } catch {
    return "hex";
  }
}

function saveFormat(format: ColorFormat): void {
  try {
    window.localStorage.setItem(FORMAT_KEY, format);
  } catch {
    // Storage blocked: the format lasts until the picker closes.
  }
}
