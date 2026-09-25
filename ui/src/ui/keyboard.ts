/**
 * Keyboard scope for one editor (AGENTS.md "Keyboard Shortcuts").
 *
 * Active only while the pointer is over the editor (or a stroke/pan that
 * started there is still in progress). While active, capture-phase listeners
 * on `window` see keys before the frontend: handled keys get
 * `preventDefault()` + `stopPropagation()`, which stops the keybinding
 * service (window, bubble phase) and LiteGraph's canvas handlers.
 *
 * The frontend's ChangeTracker also listens on window/capture, registered at
 * startup BEFORE any extension, so propagation cannot stop it; it runs graph
 * undo on Ctrl+Z unless `document.activeElement` is an INPUT/TEXTAREA. So
 * while active we move focus to a hidden read-only `<input>` inside the
 * editor (only if focus is not already in some other text field), and give
 * it back on leave.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

/** Callbacks from the scope to the editor UI. */
export interface KeyboardHandlers {
  /**
   * A keydown while active. @returns `true` if handled (stops the event).
   * @param event - The key event.
   */
  onKeyDown(event: KeyboardEvent): boolean;
  /** Space held/released (temporary pan). */
  onSpaceChange(down: boolean): void;
}

// ═══════════════════════════════════════════════════════════════════════════

/**
 * Pointer-scoped keyboard capture.
 */
export class KeyboardScope {
  private active = false;
  private hovered = false;
  private held = false;
  private spaceDown = false;
  private previousFocus: Element | null = null;
  private readonly sink: HTMLInputElement;

  private readonly keydown = (event: KeyboardEvent): void => this.handleKeyDown(event);
  private readonly keyup = (event: KeyboardEvent): void => this.handleKeyUp(event);
  private readonly blur = (): void => this.setSpace(false);

  /**
   * @param root - Editor root (hover target, hosts the focus sink).
   * @param handlers - Key callbacks.
   */
  constructor(
    private readonly root: HTMLElement,
    private readonly handlers: KeyboardHandlers,
  ) {
    this.sink = document.createElement("input");
    this.sink.className = "cps-focus-sink";
    this.sink.readOnly = true;
    this.sink.tabIndex = -1;
    this.sink.setAttribute("aria-hidden", "true");
    root.appendChild(this.sink);
    root.addEventListener("pointerenter", this.enter);
    root.addEventListener("pointerleave", this.leave);
  }

  /** Whether Space is held (pan). */
  get isSpaceDown(): boolean {
    return this.spaceDown;
  }

  /**
   * Keep the scope active while a drag that started inside is in progress,
   * even if the pointer leaves.
   * @param held - Drag in progress.
   */
  setHeld(held: boolean): void {
    this.held = held;
    this.sync();
  }

  /** Remove listeners and the focus sink. */
  dispose(): void {
    this.hovered = false;
    this.held = false;
    this.sync();
    this.root.removeEventListener("pointerenter", this.enter);
    this.root.removeEventListener("pointerleave", this.leave);
    this.sink.remove();
  }

  // ── Internals ───────────────────────────────────────────────────────────

  private readonly enter = (): void => {
    this.hovered = true;
    this.sync();
  };

  private readonly leave = (): void => {
    this.hovered = false;
    this.sync();
  };

  private sync(): void {
    const shouldBeActive = this.hovered || this.held;
    if (shouldBeActive === this.active) return;
    this.active = shouldBeActive;
    if (shouldBeActive) {
      window.addEventListener("keydown", this.keydown, true);
      window.addEventListener("keyup", this.keyup, true);
      window.addEventListener("blur", this.blur);
      this.takeFocus();
    } else {
      window.removeEventListener("keydown", this.keydown, true);
      window.removeEventListener("keyup", this.keyup, true);
      window.removeEventListener("blur", this.blur);
      this.setSpace(false);
      this.returnFocus();
    }
  }

  private takeFocus(): void {
    const current = document.activeElement;
    if (current && current !== document.body && !this.root.contains(current) && isTextField(current)) return;
    this.previousFocus = current && !this.root.contains(current) ? current : null;
    this.sink.focus({ preventScroll: true });
  }

  private returnFocus(): void {
    if (document.activeElement !== this.sink) return;
    this.sink.blur();
    const previous = this.previousFocus;
    this.previousFocus = null;
    if (previous instanceof HTMLElement && previous.isConnected && !isTextField(previous)) {
      previous.focus({ preventScroll: true });
    }
  }

  private handleKeyDown(event: KeyboardEvent): void {
    if (this.isForeignTextTarget(event.target)) return;
    if (event.key === " " || event.code === "Space") {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      event.preventDefault();
      event.stopPropagation();
      this.setSpace(true);
      return;
    }
    if (this.handlers.onKeyDown(event)) {
      event.preventDefault();
      event.stopPropagation();
    }
  }

  private handleKeyUp(event: KeyboardEvent): void {
    if (event.key === " " || event.code === "Space") {
      if (this.isForeignTextTarget(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      this.setSpace(false);
    }
  }

  private setSpace(down: boolean): void {
    if (this.spaceDown === down) return;
    this.spaceDown = down;
    this.handlers.onSpaceChange(down);
  }

  /** Text fields other than our sink keep their keys (hex field, text tool...). */
  private isForeignTextTarget(target: EventTarget | null): boolean {
    return target instanceof Element && target !== this.sink && isTextField(target);
  }
}

function isTextField(element: Element): boolean {
  if (element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) return true;
  if (element instanceof HTMLInputElement) {
    return !["range", "checkbox", "radio", "button", "color"].includes(element.type);
  }
  return element instanceof HTMLElement && element.isContentEditable;
}
