/**
 * Tracks Alt and Space modifier keys for one keyboard scope, wiring window
 * `keydown`/`keyup` listeners only while the scope is active. Clearing both
 * modifiers on window `blur` prevents stuck keys after focus leaves the page.
 *
 * Extracted from `keyboard.ts` to keep {@link KeyboardScope} under the
 * ~400-line guideline.
 */

/** Callbacks invoked when modifier state changes. */
export interface ModifierHandlers {
  /** Space held or released (temporary pan). */
  onSpaceChange(down: boolean): void;
  /** Alt held or released (temporary eyedropper). Absent = not tracked. */
  onAltChange?(down: boolean): void;
}

/**
 * Alt/Space modifier tracker for a keyboard scope. Call {@link activate} /
 * {@link deactivate} in sync with the scope going active/inactive; both
 * modifiers are cleared on deactivation.
 */
export class ModifierScope {
  private spaceDown = false;
  private altDown = false;
  private listening = false;

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Alt") {
      event.preventDefault();
      this.setAlt(true);
    } else if (event.key === " " || event.code === "Space") {
      this.setSpace(true);
    }
  };

  private readonly onKeyUp = (event: KeyboardEvent): void => {
    if (event.key === "Alt") this.setAlt(false);
    else if (event.key === " " || event.code === "Space") this.setSpace(false);
  };

  private readonly onBlur = (): void => {
    this.setSpace(false);
    this.setAlt(false);
  };

  /**
   * @param handlers - Callbacks invoked when Space or Alt changes.
   */
  constructor(private readonly handlers: ModifierHandlers) {}

  /** Whether Space is currently held. */
  get isSpaceDown(): boolean {
    return this.spaceDown;
  }

  /** Whether Alt is currently held. */
  get isAltDown(): boolean {
    return this.altDown;
  }

  /**
   * Register window listeners. Idempotent.
   */
  activate(): void {
    if (this.listening) return;
    this.listening = true;
    window.addEventListener("keydown", this.onKeyDown, true);
    window.addEventListener("keyup", this.onKeyUp, true);
    window.addEventListener("blur", this.onBlur);
  }

  /**
   * Remove window listeners and clear both modifiers. Idempotent.
   */
  deactivate(): void {
    if (!this.listening) return;
    this.listening = false;
    window.removeEventListener("keydown", this.onKeyDown, true);
    window.removeEventListener("keyup", this.onKeyUp, true);
    window.removeEventListener("blur", this.onBlur);
    this.setSpace(false);
    this.setAlt(false);
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private setSpace(down: boolean): void {
    if (this.spaceDown === down) return;
    this.spaceDown = down;
    this.handlers.onSpaceChange(down);
  }

  private setAlt(down: boolean): void {
    if (this.altDown === down) return;
    this.altDown = down;
    this.handlers.onAltChange?.(down);
  }
}