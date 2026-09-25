/**
 * Undo/redo bookkeeping (decision 10). Generic over entry payloads so it is
 * pure and unit-testable; the editor defines the entry types and applies them.
 *
 * - Synchronous: `undo()`/`redo()` just hand back the entry to apply.
 * - Memory-capped: every entry reports its byte estimate; when the total
 *   (undo + redo) exceeds the cap, the oldest undo entries are dropped. The
 *   newest entry is always kept, even if it alone exceeds the cap.
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

  /**
   * @param maxBytes - Memory budget across both stacks.
   */
  constructor(private readonly maxBytes: number = DEFAULT_HISTORY_BYTES) {}

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
   * Record a new operation. Clears the redo stack, then enforces the cap.
   *
   * @param entry - The applied operation.
   * @returns Entries evicted to stay within budget (oldest first).
   */
  push(entry: T): T[] {
    for (const dropped of this.redoStack) this.total -= dropped.bytes;
    this.redoStack.length = 0;
    this.undoStack.push(entry);
    this.total += entry.bytes;
    return this.enforceCap();
  }

  /**
   * Move the newest entry to the redo stack.
   *
   * @returns The entry to revert, or `null` when there is nothing to undo.
   */
  undo(): T | null {
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
    const entry = this.redoStack.pop();
    if (!entry) return null;
    this.undoStack.push(entry);
    return entry;
  }

  /** Drop everything. */
  clear(): void {
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
