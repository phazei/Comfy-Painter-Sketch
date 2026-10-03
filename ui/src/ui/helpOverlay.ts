/**
 * Shortcuts help overlay (design handoff section 9): a dim backdrop over the
 * editor with a centred card titled "Shortcuts" and a two-column grid of
 * section cards generated from the one shortcut list (`shortcutList.ts`).
 * Opened by the bottom bar's Help button or the `?` key; closed by Esc (the
 * host's Esc chain calls {@link HelpOverlay.close}), a backdrop click or the
 * × button. It holds only buttons and text, so keyboard focus stays on the
 * editor's key sink. Mounted in the shell's `overlaySlot`.
 */

import { setIcon } from "./icons";
import { HELP_SECTIONS } from "./shortcutList";

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

  const grid = el("div", "cps-help-grid");
  for (const section of HELP_SECTIONS) {
    const box = el("section", "cps-help-section");
    const heading = el("div", "cps-help-section-title");
    heading.textContent = section.title;
    const rows = el("div", "cps-help-rows");
    for (const row of section.rows) {
      const keys = el("span", "cps-help-keys");
      keys.textContent = row.keys;
      const action = el("span", "cps-help-action");
      action.textContent = row.action;
      rows.append(keys, action);
    }
    box.append(heading, rows);
    grid.appendChild(box);
  }
  card.append(header, grid);
  return card;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.className = className;
  return element;
}
