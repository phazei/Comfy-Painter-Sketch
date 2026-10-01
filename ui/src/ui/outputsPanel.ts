/**
 * Outputs tab (SPEC "Outputs and regions (editor)"): the Main card plus six fixed slot cards. A filled slot
 * shows a {@link RegionCard}; an empty slot is a one-line `+ Region N` row
 * that creates the default centred region in that slot. Card N always feeds
 * helper output pair N.
 *
 * Updates only on the editor's `outputs` event (edits, selection, undo/redo,
 * Clear, image size) -- never on `render` -- and refreshes cards in place, so
 * a field being edited is never rebuilt.
 */

import { MAX_REGIONS, defaultRegionName } from "../document/regions";
import type { Editor } from "../engine/editor";
import { setIcon } from "./icons";
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

/** One fixed slot: its wrapper, the empty row and the card while filled. */
interface SlotView {
  slot: number;
  element: HTMLDivElement;
  empty: HTMLButtonElement;
  card: RegionCard | null;
}

// ═══════════════════════════════════════════════════════════════════════════
// OutputsPanel
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Session-bound list of outputs.
 */
export class OutputsPanel {
  readonly element = document.createElement("div");
  private readonly list = document.createElement("div");
  private readonly slots: SlotView[] = [];
  private main: MainCard | null = null;
  private editor: Editor | null = null;
  private unbind: Array<() => void> = [];

  /**
   * @param ctx - Host services.
   */
  constructor(private readonly ctx: OutputsPanelContext) {
    this.element.className = "cps-outputs";
    this.list.className = "cps-outputs-list";
    const hint = document.createElement("div");
    hint.className = "cps-outputs-hint";
    hint.textContent = "Drag on the image to add a region; Shift-drag starts a new one inside another.";
    for (let slot = 1; slot <= MAX_REGIONS; slot++) this.slots.push(this.slotView(slot));
    this.list.append(...this.slots.map((view) => view.element));
    this.element.append(this.list, hint);
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
    for (const view of this.slots) this.setCard(view, null);
    this.editor = editor;
    if (!editor) return;
    const ctx: OutputCardContext = { ...this.ctx, editor };
    this.main = new MainCard(ctx);
    this.list.prepend(this.main.element);
    this.unbind.push(editor.events.on("outputs", () => this.sync()));
    this.sync();
  }

  /** Unbind and remove. */
  dispose(): void {
    this.setEditor(null);
    this.element.remove();
  }

  // ── Internals ───────────────────────────────────────────────────────────

  /** Bring every card up to date; a slot's card is replaced only when its region changes. */
  private sync(): void {
    const editor = this.editor;
    if (!editor) return;
    this.main?.refresh();
    for (const view of this.slots) {
      const region = editor.regionOps.inSlot(view.slot);
      if (!region) {
        this.setCard(view, null);
        continue;
      }
      if (view.card?.id !== region.id) this.setCard(view, new RegionCard(region.id, { ...this.ctx, editor }));
      view.card?.refresh();
    }
  }

  /** Swap a slot between its empty row and a card. */
  private setCard(view: SlotView, card: RegionCard | null): void {
    if (view.card === card) return;
    view.card?.dispose();
    view.card = card;
    view.empty.hidden = card !== null;
    if (card) view.element.append(card.element);
  }

  /** Wrapper + `+ Region N` row of one slot. */
  private slotView(slot: number): SlotView {
    const element = document.createElement("div");
    element.className = "cps-output-slot";
    const empty = document.createElement("button");
    empty.type = "button";
    empty.className = "cps-output-empty";
    empty.title = `Add a centred region in slot ${slot}`;
    const icon = document.createElement("span");
    setIcon(icon, "plus", 12);
    const text = document.createElement("span");
    text.textContent = defaultRegionName(slot);
    empty.append(icon, text);
    empty.addEventListener("click", () => {
      this.ctx.beforeEdit();
      this.editor?.regionOps.addDefault(slot);
    });
    element.append(empty);
    return { slot, element, empty, card: null };
  }
}
