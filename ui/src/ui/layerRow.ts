/**
 * One row of the layers panel: thumbnail, name (double-click renames inline:
 * Enter commits, Escape cancels, blur commits), visibility eye and lock.
 * Mask rows add a second line with the colour swatch, an invert toggle and
 * the overlay opacity control; the Background row is locked and not
 * selectable but has an eye and a solo button like the others. Text layers get a "T" badge on the thumbnail. The current mask
 * has a thick left bar in its own colour; paint/text/mask rows have a small
 * solo button (view only). The Image Mask row (M13a, `imageMask` kind) is a
 * mask row without rename or lock (it is never edited) and is not dragged
 * (`layerDrag.ts` only moves paint / mask rows); as the M13b Input Mask its
 * tooltips follow the name and a hint line can show under it. Paint rows
 * have the M14 layer mask slot right of the thumbnail (`layerMaskThumb.ts`);
 * with a mask, the thumbnail being edited (pixels or mask) is framed. Rows are
 * reused across updates (keyed by layer id) so a double-click survives the
 * re-render the first click causes.
 */

import { INPUT_MASK_NAME } from "../document/imageMask";
import type { SelectionMode } from "../engine/selection";
import { layerSelectMode } from "./moveCursors";
import type { OptionControl } from "./optionControls";
import { setIcon } from "./icons";
import { startInlineRename } from "./inlineRename";
import { LayerMaskSlot } from "./layerMaskThumb";
import type { MaskSlotActions, MaskSlotModel } from "./layerMaskThumb";
import { Thumbnail } from "./thumbnails";

/** Kind of row. */
export type RowKind = "paint" | "mask" | "imageMask" | "background";

/** Tooltip of the Image Mask row's name. */
export const IMAGE_MASK_TOOLTIP = "From the image's transparency. A connected mask input will replace it.";

/** Tooltip of the row's name while it shows the `mask` input (M13b). */
export const INPUT_MASK_TOOLTIP = "From the connected mask input (it replaces the image's transparency; disconnect it to use that again).";

/**
 * Class of every row's name: wraps to at most 2 lines, then an ellipsis,
 * vertically centred; lifted (`cps-renaming`) while the one-line rename
 * field is open (`styles/layers.css`).
 */
export const LAYER_NAME_CLAMP_CLASS = "cps-layer-name-clamp";

/** CSS class suffix per row kind (`cps-layer-<suffix>`). */
const ROW_CLASS: Readonly<Record<RowKind, string>> = { paint: "paint", mask: "mask", imageMask: "image-mask", background: "background" };

/** Display state of a row. */
export interface RowModel {
  id: string;
  name: string;
  visible: boolean;
  locked: boolean;
  /** Highlighted: the paint target (active paint layer, or the mask in Quick Mask). */
  selected: boolean;
  /** Active paint layer while Quick Mask targets the mask (subtle marker). */
  standby: boolean;
  /** Mask display colour. */
  color?: string;
  /** Mask invert. */
  invert?: boolean;
  /** Current mask (M8): thick left bar in the mask's colour, Quick Mask on or off. */
  current?: boolean;
  /** Editable text layer ("T" badge on the thumbnail). */
  text?: boolean;
  /** Small note under the row (M13b: the Input Mask waiting for a run). */
  hint?: string;
  /**
   * Solo display (view only): `"on"` = this row is soloed, `"dimmed"` =
   * another row of its group is soloed, `"off"` = its group has no solo.
   */
  solo?: SoloMark;
  /** Paint rows (M14): layer mask slot; with a mask, the layer thumbnail frames the pixel target. */
  maskSlot?: MaskSlotModel;
}

/** Solo display state of a row. */
export type SoloMark = "on" | "dimmed" | "off";

/** Row callbacks (ids are layer ids). */
export interface RowActions extends MaskSlotActions {
  /** Plain row click (also the Background row, which isn't selectable: it only ends the lmask-only view). */
  select(id: string): void;
  /** Plain click on a masked layer's thumbnail: edit its pixels (M14). */
  targetLayer(id: string): void;
  /** Ctrl(+Shift/Alt)+click: load the layer's pixels as the selection. */
  loadSelection(id: string, mode: SelectionMode): void;
  toggleVisible(id: string): void;
  /** Solo / un-solo (solo button). */
  toggleSolo(id: string): void;
  toggleLocked(id: string): void;
  rename(id: string, name: string): void;
  pickColor(id: string, anchor: HTMLElement): void;
  toggleInvert(id: string): void;
  /** Inline rename started/ended (the panel defers rebuilds; focus is handed back). */
  renaming(active: boolean): void;
}

/**
 * A layers panel row.
 */
export class LayerRow {
  readonly element: HTMLDivElement;
  readonly thumb = new Thumbnail();
  private readonly nameEl: HTMLSpanElement;
  private readonly eye: HTMLButtonElement | null = null;
  private readonly lock: HTMLButtonElement;
  private readonly swatch: HTMLButtonElement | null = null;
  private readonly invertButton: HTMLButtonElement | null = null;
  private readonly textBadge: HTMLSpanElement | null = null;
  private readonly soloButton: HTMLButtonElement | null = null;
  private readonly hintEl: HTMLDivElement | null = null;
  /** Paint rows: add-mask icon / mask thumbnail (M14). */
  readonly maskSlot: LayerMaskSlot | null = null;
  private readonly thumbBox: HTMLSpanElement;
  private model: RowModel | null = null;
  private editor: HTMLInputElement | null = null;
  private icons = { eye: "", lock: "" };

  /**
   * @param kind - Row kind.
   * @param id - Layer id (`"background"` for the background row).
   * @param actions - Callbacks.
   * @param maskOpacity - Overlay opacity control (mask rows).
   */
  constructor(
    readonly kind: RowKind,
    readonly id: string,
    private readonly actions: RowActions,
    maskOpacity?: OptionControl,
  ) {
    this.element = document.createElement("div");
    this.element.className = `cps-layer-row cps-layer-${ROW_CLASS[kind]}`;
    const maskLike = kind === "mask" || kind === "imageMask";
    this.element.dataset["layerId"] = id;
    const main = document.createElement("div");
    main.className = "cps-layer-main";
    const thumbBox = document.createElement("span");
    thumbBox.className = "cps-layer-thumb-box";
    thumbBox.appendChild(this.thumb.canvas);
    this.thumbBox = thumbBox;
    main.appendChild(thumbBox);
    if (kind === "paint") {
      this.textBadge = document.createElement("span");
      this.textBadge.className = "cps-layer-text-badge";
      this.textBadge.title = "Text layer (click it with the Text tool to edit)";
      this.textBadge.hidden = true;
      setIcon(this.textBadge, "text", 12);
      thumbBox.appendChild(this.textBadge);
      // M14: a plain click on a masked layer's thumbnail edits its pixels
      // (other clicks, e.g. Ctrl+click, reach the row as before).
      thumbBox.addEventListener("click", (event) => {
        if (!this.model?.maskSlot?.mask || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
        event.stopPropagation();
        actions.targetLayer(id);
      });
      this.maskSlot = new LayerMaskSlot(id, actions);
      main.appendChild(this.maskSlot.element);
    }
    this.nameEl = document.createElement("span");
    // Up to 2 lines, then an ellipsis (CSS); the full name is in the tooltip.
    this.nameEl.className = `cps-layer-name ${LAYER_NAME_CLAMP_CLASS}`;
    main.appendChild(this.nameEl);

    this.soloButton = button("cps-layer-solo", () => actions.toggleSolo(id));
    setIcon(this.soloButton, "solo", 11);
    this.eye = button("cps-layer-eye", () => actions.toggleVisible(id));
    main.append(this.soloButton, this.eye);
    this.lock = button("cps-layer-lock", () => actions.toggleLocked(id));
    main.appendChild(this.lock);
    this.element.appendChild(main);

    if (kind === "background" || kind === "imageMask") {
      this.lock.disabled = true;
      this.lock.title = kind === "background" ? "The background (input image) is locked" : "The Image Mask can't be edited (duplicate it to edit)";
      setIcon(this.lock, "lock", 14);
    }
    // The Background row isn't selectable, but any click on it still goes to `select` (it ends the lmask-only view).
    if (kind === "background") {
      this.element.addEventListener("click", (event) => {
        if (!isControl(event.target)) actions.select(id);
      });
    } else {
      this.element.addEventListener("click", (event) => {
        if (isControl(event.target)) return;
        const mode = layerSelectMode({ ctrl: event.ctrlKey || event.metaKey, shift: event.shiftKey, alt: event.altKey });
        if (mode) actions.loadSelection(id, mode);
        else actions.select(id);
      });
      this.nameEl.addEventListener("dblclick", (event) => {
        event.stopPropagation();
        if (!event.ctrlKey && !event.metaKey) this.startRename();
      });
    }

    if (maskLike) {
      const extra = document.createElement("div");
      extra.className = "cps-layer-extra";
      const swatch = button("cps-layer-swatch", () => actions.pickColor(id, swatch));
      swatch.title = "Mask colour (display only)";
      const invert = button("cps-layer-invert", () => actions.toggleInvert(id));
      setIcon(invert, "invert", 14);
      extra.append(swatch, invert);
      if (maskOpacity) extra.appendChild(maskOpacity.element);
      this.element.appendChild(extra);
      this.swatch = swatch;
      this.invertButton = invert;
    }
    if (kind === "imageMask") {
      this.hintEl = document.createElement("div");
      this.hintEl.className = "cps-layer-hint";
      this.hintEl.hidden = true;
      this.element.appendChild(this.hintEl);
    }
  }

  /** Whether the name is being edited. */
  get isRenaming(): boolean {
    return this.editor !== null;
  }

  /**
   * Apply display state.
   * @param model - New state.
   */
  update(model: RowModel): void {
    this.model = model;
    const el = this.element;
    el.classList.toggle("cps-selected", model.selected);
    el.classList.toggle("cps-standby", model.standby);
    el.classList.toggle("cps-hidden-layer", !model.visible);
    if (this.textBadge) this.textBadge.hidden = model.text !== true;
    if (this.maskSlot) this.maskSlot.update(model.maskSlot ?? { canHave: false, mask: null });
    const slotMask = model.maskSlot?.mask;
    this.thumbBox.classList.toggle("cps-target", !!slotMask && !slotMask.targeted);
    const current = model.current === true;
    el.classList.toggle("cps-current-mask", current);
    if (current && model.color) el.style.setProperty("--cps-mask-color", model.color);
    else el.style.removeProperty("--cps-mask-color");
    el.title = current && this.kind === "mask" ? "Current mask (Quick Mask paints into it)" : "";
    const solo = model.solo ?? "off";
    if (this.soloButton) {
      this.soloButton.classList.toggle("cps-active", solo === "on");
      this.soloButton.setAttribute("aria-pressed", String(solo === "on"));
      this.soloButton.title =
        solo === "on"
          ? "End solo (view only)"
          : this.kind === "background"
            ? "Solo the background: hide all paint layers (view only)"
            : "Solo: show only this layer in its group (view only)";
    }
    if (!this.editor) this.nameEl.textContent = model.name;
    this.nameEl.title =
      this.kind === "background" ? "Input image" : this.kind === "imageMask" ? imageMaskTooltip(model.name) : `${model.name} (double-click to rename)`;
    if (this.kind === "imageMask") this.lock.title = `The ${model.name} can't be edited (duplicate it to edit)`;
    if (this.hintEl) {
      this.hintEl.textContent = model.hint ?? "";
      this.hintEl.hidden = !model.hint;
    }
    if (this.eye) {
      const icon = model.visible ? "eye" : "eyeOff";
      if (icon !== this.icons.eye) setIcon(this.eye, icon, 14);
      this.icons.eye = icon;
      this.eye.classList.toggle("cps-off", !model.visible);
      this.eye.classList.toggle("cps-solo-dimmed", solo === "dimmed");
      this.eye.classList.toggle("cps-solo-on", solo === "on");
      this.eye.setAttribute("aria-pressed", String(model.visible));
      this.eye.title =
        this.kind === "background"
          ? model.visible
            ? "Hide background (shows transparency; outputs use the background colour instead of the image)"
            : "Show background (input image)"
          : this.kind !== "paint"
          ? model.visible
            ? "Hide mask (also excludes it from the MASK output)"
            : "Show mask (hidden masks are excluded from the MASK output)"
          : model.visible
            ? "Hide layer"
            : "Show layer";
    }
    if (this.kind === "paint" || this.kind === "mask") {
      const icon = model.locked ? "lock" : "unlock";
      if (icon !== this.icons.lock) setIcon(this.lock, icon, 14);
      this.icons.lock = icon;
      this.lock.classList.toggle("cps-on", model.locked);
      this.lock.setAttribute("aria-pressed", String(model.locked));
      this.lock.title = model.locked ? "Unlock layer" : "Lock layer (refuses painting)";
    }
    if (this.swatch && model.color) this.swatch.style.backgroundColor = model.color;
    if (this.invertButton) {
      const on = model.invert === true;
      this.invertButton.classList.toggle("cps-active", on);
      this.invertButton.setAttribute("aria-pressed", String(on));
      this.invertButton.title = on ? "Mask inverted (click to un-invert)" : "Invert mask";
    }
  }

  /** Begin inline renaming. */
  startRename(): void {
    if (this.editor || this.kind === "background" || this.kind === "imageMask") return;
    this.actions.renaming(true);
    // The rename field stays one line: the 2-line clamp is lifted while it's open.
    this.nameEl.classList.add("cps-renaming");
    this.editor = startInlineRename(this.nameEl, this.model?.name ?? "", (value) => {
      this.editor = null;
      this.nameEl.classList.remove("cps-renaming");
      this.nameEl.textContent = this.model?.name ?? "";
      if (value !== null) this.actions.rename(this.id, value);
      this.actions.renaming(false);
    });
  }
}

/** Name tooltip of the Image Mask / Input Mask row (by its name). */
function imageMaskTooltip(name: string): string {
  return name === INPUT_MASK_NAME ? INPUT_MASK_TOOLTIP : IMAGE_MASK_TOOLTIP;
}

function button(className: string, onClick: (event: MouseEvent) => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = `cps-icon-button cps-layer-button ${className}`;
  b.addEventListener("click", (event) => {
    event.stopPropagation();
    event.preventDefault();
    onClick(event);
  });
  return b;
}

/**
 * Whether an event target is an interactive control inside a row (buttons,
 * inputs, the opacity control) rather than the row itself.
 * @param target - Event target.
 * @returns `true` for controls.
 */
export function isControl(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest("button, input, select, .cps-num") !== null;
}
