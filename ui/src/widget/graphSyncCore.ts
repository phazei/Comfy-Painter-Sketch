/**
 * Pure parts of {@link ./graphSync}: a coalescing timer and the checks that
 * decide whether / how to ask ComfyUI's ChangeTracker for a state capture.
 * No `app` import, so everything here is unit-testable.
 */

// ── CoalescedTask ─────────────────────────────────────────────────────────────

/** Timer functions (injectable for tests). */
export interface TaskTimers {
  set(callback: () => void, delayMs: number): unknown;
  clear(handle: unknown): void;
}

const DEFAULT_TIMERS: TaskTimers = {
  set: (callback, delayMs) => setTimeout(callback, delayMs),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Runs one callback at most once per burst of {@link schedule} calls
 * (trailing debounce), with an explicit {@link flush} to run a pending call now.
 */
export class CoalescedTask {
  private handle: unknown = null;

  /**
   * @param run - The work to do.
   * @param timers - Timer functions (defaults to `setTimeout` / `clearTimeout`).
   */
  constructor(
    private readonly run: () => void,
    private readonly timers: TaskTimers = DEFAULT_TIMERS,
  ) {}

  /** @returns Whether a run is scheduled. */
  get pending(): boolean {
    return this.handle !== null;
  }

  /**
   * Run `delayMs` after the latest call (replaces any pending schedule).
   * @param delayMs - Delay in ms.
   */
  schedule(delayMs: number): void {
    this.cancel();
    this.handle = this.timers.set(() => {
      this.handle = null;
      this.run();
    }, delayMs);
  }

  /** Run now if scheduled; no-op otherwise. */
  flush(): void {
    if (!this.pending) return;
    this.cancel();
    this.run();
  }

  /** Drop a pending run. */
  cancel(): void {
    if (this.handle === null) return;
    this.timers.clear(this.handle);
    this.handle = null;
  }
}

// ── ChangeTracker access ──────────────────────────────────────────────────────

/**
 * The part of ComfyUI's `ChangeTracker` we call. `captureCanvasState` is the
 * current name (1.52+); `checkState` is the deprecated alias older frontends
 * have (it logs a deprecation warning in 1.52+).
 */
export interface ChangeTrackerLike {
  captureCanvasState?: () => void;
  checkState?: () => void;
}

/**
 * Ask a tracker to snapshot the live graph (a no-op in the tracker when
 * nothing changed).
 * @param tracker - Change tracker of the active workflow.
 * @returns `true` if a capture method was found and called.
 */
export function captureTrackerState(tracker: ChangeTrackerLike): boolean {
  if (typeof tracker.captureCanvasState === "function") {
    tracker.captureCanvasState();
    return true;
  }
  if (typeof tracker.checkState === "function") {
    tracker.checkState();
    return true;
  }
  return false;
}

/** Minimal graph shape: subgraphs expose their root as `rootGraph`. */
export interface GraphLike {
  rootGraph?: GraphLike;
}

/**
 * Whether a node lives (directly or in a subgraph) in the given root graph.
 * @param graph - The node's `graph` (`null` once removed / tab switched away).
 * @param root - The app's root graph (`app.graph`).
 * @returns `true` if `graph` belongs to `root`.
 */
export function isInRootGraph(graph: GraphLike | null | undefined, root: GraphLike | null | undefined): boolean {
  if (!graph || !root) return false;
  return (graph.rootGraph ?? graph) === root;
}
