/**
 * FG/BG swatch widget (Photoshop style): two overlapping squares -- the
 * foreground on top-left, background bottom-right -- with a small swap
 * arrow (X) and a reset icon (D, black/white). Clicking a square asks the
 * shell for a colour picker (`pick-color`, M3.2) via `actions.pick`.
 */

import type { ColorPair, ColorSlot } from "../engine/colors";
import { setIcon } from "./icons";

/** Callbacks from the widget. */
export interface SwatchActions {
  /** A square was clicked. */
  pick(slot: ColorSlot, anchor: HTMLElement): void;
  /** Swap arrow clicked. */
  swap(): void;
  /** Reset icon clicked. */
  reset(): void;
}

/**
 * The swatch widget.
 */
export class SwatchWidget {
  readonly element: HTMLDivElement;
  private readonly fg: HTMLButtonElement;
  private readonly bg: HTMLButtonElement;

  /**
   * @param actions - Click handlers.
   */
  constructor(actions: SwatchActions) {
    this.element = document.createElement("div");
    this.element.className = "cps-swatches";
    this.bg = swatch("cps-swatch cps-swatch-bg", "Background color (X swaps)", () => actions.pick("bg", this.bg));
    this.fg = swatch("cps-swatch cps-swatch-fg", "Foreground color (X swaps)", () => actions.pick("fg", this.fg));
    const swap = swatch("cps-swatch-swap", "Swap colors (X)", () => actions.swap());
    setIcon(swap, "swap", 11);
    const reset = swatch("cps-swatch-reset", "Default colors (D)", () => actions.reset());
    reset.innerHTML = '<span class="cps-reset-bg"></span><span class="cps-reset-fg"></span>';
    this.element.append(this.bg, this.fg, swap, reset);
  }

  /**
   * Show colours.
   * @param colors - Current FG/BG.
   */
  setColors(colors: Readonly<ColorPair>): void {
    this.fg.style.backgroundColor = colors.fg;
    this.bg.style.backgroundColor = colors.bg;
    this.fg.dataset["color"] = colors.fg;
    this.bg.dataset["color"] = colors.bg;
  }

  /**
   * Anchor element of a swatch (for pickers opened programmatically).
   * @param slot - Which swatch.
   * @returns The square's element.
   */
  anchor(slot: ColorSlot): HTMLElement {
    return slot === "fg" ? this.fg : this.bg;
  }
}

function swatch(className: string, title: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.title = title;
  button.setAttribute("aria-label", title);
  button.addEventListener("click", onClick);
  return button;
}
