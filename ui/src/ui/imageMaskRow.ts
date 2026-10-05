/**
 * Layers-panel pieces for the Image Mask row (`engine/imageMaskOps.ts`),
 * kept out of `layersPanel.ts`: its thumbnail (image-px coverage), the
 * Input Mask's "run the workflow" hint and the footer's Duplicate (also for
 * the selected Background row) and the headers' Delete behaviour for it. The row itself is a
 * `LayerRow` of kind `imageMask`, directly above the Background row.
 */

import { IMAGE_MASK_ID, IMAGE_MASK_NAME, INPUT_MASK_NAME } from "../document/imageMask";
import type { Editor } from "../engine/editor";
import { BACKGROUND_SOLO_ID } from "../engine/solo";
import type { LayerRow } from "./layerRow";

/** Zero-sized stand-in for a thumbnail without coverage. */
let emptyCanvas: HTMLCanvasElement | null = null;

/**
 * Redraw the Image Mask thumbnail when its coverage changed (raw coverage,
 * white-on-black like mask thumbnails, framed like the Background's). No
 * coverage (Input Mask not loaded: "no mask") is plain black, like the stage
 * (nothing drawn).
 * @param editor - Bound editor.
 * @param row - The row, if shown.
 */
export function refreshImageMaskThumb(editor: Editor, row: LayerRow | undefined): void {
  const mask = editor.imageMask.info;
  if (!row || !mask) return;
  const size = { width: mask.width, height: mask.height };
  const canvas = editor.imageMask.canvas();
  if (!canvas) {
    emptyCanvas ??= document.createElement("canvas");
    emptyCanvas.width = 0;
    emptyCanvas.height = 0;
    const region = { x: 0, y: 0, width: 0, height: 0 };
    row.thumb.update(`none|${editor.imageMask.revision}`, size, { kind: "layer", canvas: emptyCanvas, region, mask: true, invert: false });
    return;
  }
  const region = { x: 0, y: 0, width: canvas.width, height: canvas.height };
  row.thumb.update(`${editor.imageMask.revision}`, size, { kind: "layer", canvas, region, mask: true, invert: false });
}

/** Hint under the Input Mask row while a run has to deliver its pixels. */
export const INPUT_MASK_WAIT_HINT = "Run the workflow to load this mask";

/**
 * Hint line of the Image Mask / Input Mask row.
 * @param editor - Bound editor.
 * @returns {@link INPUT_MASK_WAIT_HINT} while the Input Mask waits for a run, else `undefined`.
 */
export function imageMaskHint(editor: Editor): string | undefined {
  return editor.imageMask.waiting ? INPUT_MASK_WAIT_HINT : undefined;
}

/**
 * Footer Duplicate enabled state for the selected row.
 * @param editor - Bound editor.
 * @param id - Selected row id (`null` = none).
 * @returns Whether Duplicate works on it.
 */
export function canDuplicateRow(editor: Editor, id: string | null): boolean {
  if (id === IMAGE_MASK_ID) return editor.imageMask.canDuplicate();
  if (id === BACKGROUND_SOLO_ID) return !editor.loading;
  return id !== null && editor.layerOps.canDuplicate(id);
}

/**
 * Footer / row Duplicate: the Image Mask becomes an ordinary mask (and the
 * current mask), the Background an ordinary paint layer at the bottom of the
 * paint stack (and the active layer); otherwise the selected row (active
 * paint layer, or the current cmask under Quick Mask) is duplicated.
 * @param editor - Bound editor.
 * @param id - Selected row id (`BACKGROUND_SOLO_ID` = the Background row).
 */
export function duplicateRow(editor: Editor, id: string | null): void {
  if (id === BACKGROUND_SOLO_ID) {
    editor.layerOps.duplicateBackground();
    return;
  }
  if (id !== IMAGE_MASK_ID) {
    editor.layerOps.duplicate(id ?? undefined);
    return;
  }
  const copy = editor.imageMask.duplicate();
  if (copy) editor.selectMask(copy);
}

/**
 * Delete tooltip (section header trash buttons, `sectionDeleteState`).
 * @param id - Selected row id.
 * @param targeting - Quick Mask on (a mask row is selected).
 * @param deletable - Delete is enabled.
 * @param rowName - Name of the Image Mask / Input Mask row, if any.
 * @returns Tooltip.
 */
export function deleteTitle(id: string | null, targeting: boolean, deletable: boolean, rowName = IMAGE_MASK_NAME): string {
  if (!targeting) return "Delete layer";
  if (id === IMAGE_MASK_ID) {
    const source = rowName === INPUT_MASK_NAME ? "the mask input" : "the image's transparency";
    return `The ${rowName} can't be deleted (it follows ${source})`;
  }
  return deletable ? "Delete mask" : "The last mask can't be deleted (clear it instead)";
}
