/**
 * De-duplication for user-facing toasts (pure, unit-testable).
 *
 * A message key shown within its window is suppressed, so a flaky server
 * during the 5 s idle uploads, or ten nodes failing the same way at once,
 * produces one toast instead of a storm. The console still gets every
 * occurrence (see `toast.ts`).
 */

/** Default suppression window for a repeated key. */
export const DEFAULT_TOAST_WINDOW_MS = 10_000;

/** Keys remembered at most (oldest are forgotten first). */
const MAX_KEYS = 64;

/**
 * Remembers when each key was last shown and decides whether to show again.
 */
export class ToastLimiter {
  /** Key -> time it was last shown. Insertion order = oldest first. */
  private readonly shownAt = new Map<string, number>();

  /**
   * @param now - Clock in ms (injectable for tests).
   */
  constructor(private readonly now: () => number = () => Date.now()) {}

  /**
   * Whether a toast with `key` should be shown now; records it if so.
   * A suppressed occurrence does not extend the window, so a persistent
   * problem is re-announced once per window.
   *
   * @param key - Message key (same problem = same key).
   * @param windowMs - Suppression window for this key.
   * @returns `true` to show the toast.
   */
  shouldShow(key: string, windowMs: number = DEFAULT_TOAST_WINDOW_MS): boolean {
    const t = this.now();
    const last = this.shownAt.get(key);
    if (last !== undefined && t - last < windowMs) return false;
    this.shownAt.delete(key);
    this.shownAt.set(key, t);
    while (this.shownAt.size > MAX_KEYS) {
      const oldest = this.shownAt.keys().next().value;
      if (oldest === undefined) break;
      this.shownAt.delete(oldest);
    }
    return true;
  }

  /**
   * Forget a key, so its next occurrence shows immediately (e.g. after the
   * problem was resolved).
   * @param key - Message key.
   */
  reset(key: string): void {
    this.shownAt.delete(key);
  }
}
