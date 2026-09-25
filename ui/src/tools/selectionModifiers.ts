/**
 * Photoshop modifier rules shared by the selection tools (marquees, lasso,
 * magic wand; the lasso reads `fromCentre` as "Alt = straight segments"):
 *
 * - The modifiers held at pointer-down pick the mode when a selection
 *   exists: Shift add, Alt subtract, Shift+Alt intersect, none replace.
 *   Without a selection the mode is always replace.
 * - During the drag, Shift = square/circle and Alt = from centre -- but a
 *   key that was consumed as a mode key only starts constraining after it
 *   was released and pressed again (Photoshop). Without a selection, keys
 *   held at pointer-down constrain right away.
 *
 * Pure (reads only the pointer modifier flags), unit-tested.
 */

import { selectionMode } from "../engine/selection";
import type { SelectionMode } from "../engine/selection";

/** Modifier flags of a pointer sample. */
export interface ModifierFlags {
  shiftKey: boolean;
  altKey: boolean;
}

/** Drag constraints in effect for one sample. */
export interface DragConstraints {
  /** Shift: square / circle. */
  square: boolean;
  /** Alt: the drag start is the centre. */
  fromCentre: boolean;
}

/**
 * Modifier state of one selection drag.
 */
export class SelectionModifiers {
  /** Combination mode, fixed at pointer-down. */
  readonly mode: SelectionMode;
  private shiftConsumed: boolean;
  private altConsumed: boolean;

  /**
   * @param start - Modifiers at pointer-down.
   * @param hasSelection - Whether a selection exists at pointer-down.
   */
  constructor(start: ModifierFlags, hasSelection: boolean) {
    this.mode = hasSelection ? selectionMode(start.shiftKey, start.altKey) : "replace";
    this.shiftConsumed = hasSelection && start.shiftKey;
    this.altConsumed = hasSelection && start.altKey;
  }

  /**
   * Constraints for a sample (call for every sample, in order).
   * @param flags - Current modifiers.
   * @returns Square / from-centre flags.
   */
  update(flags: ModifierFlags): DragConstraints {
    if (!flags.shiftKey) this.shiftConsumed = false;
    if (!flags.altKey) this.altConsumed = false;
    return { square: flags.shiftKey && !this.shiftConsumed, fromCentre: flags.altKey && !this.altConsumed };
  }
}
