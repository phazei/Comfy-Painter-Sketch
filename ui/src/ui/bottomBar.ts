/**
 * The bottom bar (design handoff section 6), mounted in `shell.bottomSlot`.
 * Two pills -- the left group at the left edge, the right group at the right
 * edge of the shared bar width (editor.css `--cps-bar-max`), so nothing
 * stretches across a wide stage:
 *
 * ```
 * ([status pill] [edit chip] [Quick Mask] [│ Invert  Apply  🗑])      (Align │ W × H │ Fit  Fullscreen  ?)
 * ```
 *
 * - Status pill: "LMask ×" while the lmask-only view is on (wins), else
 *   "Solo ×" while any solo is set; a click ends it. Esc never does.
 * - Edit chip (`editChip.ts`) and Quick Mask button (`quickMaskButton.ts`).
 * - lmask options (SPEC "Layer masks (lmask)" > "Options bar"): only while
 *   an lmask is targeted, outside region mode and Free Transform.
 * - Align toggles Align drawing (active while the hidden `move` tool is);
 *   amber while the resolution notice condition holds.
 * - Resolution (read-only image size), Fit, Fullscreen, Help.
 * - Simple mode (`.cps-simple`, bottomBar.css): the right pill shows only Fit,
 *   plus Align while it warns or runs; the size moves onto the stage. In
 *   fullscreen the Simple / Advanced toggle sits here (no node header).
 *
 * Everything is re-read from the session in {@link BottomBar.sync}; the host
 * calls it on the editor / tool events listed in the integration notes.
 * All controls are buttons, so the keyboard scope keeps focus on its sink.
 */

import type { EditorSession } from "../widget/sessions";
import { EditChip, inRegionMode } from "./editChip";
import type { EditChipContext } from "./editChip";
import type { EditorMode } from "../defaults/modeDefaults";
import { setIcon } from "./icons";
import { ModeToggle } from "./modeToggle";
import { QuickMaskButton } from "./quickMaskButton";

/** Id of the hidden Align drawing tool (`tools/move.ts`). */
const ALIGN_TOOL_ID = "move";

/** Align button tooltip (kept from the old layers-footer button). */
const ALIGN_TITLE = "Align drawing \u2014 reposition/scale all layers against the image";

/** What the bar needs from the host. */
export interface BottomBarContext extends EditChipContext {
  /** Toggle Align drawing (activate / leave the hidden Move tool). */
  toggleMoveDrawing(): void;
  /** Toggle fullscreen (`shell.events` "fullscreen"). */
  fullscreen(): void;
  /** Toggle the help overlay. */
  toggleHelp(): void;
  /** Optional: the bar's content changed width (`shell.requestLayout`). */
  requestLayout?(): void;
  /** The fullscreen mode toggle was clicked. */
  pickMode(mode: EditorMode): void;
}

// ═══════════════════════════════════════════════════════════════════════════
// BottomBar
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The bottom bar of one editor.
 */
export class BottomBar {
  /** `.cps-bottom-bars` (child of the container): the two pills. */
  readonly element: HTMLDivElement;
  private readonly pill: HTMLButtonElement;
  private readonly pillLabel: HTMLSpanElement;
  private readonly chip: EditChip;
  private readonly quickMask: QuickMaskButton;
  private readonly lmask: HTMLDivElement;
  private readonly lmInvert: HTMLButtonElement;
  private readonly align: HTMLButtonElement;
  private readonly alignIcon: HTMLSpanElement;
  private readonly resolution: HTMLSpanElement;
  private readonly fullscreenButton: HTMLButtonElement;
  private readonly modeToggle: ModeToggle;
  private pillKind: "lmask" | "solo" | null = null;
  private resolutionWarning = false;
  private fullscreenOn = false;
  /** Last layout-relevant state key (asks the shell to re-layout on change). */
  private layoutKey = "";

  /**
   * @param container - Mount point (`shell.bottomSlot`).
   * @param ctx - Host callbacks.
   */
  constructor(
    container: HTMLElement,
    private readonly ctx: BottomBarContext,
  ) {
    this.element = div("cps-bottom-bars");
    const left = div("cps-bottom-bar cps-bb-left");
    const right = div("cps-bottom-bar cps-bb-right");

    // ── Left: pill, chip, Quick Mask, lmask options ──
    this.pill = button("cps-bb-pill", () => this.endPill());
    this.pill.hidden = true;
    this.pillLabel = document.createElement("span");
    const pillClose = document.createElement("span");
    pillClose.className = "cps-bb-pill-close";
    setIcon(pillClose, "close", 13);
    this.pill.append(this.pillLabel, pillClose);

    this.chip = new EditChip(ctx);
    this.quickMask = new QuickMaskButton(ctx);

    this.lmask = div("cps-bb-lmask");
    this.lmask.hidden = true;
    this.lmInvert = textButton("Invert", "invert", "Invert the layer mask (a setting; pixels are kept)", () =>
      this.withTargeted((s, id) => s.editor.layerMask.setInvert(id, s.editor.layerMask.info(id)?.invert !== true)),
    );
    const lmApply = textButton("Apply", null, "Apply the layer mask: bake it into the layer's pixels and remove it (undoable)", () =>
      this.withTargeted((s, id) => s.editor.layerMask.apply(id)),
    );
    const lmDelete = iconButton("trash", "Delete the layer mask (undoable)", () => this.withTargeted((s, id) => s.editor.layerMask.remove(id)));
    lmDelete.classList.add("cps-bb-muted");
    this.lmask.append(vdiv(), this.lmInvert, lmApply, lmDelete);

    left.append(this.pill, this.chip.element, this.quickMask.element, this.lmask);

    // ── Right: Align │ resolution │ Fit, Fullscreen, Help ──
    this.align = button("cps-text-button cps-bb-align", () => ctx.toggleMoveDrawing());
    this.align.title = ALIGN_TITLE;
    this.align.setAttribute("aria-label", ALIGN_TITLE);
    this.alignIcon = document.createElement("span");
    this.alignIcon.className = "cps-bb-align-icon";
    setIcon(this.alignIcon, "alignDrawing", 16);
    const alignLabel = document.createElement("span");
    alignLabel.textContent = "Align";
    this.align.append(this.alignIcon, alignLabel);

    this.resolution = document.createElement("span");
    this.resolution.className = "cps-bb-resolution cps-mono";
    this.resolution.title = "Image size";

    const fit = iconButton("fit", "Fit to view (Ctrl 0)", () => this.ctx.getSession()?.editor.view.fit());
    fit.classList.add("cps-bb-fit");
    this.fullscreenButton = iconButton("fullscreen", "Fullscreen (F)", () => ctx.fullscreen());
    const help = iconButton("help", "Shortcuts (?)", () => ctx.toggleHelp());
    help.classList.add("cps-bb-muted");

    this.modeToggle = new ModeToggle("cps-mode-bar", (mode) => ctx.pickMode(mode));
    right.append(this.modeToggle.element, this.align, vdiv(), this.resolution, vdiv(), fit, this.fullscreenButton, help);
    this.element.append(left, right);
    container.appendChild(this.element);
  }

  /** Re-read everything from the session (cheap; unchanged parts skip DOM writes). */
  sync(): void {
    const session = this.ctx.getSession();
    const editor = session?.editor ?? null;
    const region = session ? inRegionMode(session) : false;

    // Status pill: the lmask-only view wins over Solo.
    const solo = editor?.solo;
    const pillKind = editor?.layerMask.viewing != null ? "lmask" : solo && (solo.paint || solo.mask) ? "solo" : null;
    if (pillKind !== this.pillKind) {
      this.pillKind = pillKind;
      this.pill.hidden = pillKind === null;
      this.pillLabel.textContent = pillKind === "lmask" ? "LMask" : "Solo";
      this.pill.title = pillKind === "lmask" ? "Viewing the layer mask alone \u00b7 click to exit" : "Solo is on \u00b7 click to show everything";
    }

    this.chip.sync();
    this.quickMask.sync();

    // lmask options.
    const targeted = editor?.layerMask.targeted ?? null;
    const showLmask = !!editor && targeted !== null && !region && !editor.float.transform.active;
    this.lmask.hidden = !showLmask;
    this.lmInvert.classList.toggle("cps-active", showLmask && targeted !== null && editor?.layerMask.info(targeted)?.invert === true);

    // Align: active while the hidden Move tool is; amber on a resolution mismatch.
    const alignActive = session?.tools.active.id === ALIGN_TOOL_ID;
    const warn = this.resolutionWarning && !alignActive;
    if (this.align.classList.contains("cps-warn") !== warn) setIcon(this.alignIcon, warn ? "warning" : "alignDrawing", 16);
    this.align.classList.toggle("cps-active", alignActive);
    this.align.classList.toggle("cps-warn", warn);
    this.align.disabled = !session;

    const size = editor?.imageSize;
    const res = size ? `${size.width} \u00d7 ${size.height}` : "";
    if (this.resolution.textContent !== res) this.resolution.textContent = res;

    const key = `${pillKind}|${showLmask}|${this.quickMask.element.hidden}|${res}|${this.chip.element.textContent}`;
    if (key !== this.layoutKey) {
      this.layoutKey = key;
      this.ctx.requestLayout?.();
    }
  }

  /**
   * Show the mode on the fullscreen toggle (the rest is CSS).
   * @param mode - Editor mode.
   */
  setMode(mode: EditorMode): void {
    this.modeToggle.set(mode);
    this.ctx.requestLayout?.();
  }

  /**
   * Show the fullscreen state on the Fullscreen button.
   * @param on - The editor is fullscreen.
   */
  setFullscreen(on: boolean): void {
    if (on === this.fullscreenOn) return;
    this.fullscreenOn = on;
    setIcon(this.fullscreenButton, on ? "exitFullscreen" : "fullscreen", 17);
    const title = on ? "Exit fullscreen (F / Esc)" : "Fullscreen (F)";
    this.fullscreenButton.title = title;
    this.fullscreenButton.setAttribute("aria-label", title);
  }

  /**
   * Resolution mismatch (`ResolutionNotice` `setWarning`): Align turns amber,
   * also while the notice pill is hidden.
   * @param on - The mismatch condition holds.
   */
  setResolutionWarning(on: boolean): void {
    if (on === this.resolutionWarning) return;
    this.resolutionWarning = on;
    this.sync();
  }

  /** Remove the bar, its listeners and its menus. */
  dispose(): void {
    this.quickMask.dispose();
    this.ctx.popovers.closeAnchoredIn(this.element);
    this.element.remove();
  }

  // ── Actions ─────────────────────────────────────────────────────────────

  /** Pill click: end the lmask-only view, or every solo. View only, no beforeEdit. */
  private endPill(): void {
    const editor = this.ctx.getSession()?.editor;
    if (!editor) return;
    if (editor.layerMask.viewing !== null) {
      editor.layerMask.endView();
    } else {
      const { paint, mask } = editor.solo;
      if (paint) editor.toggleSolo(paint);
      if (mask) editor.toggleSolo(mask);
    }
    this.sync();
  }

  /** Run an lmask option on the targeted layer. */
  private withTargeted(fn: (session: EditorSession, layerId: string) => unknown): void {
    const session = this.ctx.getSession();
    const id = session?.editor.layerMask.targeted ?? null;
    if (!session || id === null) return;
    this.ctx.beforeEdit();
    fn(session, id);
  }
}

// ── DOM helpers ───────────────────────────────────────────────────────────

function div(className: string): HTMLDivElement {
  const element = document.createElement("div");
  element.className = className;
  return element;
}

function vdiv(): HTMLSpanElement {
  const element = document.createElement("span");
  element.className = "cps-vdiv cps-vdiv-short";
  return element;
}

function button(className: string, onClick: () => void): HTMLButtonElement {
  const element = document.createElement("button");
  element.type = "button";
  element.className = className;
  element.addEventListener("click", onClick);
  return element;
}

/** 30 x 26 icon button. */
function iconButton(icon: string, title: string, onClick: () => void): HTMLButtonElement {
  const element = button("cps-bb-button", onClick);
  element.title = title;
  element.setAttribute("aria-label", title);
  setIcon(element, icon, 17);
  return element;
}

/** Text button with an optional leading icon. */
function textButton(label: string, icon: string | null, title: string, onClick: () => void): HTMLButtonElement {
  const element = button("cps-text-button", onClick);
  element.title = title;
  if (icon) {
    const glyph = document.createElement("span");
    glyph.className = "cps-bb-text-icon";
    setIcon(glyph, icon, 15);
    element.appendChild(glyph);
  }
  const text = document.createElement("span");
  text.textContent = label;
  element.appendChild(text);
  return element;
}
