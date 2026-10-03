/**
 * Section header element of the layers panel (`layerSections.ts` decides
 * order and titles): 11 px caps title, a chevron that rotates -90 deg when
 * collapsed (click anywhere on the header toggles), and an optional "+" and
 * trash button (Delete acts on the selected row of the section; refused, it
 * is dimmed but stays clickable and reports why). Collapsed, the masks
 * header shows a 3 px left bar plus a swatch and name of the current mask.
 */

import { setIcon } from "./icons";
import { isCollapsible, sectionTitle } from "./layerSections";
import type { SectionDeleteState, SectionId } from "./layerSections";

/** What a header shows. */
export interface SectionHeaderModel {
  /** Section collapsed. */
  collapsed: boolean;
  /** Active paint layer's name (collapsed layers title). */
  activeName?: string;
  /** Current mask (collapsed masks header: bar colour, swatch and name). */
  currentMask?: { name: string; color: string } | null;
  /** "+" disabled (with its tooltip). */
  addDisabled?: { title: string } | null;
  /** Delete button state (`sectionDeleteState`); ignored by a header without one. */
  remove?: SectionDeleteState;
}

/**
 * One collapsible section header.
 */
export class SectionHeader {
  readonly element: HTMLDivElement;
  private readonly title: HTMLSpanElement;
  private readonly info: HTMLSpanElement;
  private readonly swatch: HTMLSpanElement;
  private readonly infoName: HTMLSpanElement;
  private readonly add: HTMLButtonElement | null = null;
  private readonly addTitle: string;
  private readonly remove: HTMLButtonElement | null = null;
  private removeState: SectionDeleteState = { refused: true, title: "" };

  /**
   * @param id - Section.
   * @param onToggle - Header clicked (collapsible sections).
   * @param addButton - "+" button tooltip and action, if any.
   * @param deleteButton - Trash button (right of the "+"), if any: `onDelete`
   *   when allowed, else `onRefused` with the reason (the state's `title`).
   */
  constructor(
    readonly id: SectionId,
    onToggle: () => void,
    addButton?: { title: string; onClick: () => void },
    deleteButton?: { onDelete: () => void; onRefused: (reason: string) => void },
  ) {
    this.element = document.createElement("div");
    this.element.className = `cps-layers-section cps-layers-section-${id}`;
    this.element.setAttribute("role", "heading");
    if (isCollapsible(id)) {
      this.element.classList.add("cps-collapsible");
      const chevron = document.createElement("span");
      chevron.className = "cps-layers-section-chevron";
      setIcon(chevron, "chevronDown", 16);
      this.element.appendChild(chevron);
      this.element.addEventListener("click", (event) => {
        if (event.target instanceof Element && event.target.closest("button")) return;
        onToggle();
      });
    }
    this.title = document.createElement("span");
    this.title.className = "cps-layers-section-title";
    this.info = document.createElement("span");
    this.info.className = "cps-layers-section-info";
    this.info.hidden = true;
    this.swatch = document.createElement("span");
    this.swatch.className = "cps-layers-section-swatch";
    this.infoName = document.createElement("span");
    this.infoName.className = "cps-layers-section-name";
    this.info.append(this.swatch, this.infoName);
    const spacer = document.createElement("span");
    spacer.className = "cps-layers-section-spacer";
    this.element.append(this.title, this.info, spacer);
    this.addTitle = addButton?.title ?? "";
    if (addButton) {
      const add = document.createElement("button");
      add.type = "button";
      add.className = "cps-icon-button cps-layers-section-add";
      add.title = addButton.title;
      setIcon(add, "plus", 15);
      add.addEventListener("click", (event) => {
        event.stopPropagation();
        addButton.onClick();
      });
      this.element.appendChild(add);
      this.add = add;
    }
    if (deleteButton) {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "cps-icon-button cps-layers-section-add cps-layers-section-delete";
      setIcon(remove, "trash", 15);
      remove.addEventListener("click", (event) => {
        event.stopPropagation();
        const state = this.removeState;
        if (!state.refused) deleteButton.onDelete();
        else if (state.title) deleteButton.onRefused(state.title);
      });
      this.element.appendChild(remove);
      this.remove = remove;
    }
    this.update({ collapsed: false });
  }

  /**
   * Apply display state.
   * @param model - Header state.
   */
  update(model: SectionHeaderModel): void {
    const collapsed = isCollapsible(this.id) && model.collapsed;
    this.element.classList.toggle("cps-collapsed", collapsed);
    this.element.setAttribute("aria-expanded", String(!collapsed));
    this.title.textContent = sectionTitle(this.id, collapsed, model.activeName);
    if (isCollapsible(this.id)) this.element.title = collapsed ? "Expand section" : "Collapse section";
    const mask = this.id === "masks" && collapsed ? model.currentMask : null;
    this.info.hidden = !mask;
    if (mask) {
      this.swatch.style.background = mask.color;
      this.infoName.textContent = mask.name;
      this.element.style.setProperty("--cps-section-bar", mask.color);
    } else {
      this.element.style.removeProperty("--cps-section-bar");
    }
    if (this.add) {
      this.add.disabled = !!model.addDisabled;
      this.add.title = model.addDisabled?.title ?? this.addTitle;
    }
    if (this.remove) {
      // Refused stays clickable (the click shows the reason as a note), only dimmed.
      this.removeState = model.remove ?? { refused: true, title: "" };
      this.remove.classList.toggle("cps-refused", this.removeState.refused);
      this.remove.setAttribute("aria-disabled", String(this.removeState.refused));
      this.remove.title = this.removeState.title || "Delete";
    }
  }
}
