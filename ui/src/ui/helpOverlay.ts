/**
 * Shortcuts help overlay (design handoff section 9): a dim backdrop over the
 * editor with a centred card titled "Shortcuts": an "Essentials" band of the
 * most-used keys (the mode key at the right of its title), then flowing columns of section cards, both generated from
 * the one shortcut list (`shortcutList.ts`).
 * Opened by the bottom bar's Help button or the `?` key; closed by Esc (the
 * host's Esc chain calls {@link HelpOverlay.close}), a backdrop click or the
 * × button. It holds only buttons and text, so keyboard focus stays on the
 * editor's key sink. Mounted in the shell's `overlaySlot`.
 */

import { setIcon } from "./icons";
import { HELP_SECTIONS, QUICK_ASIDE, QUICK_ROWS } from "./shortcutList";

/**
 * The help overlay of one editor.
 */
export class HelpOverlay {
  /** Backdrop element (appended to the container only while open). */
  readonly element: HTMLDivElement;
  private open_ = false;

  /**
   * @param container - Where the overlay mounts (`shell.overlaySlot`).
   * @param onChange - Optional: the overlay opened or closed.
   */
  constructor(
    private readonly container: HTMLElement,
    private readonly onChange?: (open: boolean) => void,
  ) {
    this.element = document.createElement("div");
    this.element.className = "cps-help-backdrop";
    this.element.addEventListener("click", (event) => {
      if (event.target === this.element) this.close();
    });
    this.element.appendChild(buildCard(() => this.close()));
  }

  /** Whether the overlay is shown. */
  get isOpen(): boolean {
    return this.open_;
  }

  /** Show the overlay (no-op when open). */
  open(): void {
    if (this.open_) return;
    this.open_ = true;
    this.container.appendChild(this.element);
    this.onChange?.(true);
  }

  /**
   * Hide the overlay.
   * @returns `true` if it was open (the Esc chain consumed the key).
   */
  close(): boolean {
    if (!this.open_) return false;
    this.open_ = false;
    this.element.remove();
    this.onChange?.(false);
    return true;
  }

  /** Open when closed, close when open. */
  toggle(): void {
    if (this.open_) this.close();
    else this.open();
  }

  /** Remove the overlay. */
  dispose(): void {
    this.open_ = false;
    this.element.remove();
  }
}

// ── Building ──────────────────────────────────────────────────────────────

/** The centred card: header (title + ×) and the section grid. */
function buildCard(close: () => void): HTMLDivElement {
  const card = el("div", "cps-help-card");
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-label", "Shortcuts");
  const header = el("div", "cps-help-header");
  const title = el("span", "cps-help-title");
  title.textContent = "Shortcuts";
  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.className = "cps-icon-button cps-help-close";
  closeButton.title = "Close (Esc)";
  closeButton.setAttribute("aria-label", "Close");
  setIcon(closeButton, "close", 16);
  closeButton.addEventListener("click", close);
  header.append(title, closeButton);

  // Body (the one scroller): the Essentials band, then the section columns.
  const body = el("div", "cps-help-body");
  const quick = el("section", "cps-help-quick");
  const quickTitle = el("div", "cps-help-section-title");
  const quickLabel = el("span", "");
  quickLabel.textContent = "Essentials";
  const aside = el("span", "cps-help-quick-aside");
  const asideAction = el("span", "cps-help-action");
  asideAction.textContent = QUICK_ASIDE.action;
  aside.append(buildKeys(QUICK_ASIDE.keys), asideAction);
  quickTitle.classList.add("cps-help-quick-title");
  quickTitle.append(quickLabel, aside);
  const quickItems = el("div", "cps-help-quick-items");
  for (const row of QUICK_ROWS) {
    const item = el("div", "cps-help-quick-item");
    const action = el("span", "cps-help-action");
    action.textContent = row.action;
    item.append(buildKeys(row.keys), action);
    quickItems.appendChild(item);
  }
  quick.append(quickTitle, quickItems);

  const grid = el("div", "cps-help-grid");
  for (const section of HELP_SECTIONS) {
    const box = el("section", "cps-help-section");
    const heading = el("div", "cps-help-section-title");
    heading.textContent = section.title;
    const rows = el("div", "cps-help-rows");
    for (const row of section.rows) {
      const line = el("div", "cps-help-row");
      const action = el("span", "cps-help-action");
      action.textContent = row.action;
      line.append(buildKeys(row.keys), action);
      rows.appendChild(line);
    }
    box.append(heading, rows);
    grid.appendChild(box);
  }
  body.append(quick, grid);
  card.append(header, body);
  return card;
}

/**
 * The keys cell: each " / " alternative as a key chip, a muted slash between.
 * @param keys - Row keys, e.g. `"Ctrl ⇧ Z / Ctrl Y"`.
 * @returns The cell element.
 */
function buildKeys(keys: string): HTMLSpanElement {
  const cell = el("span", "cps-help-keys");
  keys.split(" / ").forEach((alternative, index) => {
    if (index > 0) {
      const slash = el("span", "cps-help-or");
      slash.textContent = "/";
      cell.appendChild(slash);
    }
    const chip = el("kbd", "cps-help-kbd");
    chip.textContent = alternative;
    cell.appendChild(chip);
  });
  return cell;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.className = className;
  return element;
}
