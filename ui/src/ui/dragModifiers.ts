/**
 * Watches Shift/Alt/Ctrl/Meta while a stage drag is in progress, so tools
 * whose result depends on modifiers (shape Shift = square / 15 degrees, Alt
 * = from centre) update without waiting for the next pointer move. Window
 * listeners exist only between {@link DragModifierWatch.start} and
 * {@link DragModifierWatch.stop}; they never stop propagation (the keyboard
 * scope still sees every key). Alt's default is prevented during a drag so
 * the browser does not focus its menu bar on release.
 */

/** Modifier state (a subset of `PointerEvent` / `KeyboardEvent`). */
export interface ModifierState {
  shiftKey: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
}

const MODIFIER_KEYS = new Set(["Shift", "Alt", "Control", "Meta"]);

/**
 * Modifier change listener for the duration of one drag.
 */
export class DragModifierWatch {
  private listening = false;
  private readonly handle = (event: KeyboardEvent): void => {
    if (!MODIFIER_KEYS.has(event.key) || event.repeat) return;
    if (event.key === "Alt") event.preventDefault();
    this.onChange({ shiftKey: event.shiftKey, altKey: event.altKey, ctrlKey: event.ctrlKey, metaKey: event.metaKey });
  };

  /**
   * @param onChange - Called with the new state after a modifier key goes down or up.
   */
  constructor(private readonly onChange: (state: ModifierState) => void) {}

  /** Start listening (idempotent). */
  start(): void {
    if (this.listening) return;
    this.listening = true;
    window.addEventListener("keydown", this.handle, true);
    window.addEventListener("keyup", this.handle, true);
  }

  /** Stop listening (idempotent). */
  stop(): void {
    if (!this.listening) return;
    this.listening = false;
    window.removeEventListener("keydown", this.handle, true);
    window.removeEventListener("keyup", this.handle, true);
  }
}
