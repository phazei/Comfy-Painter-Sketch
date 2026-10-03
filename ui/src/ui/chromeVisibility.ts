/**
 * When the editor's chrome (floating bars and the side panel) is on screen
 * (SPEC "Editor shell and focus"). In-node the chrome hides while the editor
 * is idle so the node is just the image; it shows while the node is
 * selected, the keyboard scope is active, or fullscreen is open.
 *
 * Timing, so the chrome doesn't flicker while the pointer merely crosses the
 * node on the graph:
 * - A show caused only by hover waits {@link SHOW_DELAY_MS}; a deliberate one
 *   (click inside the editor, node selected, fullscreen) is immediate.
 * - A hide waits {@link HIDE_GRACE_MS} so the pointer can cross the gap to
 *   the side panel, and is held off while the pointer is over a held element
 *   (the panel, which sits outside the root).
 *
 * The host applies the result (panel visibility + a root class that hides
 * the bars); this class only decides and times.
 */

/** Delay before a hover-only show takes effect, ms (3x the hide grace). */
export const SHOW_DELAY_MS = 750;
/** Delay before a requested hide takes effect, ms. */
export const HIDE_GRACE_MS = 250;

/**
 * Show / hide decision with the delays above.
 */
export class ChromeVisibility {
  /** What the host asked for. */
  private wanted = false;
  /** Pointer over a held element. */
  private hovered = false;
  /** Last applied value. */
  private shown = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly cleanups: Array<() => void> = [];

  /**
   * @param apply - Called with the new visibility whenever it changes.
   */
  constructor(private readonly apply: (shown: boolean) => void) {}

  /** Chrome currently on screen. */
  get visible(): boolean {
    return this.shown;
  }

  /**
   * Request a visibility.
   * @param visible - Wanted visibility.
   * @param immediate - A deliberate show (click, node selection, fullscreen): skip the hover delay.
   */
  request(visible: boolean, immediate = false): void {
    this.wanted = visible;
    if (visible) {
      if (this.shown) {
        this.clearTimer();
      } else if (immediate) {
        this.set(true);
      } else if (this.timer === null) {
        this.timer = setTimeout(() => {
          this.timer = null;
          if (this.wanted) this.set(true);
        }, SHOW_DELAY_MS);
      }
    } else if (this.shown) {
      if (!this.hovered) this.startGrace();
    } else {
      this.clearTimer();
    }
  }

  /**
   * Keep the chrome up while the pointer is over `element` (a part that
   * lives outside the root, so the keyboard scope's hover doesn't cover it).
   * @param element - Element to watch.
   */
  hold(element: HTMLElement): void {
    const enter = (): void => {
      this.hovered = true;
      if (this.shown) this.clearTimer();
    };
    const leave = (): void => {
      this.hovered = false;
      if (!this.wanted && this.shown) this.startGrace();
    };
    element.addEventListener("pointerenter", enter);
    element.addEventListener("pointerleave", leave);
    this.cleanups.push(() => {
      element.removeEventListener("pointerenter", enter);
      element.removeEventListener("pointerleave", leave);
    });
  }

  /** Cancel timers and listeners. */
  dispose(): void {
    this.clearTimer();
    for (const cleanup of this.cleanups.splice(0)) cleanup();
  }

  private startGrace(): void {
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.wanted && !this.hovered) this.set(false);
    }, HIDE_GRACE_MS);
  }

  private clearTimer(): void {
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
  }

  private set(shown: boolean): void {
    this.clearTimer();
    if (shown === this.shown) return;
    this.shown = shown;
    this.apply(shown);
  }
}
