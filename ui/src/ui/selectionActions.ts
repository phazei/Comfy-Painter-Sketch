/**
 * Selection actions in the options bar's fixed leading area, shown only
 * while a selection exists (whatever the tool): "To mask" adds the
 * selection coverage to the mask layer, or hides it on a targeted layer mask
 * (`Editor.selection.toMask()`, one undo step); "Invert" inverts it (`Editor.selection.invert()`, Shift+F7).
 * The buttons never take focus (the keyboard scope redirects presses on
 * non-text controls to its key sink).
 */

import type { Editor } from "../engine/editor";
import { setIcon } from "./icons";

/** "To mask" tooltip with a mask layer (cmask) as the destination. */
const TO_MASK_TITLE = "Selection to mask: add the selection to the mask";
/** "To mask" tooltip while a layer mask (lmask) is targeted. */
const TO_LMASK_TITLE = "Selection to layer mask: hide the selection";

/**
 * "Selection to mask" button bound to one editor at a time.
 */
export class SelectionActions {
  /** Root element (append to the bar's leading region). */
  readonly element: HTMLDivElement;
  private readonly toMask: HTMLButtonElement;
  private editor: Editor | null = null;

  constructor() {
    this.element = document.createElement("div");
    this.element.className = "cps-selection-actions";
    this.element.hidden = true;
    const toMask = document.createElement("button");
    this.toMask = toMask;
    toMask.type = "button";
    toMask.className = "cps-toggle";
    toMask.title = TO_MASK_TITLE;
    setIcon(toMask, "selectionToMask", 14);
    toMask.append("To mask");
    toMask.addEventListener("click", () => this.editor?.selection.toMask());
    // The target can change without a selection event: refresh before the tooltip shows.
    toMask.addEventListener("pointerenter", () => this.syncTitle());
    const invert = document.createElement("button");
    invert.type = "button";
    invert.className = "cps-toggle";
    invert.title = "Invert selection (Ctrl+Shift+I)";
    setIcon(invert, "invert", 14);
    invert.append("Invert");
    invert.addEventListener("click", () => this.editor?.selection.invert());
    this.element.append(toMask, invert);
  }

  /**
   * Follow an editor (or none) and refresh.
   * @param editor - Session editor.
   */
  setEditor(editor: Editor | null): void {
    this.editor = editor;
    this.sync();
  }

  /** Show/hide for the current selection state. */
  sync(): void {
    this.element.hidden = !this.editor?.selection.active;
    this.syncTitle();
  }

  /** "To mask" tooltip for the current target (cmask vs targeted lmask). */
  private syncTitle(): void {
    this.toMask.title = this.editor?.layerMask.targeted ? TO_LMASK_TITLE : TO_MASK_TITLE;
  }
}
