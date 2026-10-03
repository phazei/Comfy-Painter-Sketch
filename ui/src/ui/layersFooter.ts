/**
 * Footer of the layers tab (SPEC "Layers panel" > Footer; design handoff:
 * border-top, 30 x 28 buttons, icons 18): New layer, New mask, Duplicate,
 * Merge Down. Delete lives in the section headers (`layerSectionHeader.ts`:
 * the header stays put while the panel shrinks). Align drawing moved to the
 * bottom bar. Enabled states and tooltips follow the selected row (`sync`).
 */

import type { Editor } from "../engine/editor";
import { MAX_MASKS } from "../document/layerList";
import { canDuplicateRow } from "./imageMaskRow";
import { el, footerButton } from "./layersPanelParts";

/** Footer commands (the panel runs them through the editor). */
export interface FooterActions {
  addLayer(): void;
  addMask(): void;
  duplicate(): void;
  mergeDown(): void;
}

/** Tooltip of New mask while it is available. */
export const NEW_MASK_TITLE = "New mask (above the current mask)";

/**
 * Tooltip of New mask for the current state.
 * @param editor - Bound editor (or none).
 * @returns Tooltip ("At most 7 masks" at the limit).
 */
export function newMaskTitle(editor: Editor | null): string {
  return !editor || editor.layerOps.canAddMask() ? NEW_MASK_TITLE : `At most ${MAX_MASKS} masks`;
}

/**
 * The footer buttons.
 */
export class LayersFooter {
  readonly element: HTMLDivElement;
  private readonly addButton: HTMLButtonElement;
  private readonly addMaskButton: HTMLButtonElement;
  private readonly duplicateButton: HTMLButtonElement;
  private readonly mergeButton: HTMLButtonElement;

  /**
   * @param actions - Commands.
   */
  constructor(actions: FooterActions) {
    this.element = el("div", "cps-layers-footer");
    this.addButton = footerButton("layerAdd", "New layer (above the active layer)", () => actions.addLayer());
    this.addMaskButton = footerButton("maskAdd", NEW_MASK_TITLE, () => actions.addMask());
    this.duplicateButton = footerButton("duplicate", "Duplicate layer", () => actions.duplicate());
    this.mergeButton = footerButton("mergeDown", "Merge Down (Ctrl+E)", () => actions.mergeDown());
    this.element.append(this.addButton, this.addMaskButton, this.duplicateButton, this.mergeButton);
  }

  /**
   * Sync enabled states and tooltips.
   * @param editor - Bound editor (or none).
   * @param targetId - Selected row's layer id (the current cmask under Quick Mask, else the active layer).
   */
  sync(editor: Editor | null, targetId: string | null): void {
    this.addButton.disabled = !editor;
    this.addMaskButton.disabled = !(editor && editor.layerOps.canAddMask());
    this.addMaskButton.title = newMaskTitle(editor);
    this.duplicateButton.disabled = !(editor && canDuplicateRow(editor, targetId));
    this.mergeButton.disabled = !editor?.canMergeDown();
  }
}
