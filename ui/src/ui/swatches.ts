/**
 * FG/BG swatch widget (Photoshop style): two overlapping squares -- the
 * foreground on top-left, background bottom-right -- with a small swap
 * arrow (X) and a reset icon (D, black/white). Clicking a square asks the
 * shell for a colour picker (`pick-color`) via `actions.pick`.
 *
 * Mask mode (while a layer mask is the edit target): the same squares
 * show the black / white MASK swatches instead of the colours (the host
 * passes them to {@link SwatchWidget.setColors}); only the titles, the reset
 * icon (white over black) and the cursor change -- the host ignores square
 * clicks then (no colour picker for a black / white pair).
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

/** Tooltips per mode: fg, bg, swap, reset. */
const TITLES = {
  color: ["Foreground color (X swaps)", "Background color (X swaps)", "Swap colors (X)", "Default colors (D)"],
  mask: [
    "Layer mask foreground: white hides, black reveals (X swaps)",
    "Layer mask background (X swaps)",
    "Swap mask black / white (X)",
    "Default mask swatches: white / black (D)",
  ],
} as const;

/**
 * The swatch widget.
 */
export class SwatchWidget {
  readonly element: HTMLDivElement;
  private readonly fg: HTMLButtonElement;
  private readonly bg: HTMLButtonElement;
  private readonly swap: HTMLButtonElement;
  private readonly reset: HTMLButtonElement;
  private maskMode = false;

  /**
   * @param actions - Click handlers.
   */
  constructor(actions: SwatchActions) {
    this.element = document.createElement("div");
    this.element.className = "cps-swatches";
    this.bg = swatch("cps-swatch cps-swatch-bg", () => actions.pick("bg", this.bg));
    this.fg = swatch("cps-swatch cps-swatch-fg", () => actions.pick("fg", this.fg));
    this.swap = swatch("cps-swatch-swap", () => actions.swap());
    setIcon(this.swap, "swap", 11);
    this.reset = swatch("cps-swatch-reset", () => actions.reset());
    this.reset.innerHTML = '<span class="cps-reset-bg"></span><span class="cps-reset-fg"></span>';
    this.element.append(this.bg, this.fg, this.swap, this.reset);
    this.applyTitles();
  }

  /**
   * Show colours (the real FG/BG, or the mask swatches in mask mode).
   * @param colors - Current FG/BG.
   */
  setColors(colors: Readonly<ColorPair>): void {
    this.fg.style.backgroundColor = colors.fg;
    this.bg.style.backgroundColor = colors.bg;
    this.fg.dataset["color"] = colors.fg;
    this.bg.dataset["color"] = colors.bg;
  }

  /**
   * Switch between the colour swatches and the layer mask swatches (titles,
   * reset icon, cursor; the colours come from {@link setColors}).
   * @param on - A layer mask is the edit target.
   */
  setMaskMode(on: boolean): void {
    if (on === this.maskMode) return;
    this.maskMode = on;
    this.element.classList.toggle("cps-mask-swatches", on);
    this.applyTitles();
  }

  /**
   * Anchor element of a swatch (for pickers opened programmatically).
   * @param slot - Which swatch.
   * @returns The square's element.
   */
  anchor(slot: ColorSlot): HTMLElement {
    return slot === "fg" ? this.fg : this.bg;
  }

  private applyTitles(): void {
    const titles = TITLES[this.maskMode ? "mask" : "color"];
    [this.fg, this.bg, this.swap, this.reset].forEach((button, i) => {
      const title = titles[i] ?? "";
      button.title = title;
      button.setAttribute("aria-label", title);
    });
  }
}

function swatch(className: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.addEventListener("click", onClick);
  return button;
}
