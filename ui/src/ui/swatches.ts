/**
 * FG/BG swatch widget at the tool dock's right end (Photoshop style, design
 * handoff "Swatches"): the foreground circle top-left, the background circle
 * offset bottom-right, and a small column with swap (X) and reset (D)
 * icons. Clicking a circle asks the shell for a colour picker (`pick-color`)
 * via `actions.pick`.
 *
 * Mask mode (while a layer mask is the edit target): the same circles show
 * the black / white MASK swatches instead of the colours (the host passes
 * them to {@link SwatchWidget.setColors}); only the titles and the cursor
 * change -- the host ignores circle clicks then (no colour picker for a
 * black / white pair). Under Quick Mask the CSS dims the whole widget
 * (`.cps-root.cps-quickmask`).
 */

import type { ColorPair, ColorSlot } from "../engine/colors";
import { setIcon } from "./icons";

/** Callbacks from the widget. */
export interface SwatchActions {
  /** A circle was clicked. */
  pick(slot: ColorSlot, anchor: HTMLElement): void;
  /** Swap icon clicked. */
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

/** Size of the swap / reset icons, CSS px. */
const SMALL_ICON = 14;

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
    const pair = document.createElement("div");
    pair.className = "cps-swatch-pair";
    this.bg = button("cps-swatch cps-swatch-bg", () => actions.pick("bg", this.bg));
    this.fg = button("cps-swatch cps-swatch-fg", () => actions.pick("fg", this.fg));
    pair.append(this.bg, this.fg);
    const icons = document.createElement("div");
    icons.className = "cps-swatch-icons";
    this.swap = button("cps-swatch-icon", () => actions.swap());
    setIcon(this.swap, "swap", SMALL_ICON);
    this.reset = button("cps-swatch-icon", () => actions.reset());
    setIcon(this.reset, "resetColors", SMALL_ICON);
    icons.append(this.swap, this.reset);
    this.element.append(pair, icons);
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
   * cursor; the colours come from {@link setColors}).
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
   * @returns The circle's element.
   */
  anchor(slot: ColorSlot): HTMLElement {
    return slot === "fg" ? this.fg : this.bg;
  }

  private applyTitles(): void {
    const titles = TITLES[this.maskMode ? "mask" : "color"];
    [this.fg, this.bg, this.swap, this.reset].forEach((el, i) => {
      const title = titles[i] ?? "";
      el.title = title;
      el.setAttribute("aria-label", title);
    });
  }
}

function button(className: string, onClick: () => void): HTMLButtonElement {
  const el = document.createElement("button");
  el.type = "button";
  el.className = className;
  el.addEventListener("click", onClick);
  return el;
}
