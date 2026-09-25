/**
 * Collapsed option group (e.g. pen pressure): one icon button in the options
 * bar that opens a popover holding the group's descriptors, rendered by the
 * same generic controls as the bar (`optionControls.ts`). The button is
 * tinted while any of the group's `activeWhen` toggles is on. Slider
 * popovers opened from inside nest on top of the group popover.
 */

import { isGroupActive } from "../tools/options";
import type { OptionDescriptor, OptionGroup } from "../tools/options";
import { setIcon } from "./icons";
import { createControl } from "./optionControls";
import type { ControlContext, OptionControl } from "./optionControls";
import type { PopoverHandle } from "./popover";

/**
 * Create the button (and its popover) for a collapsed group.
 * @param group - Group definition.
 * @param descriptors - Member descriptors in display order.
 * @param ctx - Bar context (options, popover host, change callback).
 * @returns The control; `refresh()` updates the tint and open popover.
 */
export function groupControl(
  group: OptionGroup,
  descriptors: readonly OptionDescriptor[],
  ctx: ControlContext,
): OptionControl {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "cps-icon-button cps-option-group";
  button.title = group.title;
  button.setAttribute("aria-haspopup", "dialog");
  button.setAttribute("aria-expanded", "false");
  setIcon(button, group.icon, 18);

  let open: { handle: PopoverHandle; controls: OptionControl[] } | null = null;

  const refresh = (): void => {
    const on = isGroupActive(group, (key) => ctx.options.get(key));
    button.classList.toggle("cps-on", on);
    button.title = on ? `${group.title} (on)` : group.title;
    for (const control of open?.controls ?? []) control.refresh();
  };

  const setOpen = (value: boolean): void => {
    button.classList.toggle("cps-active", value);
    button.setAttribute("aria-expanded", String(value));
  };

  button.addEventListener("click", () => {
    if (open) {
      open.handle.close();
      return;
    }
    const content = document.createElement("div");
    content.className = "cps-group-pop";
    const title = document.createElement("div");
    title.className = "cps-group-title";
    title.textContent = group.title;
    const controls = descriptors.map((desc) => createControl(desc, ctx));
    content.append(title, ...controls.map((c) => c.element));
    const handle = ctx.popovers.open(content, {
      anchor: button,
      placement: "below",
      className: "cps-pop-group",
      onClose: () => {
        open = null;
        setOpen(false);
      },
    });
    open = { handle, controls };
    setOpen(true);
    refresh();
  });

  refresh();
  return { element: button, refresh };
}
