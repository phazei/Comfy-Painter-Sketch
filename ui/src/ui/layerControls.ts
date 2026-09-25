/**
 * Small controls of the layers panel that edit layer properties through the
 * editor's `layerOps`:
 *
 * - {@link layerOpacityControl}: the M3.1 scrubby number control
 *   (`optionControls.ts`) over a one-descriptor {@link ToolOptions} adapter.
 *   Every pointer-down on the control starts a new undo "gesture", so a
 *   whole scrub (or one slider-popover session) is one history entry.
 * - {@link MaskColorPicker}: mask display colour with one undo entry per
 *   picker session.
 */

import type { Editor } from "../engine/editor";
import type { NumberOption, OptionValue, ToolOptions } from "../tools/options";
import { createControl } from "./optionControls";
import type { OptionControl } from "./optionControls";
import type { PopoverHost } from "./popover";

/** Layer a control edits. */
export interface LayerTarget {
  editor: Editor;
  layerId: string;
}

let gestureCounter = 0;

/**
 * A fresh undo-gesture key (edits sharing one merge into one entry).
 * @param prefix - Readable prefix.
 * @returns Unique key.
 */
export function newGesture(prefix: string): string {
  return `${prefix}:${++gestureCounter}`;
}

/** Opacity as a ToolOptions adapter over the target layer. */
class LayerOpacityOptions implements ToolOptions {
  readonly descriptors: readonly NumberOption[];
  gesture = newGesture("opacity");

  constructor(
    desc: NumberOption,
    private readonly target: () => LayerTarget | null,
  ) {
    this.descriptors = [desc];
  }

  get(key: string): OptionValue | undefined {
    const t = this.target();
    if (key !== "opacity" || !t) return undefined;
    return t.editor.doc.layers.find((l) => l.id === t.layerId)?.opacity;
  }

  set(key: string, value: OptionValue): boolean {
    const t = this.target();
    if (key !== "opacity" || !t || typeof value !== "number") return false;
    return t.editor.layerOps.setOpacity(t.layerId, value, this.gesture);
  }
}

/**
 * Scrubby opacity control (0..100 %) for a layer.
 * @param label - Label text (scrub handle).
 * @param title - Tooltip.
 * @param target - Layer being edited (read on every use; `null` = none).
 * @param popovers - Where the slider popover opens.
 * @returns The control (call `refresh()` after external changes).
 */
export function layerOpacityControl(
  label: string,
  title: string,
  target: () => LayerTarget | null,
  popovers: PopoverHost,
): OptionControl {
  const desc: NumberOption = { kind: "number", key: "opacity", label, title, min: 0, max: 100, step: 1, unit: "%", scale: 100 };
  const options = new LayerOpacityOptions(desc, target);
  const control = createControl(desc, { options, popovers, changed: () => control.refresh() });
  control.element.classList.add("cps-layer-opacity");
  // A new gesture per press: scrub drag or slider-popover session = one undo step.
  control.element.addEventListener("pointerdown", () => (options.gesture = newGesture("opacity")), { capture: true });
  return control;
}

// ── Mask colour ───────────────────────────────────────────────────────────────

/** Opens a colour UI; `onInput` for live changes, `onCommit` for the final one. */
export type ColorPickFn = (
  anchor: HTMLElement,
  options: { initial: string; title: string; onInput: (hex: string) => void; onCommit: (hex: string) => void },
) => void;

/**
 * Mask colour editing: every picker session is one undo entry.
 */
export class MaskColorPicker {
  /**
   * @param pick - Colour UI to open.
   */
  constructor(private readonly pick: ColorPickFn) {}

  /**
   * Open the picker for a mask layer.
   * @param anchor - Swatch element.
   * @param target - Mask layer.
   * @param initial - Current colour.
   */
  open(anchor: HTMLElement, target: LayerTarget, initial: string): void {
    const gesture = newGesture("mask-color");
    const apply = (hex: string): void => {
      target.editor.layerOps.setMaskColor(target.layerId, hex, gesture);
    };
    this.pick(anchor, { initial, title: "Mask colour", onInput: apply, onCommit: apply });
  }
}

/**
 * Native `<input type=color>` fallback picker (used when the M3.2 colour
 * picker is not available).
 * @param host - Element to keep the hidden input in.
 * @returns A {@link ColorPickFn} and a disposer.
 */
export function nativeColorPick(host: HTMLElement): { pick: ColorPickFn; dispose: () => void } {
  const input = document.createElement("input");
  input.type = "color";
  input.className = "cps-native-color";
  input.tabIndex = -1;
  host.appendChild(input);
  let handlers: { onInput: (hex: string) => void; onCommit: (hex: string) => void } | null = null;
  input.addEventListener("input", () => handlers?.onInput(input.value));
  input.addEventListener("change", () => handlers?.onCommit(input.value));
  const pick: ColorPickFn = (_anchor, options) => {
    handlers = options;
    input.value = options.initial;
    if (typeof input.showPicker === "function") {
      try {
        input.showPicker();
        return;
      } catch {
        // Needs a user gesture in some browsers; click() below.
      }
    }
    input.click();
  };
  return { pick, dispose: () => input.remove() };
}
