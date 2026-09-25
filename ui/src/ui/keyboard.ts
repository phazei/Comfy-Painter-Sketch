/**
 * Keyboard scope for one editor (AGENTS.md "Keyboard Shortcuts").
 *
 * Active while hovering, a drag is in progress, the user has clicked inside
 * ("engaged"), or fullscreen is open. While active, capture-phase listeners
 * on `window` beat the frontend's keybinding service and LiteGraph.
 *
 * ChangeTracker (also window/capture, registered before extensions) cannot
 * be stopped; it ignores Ctrl+Z when `activeElement` is an INPUT. The editor
 * keeps a hidden `<input>` focused (the key sink) while active.
 *
 * Focus rules: hover takes the sink unless another text field has focus;
 * leaving returns it. Any click inside "engages" the editor (sink takes
 * over, survives pointer leave); a click outside or focus moving out ends
 * engagement. Non-text elements that receive focus are redirected to the
 * sink; a text field blurring to nothing reclaims it.
 *
 * Ctrl/Cmd+S in the editor is reported via {@link KeyboardHandlers.onSave}.
 * Scope going inactive is reported via {@link KeyboardHandlers.onDeactivate}.
 *
 * Fullscreen ({@link KeyboardScope.setCaptureScope}): active without hover;
 * unhandled keys filtered by {@link fullscreenKeyPolicy}.
 *
 * Alt/Space modifier tracking is delegated to {@link ModifierScope}.
 */

import { describeElement, hoverMayTakeFocus, isScopeActive, isTextEntry, mayKeepFocus, pointerFocusAction } from "./focusPolicy";
import { fullscreenKeyPolicy } from "./fullscreenKeys";
import { ModifierScope } from "./modifierScope";
import { isSaveChord } from "./saveKey";

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
  /** Alt held/released (temporary eyedropper). */
  onAltChange?(down: boolean): void;
  /**
   * Ctrl/Cmd+S while the editor owns the keyboard (focus in the root or the
   * fullscreen overlay). The event is already prevented and stopped; the
   * owner flushes uploads and runs ComfyUI's save command.
   */
  onSave?(): void;
  /**
   * The scope just became inactive (hover left without engagement, the
   * engagement ended, a held drag ended outside): the editor lost the user's
   * attention. Not called while fullscreen (the scope stays active).
   */
  onDeactivate?(): void;
}

/** Root class while the editor owns the keyboard. */
const HAS_KEYS_CLASS = "cps-has-keys";

// ═══════════════════════════════════════════════════════════════════════════

/**
 * Pointer/click-scoped keyboard capture.
 */
export class KeyboardScope {
  private active = false;
  private hovered = false;
  private held = false;
  private engaged = false;
  private previousFocus: Element | null = null;
  /** Fullscreen overlay (contains the root) while fullscreen, else `null`. */
  private captureScope: HTMLElement | null = null;
  private readonly sink: HTMLInputElement;
  /** Alt/Space modifier tracking (window keydown/keyup/blur). */
  private readonly modifiers: ModifierScope;

  private readonly keydown = (event: KeyboardEvent): void => this.handleKeyDown(event);
  private readonly keyup = (event: KeyboardEvent): void => this.handleKeyUp(event);
  /** Fullscreen: stop keys from our own text fields after they handled them. */
  private readonly rootKeydown = (event: KeyboardEvent): void => {
    if (this.captureScope && fullscreenKeyPolicy(event) === "swallow") event.stopPropagation();
  };
  /**
   * Any press inside the root engages the editor (see module doc). Capture
   * phase, so it runs before the stage/row/scrub handlers; those may still
   * `setPointerCapture` -- `preventDefault()` here only stops the focus move
   * and the compatibility mouse events, not `click`/`dblclick`.
   */
  private readonly rootPointerDown = (event: PointerEvent): void => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    this.setEngaged(true);
    if (pointerFocusAction(describeElement(target)) !== "sink") return;
    event.preventDefault();
    this.focusSink();
  };
  /**
   * Safety net: a non-text element inside the root that still receives
   * focus while active is redirected to the sink so ChangeTracker keeps
   * ignoring Ctrl+Z. Text entries and range sliders keep focus.
   */
  private readonly rootFocusIn = (event: FocusEvent): void => {
    const target = event.target;
    if (this.active && target instanceof Element && target !== this.sink && !mayKeepFocus(describeElement(target))) {
      this.focusSink();
    }
    this.syncIndicator();
  };
  /** One of our text fields blurred to nothing: give focus back to the sink. */
  private readonly rootFocusOut = (event: FocusEvent): void => {
    if (event.relatedTarget === null && event.target !== this.sink) queueMicrotask(() => this.reclaimFocus());
    queueMicrotask(() => this.syncIndicator());
  };
  /** Engaged: a press outside the root (and fullscreen overlay) ends it. */
  private readonly outsidePointerDown = (event: PointerEvent): void => {
    if (!this.isInside(event.target)) this.setEngaged(false);
  };
  /** Engaged: focus moving outside the root (and overlay) ends it. */
  private readonly outsideFocusIn = (event: FocusEvent): void => {
    if (!this.isInside(event.target)) this.setEngaged(false);
  };
  /**
   * Fullscreen: buttons and other non-input elements outside the root (the
   * overlay exit button, the backdrop) don't keep focus.
   */
  private readonly scopeFocusIn = (event: FocusEvent): void => {
    const target = event.target;
    if (target instanceof Element && !(target instanceof HTMLInputElement) && !isTextEntry(describeElement(target))) {
      this.focusSink();
    }
  };
  /** Fullscreen: a click on the backdrop leaves focus on `body`; reclaim it. */
  private readonly scopePointerUp = (): void => {
    queueMicrotask(() => this.reclaimFocus());
  };

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
    this.modifiers = new ModifierScope({
      onSpaceChange: (down) => handlers.onSpaceChange(down),
      onAltChange: (down) => handlers.onAltChange?.(down),
    });
    root.addEventListener("pointerenter", this.enter);
    root.addEventListener("pointerleave", this.leave);
    root.addEventListener("keydown", this.rootKeydown);
    root.addEventListener("pointerdown", this.rootPointerDown, true);
    root.addEventListener("focusin", this.rootFocusIn);
    root.addEventListener("focusout", this.rootFocusOut);
  }

  /** Whether Space is held (pan). */
  get isSpaceDown(): boolean {
    return this.modifiers.isSpaceDown;
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

  /**
   * Fullscreen on/off. While set, the scope is active regardless of hover
   * and filters unhandled keys (see module doc).
   * @param scope - Overlay element containing the root, or `null` to leave.
   */
  setCaptureScope(scope: HTMLElement | null): void {
    if (scope === this.captureScope) return;
    const previous = this.captureScope;
    if (previous) {
      previous.removeEventListener("focusin", this.scopeFocusIn);
      previous.removeEventListener("pointerup", this.scopePointerUp, true);
    }
    this.captureScope = scope;
    if (scope) {
      scope.addEventListener("focusin", this.scopeFocusIn);
      scope.addEventListener("pointerup", this.scopePointerUp, true);
    }
    this.sync();
    // Re-parenting the root drops focus from the sink; take it back.
    this.reclaimFocus();
    this.syncIndicator();
  }

  /**
   * While active, move focus back to the sink if nothing else holds it
   * (e.g. after a popover with a focused text field closed), so ComfyUI's
   * graph undo keeps ignoring Ctrl+Z.
   */
  reclaimFocus(): void {
    const current = document.activeElement;
    if (this.active && (!current || current === document.body)) this.focusSink();
    this.syncIndicator();
  }

  /** Remove listeners and the focus sink. */
  dispose(): void {
    this.hovered = false;
    this.held = false;
    this.setEngaged(false);
    this.setCaptureScope(null);
    this.sync();
    this.root.removeEventListener("pointerenter", this.enter);
    this.root.removeEventListener("pointerleave", this.leave);
    this.root.removeEventListener("keydown", this.rootKeydown);
    this.root.removeEventListener("pointerdown", this.rootPointerDown, true);
    this.root.removeEventListener("focusin", this.rootFocusIn);
    this.root.removeEventListener("focusout", this.rootFocusOut);
    this.root.classList.remove(HAS_KEYS_CLASS);
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

  private setEngaged(engaged: boolean): void {
    if (engaged === this.engaged) return;
    this.engaged = engaged;
    if (engaged) {
      // A click is an explicit choice; don't hand focus back on deactivation.
      this.previousFocus = null;
      window.addEventListener("pointerdown", this.outsidePointerDown, true);
      document.addEventListener("focusin", this.outsideFocusIn, true);
    } else {
      window.removeEventListener("pointerdown", this.outsidePointerDown, true);
      document.removeEventListener("focusin", this.outsideFocusIn, true);
    }
    this.sync();
  }

  private sync(): void {
    const shouldBeActive = isScopeActive({
      hovered: this.hovered,
      held: this.held,
      engaged: this.engaged,
      fullscreen: this.captureScope !== null,
    });
    if (shouldBeActive === this.active) return;
    this.active = shouldBeActive;
    if (shouldBeActive) {
      window.addEventListener("keydown", this.keydown, true);
      window.addEventListener("keyup", this.keyup, true);
      this.modifiers.activate();
      this.takeFocus();
    } else {
      window.removeEventListener("keydown", this.keydown, true);
      window.removeEventListener("keyup", this.keyup, true);
      this.modifiers.deactivate();
      this.returnFocus();
      this.handlers.onDeactivate?.();
    }
    this.syncIndicator();
  }

  /** Hover/fullscreen activation: take focus unless a text field has it. */
  private takeFocus(): void {
    const current = document.activeElement;
    const focused = current && current !== document.body ? current : null;
    if (focused === this.sink) return;
    if (focused && !hoverMayTakeFocus(describeElement(focused))) return;
    this.previousFocus = focused && !this.root.contains(focused) ? focused : null;
    this.focusSink();
  }

  private returnFocus(): void {
    if (document.activeElement !== this.sink) return;
    this.sink.blur();
    const previous = this.previousFocus;
    this.previousFocus = null;
    if (previous instanceof HTMLElement && previous.isConnected && !isTextEntry(describeElement(previous))) {
      previous.focus({ preventScroll: true });
    }
  }

  private focusSink(): void {
    if (document.activeElement !== this.sink) this.sink.focus({ preventScroll: true });
  }

  /** Focus indicator from the real focus state. */
  private syncIndicator(): void {
    const current = document.activeElement;
    const owns = current !== null && current !== document.body && this.root.contains(current);
    this.root.classList.toggle(HAS_KEYS_CLASS, owns);
  }

  /** Inside the root, or inside the fullscreen overlay holding it. */
  private isInside(target: EventTarget | null): boolean {
    if (!(target instanceof Node)) return false;
    return this.root.contains(target) || (this.captureScope?.contains(target) ?? false);
  }

  private handleKeyDown(event: KeyboardEvent): void {
    if (this.captureScope && this.isOutsideScope(event.target)) return;
    // Before the text-target check: Ctrl+S from our own fields (hex, text
    // tool) must flush too; fields outside the editor keep ComfyUI's save.
    if (isSaveChord(event) && this.ownsKeyTarget(event.target)) {
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) this.handlers.onSave?.();
      return;
    }
    if (this.isForeignTextTarget(event.target)) return;
    if (event.key === "Alt") {
      // Temporary eyedropper. Not stopped (the graph may track modifiers),
      // only prevented -- together with keyup this keeps Windows browsers
      // from focusing their menu bar when Alt is released.
      event.preventDefault();
      // ModifierScope handles the state update via its own capture listener.
      return;
    }
    if (event.key === " " || event.code === "Space") {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      event.preventDefault();
      event.stopPropagation();
      // ModifierScope handles the state update via its own capture listener.
      return;
    }
    if (this.handlers.onKeyDown(event) || (this.captureScope && fullscreenKeyPolicy(event) === "swallow")) {
      event.preventDefault();
      event.stopPropagation();
    }
  }

  private handleKeyUp(event: KeyboardEvent): void {
    if (event.key === "Alt") {
      if (!this.isForeignTextTarget(event.target)) event.preventDefault();
      return;
    }
    if (event.key === " " || event.code === "Space") {
      if (this.isForeignTextTarget(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
    }
  }

  /** Fullscreen: focus is in UI above/outside the overlay (e.g. a dialog). */
  private isOutsideScope(target: EventTarget | null): boolean {
    if (!(target instanceof Node) || target === document.body || target === document.documentElement) return false;
    return !(this.captureScope?.contains(target) ?? false);
  }

  /**
   * The editor owns this key: it targets the sink or another element inside
   * the root / fullscreen overlay. While fullscreen, `body` also counts (a
   * backdrop click can leave focus there before it is reclaimed).
   */
  private ownsKeyTarget(target: EventTarget | null): boolean {
    if (target === this.sink || this.isInside(target)) return true;
    return this.captureScope !== null && (target === document.body || target === document.documentElement);
  }

  /** Text fields other than our sink keep their keys (hex field, text tool...). */
  private isForeignTextTarget(target: EventTarget | null): boolean {
    return target instanceof Element && target !== this.sink && isTextEntry(describeElement(target));
  }
}