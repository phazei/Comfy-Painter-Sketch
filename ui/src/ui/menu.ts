/**
 * Generic menu popover (the design handoff's "menus": the edit chip,
 * Quick Mask paints, Copy, Paste, tool fly-outs, strip dropdowns). A menu
 * is an optional caps header, then rows; a row has an optional leading
 * swatch or icon, a label, and an optional trailing check mark or key hint.
 * Rows never take DOM focus (the keyboard scope redirects presses to its
 * sink), so letter shortcuts keep working after a pick. Menus open in the
 * shell's popover host, so they close on an outside press, Esc, or the
 * Esc chain, and follow the root into fullscreen.
 */

import { setIcon } from "./icons";
import type { PopoverHandle, PopoverHost, PopoverPlacement } from "./popover";

/** One menu row. */
export interface MenuItem {
  label: string;
  /** Leading icon (`ui/icons.ts`). */
  icon?: string;
  /** Leading colour swatch (any CSS background); wins over `icon`. */
  swatch?: string;
  /** Row is the current choice (tinted, check mark). */
  current?: boolean;
  /** Trailing check mark without the tint (e.g. a toggle that is on). */
  checked?: boolean;
  /** Trailing key hint in mono ("Ctrl C", "Q", "Alt-click"). */
  key?: string;
  /** Tooltip. */
  title?: string;
  /** Dimmed and inert. */
  disabled?: boolean;
  /** Run on click (the menu closes first unless `keepOpen`). */
  onPick(): void;
  /** Keep the menu open after the pick (e.g. a toggle in a list). */
  keepOpen?: boolean;
}

/** A row or a divider. */
export type MenuEntry = MenuItem | "divider";

/** Options for {@link openMenu}. */
export interface MenuOptions {
  anchor: HTMLElement;
  /** Caps header text (optional). */
  title?: string;
  entries: readonly MenuEntry[];
  /** Footer note in small muted text (e.g. "Your pick becomes the button's default"). */
  footer?: string;
  placement?: PopoverPlacement;
  /** Extra class on the popover element. */
  className?: string;
  /** Fixed width in CSS px (menus in the mock are 204 / 244 / 210). */
  width?: number;
  onClose?: () => void;
}

/**
 * Build and open a menu.
 * @param popovers - Popover host.
 * @param options - Anchor, header, rows.
 * @returns Popover handle.
 */
export function openMenu(popovers: PopoverHost, options: MenuOptions): PopoverHandle {
  const menu = document.createElement("div");
  menu.className = "cps-menu";
  menu.setAttribute("role", "menu");
  if (options.width !== undefined) menu.style.width = `${options.width}px`;
  if (options.title) {
    const header = document.createElement("div");
    header.className = "cps-menu-title";
    header.textContent = options.title;
    menu.appendChild(header);
  }
  let handle: PopoverHandle | null = null;
  for (const entry of options.entries) {
    if (entry === "divider") {
      const divider = document.createElement("div");
      divider.className = "cps-menu-divider";
      divider.setAttribute("role", "separator");
      menu.appendChild(divider);
      continue;
    }
    const row = menuRow(entry, () => {
      if (!entry.keepOpen) handle?.close();
      entry.onPick();
    });
    menu.appendChild(row);
  }
  if (options.footer) {
    const footer = document.createElement("div");
    footer.className = "cps-menu-footer";
    footer.textContent = options.footer;
    menu.appendChild(footer);
  }
  const popoverOptions = {
    anchor: options.anchor,
    placement: options.placement ?? "below",
    className: `cps-pop-menu${options.className ? ` ${options.className}` : ""}`,
    ...(options.onClose ? { onClose: options.onClose } : {}),
  };
  handle = popovers.open(menu, popoverOptions);
  return handle;
}

/**
 * One menu row element.
 * @param item - Row model.
 * @param pick - Click handler (already closes the menu when wanted).
 * @returns Button element.
 */
export function menuRow(item: MenuItem, pick: () => void): HTMLButtonElement {
  const row = document.createElement("button");
  row.type = "button";
  row.className = "cps-menu-item";
  row.setAttribute("role", "menuitem");
  if (item.current) row.classList.add("cps-current");
  if (item.title) row.title = item.title;
  if (item.disabled) {
    row.disabled = true;
    row.classList.add("cps-dim");
  }
  if (item.swatch) {
    const swatch = document.createElement("span");
    swatch.className = "cps-menu-swatch";
    swatch.style.background = item.swatch;
    row.appendChild(swatch);
  } else if (item.icon) {
    const icon = document.createElement("span");
    icon.className = "cps-menu-icon";
    setIcon(icon, item.icon, 16);
    row.appendChild(icon);
  }
  const label = document.createElement("span");
  label.className = "cps-menu-label";
  label.textContent = item.label;
  row.appendChild(label);
  if (item.current || item.checked) {
    const check = document.createElement("span");
    check.className = "cps-menu-check";
    setIcon(check, "check", 16);
    row.appendChild(check);
  }
  if (item.key) {
    const key = document.createElement("span");
    key.className = "cps-menu-key";
    key.textContent = item.key;
    row.appendChild(key);
  }
  row.addEventListener("click", (event) => {
    event.stopPropagation();
    if (!item.disabled) pick();
  });
  return row;
}
