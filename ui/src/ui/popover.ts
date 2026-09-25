/**
 * Popover host: a layer INSIDE the editor root that floats small panels
 * (slider popovers now, the colour picker in M3.2) next to an anchor. Living
 * inside the root means fullscreen (M3.4) can re-parent the root and open
 * popovers move with it, and the root's pointer/wheel isolation covers them.
 *
 * One popover at a time, except nesting: a popover whose anchor lies inside
 * an open popover (e.g. a slider opened from the pressure group popover)
 * stacks on top of it. Opening closes every open popover that does not
 * contain the new anchor. A popover closes on a pointerdown outside it and
 * its anchor (a press inside a parent closes only its children), Escape
 * (inside the popover, or via {@link PopoverHost.close} from the shortcut
 * handler), when the anchor leaves the DOM, or when its parent closes. Positions are
 * computed in root-local CSS px, dividing out the graph zoom (the root may be
 * CSS-scaled), and clamped inside the root.
 */

import { Emitter } from "../engine/emitter";

/** Where to place a popover relative to its anchor. */
export type PopoverPlacement = "below" | "above" | "right";

/** Options for {@link PopoverHost.open}. */
export interface PopoverOptions {
  /** Element the popover is attached to (clicks on it do not close it). */
  anchor: HTMLElement;
  /** Preferred side (default `"below"`); flips when there is no room. */
  placement?: PopoverPlacement;
  /** Extra class on the popover element. */
  className?: string;
  /** Called once when the popover closes (any reason). */
  onClose?: () => void;
}

/** An open popover. */
export interface PopoverHandle {
  /** The popover element (holds the content). */
  readonly element: HTMLDivElement;
  /** Anchor it was opened for. */
  readonly anchor: HTMLElement;
  /** Close it (idempotent). */
  close(): void;
  /** Re-run positioning (after content size changes). */
  reposition(): void;
}

/** Popover host events. */
export interface PopoverEvents {
  [key: string]: unknown;
  /** A popover closed. */
  close: undefined;
}

/** Gap between anchor and popover, root CSS px. */
const GAP = 4;

/**
 * The popover layer of one editor root.
 */
export class PopoverHost {
  /** Overlay element (append-only child of the editor root). */
  readonly element: HTMLDivElement;
  /** `close` fires after any popover closed. */
  readonly events = new Emitter<PopoverEvents>();
  /** Open popovers, bottom (outermost) first. */
  private readonly stack: PopoverHandle[] = [];
  private readonly outside = (event: PointerEvent): void => {
    const target = event.target;
    if (!(target instanceof Node)) return;
    for (let top = this.stack.at(-1); top; top = this.stack.at(-1)) {
      if (top.element.contains(target) || top.anchor.contains(target)) return;
      top.close();
    }
  };

  /**
   * @param root - Editor root (the host is appended to it).
   */
  constructor(private readonly root: HTMLElement) {
    this.element = document.createElement("div");
    this.element.className = "cps-popover-host";
    root.appendChild(this.element);
  }

  /** Whether a popover is open. */
  get isOpen(): boolean {
    return this.stack.length > 0;
  }

  /** The topmost open popover, if any. */
  get active(): PopoverHandle | null {
    return this.stack.at(-1) ?? null;
  }

  /**
   * Open `content` next to an anchor. Open popovers that do not contain the
   * anchor close first; one that does stays open underneath (nesting).
   * @param content - Popover content.
   * @param options - Anchor, placement, close callback.
   * @returns Handle of the new popover.
   */
  open(content: HTMLElement, options: PopoverOptions): PopoverHandle {
    for (let top = this.stack.at(-1); top && !top.element.contains(options.anchor); top = this.stack.at(-1)) {
      top.close();
    }
    const element = document.createElement("div");
    element.className = `cps-popover${options.className ? ` ${options.className}` : ""}`;
    element.appendChild(content);
    element.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      handle.close();
    });
    this.element.appendChild(element);
    let closed = false;
    const handle: PopoverHandle = {
      element,
      anchor: options.anchor,
      close: () => {
        if (closed) return;
        closed = true;
        // Children (stacked above) go first.
        const index = this.stack.indexOf(handle);
        while (index >= 0 && this.stack.length > index + 1) this.stack.at(-1)?.close();
        if (index >= 0) this.stack.splice(index, 1);
        element.remove();
        if (this.stack.length === 0) window.removeEventListener("pointerdown", this.outside, true);
        options.onClose?.();
        this.events.emit("close", undefined);
      },
      reposition: () => {
        if (options.anchor.isConnected) this.position(element, options.anchor, options.placement ?? "below");
        else handle.close();
      },
    };
    this.stack.push(handle);
    window.addEventListener("pointerdown", this.outside, true);
    handle.reposition();
    return handle;
  }

  /** Close every open popover. @returns `true` if one was open. */
  close(): boolean {
    const bottom = this.stack[0];
    if (!bottom) return false;
    bottom.close();
    return true;
  }

  /**
   * Close the open popovers anchored inside `container` (and their children).
   * @param container - E.g. the options bar whose controls are being rebuilt.
   */
  closeAnchoredIn(container: Element): void {
    const handle = this.stack.find((h) => container.contains(h.anchor));
    handle?.close();
  }

  /** Close and remove the layer. */
  dispose(): void {
    this.close();
    this.events.clear();
    this.element.remove();
  }

  // ── Positioning ─────────────────────────────────────────────────────────

  private position(element: HTMLElement, anchor: HTMLElement, placement: PopoverPlacement): void {
    const rootRect = this.root.getBoundingClientRect();
    const scale = this.root.offsetWidth > 0 && rootRect.width > 0 ? rootRect.width / this.root.offsetWidth : 1;
    const a = anchor.getBoundingClientRect();
    // Root-local padding-box coords (absolute children ignore the border).
    const ox = rootRect.left + this.root.clientLeft * scale;
    const oy = rootRect.top + this.root.clientTop * scale;
    const box = {
      left: (a.left - ox) / scale,
      top: (a.top - oy) / scale,
      right: (a.right - ox) / scale,
      bottom: (a.bottom - oy) / scale,
    };
    const w = element.offsetWidth;
    const h = element.offsetHeight;
    const rootW = this.root.clientWidth;
    const rootH = this.root.clientHeight;
    let left: number;
    let top: number;
    if (placement === "right") {
      left = box.right + GAP;
      top = box.top;
      if (left + w > rootW) left = box.left - GAP - w;
    } else {
      left = box.left;
      top = placement === "above" ? box.top - GAP - h : box.bottom + GAP;
      if (placement === "below" && top + h > rootH) top = box.top - GAP - h;
      if (placement === "above" && top < 0) top = box.bottom + GAP;
    }
    element.style.left = `${Math.round(clamp(left, 0, rootW - w))}px`;
    element.style.top = `${Math.round(clamp(top, 0, rootH - h))}px`;
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(Math.max(lo, hi), v));
}
