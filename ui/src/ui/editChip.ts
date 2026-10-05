/**
 * The bottom bar's edit chip (design handoff section 6 "Edit chip"): shows
 * what strokes edit right now -- a swatch, the name, the part in muted text,
 * a chevron -- and opens a menu above it to switch. First match wins:
 *
 * | State | Chip | Menu |
 * |---|---|---|
 * | Region mode | Main / region · Outputs | outputs, Back to {layer} |
 * | Background selected | Background · Read-only | Duplicate to an editable layer, Back |
 * | Image / Input Mask current (Quick Mask) | {row} · Read-only | Duplicate to an editable mask, Back |
 * | Quick Mask | {cmask} · Mask (· Subtract for a Subtract cmask) | Subtract, View alone, Lock (Simple: only Unlock), Back (Q) |
 * | lmask targeted | {layer} · Mask | Pixels / Layer mask, View, Enable |
 * | Paint layer | {layer} · Pixels | same; no lmask: Add layer mask |
 * | Text layer | {layer} · Pixels | Rasterize text |
 *
 * Region mode wins so a mask or lmask selection never leaks into Outputs.
 * Simple mode (no Layers panel) adds a Hide / Show entry for the current
 * layer, cmask or the Background.
 * The menu is rebuilt from the live state on every open.
 */

import { IMAGE_MASK_ID } from "../document/imageMask";
import { findPaintLayer, maskDisplayColor } from "../document/masks";
import { regionName } from "../document/regions";
import type { Layer } from "../document/types";
import type { Editor } from "../engine/editor";
import { BACKGROUND_NAME } from "../engine/layerOps";
import { RASTERIZE_PROMPT } from "../engine/rasterize";
import { REGION_TOOL_ID } from "../tools/region";
import type { EditorSession } from "../widget/sessions";
import { setIcon } from "./icons";
import { openMenu } from "./menu";
import type { MenuEntry } from "./menu";
import type { PopoverHost } from "./popover";

// ── Types ─────────────────────────────────────────────────────────────────────

/** What the chip (and the other bottom-bar parts) need from the host. */
export interface EditChipContext {
  /** The editor's popover host (`shell.popoverHost`). */
  readonly popovers: PopoverHost;
  /** Session shown by the host, or `null`. */
  getSession(): EditorSession | null;
  /** Cancel drags / pending tool interactions before an edit (`EditorHost.beforeEdit`). */
  beforeEdit(): void;
  /** Leave region mode (back to the Layers tab and the last rail tool). */
  leaveRegionMode(): void;
  /**
   * Rasterize a text layer WITHOUT asking (the chip already confirmed and
   * committed any open text edit). No public engine method exists yet:
   * the integrator wires e.g. `textTransform.rasterizeText(s, id)` behind
   * an editor facade method.
   */
  rasterizeText(layerId: string): void;
  /** Simple mode: the menu adds a visibility toggle. */
  isSimple?(): boolean;
}

/** Swatch backgrounds (CSS). */
export const CHECKER_SWATCH = "repeating-conic-gradient(#8d8f94 0 25%, #c9cbcf 0 50%) 0 0 / 8px 8px";
/** Half white / half black: a layer mask. */
export const LMASK_SWATCH = "linear-gradient(90deg, #f2f2f2 50%, #111 50%)";
/** Dark stripes: the selected Background row over an input image. */
export const BACKGROUND_SWATCH = "repeating-linear-gradient(135deg, #3a3f45 0 4px, #353a40 4px 8px)";

/** Chip content. */
export interface ChipModel {
  name: string;
  part: string;
  swatch: string;
  /** 2 px ring around the swatch (lmask targeted). */
  ring: boolean;
}

/**
 * Whether the region tool (Outputs tab) is active.
 * @param session - Session.
 * @returns `true` in region mode.
 */
export function inRegionMode(session: EditorSession): boolean {
  return session.tools.active.id === REGION_TOOL_ID;
}

// ═══════════════════════════════════════════════════════════════════════════
// EditChip
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The edit chip button and its menu.
 */
export class EditChip {
  /** The chip button. */
  readonly element: HTMLButtonElement;
  private readonly swatch: HTMLSpanElement;
  private readonly name: HTMLSpanElement;
  private readonly part: HTMLSpanElement;
  /** Last rendered model key (skips DOM writes on unchanged syncs). */
  private shown = "";

  /**
   * @param ctx - Host callbacks.
   */
  constructor(private readonly ctx: EditChipContext) {
    this.element = document.createElement("button");
    this.element.type = "button";
    this.element.className = "cps-chip";
    this.element.title = "What you're editing. Click to switch.";
    this.swatch = span("cps-chip-swatch");
    this.name = span("cps-chip-name");
    this.part = span("cps-chip-part");
    const chevron = span("cps-chip-chevron");
    setIcon(chevron, "chevronDown", 16);
    this.element.append(this.swatch, this.name, this.part, chevron);
    this.element.addEventListener("click", () => this.toggleMenu());
  }

  /** Re-read the chip content from the session. */
  sync(): void {
    const session = this.ctx.getSession();
    const model = session ? chipModel(session) : { name: "\u2014", part: "", swatch: "transparent", ring: false };
    this.element.disabled = !session;
    const key = `${model.name}\u0000${model.part}\u0000${model.swatch}\u0000${model.ring}`;
    if (key === this.shown) return;
    this.shown = key;
    this.name.textContent = model.name;
    this.name.title = model.name;
    this.part.textContent = model.part ? `\u00b7 ${model.part}` : "";
    this.swatch.style.background = model.swatch;
    this.swatch.classList.toggle("cps-ring2", model.ring);
  }

  // ── Menu ────────────────────────────────────────────────────────────────

  private toggleMenu(): void {
    const popovers = this.ctx.popovers;
    if (popovers.active?.anchor === this.element) {
      popovers.active.close();
      return;
    }
    const session = this.ctx.getSession();
    if (!session) return;
    const { title, entries } = this.menuFor(session);
    if (this.ctx.isSimple?.() && !inRegionMode(session)) this.addVisibility(session.editor, entries);
    if (entries.length === 0) return;
    openMenu(popovers, { anchor: this.element, title, entries, placement: "above", width: 244 });
  }

  private menuFor(session: EditorSession): { title: string; entries: MenuEntry[] } {
    const editor = session.editor;
    const paint = findPaintLayer(editor.doc);
    const backName = paint?.name ?? "layer";
    if (inRegionMode(session)) return this.outputsMenu(editor);
    if (editor.backgroundSelected) {
      return {
        title: `${BACKGROUND_NAME} \u00b7 Read-only`,
        entries: [
          {
            label: "Duplicate to an editable layer",
            icon: "duplicate",
            disabled: editor.loading,
            onPick: () => this.edit(editor, () => editor.layerOps.duplicateBackground()),
          },
          "divider",
          { label: `Back to ${backName}`, icon: "back", onPick: () => this.edit(editor, () => editor.setPaintTarget("paint")) },
        ],
      };
    }
    const mask = editor.paintTarget === "mask" ? editor.maskLayer : undefined;
    if (mask?.id === IMAGE_MASK_ID) {
      return {
        title: `${mask.name} \u00b7 Read-only`,
        entries: [
          {
            label: "Duplicate to an editable mask",
            icon: "duplicate",
            disabled: !editor.imageMask.canDuplicate(),
            onPick: () => this.edit(editor, () => {
              const copy = editor.imageMask.duplicate();
              if (copy) editor.selectMask(copy);
            }),
          },
          "divider",
          { label: `Back to ${backName}`, icon: "back", onPick: () => this.edit(editor, () => editor.setPaintTarget("paint")) },
        ],
      };
    }
    if (mask) return this.cmaskMenu(editor, mask, backName, this.ctx.isSimple?.() === true);
    if (!paint) return { title: "", entries: [] };
    return this.layerMenu(editor, paint);
  }

  private outputsMenu(editor: Editor): { title: string; entries: MenuEntry[] } {
    const selected = editor.regionOps.selectedId;
    const regions = [...editor.doc.regions].sort((a, b) => a.slot - b.slot);
    const paint = editor.paintTarget === "mask" ? editor.maskLayer : findPaintLayer(editor.doc);
    const entries: MenuEntry[] = [
      { label: "Main", swatch: "var(--cps-ring)", current: selected === null, onPick: () => editor.regionOps.select(null) },
      ...regions.map((r): MenuEntry => ({
        label: regionName(r),
        swatch: "var(--cps-chip-bg)",
        current: selected === r.id,
        onPick: () => editor.regionOps.select(r.id),
      })),
      "divider",
      { label: `Back to ${paint?.name ?? "layer"}`, icon: "back", onPick: () => this.ctx.leaveRegionMode() },
    ];
    return { title: "Outputs", entries };
  }

  /** cmask menu; Simple mode shows Lock only to undo it (Unlock while locked). */
  private cmaskMenu(editor: Editor, mask: Readonly<Layer>, backName: string, simple: boolean): { title: string; entries: MenuEntry[] } {
    const id = mask.id;
    const locked = mask.locked;
    const lock: MenuEntry[] = simple && !locked ? [] : [{ label: locked ? "Unlock" : "Lock", icon: locked ? "unlock" : "lock", onPick: () => this.edit(editor, () => editor.layerOps.setLocked(id, !locked)) }];
    return {
      title: mask.name,
      entries: [
        { label: "Subtract", icon: "maskSubtract", checked: mask.subtract === true, onPick: () => this.edit(editor, () => editor.layerOps.setMaskSubtract(id, mask.subtract !== true)) },
        // View only (no beforeEdit), like the row's solo button.
        { label: "View this mask alone", icon: "solo", checked: editor.solo.mask === id, onPick: () => editor.toggleSolo(id) },
        ...lock,
        "divider",
        { label: `Back to ${backName}`, icon: "back", key: "Q", onPick: () => this.edit(editor, () => editor.setPaintTarget("paint")) },
      ],
    };
  }

  private layerMenu(editor: Editor, layer: Readonly<Layer>): { title: string; entries: MenuEntry[] } {
    const id = layer.id;
    const lm = editor.layerMask;
    const info = lm.info(id);
    const onMask = lm.targeted === id;
    const entries: MenuEntry[] = [
      { label: "Pixels", swatch: CHECKER_SWATCH, current: !onMask, onPick: () => this.edit(editor, () => lm.setTarget(id, "layer")) },
    ];
    if (layer.kind === "text") {
      entries.push("divider", { label: "Rasterize text", icon: "rasterize", onPick: () => this.rasterize(editor, id) });
    } else if (info) {
      const enabled = info.enabled;
      entries.push(
        { label: "Layer mask", swatch: LMASK_SWATCH, current: onMask, onPick: () => this.edit(editor, () => lm.setTarget(id, "mask")) },
        "divider",
        { label: "View layer mask only", icon: "maskView", checked: lm.viewing === id, key: "Alt-click", onPick: () => this.edit(editor, () => lm.toggleView(id)) },
        {
          label: enabled ? "Disable layer mask" : "Enable layer mask",
          icon: enabled ? "ban" : "check",
          key: "\u21e7-click",
          onPick: () => this.edit(editor, () => lm.setEnabled(id, !enabled)),
        },
      );
    } else {
      entries.push("divider", {
        label: "Add layer mask",
        icon: "layerMaskAdd",
        title: "Reveal all (or show only the selection)",
        onPick: () => this.edit(editor, () => lm.add(id, editor.selection.active ? "selection" : "reveal")),
      });
    }
    return { title: `Edit on ${layer.name}`, entries };
  }

  /**
   * Simple mode: Hide / Show for what the chip edits (the Layers panel's eye
   * is out of reach there), plus Unlock for a locked paint layer. Read-only
   * mask rows have no eye.
   */
  private addVisibility(editor: Editor, entries: MenuEntry[]): void {
    const toggle = (visible: boolean, what: string, set: (v: boolean) => void): void => {
      entries.push("divider", {
        label: visible ? `Hide ${what}` : `Show ${what}`,
        icon: visible ? "eyeOff" : "eye",
        onPick: () => this.edit(editor, () => set(!visible)),
      });
    };
    if (editor.backgroundSelected) {
      toggle(editor.doc.backgroundVisible !== false, "background", (v) => editor.layerOps.setBackgroundVisible(v));
      return;
    }
    const mask = editor.paintTarget === "mask" ? editor.maskLayer : undefined;
    const item = mask ?? findPaintLayer(editor.doc);
    if (!item || item.id === IMAGE_MASK_ID) return;
    toggle(item.visible, mask ? "mask" : "layer", (v) => editor.layerOps.setVisible(item.id, v));
    // A paint layer locked in Advanced: Unlock only (the cmask menu has its own).
    if (!mask && item.locked) {
      entries.push({ label: "Unlock layer", icon: "unlock", onPick: () => this.edit(editor, () => editor.layerOps.setLocked(item.id, false)) });
    }
  }

  /** "Rasterize text": end the text edit, confirm, then rasterize (one undo step). */
  private rasterize(editor: Editor, id: string): void {
    this.ctx.beforeEdit();
    if (editor.text.editing) editor.text.commit();
    if (!window.confirm(RASTERIZE_PROMPT)) return;
    this.ctx.rasterizeText(id);
  }

  private edit(editor: Editor, fn: () => unknown): void {
    if (this.ctx.getSession()?.editor !== editor) return;
    this.ctx.beforeEdit();
    fn();
  }
}

// ── Model ─────────────────────────────────────────────────────────────────

/**
 * Chip content for the session's state (first match wins).
 * @param session - Session.
 * @returns Model.
 */
export function chipModel(session: EditorSession): ChipModel {
  const editor = session.editor;
  if (inRegionMode(session)) {
    const id = editor.regionOps.selectedId;
    const region = id === null ? undefined : editor.doc.regions.find((r) => r.id === id);
    return { name: region ? regionName(region) : "Main", part: "Outputs", swatch: "var(--cps-ring)", ring: false };
  }
  if (editor.backgroundSelected) {
    // The fill colour without an image; the design handoff's stripes for an image (no thumbnail in a 14 px swatch).
    const bg = editor.background;
    return { name: BACKGROUND_NAME, part: "Read-only", swatch: bg.kind === "fill" ? bg.color : BACKGROUND_SWATCH, ring: false };
  }
  const mask = editor.paintTarget === "mask" ? editor.maskLayer : undefined;
  if (mask) {
    const part = mask.id === IMAGE_MASK_ID ? "Read-only" : mask.subtract === true ? "Subtract" : "Mask";
    return { name: mask.name, part, swatch: maskDisplayColor(mask), ring: false };
  }
  const paint = findPaintLayer(editor.doc);
  if (!paint) return { name: "\u2014", part: "", swatch: "transparent", ring: false };
  const onMask = paint.kind !== "text" && editor.layerMask.targeted === paint.id;
  return { name: paint.name, part: onMask ? "Mask" : "Pixels", swatch: onMask ? LMASK_SWATCH : CHECKER_SWATCH, ring: onMask };
}

function span(className: string): HTMLSpanElement {
  const element = document.createElement("span");
  element.className = className;
  return element;
}
