/**
 * Fullscreen by re-parenting (SPEC decision 1, M3.4): ONE editor instance
 * whose root element moves between the node and a fixed full-viewport
 * overlay on `document.body`.
 *
 * What moves and what stays:
 * - {@link FullscreenMount.container} (`.cps-widget`) is the element handed
 *   to `addDOMWidget`. It never moves: the frontend owns where it lives.
 *   LiteGraph's `DomWidget.vue` appends it once to its positioned wrapper and
 *   toggles that wrapper's visibility/transform each frame; Nodes 2.0's
 *   `WidgetDOM.vue` `replaceChildren(widget.element)`s it into its slot on
 *   (re)mount. Both only check "is `widget.element` already my child", so
 *   moving an inner child never confuses them, and hiding the wrapper (node
 *   off-screen, other graph) never hides the moved editor.
 * - The editor root (a child of the container) is what moves. While
 *   fullscreen, a placeholder button takes its place in the container.
 *
 * Exits automatically when the container leaves the DOM (Nodes 2.0 unmount,
 * LiteGraph widget unregistered) or when the owner reports the node is no
 * longer on the viewed graph (subgraph navigation, tab switch) -- checked on
 * a short poll that only runs while open. At most one editor is fullscreen
 * per page; entering another exits the first. The overlay is created on
 * enter and removed on exit, so nothing is left on `document.body`.
 */

import { setIcon } from "./icons";

/** Poll interval of the exit conditions while fullscreen. */
const WATCH_MS = 250;

/** Placeholder shown in the node while fullscreen. */
const PLACEHOLDER_TEXT = "Editing in fullscreen \u2014 press Esc or click to return";

/**
 * Events stopped at the overlay so nothing on the backdrop reaches
 * document-level graph handlers (the root stops its own).
 */
const OVERLAY_STOPPED = [
  "pointerdown",
  "pointerup",
  "pointercancel",
  "mousedown",
  "mouseup",
  "click",
  "dblclick",
  "contextmenu",
] as const;

/** Options for {@link FullscreenMount}. */
export interface FullscreenOptions {
  /** Runs right before the root moves (either direction). */
  beforeChange?: () => void;
  /** Runs right after the root moved. @param open - Now fullscreen. */
  onChange: (open: boolean) => void;
  /** Owner's extra exit check (node gone from the viewed graph). */
  isDetached?: () => boolean;
}

/** The mount that is currently fullscreen (at most one per page). */
let openMount: FullscreenMount | null = null;

// ═══════════════════════════════════════════════════════════════════════════
// FullscreenMount
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Owns the stable widget container and moves the editor root in and out of
 * the fullscreen overlay.
 */
export class FullscreenMount {
  /** Stable DOM widget element; holds the root (or the placeholder). */
  readonly container: HTMLDivElement;
  private readonly placeholder: HTMLButtonElement;
  private overlay: HTMLDivElement | null = null;
  private watchTimer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;

  /**
   * @param root - Editor root (appended to the container now).
   * @param options - Callbacks.
   */
  constructor(
    private readonly root: HTMLElement,
    private readonly options: FullscreenOptions,
  ) {
    this.container = document.createElement("div");
    this.container.className = "cps-widget";
    this.container.appendChild(root);
    this.placeholder = document.createElement("button");
    this.placeholder.type = "button";
    this.placeholder.className = "cps-fullscreen-placeholder";
    this.placeholder.textContent = PLACEHOLDER_TEXT;
    this.placeholder.addEventListener("click", () => this.exit());
  }

  /** Whether the editor is fullscreen. */
  get isOpen(): boolean {
    return this.overlay !== null;
  }

  /** The overlay element while fullscreen, else `null`. */
  get overlayElement(): HTMLElement | null {
    return this.overlay;
  }

  /** Enter or leave fullscreen. */
  toggle(): void {
    if (this.overlay) this.exit();
    else this.enter();
  }

  /** Move the root into a new overlay. No-op if open, disposed or unmounted. */
  enter(): void {
    if (this.overlay || this.disposed || !this.container.isConnected) return;
    openMount?.exit();
    this.options.beforeChange?.();
    const overlay = buildOverlay(() => this.exit());
    this.overlay = overlay;
    openMount = this;
    overlay.prepend(this.root);
    this.container.appendChild(this.placeholder);
    document.body.appendChild(overlay);
    this.watchTimer = setInterval(() => this.watch(), WATCH_MS);
    this.options.onChange(true);
  }

  /** Move the root back into the container and remove the overlay. */
  exit(): void {
    const overlay = this.overlay;
    if (!overlay) return;
    this.options.beforeChange?.();
    this.overlay = null;
    if (openMount === this) openMount = null;
    if (this.watchTimer !== null) clearInterval(this.watchTimer);
    this.watchTimer = null;
    this.placeholder.remove();
    this.container.appendChild(this.root);
    overlay.remove();
    this.options.onChange(false);
  }

  /** Exit (if open) and stop accepting `enter`. Idempotent. */
  dispose(): void {
    this.exit();
    this.disposed = true;
  }

  private watch(): void {
    if (!this.container.isConnected || this.options.isDetached?.()) this.exit();
  }
}

// ── Overlay ───────────────────────────────────────────────────────────────────

/**
 * Build the overlay: backdrop + top-right exit button. Pointer, wheel and
 * drag events are kept from reaching document-level graph handlers.
 * @param exit - Exit handler.
 * @returns The (not yet attached) overlay.
 */
function buildOverlay(exit: () => void): HTMLDivElement {
  const overlay = document.createElement("div");
  overlay.className = "cps-fullscreen";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-label", "PainterSketch fullscreen editor");

  const button = document.createElement("button");
  button.type = "button";
  button.className = "cps-fullscreen-exit";
  button.title = "Exit fullscreen (Esc)";
  setIcon(button, "exitFullscreen", 16);
  const label = document.createElement("span");
  label.textContent = "Exit fullscreen";
  button.appendChild(label);
  button.addEventListener("click", exit);
  overlay.appendChild(button);

  const stop = (event: Event): void => event.stopPropagation();
  for (const type of OVERLAY_STOPPED) overlay.addEventListener(type, stop);
  // Backdrop wheel: no page scroll / browser zoom (the root handles its own).
  overlay.addEventListener(
    "wheel",
    (event) => {
      event.stopPropagation();
      if (event.target === overlay || event.ctrlKey) event.preventDefault();
    },
    { passive: false },
  );
  // Dropping files here must not load a workflow into the hidden graph.
  const noDrop = (event: DragEvent): void => {
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "none";
  };
  overlay.addEventListener("dragover", noDrop);
  overlay.addEventListener("drop", noDrop);
  return overlay;
}
