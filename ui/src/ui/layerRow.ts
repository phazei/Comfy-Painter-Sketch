/**
 * One row of the layers panel (design handoff "Layers tab"), left to right:
 *
 * - cmask: 3 px current bar (mask colour) | eye | 36 x 28 thumbnail (a plain
 *   minus badge for a Subtract cmask, like the lock badge) | name over a sub-line (10 px colour swatch,
 *   "Subtract" when on; the overlay opacity is the panel header's chip) |
 *   subtract | lock | solo.
 * - paint / text: spacer | eye | checker thumbnail ("T" badge for text) |
 *   lmask slot (`layerMaskThumb.ts`) | name (+ "Text") | lock | solo.
 * - Image / Input Mask: like a cmask (bar, swatch, subtract) with a
 *   lock badge on the thumbnail instead of a lock button, plus Duplicate
 *   ("Duplicate to an editable mask"); no rename, never dragged.
 * - Background: spacer | eye | thumbnail + lock badge | "Background" /
 *   "Read-only" | Duplicate ("Duplicate to an editable layer") | solo.
 *   Selectable (read-only, like the Image Mask); Ctrl+click does nothing.
 *
 * Name: double-click renames inline (Enter / blur commit, Esc cancels).
 * Selected rows get the accent background and a ring on the targeted
 * thumbnail (pixels or lmask); hidden (or solo-hidden) rows dim. Rows are
 * reused across updates (keyed by layer id) so a double-click survives the
 * re-render the first click causes.
 */

import { INPUT_MASK_NAME } from "../document/imageMask";
import type { SelectionMode } from "../engine/selection";
import { layerSelectMode } from "./moveCursors";
import { setIcon } from "./icons";
import { startInlineRename } from "./inlineRename";
import { LayerMaskSlot } from "./layerMaskThumb";
import type { MaskSlotActions, MaskSlotModel } from "./layerMaskThumb";
import { Thumbnail } from "./thumbnails";

/** Kind of row. */
export type RowKind = "paint" | "mask" | "imageMask" | "background";

/** Tooltip of the Image Mask row's name. */
export const IMAGE_MASK_TOOLTIP = "From the image's transparency. A connected mask input will replace it.";

/** Tooltip of the row's name while it shows the `mask` input (the Input Mask). */
export const INPUT_MASK_TOOLTIP = "From the connected mask input (it replaces the image's transparency; disconnect it to use that again).";

/**
 * Class of every row's name: 2 lines then an ellipsis (1 line when the row
 * has a sub-line); lifted (`cps-renaming`) while the one-line rename field is
 * open (`styles/layerRows.css`).
 */
export const LAYER_NAME_CLAMP_CLASS = "cps-layer-name-clamp";

/** Tooltip of a Subtract cmask's badge and (on) button. */
const SUBTRACT_ON_TITLE = "Subtract mask: its coverage is removed from the other masks (click to make it normal)";

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
  /** Subtract cmask: its coverage is removed from the cmask union (badge, sub-line, button on). */
  subtract?: boolean;
  /** Current mask: left bar in the mask's colour, Quick Mask on or off. */
  current?: boolean;
  /** Editable text layer ("T" badge, "Text" sub-line). */
  text?: boolean;
  /** Small note under the row (e.g. the Input Mask waiting for a run). */
  hint?: string;
  /** Read-only rows (Image / Input Mask, Background): Duplicate enabled. */
  canDuplicate?: boolean;
  /**
   * Solo display (view only): `"on"` = this row is soloed, `"dimmed"` =
   * another row is soloed, `"off"` = no solo.
   */
  solo?: SoloMark;
  /** Paint rows: layer mask slot; with a mask, the targeted thumbnail gets the ring. */
  maskSlot?: MaskSlotModel;
}

/** Solo display state of a row. */
export type SoloMark = "on" | "dimmed" | "off";

/** Row callbacks (ids are layer ids). */
export interface RowActions extends MaskSlotActions {
  /** Plain row click (also the read-only Background row). */
  select(id: string): void;
  /** Plain click on a masked layer's thumbnail: edit its pixels. */
  targetLayer(id: string): void;
  /** Ctrl(+Shift/Alt)+click: load the layer's pixels as the selection. */
  loadSelection(id: string, mode: SelectionMode): void;
  toggleVisible(id: string): void;
  /** Solo / un-solo (solo button). */
  toggleSolo(id: string): void;
  toggleLocked(id: string): void;
  rename(id: string, name: string): void;
  pickColor(id: string, anchor: HTMLElement): void;
  toggleSubtract(id: string): void;
  /** Duplicate button of a read-only row (Image / Input Mask, Background). */
  duplicate(id: string): void;
  /** Inline rename started/ended (the panel defers rebuilds; focus is handed back). */
  renaming(active: boolean): void;
}

/**
 * A layers panel row.
 */
export class LayerRow {
  readonly element: HTMLDivElement;
  readonly thumb = new Thumbnail();
  /** Paint rows: add-mask icon / mask thumbnail. */
  readonly maskSlot: LayerMaskSlot | null = null;
  private readonly nameEl: HTMLSpanElement;
  private readonly sub: HTMLDivElement;
  private readonly eye: HTMLButtonElement;
  private readonly lock: HTMLButtonElement | null = null;
  private readonly swatch: HTMLButtonElement | null = null;
  private readonly subtractButton: HTMLButtonElement | null = null;
  private readonly dupButton: HTMLButtonElement | null = null;
  private readonly textBadge: HTMLSpanElement | null = null;
  private readonly subtractBadge: HTMLSpanElement | null = null;
  private readonly subtractLabel: HTMLSpanElement | null = null;
  private readonly soloButton: HTMLButtonElement;
  private readonly hintEl: HTMLDivElement | null = null;
  private readonly thumbBox: HTMLSpanElement;
  private model: RowModel | null = null;
  private editor: HTMLInputElement | null = null;
  private icons = { eye: "", lock: "" };

  /**
   * @param kind - Row kind.
   * @param id - Layer id (`"background"` for the background row).
   * @param actions - Callbacks.
   */
  constructor(
    readonly kind: RowKind,
    readonly id: string,
    private readonly actions: RowActions,
  ) {
    const maskLike = kind === "mask" || kind === "imageMask";
    const readOnly = kind === "imageMask" || kind === "background";
    this.element = el("div", `cps-layer-row cps-layer-${ROW_CLASS[kind]}`);
    this.element.dataset["layerId"] = id;

    const bar = el("span", "cps-layer-bar");
    this.eye = button("cps-layer-eye", () => actions.toggleVisible(id));
    this.thumbBox = el("span", "cps-layer-thumb-box");
    this.thumbBox.appendChild(this.thumb.canvas);
    this.element.append(bar, this.eye, this.thumbBox);

    if (kind === "paint") {
      this.textBadge = el("span", "cps-layer-badge cps-layer-text-badge");
      this.textBadge.title = "Text layer (click it with the Text tool to edit)";
      this.textBadge.textContent = "T";
      this.textBadge.hidden = true;
      this.thumbBox.appendChild(this.textBadge);
      // A plain click on a masked layer's thumbnail edits its pixels
      // (other clicks, e.g. Ctrl+click, reach the row as before).
      this.thumbBox.addEventListener("click", (event) => {
        if (!this.model?.maskSlot?.mask || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
        event.stopPropagation();
        actions.targetLayer(id);
      });
      this.maskSlot = new LayerMaskSlot(id, actions);
      this.element.appendChild(this.maskSlot.element);
    }
    if (maskLike) {
      this.subtractBadge = el("span", "cps-layer-badge cps-layer-subtract-badge");
      this.subtractBadge.title = SUBTRACT_ON_TITLE;
      setIcon(this.subtractBadge, "minus", 9);
      this.subtractBadge.hidden = true;
      this.thumbBox.appendChild(this.subtractBadge);
    }
    if (readOnly) {
      const badge = el("span", "cps-layer-badge cps-layer-lock-badge");
      badge.title = kind === "background" ? "Read-only: the background (input image) is locked" : "Read-only (duplicate it to edit)";
      setIcon(badge, "lock", 9);
      this.thumbBox.appendChild(badge);
    }

    const text = el("div", "cps-layer-text");
    // Up to 2 lines, then an ellipsis (CSS); the full name is in the tooltip.
    this.nameEl = el("span", `cps-layer-name ${LAYER_NAME_CLAMP_CLASS}`);
    this.sub = el("div", "cps-layer-sub");
    text.append(this.nameEl, this.sub);
    if (maskLike) {
      const swatch = button("cps-layer-swatch", () => actions.pickColor(id, swatch));
      swatch.title = "Mask colour (display only)";
      this.subtractLabel = el("span", "cps-layer-subtract-label");
      this.subtractLabel.textContent = "Subtract";
      this.subtractLabel.hidden = true;
      this.sub.append(swatch, this.subtractLabel);
      this.swatch = swatch;
    } else if (kind === "background") {
      this.sub.textContent = "Read-only";
    } else {
      this.sub.textContent = "Text";
    }
    if (kind === "imageMask") {
      this.hintEl = el("div", "cps-layer-hint");
      this.hintEl.hidden = true;
      text.appendChild(this.hintEl);
    }
    this.element.appendChild(text);

    if (maskLike) {
      this.subtractButton = button("cps-layer-subtract", () => actions.toggleSubtract(id));
      setIcon(this.subtractButton, "maskSubtract", 16);
      this.element.appendChild(this.subtractButton);
    }
    if (!readOnly) {
      this.lock = button("cps-layer-lock", () => actions.toggleLocked(id));
      this.element.appendChild(this.lock);
    }
    if (readOnly) {
      this.dupButton = button("cps-layer-dup", () => actions.duplicate(id));
      this.dupButton.title = kind === "background" ? "Duplicate to an editable layer" : "Duplicate to an editable mask";
      setIcon(this.dupButton, "duplicate", 15);
      this.element.appendChild(this.dupButton);
    }
    this.soloButton = button("cps-layer-solo", () => actions.toggleSolo(id));
    setIcon(this.soloButton, "solo", 16);
    this.element.appendChild(this.soloButton);

    // The Background row: a plain click selects it (read-only); Ctrl+click does nothing (no pixels to load).
    if (kind === "background") {
      this.element.addEventListener("click", (event) => {
        if (!isControl(event.target) && !event.ctrlKey && !event.metaKey) actions.select(id);
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
    const solo = model.solo ?? "off";
    el.classList.toggle("cps-selected", model.selected);
    el.classList.toggle("cps-standby", model.standby && !model.selected);
    el.classList.toggle("cps-hidden-layer", solo === "off" ? !model.visible : solo === "dimmed");
    if (this.textBadge) this.textBadge.hidden = model.text !== true;
    if (this.maskSlot) this.maskSlot.update(model.maskSlot ?? { canHave: false, mask: null });
    // The ring (selected rows) goes on the targeted thumbnail: the lmask when it is the target, else this one.
    this.thumbBox.classList.toggle("cps-target", model.maskSlot?.mask?.targeted !== true);
    const hasSub = this.kind !== "paint" || model.text === true;
    this.sub.hidden = !hasSub;
    el.classList.toggle("cps-has-sub", hasSub);
    const current = model.current === true;
    el.classList.toggle("cps-current-mask", current);
    if (model.color) el.style.setProperty("--cps-mask-color", model.color);
    else el.style.removeProperty("--cps-mask-color");
    el.title = current && this.kind === "mask" ? "Current mask (Quick Mask paints into it)" : "";
    this.soloButton.classList.toggle("cps-active", solo === "on");
    this.soloButton.setAttribute("aria-pressed", String(solo === "on"));
    this.soloButton.title =
      solo === "on"
        ? "End solo (view only)"
        : this.kind === "background"
          ? "Solo the background: hide all paint layers (view only)"
          : "Solo: show only this layer in its group (view only)";
    if (!this.editor) this.nameEl.textContent = model.name;
    this.nameEl.title =
      this.kind === "background" ? "Input image" : this.kind === "imageMask" ? imageMaskTooltip(model.name) : `${model.name} (double-click to rename)`;
    if (this.hintEl) {
      this.hintEl.textContent = model.hint ?? "";
      this.hintEl.hidden = !model.hint;
    }
    if (this.dupButton) this.dupButton.disabled = model.canDuplicate !== true;
    this.updateEye(model, solo);
    if (this.lock) {
      const icon = model.locked ? "lock" : "unlock";
      if (icon !== this.icons.lock) setIcon(this.lock, icon, 15);
      this.icons.lock = icon;
      this.lock.classList.toggle("cps-on", model.locked);
      this.lock.setAttribute("aria-pressed", String(model.locked));
      this.lock.title = model.locked ? "Unlock layer" : "Lock layer (refuses painting)";
    }
    if (this.swatch && model.color) this.swatch.style.backgroundColor = model.color;
    if (this.subtractButton) {
      const on = model.subtract === true;
      this.subtractButton.classList.toggle("cps-active", on);
      this.subtractButton.setAttribute("aria-pressed", String(on));
      this.subtractButton.title = on ? SUBTRACT_ON_TITLE : "Subtract: remove this mask's coverage from the other masks";
      el.classList.toggle("cps-subtract", on);
      if (this.subtractBadge) this.subtractBadge.hidden = !on;
      if (this.subtractLabel) this.subtractLabel.hidden = !on;
    }
  }

  /** Begin inline renaming. */
  startRename(): void {
    if (this.editor || this.kind === "background" || this.kind === "imageMask") return;
    this.actions.renaming(true);
    // The rename field stays one line: the clamp is lifted while it's open.
    this.nameEl.classList.add("cps-renaming");
    this.editor = startInlineRename(this.nameEl, this.model?.name ?? "", (value) => {
      this.editor = null;
      this.nameEl.classList.remove("cps-renaming");
      this.nameEl.textContent = this.model?.name ?? "";
      if (value !== null) this.actions.rename(this.id, value);
      this.actions.renaming(false);
    });
  }

  private updateEye(model: RowModel, solo: SoloMark): void {
    const eye = this.eye;
    const icon = model.visible ? "eye" : "eyeOff";
    if (icon !== this.icons.eye) setIcon(eye, icon, 17);
    this.icons.eye = icon;
    eye.classList.toggle("cps-off", !model.visible);
    eye.classList.toggle("cps-solo-dimmed", solo === "dimmed");
    eye.classList.toggle("cps-solo-on", solo === "on");
    eye.setAttribute("aria-pressed", String(model.visible));
    eye.title =
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
}

/** Name tooltip of the Image Mask / Input Mask row (by its name). */
function imageMaskTooltip(name: string): string {
  return name === INPUT_MASK_NAME ? INPUT_MASK_TOOLTIP : IMAGE_MASK_TOOLTIP;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.className = className;
  return element;
}

function button(className: string, onClick: (event: MouseEvent) => void): HTMLButtonElement {
  const b = el("button", `cps-icon-button cps-layer-button ${className}`);
  b.type = "button";
  b.addEventListener("click", (event) => {
    event.stopPropagation();
    event.preventDefault();
    onClick(event);
  });
  return b;
}

/**
 * Whether an event target is an interactive control inside a row (buttons,
 * inputs) rather than the row itself.
 * @param target - Event target.
 * @returns `true` for controls.
 */
export function isControl(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest("button, input, select") !== null;
}
