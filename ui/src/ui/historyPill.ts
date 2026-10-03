/**
 * Top-left history pill (design handoff "Top-left group: history"): Undo,
 * Redo, a divider, then Clear (a history-type "start over"; the handler
 * confirms). Buttons never keep DOM focus (the keyboard scope redirects
 * presses on non-text controls).
 */

import { setIcon } from "./icons";

/** Callbacks from the pill. */
export interface HistoryPillActions {
  undo(): void;
  redo(): void;
  /** Clear everything (the handler asks for confirmation). */
  clear(): void;
}

/**
 * Undo / Redo / Clear pill.
 */
export class HistoryPill {
  /** The pill. */
  readonly element: HTMLDivElement;
  private readonly undoButton: HTMLButtonElement;
  private readonly redoButton: HTMLButtonElement;

  /**
   * @param container - Shell slot (`shell.top.history`).
   * @param actions - Button handlers.
   */
  constructor(container: HTMLElement, actions: HistoryPillActions) {
    this.element = document.createElement("div");
    this.element.className = "cps-pill cps-history";
    this.undoButton = barButton("undo", "Undo (Ctrl Z)", 19, () => actions.undo());
    this.redoButton = barButton("redo", "Redo (Ctrl Y)", 19, () => actions.redo());
    const divider = document.createElement("span");
    divider.className = "cps-vdiv";
    this.element.append(this.undoButton, this.redoButton, divider, barButton("clear", "Clear all\u2026", 18, () => actions.clear()));
    container.appendChild(this.element);
    this.setHistory(false, false);
  }

  /**
   * Enable / disable Undo and Redo.
   * @param canUndo - Undo available.
   * @param canRedo - Redo available.
   */
  setHistory(canUndo: boolean, canRedo: boolean): void {
    this.undoButton.disabled = !canUndo;
    this.redoButton.disabled = !canRedo;
  }
}

/**
 * A 32 px bar button with an icon and a tooltip.
 * @param icon - Icon name.
 * @param title - Tooltip / accessible name.
 * @param size - Icon size, CSS px.
 * @param onClick - Click handler.
 * @returns The button.
 */
export function barButton(icon: string, title: string, size: number, onClick: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "cps-bar-button";
  button.title = title;
  button.setAttribute("aria-label", title);
  setIcon(button, icon, size);
  button.addEventListener("click", onClick);
  return button;
}
