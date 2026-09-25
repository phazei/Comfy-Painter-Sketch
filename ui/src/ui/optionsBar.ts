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

/** Mask state shown in the strip. */
export interface MaskIndicator {
  /** Strokes go to the mask (Quick Mask on). */
  targeting: boolean;
  /** Mask display colour. */
  color: string;
  /** Mask layer visible (a missing mask layer counts as visible). */
  visible: boolean;
}

const EYE_OPEN = "M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6";
const EYE_CLOSED = `${EYE_OPEN}M4 4l16 16`;

/**
 * Options strip bound to one `PaintOptions` object at a time, plus the mask
 * indicator ("Mask" badge while Quick Mask is on) and mask visibility toggle.
 */
export class OptionsBar {
  readonly element: HTMLDivElement;
  private options: PaintOptions | null = null;
  private readonly ranges = new Map<NumberField["key"], { input: HTMLInputElement; value: HTMLSpanElement }>();
  private readonly color: HTMLInputElement;
  private readonly colorWrap: HTMLLabelElement;
  private readonly pressureSize: HTMLInputElement;
  private readonly pressureOpacity: HTMLInputElement;
  private readonly maskBadge: HTMLSpanElement;
  private readonly maskEye: HTMLButtonElement;
  private readonly maskEyePath: SVGPathElement;
  private maskTargeting = false;

  /**
   * @param onChange - Called after the user edits an option.
   * @param onToggleMaskVisible - Eye button clicked.
   */
  constructor(
    private readonly onChange: () => void,
    onToggleMaskVisible: () => void,
  ) {
    this.element = document.createElement("div");
    this.element.className = "cps-options";

    this.maskBadge = document.createElement("span");
    this.maskBadge.className = "cps-mask-badge";
    this.maskBadge.textContent = "Mask";
    this.maskBadge.title = "Quick Mask: strokes paint the mask (Q to exit)";
    this.maskBadge.hidden = true;
    this.maskEye = document.createElement("button");
    this.maskEye.type = "button";
    this.maskEye.className = "cps-mask-eye";
    this.maskEye.addEventListener("click", onToggleMaskVisible);
    const svgNs = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(svgNs, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    this.maskEyePath = document.createElementNS(svgNs, "path");
    svg.appendChild(this.maskEyePath);
    this.maskEye.appendChild(svg);
    this.element.append(this.maskBadge, this.maskEye);

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
    // Colour is irrelevant while painting the mask.
    this.colorWrap.hidden = options.color === undefined || this.maskTargeting;
    if (options.color !== undefined) this.color.value = options.color;
    this.pressureSize.checked = options.pressureSize;
    this.pressureOpacity.checked = options.pressureOpacity;
  }

  /**
   * Update the mask badge and eye button.
   * @param state - Current mask state.
   */
  setMask(state: MaskIndicator): void {
    this.maskTargeting = state.targeting;
    this.maskBadge.hidden = !state.targeting;
    this.maskBadge.style.backgroundColor = state.color;
    this.maskEyePath.setAttribute("d", state.visible ? EYE_OPEN : EYE_CLOSED);
    this.maskEye.classList.toggle("cps-off", !state.visible);
    this.maskEye.style.color = state.visible ? state.color : "";
    this.maskEye.title = state.visible
      ? "Hide mask (also excludes it from the MASK output)"
      : "Show mask (hidden masks are excluded from the MASK output)";
    this.maskEye.setAttribute("aria-pressed", String(state.visible));
    this.refresh();
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
