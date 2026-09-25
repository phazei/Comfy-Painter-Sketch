/**
 * Tiny options strip for the active paint tool: size, hardness, opacity,
 * flow, colour (native picker), pressure -> size / opacity toggles.
 * Deliberately minimal and replaceable (M3 builds the real options bar).
 */

import type { PaintOptions } from "../tools/types";

/** Numeric option descriptors: key, label, range, display scale. */
interface NumberField {
  key: "size" | "hardness" | "opacity" | "flow";
  label: string;
  min: number;
  max: number;
  /** UI value = option value * scale. */
  scale: number;
}

const NUMBER_FIELDS: readonly NumberField[] = [
  { key: "size", label: "Size", min: 1, max: 500, scale: 1 },
  { key: "hardness", label: "Hard", min: 0, max: 100, scale: 100 },
  { key: "opacity", label: "Opac", min: 1, max: 100, scale: 100 },
  { key: "flow", label: "Flow", min: 1, max: 100, scale: 100 },
];

/**
 * Options strip bound to one `PaintOptions` object at a time.
 */
export class OptionsBar {
  readonly element: HTMLDivElement;
  private options: PaintOptions | null = null;
  private readonly ranges = new Map<NumberField["key"], { input: HTMLInputElement; value: HTMLSpanElement }>();
  private readonly color: HTMLInputElement;
  private readonly colorWrap: HTMLLabelElement;
  private readonly pressureSize: HTMLInputElement;
  private readonly pressureOpacity: HTMLInputElement;

  /**
   * @param onChange - Called after the user edits an option.
   */
  constructor(private readonly onChange: () => void) {
    this.element = document.createElement("div");
    this.element.className = "cps-options";

    for (const field of NUMBER_FIELDS) {
      const label = document.createElement("label");
      label.className = "cps-opt";
      label.title = field.label;
      const name = document.createElement("span");
      name.textContent = field.label;
      const input = document.createElement("input");
      input.type = "range";
      input.min = String(field.min);
      input.max = String(field.max);
      input.step = "1";
      const value = document.createElement("span");
      value.className = "cps-opt-value";
      input.addEventListener("input", () => {
        if (!this.options) return;
        this.options[field.key] = Number(input.value) / field.scale;
        value.textContent = input.value;
        this.onChange();
      });
      label.append(name, input, value);
      this.element.appendChild(label);
      this.ranges.set(field.key, { input, value });
    }

    this.colorWrap = document.createElement("label");
    this.colorWrap.className = "cps-opt";
    this.colorWrap.title = "Color";
    this.color = document.createElement("input");
    this.color.type = "color";
    this.color.className = "cps-color";
    this.color.addEventListener("input", () => {
      if (!this.options || this.options.color === undefined) return;
      this.options.color = this.color.value;
      this.onChange();
    });
    this.colorWrap.appendChild(this.color);
    this.element.appendChild(this.colorWrap);

    this.pressureSize = this.toggle("P\u2192size", "Pen pressure controls size", (v) => {
      if (this.options) this.options.pressureSize = v;
    });
    this.pressureOpacity = this.toggle("P\u2192opac", "Pen pressure controls opacity", (v) => {
      if (this.options) this.options.pressureOpacity = v;
    });
  }

  /**
   * Show options of a tool (or hide when `null`).
   * @param options - Options object (edited in place).
   */
  bind(options: PaintOptions | null): void {
    this.options = options;
    this.element.hidden = options === null;
    this.refresh();
  }

  /** Re-read values from the bound options (after shortcuts changed them). */
  refresh(): void {
    const options = this.options;
    if (!options) return;
    for (const field of NUMBER_FIELDS) {
      const entry = this.ranges.get(field.key);
      if (!entry) continue;
      const v = String(Math.round(options[field.key] * field.scale));
      entry.input.value = v;
      entry.value.textContent = v;
    }
    this.colorWrap.hidden = options.color === undefined;
    if (options.color !== undefined) this.color.value = options.color;
    this.pressureSize.checked = options.pressureSize;
    this.pressureOpacity.checked = options.pressureOpacity;
  }

  private toggle(text: string, title: string, apply: (value: boolean) => void): HTMLInputElement {
    const label = document.createElement("label");
    label.className = "cps-opt cps-opt-toggle";
    label.title = title;
    const input = document.createElement("input");
    input.type = "checkbox";
    input.addEventListener("change", () => {
      apply(input.checked);
      this.onChange();
    });
    const span = document.createElement("span");
    span.textContent = text;
    label.append(input, span);
    this.element.appendChild(label);
    return input;
  }
}
