/**
 * Undo/redo bookkeeping (SPEC "Undo and redo"). Generic over entry payloads so it is
 * pure and unit-testable; the editor defines the entry types and applies them.
 *
 * - Synchronous: `undo()`/`redo()` just hand back the entry to apply.
 * - Memory-capped: every entry reports its byte estimate; when the total
 *   (undo + redo) exceeds the cap, the oldest undo entries are dropped. The
 *   newest entry is always kept, even if it alone exceeds the cap.
 * - Joinable: {@link HistoryStack.joinNext} folds the next entry into the
 *   newest one (via the `combine` callback), so a preparatory step and the
 *   edit that follows undo together.
 */

/** Anything that can report its memory cost. */
export interface Sized {
  /** Estimated bytes held by the entry. */
  readonly bytes: number;
}

/** Default memory cap: 256 MB. */
export const DEFAULT_HISTORY_BYTES = 256 * 1024 * 1024;

/**
 * Undo/redo stacks with a byte budget.
 */
export class HistoryStack<T extends Sized> {
  private readonly undoStack: T[] = [];
  private readonly redoStack: T[] = [];
  private total = 0;
  /** Pending {@link joinNext}: which next entry joins the newest one. */
  private joining: ((entry: T) => boolean) | null = null;

  /**
   * @param maxBytes - Memory budget across both stacks.
   * @param combine - Builds one entry from two (older first) for {@link joinNext}.
   */
  constructor(
    private readonly maxBytes: number = DEFAULT_HISTORY_BYTES,
    private readonly combine?: (older: T, newer: T) => T,
  ) {}

  /** Whether there is something to undo. */
  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  /** Whether there is something to redo. */
  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** Estimated bytes held. */
  get totalBytes(): number {
    return this.total;
  }

  /** Number of undo entries. */
  get undoDepth(): number {
    return this.undoStack.length;
  }

  /** Number of redo entries. */
  get redoDepth(): number {
    return this.redoStack.length;
  }

  /**
   * The newest undo entry, only while nothing is redoable (the entry a
   * continuing gesture may merge into).
   * @returns The entry, or `undefined`.
   */
  mergeTarget(): T | undefined {
    return this.redoStack.length ? undefined : this.undoStack[this.undoStack.length - 1];
  }

  /**
   * Record a new operation. Clears the redo stack, then enforces the cap.
   *
   * @param entry - The applied operation.
   * @returns Entries evicted to stay within budget (oldest first).
   */
  push(entry: T): T[] {
    for (const dropped of this.redoStack) this.total -= dropped.bytes;
    this.redoStack.length = 0;
    const accept = this.joining;
    this.joining = null;
    const older = accept && this.combine && accept(entry) ? this.undoStack.pop() : undefined;
    if (older && this.combine) {
      this.total -= older.bytes;
      entry = this.combine(older, entry);
    }
    this.undoStack.push(entry);
    this.total += entry.bytes;
    return this.enforceCap();
  }

  /**
   * Make the next pushed entry part of the newest one (one undo step), if
   * `accept` approves it; any other push, undo, redo or clear drops the
   * request. Used when an edit needs a preparatory step (rasterizing a text
   * layer before painting on it).
   * @param accept - Which next entry may join (default: any).
   */
  joinNext(accept: (entry: T) => boolean = () => true): void {
    this.joining = this.undoStack.length > 0 && this.redoStack.length === 0 ? accept : null;
  }

  /**
   * Drop the newest undo entry without making it redoable (an operation that
   * turned out to be a no-op, e.g. a text layer committed empty).
   * @returns The dropped entry, or `null`.
   */
  discardNewest(): T | null {
    this.joining = null;
    const entry = this.undoStack.pop();
    if (!entry) return null;
    this.total -= entry.bytes;
    return entry;
  }

  /**
   * Fold `entry` and every undo entry newer than it into ONE step (via the
   * `combine` callback, oldest first). Used when an operation spans several
   * pushes (an inserted image: the layer add + the transform commit).
   * @param entry - Oldest entry of the step (must be on the undo side).
   * @returns `true` if entries were joined.
   */
  joinSince(entry: T): boolean {
    const i = this.undoStack.indexOf(entry);
    const combine = this.combine;
    if (i < 0 || i === this.undoStack.length - 1 || !combine) return false;
    this.joining = null;
    const parts = this.undoStack.splice(i);
    this.undoStack.push(parts.reduce((older, newer) => combine(older, newer)));
    return true;
  }

  /** Drop the redo side (an undo that must not be redoable, e.g. a cancelled insert). */
  dropRedo(): void {
    for (const dropped of this.redoStack) this.total -= dropped.bytes;
    this.redoStack.length = 0;
  }

  /**
   * Move the newest entry to the redo stack.
   *
   * @returns The entry to revert, or `null` when there is nothing to undo.
   */
  undo(): T | null {
    this.joining = null;
    const entry = this.undoStack.pop();
    if (!entry) return null;
    this.redoStack.push(entry);
    return entry;
  }

  /**
   * Move the newest redo entry back to the undo stack.
   *
   * @returns The entry to re-apply, or `null` when there is nothing to redo.
   */
  redo(): T | null {
    this.joining = null;
    const entry = this.redoStack.pop();
    if (!entry) return null;
    this.undoStack.push(entry);
    return entry;
  }

  /**
   * Whether any entry (undo or redo side) matches.
   * @param predicate - Test.
   * @returns `true` if one matches.
   */
  some(predicate: (entry: T) => boolean): boolean {
    return this.undoStack.some(predicate) || this.redoStack.some(predicate);
  }

  /**
   * Split the history at the newest undo entry matching `isBarrier`.
   * @param isBarrier - Barrier test (e.g. a Clear step).
   * @returns The barrier (or `undefined`) and every entry the barrier does
   *   not cover: undo entries newer than it (all undo entries without one)
   *   plus the whole redo side.
   */
  since(isBarrier: (entry: T) => boolean): { barrier: T | undefined; newer: T[] } {
    let i = this.undoStack.length - 1;
    for (; i >= 0; i--) {
      const entry = this.undoStack[i];
      if (entry !== undefined && isBarrier(entry)) break;
    }
    return { barrier: i >= 0 ? this.undoStack[i] : undefined, newer: [...this.undoStack.slice(i + 1), ...this.redoStack] };
  }

  /**
   * Drop every undo entry newer than `entry` and the whole redo side;
   * `entry` becomes the newest step. No-op when `entry` is not on the undo side.
   * @param entry - Entry to keep as the newest.
   */
  truncateAfter(entry: T): void {
    const i = this.undoStack.indexOf(entry);
    if (i < 0) return;
    this.joining = null;
    for (const dropped of [...this.undoStack.splice(i + 1), ...this.redoStack]) this.total -= dropped.bytes;
    this.redoStack.length = 0;
  }

  /** Drop everything. */
  clear(): void {
    this.joining = null;
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.total = 0;
  }

  private enforceCap(): T[] {
    const evicted: T[] = [];
    while (this.total > this.maxBytes && this.undoStack.length > 1) {
      const oldest = this.undoStack.shift();
      if (!oldest) break;
      this.total -= oldest.bytes;
      evicted.push(oldest);
    }
    return evicted;
  }
}
