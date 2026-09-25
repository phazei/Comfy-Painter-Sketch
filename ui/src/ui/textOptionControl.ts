/**
 * Options-bar control for `text` descriptors (`tools/options.ts`
 * {@link TextOption}; the text tool's font): a `<select>` of the
 * descriptor's suggestions (re-read on every refresh, so recent fonts stay
 * current; a value that is not listed is shown at the top) plus a
 * "Custom..." entry that swaps the menu for a text field. Enter / blur
 * commits the typed value, Escape reverts.
 *
 * Both are native text-entry elements, so the keyboard scope leaves typing
 * alone (`focusPolicy.ts`).
 */

import { cssFontFamily } from "../engine/textRender";
import { isOptionEnabled } from "../tools/options";
import type { TextOption } from "../tools/options";
import type { ControlContext, OptionControl } from "./optionControls";

/** `<option>` value of the "Custom..." entry (never a valid stored value). */
const CUSTOM = "\u0000custom";

/**
 * Create the control for a text descriptor.
 * @param desc - Descriptor.
 * @param ctx - Bar context.
 * @returns The control.
 */
export function textControl(desc: TextOption, ctx: ControlContext): OptionControl {
  const element = document.createElement("label");
  element.className = "cps-select cps-text-option";
  if (desc.title) element.title = desc.title;
  const name = document.createElement("span");
  name.className = "cps-num-label";
  name.textContent = desc.label;
  const select = document.createElement("select");
  const field = document.createElement("input");
  field.type = "text";
  field.className = "cps-num-input cps-text-field";
  field.spellcheck = false;
  field.maxLength = desc.maxLength ?? 100;
  field.hidden = true;
  element.append(name, select, field);

  let signature = "";
  let typing = false;
  const current = (): string => {
    const v = ctx.options.get(desc.key);
    return typeof v === "string" ? v : "";
  };

  const rebuild = (): void => {
    const value = current();
    const list = desc.suggestions();
    const listed = list.find((v) => v.toLowerCase() === value.toLowerCase());
    const entries = listed || !value ? list : [value, ...list];
    const next = `${entries.join("\n")}|${value}`;
    if (next !== signature) {
      signature = next;
      const options = entries.map((v) => option(v, v, desc.previewFont === true));
      select.replaceChildren(...options, option(CUSTOM, desc.customLabel, false));
    }
    select.value = listed ?? value;
  };

  const finish = (commit: boolean): void => {
    if (!typing) return;
    typing = false;
    field.hidden = true;
    select.hidden = false;
    if (commit && ctx.options.set(desc.key, field.value)) ctx.changed();
    refresh();
  };

  select.addEventListener("change", () => {
    if (select.value !== CUSTOM) {
      if (ctx.options.set(desc.key, select.value)) ctx.changed();
      return;
    }
    typing = true;
    select.hidden = true;
    field.hidden = false;
    field.value = current();
    field.focus({ preventScroll: true });
    field.select();
  });
  field.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== "Escape") return;
    event.preventDefault();
    finish(event.key === "Enter");
  });
  field.addEventListener("blur", () => finish(true));

  const refresh = (): void => {
    if (!typing) rebuild();
    element.classList.toggle("cps-dim", !isOptionEnabled(desc, (k) => ctx.options.get(k)));
  };
  refresh();
  return { element, refresh };
}

function option(value: string, label: string, preview: boolean): HTMLOptionElement {
  const el = document.createElement("option");
  el.value = value;
  el.textContent = label;
  if (preview) el.style.fontFamily = cssFontFamily(value);
  return el;
}
