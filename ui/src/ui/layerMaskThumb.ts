/**
 * Layer mask slot of a paint row (SPEC "Layer masks (lmask)"): right of
 * the layer thumbnail, a tiny "add layer mask" icon (click = reveal all /
 * all black, or show only the selection when there is one; Alt+click = hide
 * all / all white) that becomes the mask thumbnail once the layer has a
 * mask. The thumbnail is grayscale in the ComfyUI mask convention (white =
 * hidden, black = shown, invert applied), redrawn like the layer thumbnail
 * (cache key, throttled by the panel); a red X marks a disabled mask.
 *
 * Mask thumbnail clicks (Photoshop):
 * - click = edit the mask (target; an lmask-only view moves to it);
 * - Shift+click = off / on;
 * - Alt+click = view the mask alone in the stage and edit it (again = end);
 * - Ctrl(+Shift / +Alt / +Shift+Alt)+click = selection from the mask's
 * shown (black) part.
 *
 * While hovered, the held modifier shows what a click will do (`data-mod`,
 * set by `layerSelectHover.ts`): on the thumbnail Alt = an eye in corner
 * brackets, Shift = a red X; on the add icon Alt = the inverted mask glyph.
 *
 * The slot never widens the row beyond the thumbnail box; the name wraps
 * to 2 lines and ellipsizes instead (CSS). All clicks stop at the slot (the row's own click
 * would re-select / load the layer's pixels).
 */

import type { SelectionMode } from "../engine/selection";
import { iconSvg, setIcon } from "./icons";
import { layerSelectMode } from "./moveCursors";
import { Thumbnail } from "./thumbnails";

/** Mask state of a paint row. */
export interface MaskSlotModel {
  /** The layer can get a mask (paint layer); `false` hides the slot. */
  canHave: boolean;
  /** The layer's mask, or `null` (shows the add icon). */
  mask: { enabled: boolean; targeted: boolean; viewing: boolean } | null;
}

/** Callbacks of the slot (ids are layer ids). */
export interface MaskSlotActions {
  /** Add icon: `hideAll` for Alt+click. */
  addLayerMask(id: string, hideAll: boolean): void;
  /** Plain click on the mask thumbnail: edit the mask. */
  targetMask(id: string): void;
  /** Shift+click: enabled toggle. */
  toggleMaskEnabled(id: string): void;
  /** Alt+click: grayscale view toggle. */
  toggleMaskView(id: string): void;
  /** Ctrl(+...)+click: selection from the mask coverage. */
  maskSelection(id: string, mode: SelectionMode): void;
}

/**
 * The add icon / mask thumbnail of one paint row.
 */
export class LayerMaskSlot {
  readonly element: HTMLSpanElement;
  readonly thumb = new Thumbnail();
  private readonly addButton: HTMLButtonElement;
  private readonly thumbBox: HTMLSpanElement;
  private readonly off: HTMLSpanElement;

  /**
   * @param id - Layer id.
   * @param actions - Callbacks.
   */
  constructor(
    private readonly id: string,
    private readonly actions: MaskSlotActions,
  ) {
    this.element = document.createElement("span");
    this.element.className = "cps-layer-mask-slot";
    this.addButton = document.createElement("button");
    this.addButton.type = "button";
    this.addButton.className = "cps-icon-button cps-layer-button cps-layer-mask-add";
    this.addButton.title = "Add layer mask (reveals all, or shows only the selection; Alt+click hides all)";
    // Alt (hide all) shows the inverted glyph (`layerSelectHover.ts` sets `data-mod`).
    this.addButton.innerHTML =
      `<span class="cps-mod-plain">${iconSvg("layerMaskAdd", 12)}</span><span class="cps-mod-alt">${iconSvg("maskInverted", 12)}</span>`;
    this.addButton.addEventListener("click", (event) => {
      stop(event);
      actions.addLayerMask(id, event.altKey);
    });
    this.thumbBox = document.createElement("span");
    this.thumbBox.className = "cps-layer-thumb-box cps-layer-mask-thumb";
    this.thumbBox.title =
      "Layer mask: click to edit it; Shift+click off/on; Alt+click view it alone; Ctrl+click select its shown (black) part (+Shift add, +Alt subtract)";
    this.off = document.createElement("span");
    this.off.className = "cps-layer-mask-off";
    this.off.hidden = true;
    setIcon(this.off, "close", 30);
    // Modifier indicators: what a click does now (Alt = view alone, Shift = off / on).
    const mods = document.createElement("span");
    mods.className = "cps-layer-mask-mods";
    mods.innerHTML = `<span class="cps-mod-alt">${iconSvg("maskView", 18)}</span><span class="cps-mod-shift">${iconSvg("close", 22)}</span>`;
    this.thumbBox.append(this.thumb.canvas, this.off, mods);
    this.thumbBox.addEventListener("click", (event) => this.thumbClick(event));
    this.element.append(this.addButton, this.thumbBox);
  }

  /**
   * Apply display state.
   * @param model - Mask state.
   */
  update(model: MaskSlotModel): void {
    this.element.hidden = !model.canHave;
    const mask = model.mask;
    this.addButton.hidden = mask !== null;
    this.thumbBox.hidden = mask === null;
    this.thumbBox.classList.toggle("cps-target", mask?.targeted === true);
    this.thumbBox.classList.toggle("cps-viewing", mask?.viewing === true);
    this.off.hidden = mask?.enabled !== false;
    if (!mask) this.thumb.invalidate();
  }

  private thumbClick(event: MouseEvent): void {
    stop(event);
    const ctrl = event.ctrlKey || event.metaKey;
    const mode = layerSelectMode({ ctrl, shift: event.shiftKey, alt: event.altKey });
    if (mode) this.actions.maskSelection(this.id, mode);
    else if (event.shiftKey) this.actions.toggleMaskEnabled(this.id);
    else if (event.altKey) this.actions.toggleMaskView(this.id);
    else this.actions.targetMask(this.id);
  }
}

function stop(event: MouseEvent): void {
  event.stopPropagation();
  event.preventDefault();
}
