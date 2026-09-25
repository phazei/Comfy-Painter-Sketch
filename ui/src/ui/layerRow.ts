/**
 * One row of the layers panel: thumbnail, name (double-click renames inline:
 * Enter commits, Escape cancels, blur commits), visibility eye and lock.
 * Mask rows add a second line with the colour swatch, an invert toggle and
 * the overlay opacity control; the Background row is static (locked, not
 * selectable). Rows are reused across updates (keyed by layer id) so a
 * double-click survives the re-render the first click causes.
 */

import type { OptionControl } from "./optionControls";
import { setIcon } from "./icons";
import { Thumbnail } from "./thumbnails";

/** Kind of row. */
export type RowKind = "paint" | "mask" | "background";

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
}

/** Row callbacks (ids are layer ids). */
export interface RowActions {
  select(id: string): void;
  toggleVisible(id: string): void;
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
    this.element.className = `cps-layer-row cps-layer-${kind}`;
    this.element.dataset["layerId"] = id;
    const main = document.createElement("div");
    main.className = "cps-layer-main";
    const thumbBox = document.createElement("span");
    thumbBox.className = "cps-layer-thumb-box";
    thumbBox.appendChild(this.thumb.canvas);
    this.nameEl = document.createElement("span");
    this.nameEl.className = "cps-layer-name";
    main.append(thumbBox, this.nameEl);

    if (kind !== "background") {
      this.eye = button("cps-layer-eye", () => actions.toggleVisible(id));
      main.appendChild(this.eye);
    }
    this.lock = button("cps-layer-lock", () => actions.toggleLocked(id));
    main.appendChild(this.lock);
    this.element.appendChild(main);

    if (kind === "background") {
      this.lock.disabled = true;
      this.lock.title = "The background (input image) is locked";
      setIcon(this.lock, "lock", 14);
    } else {
      this.element.addEventListener("click", (event) => {
        if (!isControl(event.target)) actions.select(id);
      });
      this.nameEl.addEventListener("dblclick", (event) => {
        event.stopPropagation();
        this.startRename();
      });
    }

    if (kind === "mask") {
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
    if (!this.editor) this.nameEl.textContent = model.name;
    this.nameEl.title = this.kind === "background" ? "Input image" : `${model.name} (double-click to rename)`;
    if (this.eye) {
      const icon = model.visible ? "eye" : "eyeOff";
      if (icon !== this.icons.eye) setIcon(this.eye, icon, 14);
      this.icons.eye = icon;
      this.eye.classList.toggle("cps-off", !model.visible);
      this.eye.setAttribute("aria-pressed", String(model.visible));
      this.eye.title =
        this.kind === "mask"
          ? model.visible
            ? "Hide mask (also excludes it from the MASK output)"
            : "Show mask (hidden masks are excluded from the MASK output)"
          : model.visible
            ? "Hide layer"
            : "Show layer";
    }
    if (this.kind !== "background") {
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
    if (this.editor || this.kind === "background") return;
    const input = document.createElement("input");
    input.type = "text";
    input.className = "cps-layer-rename";
    input.value = this.model?.name ?? "";
    input.spellcheck = false;
    input.maxLength = 100;
    this.editor = input;
    this.nameEl.replaceChildren(input);
    this.actions.renaming(true);
    let done = false;
    const finish = (commit: boolean): void => {
      if (done) return;
      done = true;
      const value = input.value;
      this.editor = null;
      this.nameEl.textContent = this.model?.name ?? "";
      if (commit) this.actions.rename(this.id, value);
      this.actions.renaming(false);
    };
    input.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Enter") {
        event.preventDefault();
        finish(true);
      } else if (event.key === "Escape") {
        event.preventDefault();
        finish(false);
      }
    });
    input.addEventListener("blur", () => finish(true));
    input.addEventListener("pointerdown", (event) => event.stopPropagation());
    input.addEventListener("click", (event) => event.stopPropagation());
    input.focus({ preventScroll: true });
    input.select();
  }
}

function button(className: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = `cps-icon-button cps-layer-button ${className}`;
  b.addEventListener("click", (event) => {
    event.stopPropagation();
    onClick();
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
