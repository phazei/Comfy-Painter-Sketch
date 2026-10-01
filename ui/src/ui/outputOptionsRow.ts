/**
 * Options of an output card (Main or a region), two lines:
 * 1. "Modify" dropdown (never squeezed) + Alpha checkbox (hidden while
 *    Fill mask; the Fill colour swatch takes its place).
 * 2. Per-choice extras, only when there are any: Crop -> padding; Add
 *    border -> width, colour and "Mask border" (wrapping only when needed).
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

/** Mask mode choices, in menu order. */
const MODES: ReadonlyArray<readonly [OutputOptions["applyMask"], string]> = [
  ["none", "None"],
  ["fill", "Fill mask"],
  ["crop", "Crop to mask"],
  ["border", "Add border"],
];

/**
 * Narrow a `<select>` value to a mask mode.
 * @param value - Raw value.
 * @returns The mode, or null.
 */
function readMode(value: string): OutputOptions["applyMask"] | null {
  return value === "none" || value === "fill" || value === "crop" || value === "border" ? value : null;
}

/** Tooltip of the Alpha checkbox. */
export const ALPHA_TITLE = "Output the image with the mask as transparency (RGBA). Some nodes use RGB only and drop it.";

/**
 * Inline checkbox with a text label (`.cps-output-check`).
 * @param text - Label text.
 * @param title - Tooltip.
 * @param onChange - Called with the new checked state.
 * @returns The label and its checkbox.
 */
function checkLabel(
  text: string, title: string, onChange: (checked: boolean) => void,
): { label: HTMLLabelElement; box: HTMLInputElement } {
  const label = document.createElement("label");
  const box = document.createElement("input");
  box.type = "checkbox";
  box.addEventListener("change", () => onChange(box.checked));
  label.className = "cps-output-check";
  label.title = title;
  const span = document.createElement("span");
  span.textContent = text;
  label.append(box, span);
  return { label, box };
}

// ═══════════════════════════════════════════════════════════════════════════
// OutputOptionsRow
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Mode line + extras line, refreshed in place.
 */
export class OutputOptionsRow {
  readonly element = document.createElement("div");
  /** Line 1: Modify label + dropdown + Alpha (or the Fill swatch). */
  private readonly mainLine = document.createElement("div");
  /** Line 2: Crop / Add border extras; hidden when the choice has none. */
  private readonly extrasLine = document.createElement("div");
  private readonly mode = document.createElement("select");
  private readonly swatch = document.createElement("button");
  private readonly padding: OutputField;
  private readonly borderSize: OutputField;
  private readonly borderMask: HTMLLabelElement;
  private readonly borderMaskBox: HTMLInputElement;
  /** Alpha: RGBA IMAGE (hidden, value kept, while Modify = Fill mask). */
  private readonly alpha: HTMLLabelElement;
  private readonly alphaBox: HTMLInputElement;

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

    this.mode.className = "cps-output-mode";
    this.mode.title = "Modify this output";
    this.mode.setAttribute("aria-label", this.mode.title);
    for (const [value, text] of MODES) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = text;
      this.mode.append(option);
    }
    this.mode.addEventListener("change", () => {
      const mode = readMode(this.mode.value);
      if (!mode) return;
      ctx.beforeEdit();
      ops.setOptions(id, { applyMask: mode });
    });

    this.swatch.type = "button";
    this.swatch.className = "cps-output-swatch";
    this.swatch.addEventListener("click", () => this.pickColor());

    this.padding = outputField({
      label: "Pad",
      title: "Crop padding (output px)",
      ops,
      beforeEdit: ctx.beforeEdit,
      releaseFocus: ctx.releaseFocus,
      read: () => ops.options(id).cropPadding,
      bounds: () => ({ min: 0, max: Number.MAX_SAFE_INTEGER }),
      write: (value) => ops.setOptions(id, { cropPadding: Number(value) }),
    });
    this.borderSize = outputField({
      label: "W",
      title: `Border width per side (output px, 1..${MAX_BORDER_SIZE})`,
      ops,
      beforeEdit: ctx.beforeEdit,
      releaseFocus: ctx.releaseFocus,
      read: () => ops.options(id).borderSize,
      bounds: () => ({ min: 1, max: MAX_BORDER_SIZE }),
      write: (value) => ops.setOptions(id, { borderSize: Number(value) }),
    });

    ({ label: this.borderMask, box: this.borderMaskBox } = checkLabel(
      "Mask border", "Border area white in the MASK (for outpainting)", (checked) => {
        ctx.beforeEdit();
        ops.setOptions(id, { borderMask: checked });
      }));
    ({ label: this.alpha, box: this.alphaBox } = checkLabel("Alpha", ALPHA_TITLE, (checked) => {
      ctx.beforeEdit();
      ops.setOptions(id, { alpha: checked });
    }));
    this.alpha.classList.add("cps-output-alpha");

    const label = document.createElement("span");
    label.className = "cps-output-label";
    label.textContent = "Modify";
    this.mainLine.className = "cps-output-options-line";
    this.extrasLine.className = "cps-output-options-line cps-output-extras";
    this.mainLine.append(label, this.mode, this.alpha);
    this.extrasLine.append(this.padding.element, this.borderSize.element, this.swatch, this.borderMask);
    this.element.append(this.mainLine, this.extrasLine);
    this.refresh();
  }

  /** Show the current options (fields being edited keep their text). */
  refresh(): void {
    const options = this.ctx.editor.regionOps.options(this.id);
    this.mode.value = options.applyMask;
    const border = options.applyMask === "border";
    const fill = options.applyMask === "fill";
    this.extrasLine.hidden = !border && options.applyMask !== "crop";
    // Fill: swatch in Alpha's place on line 1; border: after the width on line 2.
    if (fill && this.swatch.parentElement !== this.mainLine) this.mainLine.append(this.swatch);
    if (border && this.swatch.parentElement !== this.extrasLine) this.borderSize.element.after(this.swatch);
    this.swatch.hidden = !fill && !border;
    this.swatch.style.backgroundColor = border ? options.borderColor : options.fillColor;
    this.swatch.title = border ? "Border colour (output only)" : "Fill colour (output only)";
    this.swatch.setAttribute("aria-label", this.swatch.title);
    this.padding.element.hidden = options.applyMask !== "crop";
    this.padding.refresh();
    this.borderSize.element.hidden = !border;
    this.borderSize.refresh();
    this.borderMask.hidden = !border;
    this.borderMaskBox.checked = options.borderMask;
    // Fill and alpha cancel out: hidden, the saved value is kept.
    this.alphaBox.checked = options.alpha === true;
    this.alpha.hidden = fill;
  }

  /** Close an open colour picker (its `onClose` commits the session) and the number controls. */
  dispose(): void {
    this.ctx.popovers.closeAnchoredIn(this.element);
    this.padding.dispose();
    this.borderSize.dispose();
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
