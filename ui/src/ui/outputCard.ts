/**
 * Output cards of the Outputs tab (SPEC "Outputs and regions (editor)").
 *
 * - {@link RegionCard} (filled slot): row 1 eye, title (`N · name`,
 *   double-click renames like a layer row), delete; row 2 X / Y / W / H in
 *   current-image px (scrub labels); row 3 options.
 * - {@link MainCard}: fixed title `Main`, read-only image size, options.
 *
 * Clicking a card selects it (a view change, not a document edit). Cards are
 * refreshed in place; a field being edited keeps its text.
 */

import { regionName, regionSlotLabel } from "../document/regions";
import type { Region } from "../document/types";
import { regionFieldBounds } from "../engine/regionGeometry";
import type { RegionRectField } from "../engine/regionGeometry";
import { clampNumber } from "../geometry/rect";
import { setIcon } from "./icons";
import { startInlineRename } from "./inlineRename";
import { isControl } from "./layerRow";
import { outputField } from "./outputField";
import type { OutputField } from "./outputField";
import { OutputOptionsRow } from "./outputOptionsRow";
import type { OutputCardContext } from "./outputOptionsRow";

/** X / Y / W / H fields in display order. */
const RECT_FIELDS: ReadonlyArray<readonly [RegionRectField, string, string]> = [
  ["x", "X", "Left edge (image px)"],
  ["y", "Y", "Top edge (image px)"],
  ["width", "W", "Width (image px)"],
  ["height", "H", "Height (image px)"],
];

/**
 * Card element with click-to-select.
 * @param ctx - Card services.
 * @param id - Region id, or null for Main.
 * @returns Section element.
 */
function cardElement(ctx: OutputCardContext, id: string | null): HTMLElement {
  const element = document.createElement("section");
  element.className = "cps-output-card";
  element.addEventListener("pointerdown", (event) => {
    if (isControl(event.target)) return;
    ctx.editor.regionOps.select(id);
  });
  element.addEventListener("focusin", () => ctx.editor.regionOps.select(id));
  return element;
}

/**
 * Small icon button that never takes the row's click.
 * @param className - Extra class.
 * @param icon - Icon name.
 * @param onClick - Handler.
 * @returns Button.
 */
function iconButton(className: string, icon: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `cps-icon-button cps-layer-button ${className}`;
  setIcon(button, icon, 14);
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    event.preventDefault();
    onClick();
  });
  return button;
}

// ═══════════════════════════════════════════════════════════════════════════
// RegionCard
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Card of one filled slot, bound to one region id for its lifetime.
 */
export class RegionCard {
  readonly element: HTMLElement;
  private readonly eye: HTMLButtonElement;
  private readonly title = document.createElement("span");
  private readonly fields: OutputField[] = [];
  private readonly options: OutputOptionsRow;
  private renaming = false;
  private eyeIcon = "";

  /**
   * @param id - Region id.
   * @param ctx - Card services.
   */
  constructor(
    readonly id: string,
    private readonly ctx: OutputCardContext,
  ) {
    const ops = ctx.editor.regionOps;
    this.element = cardElement(ctx, id);

    const header = document.createElement("div");
    header.className = "cps-output-header";
    this.eye = iconButton("cps-layer-eye", "eye", () => {
      ctx.beforeEdit();
      ops.setVisible(id, !(this.region()?.visible ?? true));
    });
    this.title.className = "cps-layer-name cps-output-title";
    this.title.addEventListener("dblclick", (event) => {
      event.stopPropagation();
      this.startRename();
    });
    const remove = iconButton("cps-output-delete", "trash", () => {
      ctx.beforeEdit();
      ops.remove(id);
    });
    remove.title = "Delete region (empties the slot)";
    remove.setAttribute("aria-label", remove.title);
    header.append(this.eye, this.title, remove);

    const geometry = document.createElement("div");
    geometry.className = "cps-output-geometry";
    for (const [key, label, title] of RECT_FIELDS) {
      const field = this.rectField(key, label, title);
      this.fields.push(field);
      geometry.append(field.element);
    }

    this.options = new OutputOptionsRow(id, ctx);
    this.element.append(header, geometry, this.options.element);
    this.refresh();
  }

  /** Show the region's current state. */
  refresh(): void {
    const region = this.region();
    if (!region) return;
    const selected = this.ctx.editor.regionOps.selectedId === this.id;
    this.element.classList.toggle("cps-selected", selected);
    this.element.classList.toggle("cps-hidden-layer", !region.visible);
    if (!this.renaming) this.title.textContent = regionSlotLabel(region);
    this.title.title = `${regionSlotLabel(region)} -- output pair ${region.slot} (double-click to rename)`;
    const icon = region.visible ? "eye" : "eyeOff";
    if (icon !== this.eyeIcon) setIcon(this.eye, icon, 14);
    this.eyeIcon = icon;
    this.eye.classList.toggle("cps-off", !region.visible);
    this.eye.title = region.visible ? "Hide outline (output unaffected)" : "Show outline";
    this.eye.setAttribute("aria-label", this.eye.title);
    this.eye.setAttribute("aria-pressed", String(region.visible));
    for (const field of this.fields) field.refresh();
    this.options.refresh();
  }

  /** Revert open sessions and remove the element. */
  dispose(): void {
    for (const field of this.fields) field.dispose();
    this.options.dispose();
    this.element.remove();
  }

  // ── Internals ───────────────────────────────────────────────────────────

  private region(): Region | undefined {
    return this.ctx.editor.doc.regions.find((region) => region.id === this.id);
  }

  /** Inline rename of just the name, pre-filled with the effective name. */
  private startRename(): void {
    const region = this.region();
    if (this.renaming || !region) return;
    this.renaming = true;
    startInlineRename(this.title, regionName(region), (value) => {
      this.renaming = false;
      if (value !== null) {
        this.ctx.beforeEdit();
        this.ctx.editor.regionOps.rename(this.id, value);
      }
      this.refresh();
      this.ctx.releaseFocus();
    });
  }

  /** One X / Y / W / H field, clamped to the region area. */
  private rectField(key: RegionRectField, label: string, title: string): OutputField {
    const { editor } = this.ctx;
    const ops = editor.regionOps;
    const bounds = (): { min: number; max: number } => {
      const rect = ops.imageRect(this.id);
      return rect ? regionFieldBounds(rect, key, editor.imageSize) : { min: 0, max: 0 };
    };
    return outputField({
      label,
      title,
      ops,
      beforeEdit: this.ctx.beforeEdit,
      releaseFocus: this.ctx.releaseFocus,
      read: () => ops.imageRect(this.id)?.[key] ?? 0,
      bounds,
      write: (value) => {
        const rect = ops.imageRect(this.id);
        if (!rect) return;
        const { min, max } = bounds();
        ops.setRect(this.id, { ...rect, [key]: clampNumber(Math.round(Number(value)), min, max) });
      },
    });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// MainCard
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Card of the Main output (always present).
 */
export class MainCard {
  readonly element: HTMLElement;
  private readonly size = document.createElement("span");
  private readonly options: OutputOptionsRow;

  /**
   * @param ctx - Card services.
   */
  constructor(private readonly ctx: OutputCardContext) {
    this.element = cardElement(ctx, null);
    this.element.classList.add("cps-output-main");
    const header = document.createElement("div");
    header.className = "cps-output-header";
    const title = document.createElement("span");
    title.className = "cps-layer-name cps-output-title";
    title.textContent = "Main";
    this.size.className = "cps-output-size";
    this.size.title = "Output size (current image px)";
    header.append(title, this.size);
    this.options = new OutputOptionsRow(null, ctx);
    this.element.append(header, this.options.element);
    this.refresh();
  }

  /** Show selection, size and options. */
  refresh(): void {
    const { editor } = this.ctx;
    this.element.classList.toggle("cps-selected", editor.regionOps.selectedId === null);
    this.size.textContent = `${editor.imageSize.width} x ${editor.imageSize.height}`;
    this.options.refresh();
  }

  /** Revert open sessions and remove the element. */
  dispose(): void {
    this.options.dispose();
    this.element.remove();
  }
}
