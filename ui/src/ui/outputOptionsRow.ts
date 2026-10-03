/**
 * Options of an output card (Main or a region; SPEC "Outputs and regions
 * (editor)", design handoff "Card"), two lines:
 * 1. A 4-way segmented control `None | Fill | Crop | Border` (long names as
 *    tooltips) + an `Alpha` toggle pill (greyed and inert while Fill; its
 *    value is kept).
 * 2. Per-choice extras, only when there are any:
 *    - Fill: "Color" + swatch.
 *    - Crop: "Padding" + stepper (steps of 8, min 0).
 *    - Border: width stepper (±1 up to 8, then ±4; 1..MAX_BORDER_SIZE),
 *      colour swatch, "Mask border" pill.
 *    Stepper values are typeable fields ({@link outputField}).
 * Options apply on execution only; nothing changes on the stage.
 */

import { MAX_BORDER_SIZE } from "../document/outputOptions";
import type { OutputOptions } from "../document/types";
import type { Editor } from "../engine/editor";
import { openColorPicker } from "./colorPicker";
import { outputField } from "./outputField";
import type { OutputField } from "./outputField";
import type { PopoverHost } from "./popover";

/** Services shared by all output cards. */
export interface OutputCardContext {
  editor: Editor;
  popovers: PopoverHost;
  /** Called before an edit starts (cancels canvas drags). */
  beforeEdit(): void;
  /** Hand keyboard focus back to the editor after a field blurs. */
  releaseFocus(): void;
}

/** Mask mode segments: value, label, tooltip. */
const MODES: ReadonlyArray<readonly [OutputOptions["applyMask"], string, string]> = [
  ["none", "None", "None"],
  ["fill", "Fill", "Fill mask"],
  ["crop", "Crop", "Crop to mask"],
  ["border", "Border", "Add border"],
];

/** Tooltip of the Alpha pill. */
export const ALPHA_TITLE = "Output the image with the mask as transparency (RGBA). Some nodes use RGB only and drop it.";

/** Tooltip of the Alpha pill while Fill is chosen. */
export const ALPHA_FILL_TITLE = "Not available with Fill";

/** Crop padding stepper increment (output px). */
export const PADDING_STEP = 8;

// ── Pure stepping rules ───────────────────────────────────────────────────────

/**
 * Next crop padding for a stepper click.
 * @param value - Current padding.
 * @param direction - -1 (−) or 1 (+).
 * @returns Padding stepped by {@link PADDING_STEP}, never below 0.
 */
export function stepPadding(value: number, direction: -1 | 1): number {
  return Math.max(0, value + direction * PADDING_STEP);
}

/**
 * Next border width for a stepper click: ±1 up to 8, ±4 above.
 * @param value - Current width.
 * @param direction - -1 (−) or 1 (+).
 * @returns Width clamped to 1..MAX_BORDER_SIZE.
 */
export function stepBorderSize(value: number, direction: -1 | 1): number {
  const step = direction > 0 ? (value >= 8 ? 4 : 1) : (value > 8 ? 4 : 1);
  return Math.min(MAX_BORDER_SIZE, Math.max(1, value + direction * step));
}

// ── DOM helpers ───────────────────────────────────────────────────────────────

/**
 * Plain button with a click handler.
 * @param className - Class list.
 * @param text - Text content.
 * @param title - Tooltip / accessible name.
 * @param onClick - Handler.
 * @returns Button.
 */
function button(className: string, text: string, title: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = className;
  b.textContent = text;
  b.title = title;
  b.setAttribute("aria-label", title);
  b.addEventListener("click", (event) => {
    event.stopPropagation();
    onClick();
  });
  return b;
}

/**
 * Text label of the extras line.
 * @param text - Label text.
 * @returns Span.
 */
function lineLabel(text: string): HTMLSpanElement {
  const span = document.createElement("span");
  span.className = "cps-output-label";
  span.textContent = text;
  return span;
}

/** A − value + stepper around a typeable field. */
interface Stepper {
  element: HTMLSpanElement;
  dec: HTMLButtonElement;
  inc: HTMLButtonElement;
  field: OutputField;
}

// ═══════════════════════════════════════════════════════════════════════════
// OutputOptionsRow
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Mode line + extras line, refreshed in place.
 */
export class OutputOptionsRow {
  readonly element = document.createElement("div");
  /** Line 1: mode segments + Alpha pill. */
  private readonly mainLine = document.createElement("div");
  /** Line 2: Fill / Crop / Border extras; hidden for None. */
  private readonly extrasLine = document.createElement("div");
  private readonly modes = document.createElement("div");
  private readonly modeButtons = new Map<OutputOptions["applyMask"], HTMLButtonElement>();
  private readonly alpha: HTMLButtonElement;
  private readonly colorLabel = lineLabel("Color");
  private readonly paddingLabel = lineLabel("Padding");
  private readonly padding: Stepper;
  private readonly borderSize: Stepper;
  private readonly swatch = document.createElement("button");
  private readonly spacer = document.createElement("span");
  private readonly borderMask: HTMLButtonElement;

  /**
   * @param id - Region id, or null for Main.
   * @param ctx - Card services.
   */
  constructor(
    private readonly id: string | null,
    private readonly ctx: OutputCardContext,
  ) {
    const ops = ctx.editor.regionOps;
    this.element.className = "cps-output-options";

    this.modes.className = "cps-segmented cps-output-modes";
    for (const [value, label, title] of MODES) {
      const segment = button("", label, title, () => this.set({ applyMask: value }));
      this.modeButtons.set(value, segment);
      this.modes.append(segment);
    }

    this.alpha = button("cps-output-pill cps-output-alpha", "Alpha", ALPHA_TITLE, () => {
      const options = ops.options(id);
      if (options.applyMask === "fill") return;
      this.set({ alpha: options.alpha !== true });
    });

    this.padding = this.stepper({
      title: "Crop padding (output px)",
      bounds: () => ({ min: 0, max: Number.MAX_SAFE_INTEGER }),
      read: () => ops.options(id).cropPadding,
      write: (value) => ops.setOptions(id, { cropPadding: value }),
      step: (value, direction) => stepPadding(value, direction),
    });
    this.borderSize = this.stepper({
      title: "Border width",
      fieldTitle: `Border width per side (output px, 1..${MAX_BORDER_SIZE})`,
      bounds: () => ({ min: 1, max: MAX_BORDER_SIZE }),
      read: () => ops.options(id).borderSize,
      write: (value) => ops.setOptions(id, { borderSize: value }),
      step: (value, direction) => stepBorderSize(value, direction),
    });

    this.swatch.type = "button";
    this.swatch.className = "cps-output-swatch";
    this.swatch.addEventListener("click", (event) => {
      event.stopPropagation();
      this.pickColor();
    });
    this.spacer.className = "cps-output-spacer";
    this.paddingLabel.classList.add("cps-output-grow");
    this.borderMask = button("cps-output-pill cps-output-mask-border", "Mask border",
      "Border area white in the MASK (for outpainting)",
      () => this.set({ borderMask: !ops.options(id).borderMask }));

    this.mainLine.className = "cps-output-options-line";
    this.extrasLine.className = "cps-output-options-line cps-output-extras";
    this.mainLine.append(this.modes, this.alpha);
    this.extrasLine.append(
      this.colorLabel, this.paddingLabel, this.padding.element, this.borderSize.element,
      this.swatch, this.spacer, this.borderMask,
    );
    this.element.append(this.mainLine, this.extrasLine);
    this.refresh();
  }

  /** Show the current options (fields being edited keep their text). */
  refresh(): void {
    const options = this.ctx.editor.regionOps.options(this.id);
    const mode = options.applyMask;
    for (const [value, segment] of this.modeButtons) {
      segment.classList.toggle("cps-active", value === mode);
      segment.setAttribute("aria-pressed", String(value === mode));
    }
    const fill = mode === "fill";
    const crop = mode === "crop";
    const border = mode === "border";

    // Fill and alpha cancel out: greyed and inert, the saved value is kept.
    const alphaOn = options.alpha === true;
    this.alpha.classList.toggle("cps-active", alphaOn && !fill);
    this.alpha.classList.toggle("cps-disabled", fill);
    this.alpha.setAttribute("aria-pressed", String(alphaOn));
    this.alpha.setAttribute("aria-disabled", String(fill));
    this.alpha.title = fill ? ALPHA_FILL_TITLE : ALPHA_TITLE;

    this.extrasLine.hidden = !fill && !crop && !border;
    this.colorLabel.hidden = !fill;
    this.paddingLabel.hidden = !crop;
    this.padding.element.hidden = !crop;
    this.borderSize.element.hidden = !border;
    this.swatch.hidden = !fill && !border;
    this.spacer.hidden = !border;
    this.borderMask.hidden = !border;

    this.swatch.style.backgroundColor = border ? options.borderColor : options.fillColor;
    this.swatch.title = border ? "Border colour (output only)" : "Fill colour (output only)";
    this.swatch.setAttribute("aria-label", this.swatch.title);
    this.borderMask.classList.toggle("cps-active", options.borderMask);
    this.borderMask.setAttribute("aria-pressed", String(options.borderMask));

    this.padding.field.refresh();
    this.padding.dec.disabled = options.cropPadding <= 0;
    this.borderSize.field.refresh();
    this.borderSize.dec.disabled = options.borderSize <= 1;
    this.borderSize.inc.disabled = options.borderSize >= MAX_BORDER_SIZE;
  }

  /**
   * Close an open colour picker (its `onClose` commits the session) and end
   * the stepper fields' sessions.
   * @param revert - `true` (default) reverts open field sessions; `false` commits them.
   */
  dispose(revert = true): void {
    this.ctx.popovers.closeAnchoredIn(this.element);
    this.padding.field.dispose(revert);
    this.borderSize.field.dispose(revert);
  }

  // ── Internals ───────────────────────────────────────────────────────────

  /** One undoable option change from a click. */
  private set(patch: Partial<OutputOptions>): void {
    this.ctx.beforeEdit();
    this.ctx.editor.regionOps.setOptions(this.id, patch);
  }

  /** `− value px +` stepper; the value is a typeable field. */
  private stepper(spec: {
    title: string;
    fieldTitle?: string;
    bounds: () => { min: number; max: number };
    read: () => number;
    write: (value: number) => void;
    step: (value: number, direction: -1 | 1) => number;
  }): Stepper {
    const { ctx } = this;
    const ops = ctx.editor.regionOps;
    const element = document.createElement("span");
    element.className = "cps-stepper";
    element.title = spec.title;
    const click = (direction: -1 | 1) => () => {
      const { min, max } = spec.bounds();
      const next = Math.min(max, Math.max(min, spec.step(spec.read(), direction)));
      if (next === spec.read()) return;
      ctx.beforeEdit();
      spec.write(next);
    };
    const dec = button("cps-stepper-button", "\u2212", `${spec.title}: decrease`, click(-1));
    const inc = button("cps-stepper-button", "+", `${spec.title}: increase`, click(1));
    const field = outputField({
      label: "",
      suffix: "px",
      title: spec.fieldTitle ?? spec.title,
      ops,
      beforeEdit: ctx.beforeEdit,
      releaseFocus: ctx.releaseFocus,
      read: spec.read,
      bounds: spec.bounds,
      write: (value) => {
        const { min, max } = spec.bounds();
        spec.write(Math.min(max, Math.max(min, Math.floor(Number(value)))));
      },
    });
    field.element.classList.add("cps-stepper-field");
    element.append(dec, field.element, inc);
    return { element, dec, inc, field };
  }

  /** Fill / border colour picker: one session = one undo step; Esc / click-outside keep the colour. */
  private pickColor(): void {
    const { popovers, editor } = this.ctx;
    const ops = editor.regionOps;
    this.ctx.beforeEdit();
    popovers.close();
    const border = ops.options(this.id).applyMask === "border";
    if (!ops.begin()) return;
    const options = ops.options(this.id);
    openColorPicker(popovers, this.swatch, {
      initial: border ? options.borderColor : options.fillColor,
      title: border ? "Border colour" : "Fill colour",
      onInput: (hex) => {
        if (!ops.active) return;
        ops.setOptions(this.id, border ? { borderColor: hex } : { fillColor: hex });
      },
      onClose: () => {
        ops.commit();
      },
    });
  }
}
