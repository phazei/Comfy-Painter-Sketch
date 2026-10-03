/**
 * Outputs tab content (SPEC "Outputs and regions (editor)", design handoff
 * "Outputs tab"), top to bottom:
 * 1. the Main card;
 * 2. the slot grid: six fixed slots. A filled slot selects its region; an
 *    empty slot creates the centred half-size region in that slot. Slot N
 *    always feeds helper output pair N;
 * 3. the selected region's card (only while a region is selected);
 * 4. the hint.
 *
 * Updates only on the editor's `outputs` event (edits, selection, undo/redo,
 * Clear, image size) -- never on `render` -- and refreshes in place: a field
 * being edited is never rebuilt, and the region card is swapped only when the
 * selected id changes (open sessions of the old card commit).
 *
 * The element itself is the scroll container when the side panel caps its
 * height.
 */

import { MAX_REGIONS, regionName } from "../document/regions";
import type { Editor } from "../engine/editor";
import { MainCard, RegionCard } from "./outputCard";
import type { OutputCardContext } from "./outputOptionsRow";
import type { PopoverHost } from "./popover";

/** Host services. */
export interface OutputsPanelContext {
  popovers: PopoverHost;
  /** Called before an edit starts (cancels canvas drags). */
  beforeEdit(): void;
  /** Hand keyboard focus back to the editor after a field blurs. */
  releaseFocus(): void;
}

/** Hint under the cards. */
export const OUTPUTS_HINT = "Drag on the image to add a region; Shift-drag starts a new one inside another.";

/**
 * Tooltip of an empty slot.
 * @param slot - Slot 1..6.
 * @returns Tooltip text.
 */
export function emptySlotTitle(slot: number): string {
  return `Add region ${slot} (centred) \u00b7 or drag on the image`;
}

// ═══════════════════════════════════════════════════════════════════════════
// OutputsPanel
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Session-bound Outputs tab.
 */
export class OutputsPanel {
  readonly element = document.createElement("div");
  private readonly slotGrid = document.createElement("div");
  private readonly slotButtons: HTMLButtonElement[] = [];
  private readonly hint = document.createElement("div");
  private main: MainCard | null = null;
  private regionCard: RegionCard | null = null;
  private editor: Editor | null = null;
  private unbind: Array<() => void> = [];

  /**
   * @param ctx - Host services.
   */
  constructor(private readonly ctx: OutputsPanelContext) {
    this.element.className = "cps-outputs";
    this.slotGrid.className = "cps-output-slots cps-mono";
    for (let slot = 1; slot <= MAX_REGIONS; slot++) this.slotButtons.push(this.slotButton(slot));
    this.slotGrid.append(...this.slotButtons);
    this.hint.className = "cps-outputs-hint";
    this.hint.textContent = OUTPUTS_HINT;
    this.element.append(this.slotGrid, this.hint);
  }

  /**
   * Bind to an editor (or none).
   * @param editor - Session editor, or null on detach.
   */
  setEditor(editor: Editor | null): void {
    for (const off of this.unbind) off();
    this.unbind = [];
    this.main?.dispose();
    this.main = null;
    this.regionCard?.dispose();
    this.regionCard = null;
    this.editor = editor;
    this.syncSlots();
    if (!editor) return;
    this.main = new MainCard(this.cardContext(editor));
    this.element.prepend(this.main.element);
    this.unbind.push(editor.events.on("outputs", () => this.sync()));
    this.sync();
  }

  /** Unbind and remove. */
  dispose(): void {
    this.setEditor(null);
    this.element.remove();
  }

  // ── Internals ───────────────────────────────────────────────────────────

  private cardContext(editor: Editor): OutputCardContext {
    return { ...this.ctx, editor };
  }

  /** Bring every part up to date. */
  private sync(): void {
    if (!this.editor) return;
    this.main?.refresh();
    this.syncSlots();
    this.syncRegionCard();
  }

  /**
   * Show the selected region's card; swap it only when the selected id
   * changes. Disposing the old card commits its open sessions, which may
   * re-enter {@link sync}; the recursion re-reads the selection.
   */
  private syncRegionCard(): void {
    const editor = this.editor;
    if (!editor) return;
    const id = editor.regionOps.selectedId;
    const card = this.regionCard;
    if (card && card.id !== id) {
      this.regionCard = null;
      card.dispose(false);
      this.syncRegionCard();
      return;
    }
    if (id !== null && !card) {
      const next = new RegionCard(id, this.cardContext(editor));
      this.regionCard = next;
      this.slotGrid.after(next.element);
    }
    this.regionCard?.refresh();
  }

  /** Slot buttons: filled / selected / empty state, label and tooltip. */
  private syncSlots(): void {
    const ops = this.editor?.regionOps;
    const selected = ops?.selectedId ?? null;
    this.slotButtons.forEach((button, index) => {
      const slot = index + 1;
      const region = ops?.inSlot(slot);
      button.classList.toggle("cps-filled", region !== undefined);
      button.classList.toggle("cps-empty", region === undefined);
      button.classList.toggle("cps-selected", region !== undefined && region.id === selected);
      button.setAttribute("aria-pressed", String(region !== undefined && region.id === selected));
      button.title = region ? regionName(region) : emptySlotTitle(slot);
      button.setAttribute("aria-label", button.title);
    });
  }

  /** One slot button: select a filled slot, fill an empty one. */
  private slotButton(slot: number): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "cps-output-slot cps-empty";
    button.textContent = String(slot);
    button.addEventListener("click", () => {
      const ops = this.editor?.regionOps;
      if (!ops) return;
      const region = ops.inSlot(slot);
      if (region) {
        ops.select(region.id);
        return;
      }
      this.ctx.beforeEdit();
      ops.addDefault(slot);
    });
    return button;
  }
}
