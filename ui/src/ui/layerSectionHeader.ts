/**
 * Section header element of the layers panel (`layerSections.ts` decides
 * order and titles): 11 px caps title, a chevron that rotates -90 deg when
 * collapsed (click anywhere on the header toggles), and an optional "+"
 * button. Collapsed, the masks header shows a 3 px left bar plus a swatch and
 * name of the current mask (`setInfo`).
 */

import { setIcon } from "./icons";
import { isCollapsible, sectionTitle } from "./layerSections";
import type { SectionId } from "./layerSections";

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

  /**
   * @param id - Section.
   * @param onToggle - Header clicked (collapsible sections).
   * @param addButton - "+" button tooltip and action, if any.
   */
  constructor(
    readonly id: SectionId,
    onToggle: () => void,
    addButton?: { title: string; onClick: () => void },
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
  }
}
