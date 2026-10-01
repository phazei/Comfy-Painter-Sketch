/**
 * Selection moves that are not a new selection (SPEC "Selection"):
 *
 * - {@link followSelection}: a whole-layer move (Move tool outside the
 *   selection, nudges) carries the selection by the same delta, folded into
 *   the move's undo step (group entry `[move, selection]`). Consecutive
 *   nudges still merge: the previous `[move, selection]` step is unwrapped
 *   so the mover can merge into its own entry, then re-wrapped.
 * - {@link SelectionMoveOps}: dragging only the outline (marquee / lasso /
 *   wand plain drag inside the selection), ONE `selection` history entry
 *   per drag -- the same entry kind every other selection change uses.
 *   Arrow nudges ({@link SelectionMoveOps.nudge}) merge into one such entry.
 *
 * Selections are immutable and shifted by whole document px only
 * (`floatMath.offsetSelection`, the coverage bytes are shared).
 */

import type { HistoryEntry } from "./editorTypes";
import type { EditorState } from "./editorState";
import { offsetSelection, selectionHit } from "./floatMath";
import { selectionBytes, selectionsEqual } from "./selection";
import type { Selection } from "./selection";

/** Gesture key that merges consecutive outline arrow nudges. */
export const SELECTION_NUDGE_GESTURE = "selection-nudge";

/**
 * Push a `selection` entry that joins the newest history entry (one undo step).
 * @param s - Editor state.
 * @param before - Selection before.
 * @param after - Selection after (already current).
 * @param join - Join the newest entry instead of making a separate step.
 */
export function recordSelectionMove(s: EditorState, before: Selection | null, after: Selection | null, join: boolean): void {
  if (selectionsEqual(before, after)) return;
  if (join) s.history.joinNext((entry) => entry.kind === "selection");
  s.history.push({ kind: "selection", before, after, bytes: selectionBytes(before) + selectionBytes(after) });
  s.events.emit("history", undefined);
}

/**
 * Run a whole-layer move and move the selection with it (one undo step).
 * @param s - Editor state.
 * @param dx - Layer shift, whole document px.
 * @param dy - Layer shift, whole document px.
 * @param gesture - Merge key of the move (nudges), if any.
 * @param move - Performs the layer move and records its entry; `true` if it moved.
 * @returns What `move` returned.
 */
export function followSelection(s: EditorState, dx: number, dy: number, gesture: string | undefined, move: () => boolean): boolean {
  const sel = s.selection.current;
  if (!sel) return move();
  let before: Selection | null = sel;
  let unwrapped = false;
  const top = gesture ? s.history.mergeTarget() : undefined;
  if (top?.kind === "group" && top.entries.length === 2) {
    const [first, last] = top.entries as [HistoryEntry, HistoryEntry];
    if (last.kind === "selection" && last.after === sel && hasGesture(first, gesture)) {
      s.history.discardNewest();
      s.history.push(first);
      before = last.before;
      unwrapped = true;
    }
  }
  const moved = move();
  const after = moved ? offsetSelection(sel, dx, dy) : sel;
  s.selection.set(after);
  if (moved || unwrapped) recordSelectionMove(s, before, after, true);
  return moved;
}

function hasGesture(entry: HistoryEntry, gesture: string | undefined): boolean {
  return gesture !== undefined && "gesture" in entry && entry.gesture === gesture;
}

/**
 * Outline-only drag of the selection (no pixels), exposed as `Editor.selectionMove`.
 */
export class SelectionMoveOps {
  private start: Selection | null = null;

  /**
   * @param s - Shared editor state.
   */
  constructor(private readonly s: EditorState) {}

  /**
   * Whether a document point is inside the current selection (coverage >= 50 %).
   * @param x - Document x.
   * @param y - Document y.
   * @returns `true` if inside.
   */
  hit(x: number, y: number): boolean {
    return selectionHit(this.s.selection.current, x, y);
  }

  /**
   * Start an outline drag (commits a floating selection first).
   * @returns `false` without a selection or while busy.
   */
  begin(): boolean {
    const s = this.s;
    if (s.loading || s.stroke.active) return false;
    s.settleFloat();
    if (!s.selection.current) return false;
    this.start = s.selection.current;
    return true;
  }

  /**
   * Show the outline at an offset from the drag start.
   * @param dx - Whole document px.
   * @param dy - Whole document px.
   */
  preview(dx: number, dy: number): void {
    if (this.start) this.s.selection.set(offsetSelection(this.start, dx, dy));
  }

  /**
   * End the drag: one `selection` history entry (nothing if it did not move).
   * @returns `true` if the selection moved.
   */
  commit(): boolean {
    const start = this.start;
    this.start = null;
    if (!start) return false;
    const after = this.s.selection.current;
    if (after === start) return false;
    recordSelectionMove(this.s, start, after, false);
    return true;
  }

  /** Abort the drag: the outline goes back. */
  cancel(): void {
    if (this.start) this.s.selection.set(this.start);
    this.start = null;
  }

  /**
   * Arrow nudge of the outline only (selection tools, no float). Consecutive
   * nudges merge into one `selection` history entry (like Move nudges); a
   * run that returns to its start drops the entry.
   * @param dx - Whole document px.
   * @param dy - Whole document px.
   * @returns `false` without a selection, while busy or mid-drag.
   */
  nudge(dx: number, dy: number): boolean {
    const s = this.s;
    if (this.start || s.loading || s.stroke.active) return false;
    s.settleFloat();
    const sel = s.selection.current;
    if (!sel) return false;
    if (dx === 0 && dy === 0) return true;
    const after = offsetSelection(sel, dx, dy);
    const top = s.history.mergeTarget();
    if (top?.kind === "selection" && top.gesture === SELECTION_NUDGE_GESTURE && top.after === sel) {
      top.after = after;
      if (selectionsEqual(top.before, after)) s.history.discardNewest();
    } else {
      const bytes = selectionBytes(sel) + selectionBytes(after);
      s.history.push({ kind: "selection", before: sel, after, bytes, gesture: SELECTION_NUDGE_GESTURE });
    }
    s.selection.set(after);
    s.events.emit("history", undefined);
    return true;
  }
}
