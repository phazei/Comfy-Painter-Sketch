/**
 * Top-right pill (design handoff "Top-right group: images and clipboard"):
 * the Images button (owned by `imagesPanel.ts`, appended first), a divider,
 * then Copy, Cut and Paste (SPEC "Clipboard and drop").
 *
 * Copy and Paste follow the long-press convention (`longPress.ts`): a tap
 * runs the button's current mode; a long-press, right-click or the corner
 * caret opens a small menu whose pick runs AND becomes the button's mode and
 * icon until changed (sticky per editor, like a tool group's current tool):
 *
 * - Copy: "Copy" (Ctrl+C) or "Copy merged" (Ctrl+Shift+C; icon `copyMerged`).
 * - Paste: "System clipboard" (the Ctrl+V order: system clipboard, else our
 *   own copy, else the clipspace) or "Clipspace" (icon `pasteClipspace`).
 *   An empty source shows a stage note (the handler's business).
 *   Below a divider, the toggle "Insert into current layer" (sticky per
 *   editor; picking it doesn't paste): pastes float on the current layer
 *   instead of making a new one. Simple mode always pastes that way
 *   (EditorHost), whatever the toggle says.
 *
 * Buttons never keep DOM focus (the keyboard scope redirects presses).
 */

import type { PasteRequest } from "./clipboardActions";
import { barButton } from "./historyPill";
import { setIcon } from "./icons";
import { cornerCaret, installLongPress } from "./longPress";
import type { LongPressHandle } from "./longPress";
import { openMenu } from "./menu";
import type { PopoverHandle, PopoverHost } from "./popover";

/** Copy button mode. */
export type CopyMode = "copy" | "merged";

/** Callbacks from the pill. */
export interface ClipGroupActions {
  /** Copy (`merged` = all visible layers, within the selection if any). */
  copy(merged: boolean): void;
  cut(): void;
  /** Paste from a source (its current mode or a menu pick). */
  paste(request: PasteRequest): void;
}

/** Tooltip of the Paste menu's "Insert into current layer" toggle. */
const INTO_CURRENT_TITLE = "On: pastes, drops and Images float on the current layer (move, then Enter commits, Esc cancels) instead of making a new layer. Always on in Simple mode";

/** Optional parts. */
export interface ClipGroupOptions {
  /** Images button (from `ImagesPanel`), shown first. */
  imagesButton?: HTMLButtonElement;
}

/** Footer of both menus. */
const MENU_FOOTER = "Your pick becomes the button's default";
/** Width of both menus, CSS px (handoff). */
const MENU_WIDTH = 204;
/** Icon size in this pill, CSS px. */
const ICON = 18;

/** Copy modes: icon, label, key hint, tooltip. */
const COPY_MODES: Readonly<Record<CopyMode, { icon: string; label: string; key: string; title: string }>> = {
  copy: { icon: "copy", label: "Copy", key: "Ctrl C", title: "Copy (Ctrl C) \u00b7 hold or right-click to change" },
  merged: { icon: "copyMerged", label: "Copy merged", key: "Ctrl \u21e7 C", title: "Copy merged (Ctrl \u21e7 C) \u00b7 hold or right-click to change" },
};

/** Paste sources: icon, label. */
const PASTE_MODES: Readonly<Record<PasteRequest, { icon: string; label: string }>> = {
  system: { icon: "paste", label: "System clipboard" },
  clipspace: { icon: "pasteClipspace", label: "Clipspace" },
};

/**
 * Tooltip of the Paste button in a mode.
 * @param mode - Current source.
 * @param intoCurrent - Pastes go into the current layer (toggle on).
 * @returns Title text.
 */
export function pasteButtonTitle(mode: PasteRequest, intoCurrent = false): string {
  const source = mode === "clipspace" ? "from the ComfyUI clipspace" : "from the system clipboard (else our copy, else clipspace), Ctrl+V";
  const target = intoCurrent ? "into the current layer" : "as new layer";
  return `Paste ${target} ${source}. Ctrl+Shift+V pastes our copy in place. Hold for sources`;
}

/**
 * Images / Copy / Cut / Paste pill.
 */
export class ClipGroup {
  /** The pill. */
  readonly element: HTMLDivElement;
  private readonly copyButton: HTMLButtonElement;
  private readonly pasteButton: HTMLButtonElement;
  private readonly copyCaret: HTMLSpanElement;
  private readonly pasteCaret: HTMLSpanElement;
  private readonly presses: LongPressHandle[] = [];
  private readonly divider: HTMLSpanElement;
  private menu: PopoverHandle | null = null;
  private copyMode: CopyMode = "copy";
  private pasteMode: PasteRequest = "system";
  private into = false;

  /**
   * @param container - Shell slot (`shell.top.clip`).
   * @param actions - Clipboard commands.
   * @param popovers - Popover host (Copy / Paste menus).
   * @param options - Images button.
   */
  constructor(
    container: HTMLElement,
    private readonly actions: ClipGroupActions,
    private readonly popovers: PopoverHost,
    options: ClipGroupOptions = {},
  ) {
    this.element = document.createElement("div");
    this.element.className = "cps-pill cps-clip";
    this.divider = document.createElement("span");
    this.divider.className = "cps-vdiv";
    this.divider.hidden = true;

    this.copyButton = menuButton();
    const copyPress = installLongPress(this.copyButton, {
      tap: () => this.actions.copy(this.copyMode === "merged"),
      hold: () => this.openCopyMenu(),
    });
    this.copyCaret = cornerCaret(() => copyPress.openNow());
    this.pasteButton = menuButton();
    const pastePress = installLongPress(this.pasteButton, {
      tap: () => this.actions.paste(this.pasteMode),
      hold: () => this.openPasteMenu(),
    });
    this.pasteCaret = cornerCaret(() => pastePress.openNow());
    this.presses.push(copyPress, pastePress);

    const cut = barButton("cut", "Cut (Ctrl X)", ICON, () => this.actions.cut());
    this.element.append(this.divider, this.copyButton, cut, this.pasteButton);
    if (options.imagesButton) this.setImagesButton(options.imagesButton);
    this.renderCopy();
    this.renderPaste();
    container.appendChild(this.element);
  }

  /**
   * Put the Images button first (with the divider after it).
   * @param button - The Images button (`ImagesPanel.button`).
   */
  setImagesButton(button: HTMLButtonElement): void {
    this.element.prepend(button);
    this.divider.hidden = false;
  }

  /** The "Insert into current layer" toggle is on. */
  get intoCurrent(): boolean {
    return this.into;
  }

  /** Close the menu and remove the press listeners. */
  dispose(): void {
    for (const press of this.presses) press.dispose();
    this.menu?.close();
  }

  // ── Rendering ───────────────────────────────────────────────────────────

  private renderCopy(): void {
    const mode = COPY_MODES[this.copyMode];
    setIcon(this.copyButton, mode.icon, ICON);
    this.copyButton.appendChild(this.copyCaret);
    this.copyButton.title = mode.title;
    this.copyButton.setAttribute("aria-label", mode.title);
  }

  private renderPaste(): void {
    setIcon(this.pasteButton, PASTE_MODES[this.pasteMode].icon, ICON);
    this.pasteButton.appendChild(this.pasteCaret);
    const title = pasteButtonTitle(this.pasteMode, this.into);
    this.pasteButton.title = title;
    this.pasteButton.setAttribute("aria-label", title);
  }

  // ── Menus ───────────────────────────────────────────────────────────────

  private openCopyMenu(): void {
    if (this.menu) return;
    this.track(
      this.copyButton,
      openMenu(this.popovers, {
        anchor: this.copyButton,
        title: "Copy",
        placement: "below",
        width: MENU_WIDTH,
        footer: MENU_FOOTER,
        entries: (Object.keys(COPY_MODES) as CopyMode[]).map((mode) => ({
          label: COPY_MODES[mode].label,
          icon: COPY_MODES[mode].icon,
          key: COPY_MODES[mode].key,
          current: mode === this.copyMode,
          onPick: () => {
            this.copyMode = mode;
            this.renderCopy();
            this.actions.copy(mode === "merged");
          },
        })),
        onClose: () => this.untrack(this.copyButton),
      }),
    );
  }

  private openPasteMenu(): void {
    if (this.menu) return;
    this.track(
      this.pasteButton,
      openMenu(this.popovers, {
        anchor: this.pasteButton,
        title: "Paste from",
        placement: "below",
        width: MENU_WIDTH,
        footer: MENU_FOOTER,
        entries: [
          ...(Object.keys(PASTE_MODES) as PasteRequest[]).map((mode) => ({
            label: PASTE_MODES[mode].label,
            icon: PASTE_MODES[mode].icon,
            current: mode === this.pasteMode,
            // The click is still a user gesture for `navigator.clipboard.read()`.
            onPick: () => {
              this.pasteMode = mode;
              this.renderPaste();
              this.actions.paste(mode);
            },
          })),
          "divider" as const,
          {
            label: "Insert into current layer",
            icon: "mergeDown",
            checked: this.into,
            title: INTO_CURRENT_TITLE,
            // A setting, not a paste.
            onPick: () => {
              this.into = !this.into;
              this.renderPaste();
            },
          },
        ],
        onClose: () => this.untrack(this.pasteButton),
      }),
    );
  }

  private track(button: HTMLButtonElement, handle: PopoverHandle): void {
    this.menu = handle;
    button.classList.add("cps-menu-open");
  }

  private untrack(button: HTMLButtonElement): void {
    this.menu = null;
    button.classList.remove("cps-menu-open");
  }
}

function menuButton(): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "cps-bar-button";
  button.setAttribute("aria-haspopup", "menu");
  return button;
}
