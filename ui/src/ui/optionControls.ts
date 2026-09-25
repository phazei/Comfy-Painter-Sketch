/**
 * Generic controls for option descriptors (`tools/options.ts`), used by the
 * options bar -- no per-tool UI code:
 *
 * - number: `label` + value button. Dragging the label horizontally scrubs
 *   the value (Photoshop scrubby slider, Shift = 10x); clicking the value
 *   opens a slider popover (in the shell's popover host) with a typed field.
 * - toggle: compact pill button (`aria-pressed`).
 * - select: label + `<select>`.
 * - button: command pill (`set(key, true)` performs it; dim while `get(key) === false`).
 * - text: suggestion menu + "Custom..." text field (`textOptionControl.ts`).
 *
 * Controls write through `ToolOptions.set` (which clamps/snaps) and call
 * `changed()`; `refresh()` re-reads values (after shortcuts etc.).
 */

import {
  displayToSlider,
  formatDisplay,
  fromDisplay,
  isOptionEnabled,
  sliderToDisplay,
  toDisplay,
} from "../tools/options";
import type { ButtonOption, NumberOption, OptionDescriptor, SelectOption, ToggleOption, ToolOptions } from "../tools/options";
import type { PopoverHandle, PopoverHost } from "./popover";
import { scrubValue } from "./scrub";
import { textControl } from "./textOptionControl";

/** What a control needs from the bar. */
export interface ControlContext {
  /** Options being edited. */
  options: ToolOptions;
  /** Where slider popovers open. */
  popovers: PopoverHost;
  /** An option changed (refresh bar, cursor, notify the registry). */
  changed(): void;
}

/** A rendered option control. */
export interface OptionControl {
  readonly element: HTMLElement;
  /** Re-read the value and enabled state. */
  refresh(): void;
}

/** Slider resolution (range input steps over 0..1). */
const SLIDER_STEPS = 1000;

/**
 * Create the control for a descriptor.
 * @param desc - Descriptor.
 * @param ctx - Bar context.
 * @returns The control.
 */
export function createControl(desc: OptionDescriptor, ctx: ControlContext): OptionControl {
  switch (desc.kind) {
    case "number":
      return numberControl(desc, ctx);
    case "toggle":
      return toggleControl(desc, ctx);
    case "select":
      return selectControl(desc, ctx);
    case "button":
      return buttonControl(desc, ctx);
    case "text":
      return textControl(desc, ctx);
  }
}

// ── Number ────────────────────────────────────────────────────────────────────

function numberControl(desc: NumberOption, ctx: ControlContext): OptionControl {
  const element = document.createElement("div");
  element.className = "cps-num";
  if (desc.title) element.title = desc.title;
  const label = document.createElement("span");
  label.className = "cps-num-label";
  label.textContent = desc.label;
  const value = document.createElement("button");
  value.type = "button";
  value.className = "cps-num-value";
  element.append(label, value);

  const display = (): number => {
    const v = ctx.options.get(desc.key);
    return typeof v === "number" ? toDisplay(desc, v) : desc.min;
  };
  const commit = (next: number): void => {
    if (ctx.options.set(desc.key, fromDisplay(desc, next))) ctx.changed();
  };
  let popover: { handle: PopoverHandle; sync(): void } | null = null;

  const refresh = (): void => {
    value.textContent = `${formatDisplay(desc, display())}${desc.unit ?? ""}`;
    element.classList.toggle("cps-dim", !isOptionEnabled(desc, (k) => ctx.options.get(k)));
    popover?.sync();
  };

  label.addEventListener("pointerdown", (event) => startScrub(event, label, desc, display, commit));
  value.addEventListener("click", () => {
    if (popover) {
      popover.handle.close();
      return;
    }
    popover = openSlider(desc, ctx, value, display, commit, () => (popover = null));
  });
  refresh();
  return { element, refresh };
}

/** Scrub on label drag; re-anchors when Shift changes mid-drag. */
function startScrub(
  event: PointerEvent,
  label: HTMLElement,
  desc: NumberOption,
  display: () => number,
  commit: (next: number) => void,
): void {
  if (event.button !== 0) return;
  event.preventDefault();
  const id = event.pointerId;
  let startX = event.clientX;
  let start = display();
  let fast = event.shiftKey;
  try {
    label.setPointerCapture(id);
  } catch {
    return;
  }
  label.classList.add("cps-scrubbing");
  const controller = new AbortController();
  const move = (e: PointerEvent): void => {
    if (e.pointerId !== id) return;
    if (e.shiftKey !== fast) {
      start = display();
      startX = e.clientX;
      fast = e.shiftKey;
    }
    commit(scrubValue(desc, start, e.clientX - startX, fast));
  };
  const end = (e: PointerEvent): void => {
    if (e.pointerId !== id) return;
    controller.abort();
    label.classList.remove("cps-scrubbing");
    if (label.hasPointerCapture(id)) label.releasePointerCapture(id);
  };
  const { signal } = controller;
  label.addEventListener("pointermove", move, { signal });
  label.addEventListener("pointerup", end, { signal });
  label.addEventListener("pointercancel", end, { signal });
  label.addEventListener("lostpointercapture", end, { signal });
}

/** Slider popover with a typed field; Enter/Escape close it. */
function openSlider(
  desc: NumberOption,
  ctx: ControlContext,
  anchor: HTMLElement,
  display: () => number,
  commit: (next: number) => void,
  onClose: () => void,
): { handle: PopoverHandle; sync(): void } {
  const content = document.createElement("div");
  content.className = "cps-slider-pop";
  const range = document.createElement("input");
  range.type = "range";
  range.min = "0";
  range.max = String(SLIDER_STEPS);
  range.step = "1";
  range.className = "cps-slider";
  const field = document.createElement("input");
  field.type = "text";
  field.inputMode = "decimal";
  field.className = "cps-num-input";
  field.spellcheck = false;
  const unit = document.createElement("span");
  unit.className = "cps-num-unit";
  unit.textContent = desc.unit ?? "";
  content.append(range, field, unit);

  const sync = (): void => {
    const d = display();
    range.value = String(Math.round(displayToSlider(desc, d) * SLIDER_STEPS));
    if (document.activeElement !== field) field.value = formatDisplay(desc, d);
  };
  const commitField = (): void => {
    const parsed = Number.parseFloat(field.value.replace(",", "."));
    if (Number.isFinite(parsed)) commit(parsed);
    field.value = formatDisplay(desc, display());
  };
  range.addEventListener("input", () => commit(sliderToDisplay(desc, Number(range.value) / SLIDER_STEPS)));
  field.addEventListener("change", commitField);
  field.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    commitField();
    handle.close();
  });

  const handle = ctx.popovers.open(content, { anchor, placement: "below", className: "cps-pop-slider", onClose });
  sync();
  field.focus({ preventScroll: true });
  field.select();
  return { handle, sync };
}

// ── Toggle / select ───────────────────────────────────────────────────────────

function toggleControl(desc: ToggleOption, ctx: ControlContext): OptionControl {
  const element = document.createElement("button");
  element.type = "button";
  element.className = "cps-toggle";
  element.textContent = desc.label;
  if (desc.title) element.title = desc.title;
  element.addEventListener("click", () => {
    if (ctx.options.set(desc.key, ctx.options.get(desc.key) !== true)) ctx.changed();
  });
  const refresh = (): void => {
    const on = ctx.options.get(desc.key) === true;
    element.classList.toggle("cps-active", on);
    element.setAttribute("aria-pressed", String(on));
    element.classList.toggle("cps-dim", !isOptionEnabled(desc, (k) => ctx.options.get(k)));
  };
  refresh();
  return { element, refresh };
}

function buttonControl(desc: ButtonOption, ctx: ControlContext): OptionControl {
  const element = document.createElement("button");
  element.type = "button";
  element.className = "cps-toggle cps-command";
  element.textContent = desc.label;
  if (desc.title) element.title = desc.title;
  element.addEventListener("click", () => {
    ctx.options.set(desc.key, true);
    ctx.changed();
  });
  const refresh = (): void => {
    element.classList.toggle("cps-dim", ctx.options.get(desc.key) === false);
  };
  refresh();
  return { element, refresh };
}

function selectControl(desc: SelectOption, ctx: ControlContext): OptionControl {
  const element = document.createElement("label");
  element.className = "cps-select";
  if (desc.title) element.title = desc.title;
  const name = document.createElement("span");
  name.className = "cps-num-label";
  name.textContent = desc.label;
  const select = document.createElement("select");
  for (const choice of desc.choices) {
    const option = document.createElement("option");
    option.value = choice.value;
    option.textContent = choice.label;
    select.appendChild(option);
  }
  select.addEventListener("change", () => {
    if (ctx.options.set(desc.key, select.value)) ctx.changed();
  });
  element.append(name, select);
  const refresh = (): void => {
    const v = ctx.options.get(desc.key);
    if (typeof v === "string") select.value = v;
    element.classList.toggle("cps-dim", !isOptionEnabled(desc, (k) => ctx.options.get(k)));
  };
  refresh();
  return { element, refresh };
}
