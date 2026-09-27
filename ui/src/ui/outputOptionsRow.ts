/**
 * Options row of an output card (Main or a region): "Modify" dropdown with
 * the Fill colour swatch, the Crop padding field, or the Add border width,
 * colour and "Mask border" checkbox inline (wrapping only when needed).
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

// ═══════════════════════════════════════════════════════════════════════════
// OutputOptionsRow
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Mode + swatch/padding row, refreshed in place.
 */
export class OutputOptionsRow {
  readonly element = document.createElement("div");
  private readonly mode = document.createElement("select");
  private readonly swatch = document.createElement("button");
  private readonly padding: OutputField;
  private readonly borderSize: OutputField;
  private readonly borderMask = document.createElement("label");
  private readonly borderMaskBox = document.createElement("input");

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

    this.borderMaskBox.type = "checkbox";
    this.borderMaskBox.addEventListener("change", () => {
      ctx.beforeEdit();
      ops.setOptions(id, { borderMask: this.borderMaskBox.checked });
    });
    this.borderMask.className = "cps-output-check";
    this.borderMask.title = "Border area white in the MASK (for outpainting)";
    const checkText = document.createElement("span");
    checkText.textContent = "Mask border";
    this.borderMask.append(this.borderMaskBox, checkText);

    const label = document.createElement("span");
    label.className = "cps-output-label";
    label.textContent = "Modify";
    this.element.append(
      label, this.mode, this.padding.element, this.borderSize.element, this.swatch, this.borderMask,
    );
    this.refresh();
  }

  /** Show the current options (fields being edited keep their text). */
  refresh(): void {
    const options = this.ctx.editor.regionOps.options(this.id);
    this.mode.value = options.applyMask;
    const border = options.applyMask === "border";
    this.swatch.hidden = options.applyMask !== "fill" && !border;
    this.swatch.style.backgroundColor = border ? options.borderColor : options.fillColor;
    this.swatch.title = border ? "Border colour (output only)" : "Fill colour (output only)";
    this.swatch.setAttribute("aria-label", this.swatch.title);
    this.padding.element.hidden = options.applyMask !== "crop";
    this.padding.refresh();
    this.borderSize.element.hidden = !border;
    this.borderSize.refresh();
    this.borderMask.hidden = !border;
    this.borderMaskBox.checked = options.borderMask;
  }

  /** Close the picker / revert open sessions. */
  dispose(): void {
    this.ctx.popovers.closeAnchoredIn(this.element);
    this.padding.dispose();
    this.borderSize.dispose();
  }

  /** Fill / border colour picker: one session = one undo step; Esc reverts. */
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
      onClose: (cancelled) => {
        if (cancelled) ops.cancel();
        else ops.commit();
      },
    });
  }
}
