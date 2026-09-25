/**
 * Selection actions in the options bar's fixed leading area, shown only
 * while a selection exists (whatever the tool): "To mask" adds the
 * selection coverage to the mask layer (`Editor.selection.toMask()`, one
 * undo step); "Invert" inverts it (`Editor.selection.invert()`, Shift+F7).
 * The buttons never take focus (the keyboard scope redirects presses on
 * non-text controls to its key sink).
 */

import type { Editor } from "../engine/editor";
import { setIcon } from "./icons";

/**
 * "Selection to mask" button bound to one editor at a time.
 */
export class SelectionActions {
  /** Root element (append to the bar's leading region). */
  readonly element: HTMLDivElement;
  private editor: Editor | null = null;

  constructor() {
    this.element = document.createElement("div");
    this.element.className = "cps-selection-actions";
    this.element.hidden = true;
    const toMask = document.createElement("button");
    toMask.type = "button";
    toMask.className = "cps-toggle";
    toMask.title = "Selection to mask: add the selection to the mask";
    setIcon(toMask, "selectionToMask", 14);
    toMask.append("To mask");
    toMask.addEventListener("click", () => this.editor?.selection.toMask());
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
  }
}
