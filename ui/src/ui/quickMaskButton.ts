/**
 * The bottom bar's Quick Mask button (design handoff section 6 "Quick Mask
 * button"; SPEC "Layers" > "cmasks, current mask and Quick Mask"): the
 * `quickMask` icon + "Quick Mask" + a corner caret. A tap toggles Quick
 * Mask (like Q); a long-press, right-click or the caret opens "Quick Mask
 * paints", the cmask list (top-most first, current marked) -- picking one
 * makes it current and turns Quick Mask on. While on, the button is tinted
 * with the current mask's colour (`--cps-qm-color`). The Image / Input Mask
 * row being current doesn't count as on (the chip shows it as read-only);
 * a tap then switches to the top-most editable cmask. Hidden in region mode.
 */

import { IMAGE_MASK_ID } from "../document/imageMask";
import { maskDisplayColor } from "../document/masks";
import type { EditorSession } from "../widget/sessions";
import { inRegionMode } from "./editChip";
import { setIcon } from "./icons";
import { cornerCaret, installLongPress } from "./longPress";
import type { LongPressHandle } from "./longPress";
import { openMenu } from "./menu";
import type { MenuEntry } from "./menu";
import type { PopoverHost } from "./popover";

/** What the button needs from the host. */
export interface QuickMaskContext {
  readonly popovers: PopoverHost;
  getSession(): EditorSession | null;
  /** Cancel drags / pending tool interactions first. */
  beforeEdit(): void;
}

/**
 * The Quick Mask button.
 */
export class QuickMaskButton {
  /** The button. */
  readonly element: HTMLButtonElement;
  private readonly icon: HTMLSpanElement;
  private readonly press: LongPressHandle;
  /** Last rendered state key. */
  private shown = "";

  /**
   * @param ctx - Host callbacks.
   */
  constructor(private readonly ctx: QuickMaskContext) {
    this.element = document.createElement("button");
    this.element.type = "button";
    this.element.className = "cps-qm-button";
    this.element.title = "Quick Mask (Q) \u00b7 hold or right-click to pick the mask";
    this.icon = document.createElement("span");
    this.icon.className = "cps-qm-icon";
    setIcon(this.icon, "quickMask", 16);
    const label = document.createElement("span");
    label.textContent = "Quick Mask";
    this.element.append(this.icon, label);
    this.press = installLongPress(this.element, { tap: () => this.toggle(), hold: () => this.openMenu() });
    this.element.appendChild(cornerCaret(() => this.press.openNow()));
  }

  /** Re-read visibility and the on / colour state. */
  sync(): void {
    const session = this.ctx.getSession();
    const editor = session?.editor;
    const hidden = !session || inRegionMode(session);
    const mask = editor && editor.paintTarget === "mask" ? editor.maskLayer : undefined;
    const on = !!mask && mask.id !== IMAGE_MASK_ID;
    const color = on && mask ? maskDisplayColor(mask) : "";
    const key = `${hidden}|${on}|${color}`;
    if (key === this.shown) return;
    this.shown = key;
    this.element.hidden = hidden;
    this.element.classList.toggle("cps-on", on);
    if (on) this.element.style.setProperty("--cps-qm-color", color);
    else this.element.style.removeProperty("--cps-qm-color");
    if (hidden) this.ctx.popovers.closeAnchoredIn(this.element);
  }

  /** Remove listeners and close its menu. */
  dispose(): void {
    this.press.dispose();
    this.ctx.popovers.closeAnchoredIn(this.element);
  }

  // ── Actions ─────────────────────────────────────────────────────────────

  private toggle(): void {
    const session = this.ctx.getSession();
    if (!session || inRegionMode(session)) return;
    const editor = session.editor;
    this.ctx.beforeEdit();
    if (editor.paintTarget === "mask" && editor.maskLayer?.id === IMAGE_MASK_ID) {
      const top = topMostMask(session);
      if (top) {
        editor.selectMask(top);
        return;
      }
    }
    editor.togglePaintTarget();
  }

  private openMenu(): void {
    const session = this.ctx.getSession();
    if (!session || inRegionMode(session)) return;
    const editor = session.editor;
    const currentId = editor.paintTarget === "mask" ? editor.maskLayer?.id : undefined;
    const masks = editor.doc.layers.filter((l) => l.kind === "mask").reverse();
    if (masks.length === 0) return;
    const entries: MenuEntry[] = masks.map((m) => ({
      label: m.name,
      swatch: maskDisplayColor(m),
      current: m.id === currentId,
      onPick: () => {
        if (this.ctx.getSession()?.editor !== editor) return;
        this.ctx.beforeEdit();
        editor.selectMask(m.id);
      },
    }));
    openMenu(this.ctx.popovers, { anchor: this.element, title: "Quick Mask paints", entries, placement: "above", width: 210 });
  }
}

/** Id of the top-most ordinary cmask (layers are stored bottom first). */
function topMostMask(session: EditorSession): string | null {
  const layers = session.editor.doc.layers;
  for (let i = layers.length - 1; i >= 0; i--) {
    const layer = layers[i];
    if (layer?.kind === "mask") return layer.id;
  }
  return null;
}
