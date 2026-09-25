/**
 * Top options bar: renders the active tool's option descriptors generically
 * (`optionControls.ts`) into the shell's horizontally scrolling bar region,
 * plus the Quick Mask "Mask" badge in the fixed leading area (the mask eye
 * toggle lives on the layers panel's mask row since M3.3). Groups the tool
 * lists in `ToolOptions.groups` (pen pressure) collapse behind one icon
 * button with a popover (`optionGroup.ts`); layout is {@link layoutOptions}.
 */

import { layoutOptions } from "../tools/options";
import type { ToolOptions } from "../tools/options";
import type { BarRegions } from "./shell";
import { createControl } from "./optionControls";
import type { OptionControl } from "./optionControls";
import { groupControl } from "./optionGroup";
import type { PopoverHost } from "./popover";

/** Mask state shown in the bar. */
export interface MaskIndicator {
  /** Strokes go to the mask (Quick Mask on). */
  targeting: boolean;
  /** Mask display colour. */
  color: string;
}

/**
 * Options bar bound to one tool's options at a time.
 */
export class OptionsBar {
  private options: ToolOptions | null = null;
  private controls: OptionControl[] = [];
  private readonly maskBadge: HTMLSpanElement;

  /**
   * @param regions - Shell bar regions to render into.
   * @param popovers - Popover host (number slider popovers).
   * @param onChange - Called after the user edits an option.
   */
  constructor(
    private readonly regions: BarRegions,
    private readonly popovers: PopoverHost,
    private readonly onChange: () => void,
  ) {
    this.maskBadge = document.createElement("span");
    this.maskBadge.className = "cps-mask-badge";
    this.maskBadge.textContent = "Mask";
    this.maskBadge.title = "Quick Mask: strokes paint the mask (Q to exit)";
    this.maskBadge.hidden = true;
    regions.leading.append(this.maskBadge);
  }

  /**
   * Show a tool's options (rebuilds controls only when the options object
   * changes, so an in-progress scrub survives refreshes).
   * @param options - Options to edit, or `null` for none.
   */
  bind(options: ToolOptions | null): void {
    if (options === this.options) {
      this.refresh();
      return;
    }
    this.closeOwnPopover();
    this.options = options;
    this.controls = [];
    const scroller = this.regions.scroller;
    scroller.replaceChildren();
    scroller.scrollLeft = 0;
    if (!options) return;
    const ctx = { options, popovers: this.popovers, changed: () => this.onChange() };
    for (const item of layoutOptions(options.descriptors, options.groups)) {
      if (item.kind === "separator") {
        scroller.appendChild(separator());
        continue;
      }
      const control = item.kind === "group" ? groupControl(item.group, item.descriptors, ctx) : createControl(item.desc, ctx);
      this.controls.push(control);
      scroller.appendChild(control.element);
    }
  }

  /** Re-read values from the bound options (after shortcuts changed them). */
  refresh(): void {
    for (const control of this.controls) control.refresh();
  }

  /**
   * Update the mask badge.
   * @param state - Current mask state.
   */
  setMask(state: MaskIndicator): void {
    this.maskBadge.hidden = !state.targeting;
    this.maskBadge.style.backgroundColor = state.color;
  }

  /** Close a slider popover anchored in the bar (its control is going away). */
  private closeOwnPopover(): void {
    this.popovers.closeAnchoredIn(this.regions.element);
  }
}

function separator(): HTMLSpanElement {
  const sep = document.createElement("span");
  sep.className = "cps-bar-sep";
  return sep;
}
