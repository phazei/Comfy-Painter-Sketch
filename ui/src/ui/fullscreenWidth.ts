/**
 * Fullscreen width handles (SPEC "Canvas, view and fullscreen"): two vertical
 * bars at the editor's left and right edges in the fullscreen overlay. Dragging
 * either one moves both, symmetrically about the overlay's centre, so a very
 * wide monitor can keep the bars and the side panel near a centred image.
 *
 * The width is the editor root's `max-width` in CSS px (`null` = full width),
 * remembered per browser in `localStorage`. Double-click a handle for full
 * width. The overlay is a centred flex row `[left handle, root, right handle]`,
 * so the handles always sit against the root's edges and a window narrower than
 * the stored width simply shrinks the root.
 */

/** `localStorage` key of the remembered width. */
const STORAGE_KEY = "PainterSketch.fullscreenWidth";

/** Narrowest editor width a drag can reach, CSS px. */
export const MIN_FULLSCREEN_WIDTH = 640;

/** Within this many px of the available width a drag snaps to full width. */
const FULL_SNAP = 16;

// ── Pure geometry ─────────────────────────────────────────────────────────────

/**
 * Editor width for a handle dragged to `pointerX`: twice the distance to the
 * overlay's centre, minus the two handles.
 * @param pointerX - Pointer x, client px.
 * @param centerX - Overlay content centre, client px.
 * @param available - Widest the editor can be (overlay content minus handles), px.
 * @param handleWidth - Width of one handle, px.
 * @returns Width in px, or `null` for full width (at or near `available`).
 */
export function widthForPointer(
  pointerX: number,
  centerX: number,
  available: number,
  handleWidth: number,
): number | null {
  const width = Math.round(2 * Math.abs(pointerX - centerX) - handleWidth);
  if (width >= available - FULL_SNAP) return null;
  return Math.max(Math.min(MIN_FULLSCREEN_WIDTH, available), width);
}

/**
 * Narrow a stored value to a usable width.
 * @param raw - Stored string (or `null`).
 * @returns Width in px, or `null` for full width / unreadable values.
 */
export function parseStoredWidth(raw: string | null): number | null {
  if (raw === null) return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < MIN_FULLSCREEN_WIDTH) return null;
  return Math.round(value);
}

// ── Storage ───────────────────────────────────────────────────────────────────

/** The remembered width (`null` = full; storage blocked counts as unset). */
function loadWidth(): number | null {
  try {
    return parseStoredWidth(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    return null;
  }
}

/** Remember `width` (`null` clears it). Blocked storage: this page only. */
function saveWidth(width: number | null): void {
  try {
    if (width === null) window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, String(width));
  } catch (error) {
    console.warn("[PainterSketch] Could not remember the fullscreen width:", error);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// FullscreenWidth
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The two width handles of one fullscreen overlay. Created on enter, disposed
 * with the overlay.
 */
export class FullscreenWidth {
  private readonly left: HTMLDivElement;
  private readonly right: HTMLDivElement;
  private width: number | null = loadWidth();
  private dragging: HTMLElement | null = null;

  /**
   * Insert the handles around `root` (already a child of `overlay`) and apply
   * the remembered width.
   * @param overlay - Fullscreen overlay (centred flex row).
   * @param root - Editor root inside the overlay.
   */
  constructor(
    private readonly overlay: HTMLElement,
    private readonly root: HTMLElement,
  ) {
    this.left = this.buildHandle("left");
    this.right = this.buildHandle("right");
    root.before(this.left);
    root.after(this.right);
    this.apply();
  }

  /** Remove the handles and the width limit from the root. */
  dispose(): void {
    this.left.remove();
    this.right.remove();
    this.root.style.removeProperty("max-width");
  }

  private buildHandle(side: "left" | "right"): HTMLDivElement {
    const handle = document.createElement("div");
    handle.className = `cps-fs-handle cps-fs-handle-${side}`;
    handle.title = "Drag to narrow or widen the editor (double-click: full width)";
    const grip = document.createElement("div");
    grip.className = "cps-fs-grip";
    handle.appendChild(grip);
    handle.addEventListener("pointerdown", (event) => this.down(event, handle));
    handle.addEventListener("pointermove", (event) => this.move(event, handle));
    handle.addEventListener("pointerup", (event) => this.up(event, handle));
    handle.addEventListener("pointercancel", (event) => this.up(event, handle));
    handle.addEventListener("lostpointercapture", () => this.end());
    handle.addEventListener("dblclick", () => {
      this.width = null;
      this.apply();
      saveWidth(null);
    });
    return handle;
  }

  private down(event: PointerEvent, handle: HTMLElement): void {
    if (event.button !== 0) return;
    event.preventDefault();
    handle.setPointerCapture(event.pointerId);
    this.dragging = handle;
    this.overlay.classList.add("cps-fs-resizing");
  }

  private move(event: PointerEvent, handle: HTMLElement): void {
    if (this.dragging !== handle) return;
    const rect = this.overlay.getBoundingClientRect();
    const style = getComputedStyle(this.overlay);
    const padLeft = parseFloat(style.paddingLeft) || 0;
    const padRight = parseFloat(style.paddingRight) || 0;
    const handleWidth = handle.getBoundingClientRect().width;
    const content = rect.width - padLeft - padRight;
    const centerX = rect.left + padLeft + content / 2;
    this.width = widthForPointer(event.clientX, centerX, content - 2 * handleWidth, handleWidth);
    this.apply();
  }

  private up(event: PointerEvent, handle: HTMLElement): void {
    if (this.dragging !== handle) return;
    if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
    this.end();
  }

  /** Finish a drag (once): remember the width. */
  private end(): void {
    if (!this.dragging) return;
    this.dragging = null;
    this.overlay.classList.remove("cps-fs-resizing");
    saveWidth(this.width);
  }

  private apply(): void {
    if (this.width === null) this.root.style.removeProperty("max-width");
    else this.root.style.maxWidth = `${this.width}px`;
  }
}
