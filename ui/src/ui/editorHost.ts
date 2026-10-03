/**
 * The editor's DOM host: builds the shell layout (`shell.ts`) and wires its
 * components -- the floating bars, stage renderer, pointer input and
 * keyboard scope -- to one session at a time. Redraws are driven by editor
 * events, never by graph repaints.
 *
 * Knows nothing about ComfyUI; the widget layer attaches sessions and
 * reports node selection ({@link EditorHost.setNodeSelected}) and the side
 * panel's height cap ({@link EditorHost.setPanelHeightCap}).
 *
 * Chrome sync (tool changes, mask state, history, bottom bar) is delegated
 * to {@link HostSync} (`hostSync.ts`), which owns the bars, the Images
 * tray, the help overlay, the layers and outputs panels and region mode
 * (Outputs tab <-> region tool).
 *
 * Handles `pick-color` from the shell by opening the custom
 * {@link openColorPicker} popover (the only colour picker; there is no
 * native fallback), and `help` by toggling the help overlay.
 *
 * Chrome visibility (bars + side panel, `chromeVisibility.ts`): shown while
 * the node is selected, the keyboard scope is active (hover / engaged) or
 * fullscreen is open; hover alone shows it after a delay. Hidden chrome is
 * a root class (`cps-chrome-hidden`, editor.css) plus the panel's `hidden`.
 *
 * The `fullscreen` event toggles {@link FullscreenMount}, which moves
 * `root` between the stable DOM widget element ({@link EditorHost.element})
 * and a body-level overlay. Entering re-fits; leaving re-fits if the view
 * was fitting.
 */

import type { EditorSession } from "../widget/sessions";
import type { SourceHistory } from "../widget/sourceHistory";
import { ChromeVisibility } from "./chromeVisibility";
import { ClipboardActions } from "./clipboardActions";
import { insertSourceUrl } from "./sourceInsertAction";
import { openColorPicker } from "./colorPicker";
import { installDropImport } from "./dropImport";
import { FullscreenMount } from "./fullscreen";
import { HostSync } from "./hostSync";
import { KeyboardScope } from "./keyboard";
import { EditorShell } from "./shell";
import { handleShortcut } from "./shortcuts";
import { StageInput } from "./stageInput";
import { StageView } from "./stageView";
import { TextOverlay } from "./textOverlay";

/** Root class while the chrome (bars) is hidden; the panel uses `hidden`. */
const CHROME_HIDDEN_CLASS = "cps-chrome-hidden";

/** Callbacks from the host to its owner. */
export interface EditorHostEvents {
  /** The stage went from zero size (hidden/unmounted) to a visible size. */
  onBecameVisible?: () => void;
  /**
   * Polled while fullscreen: `true` when the editor's node is no longer on
   * the viewed graph (fullscreen then exits).
   */
  isDetached?: () => boolean;
  /**
   * The editor lost the user's attention: keyboard scope went inactive
   * (disengaged) or fullscreen closed. Upload trigger.
   */
  onDisengage?: () => void;
  /** Ctrl/Cmd+S while the editor owns the keyboard (already prevented). */
  onSave?: () => void;
}

// ═══════════════════════════════════════════════════════════════════════════
// EditorHost
// ═══════════════════════════════════════════════════════════════════════════

/**
 * DOM host of one node's editor.
 */
export class EditorHost {
  /** Layout regions + extension seams (side panel, popovers, events). */
  readonly shell: EditorShell;
  /** Element handed to `addDOMWidget`; never moves (holds `root`). */
  readonly element: HTMLDivElement;
  /** Editor root (= `shell.root`); moves into the fullscreen overlay. */
  readonly root: HTMLDivElement;
  /** Canvas area. */
  readonly stage: HTMLDivElement;
  /** Pointer/wheel router (the isolation guard forwards to it). */
  readonly input: StageInput;

  private readonly view: StageView;
  /** Chrome sync layer (owns the bars, Images tray, help overlay, side panels). */
  private readonly sync: HostSync;
  /** Text tool's in-canvas `<textarea>` + rasterize prompt. */
  private readonly textOverlay: TextOverlay;
  private readonly keyboard: KeyboardScope;
  private readonly resizeObserver: ResizeObserver;
  private readonly fullscreen: FullscreenMount;
  /** Copy / cut / paste (keys, clipboard pill, drops). */
  private readonly clipboard: ClipboardActions;
  private readonly removeDrop: () => void;
  /** Whether the view was fitting when fullscreen opened (re-fit on leaving). */
  private fittingBeforeFullscreen = true;
  /** The node is selected on the graph (chrome visibility). */
  private nodeSelected = false;
  /** The keyboard scope is active (chrome visibility). */
  private keyboardActive = false;
  /** The keyboard scope is engaged by a click (chrome shows at once). */
  private keyboardEngaged = false;
  /** Timed show / hide of the bars and the side panel. */
  private readonly chrome: ChromeVisibility;
  /** In-node side panel height cap, CSS px (`null` = none). */
  private panelHeightCap: number | null = null;

  private session: EditorSession | null = null;
  private unbind: Array<() => void> = [];
  private wasVisible = false;
  private disposed = false;

  /**
   * @param events - Owner callbacks.
   * @param sources - The node's `layer_source` history (Images tray), or `null`.
   */
  constructor(private readonly events: EditorHostEvents = {}, sources: SourceHistory | null = null) {
    this.shell = new EditorShell();
    this.root = this.shell.root;
    this.stage = this.shell.stage;
    this.fullscreen = new FullscreenMount(this.root, {
      beforeChange: () => {
        this.input.cancel();
        this.shell.popoverHost.close();
      },
      onChange: (open) => this.fullscreenChanged(open),
      isDetached: () => this.events.isDetached?.() ?? false,
    });
    this.element = this.fullscreen.container;
    this.chrome = new ChromeVisibility((shown) => {
      this.root.classList.toggle(CHROME_HIDDEN_CLASS, !shown);
      this.shell.sidePanel.setVisible(shown);
      // Nothing to anchor a menu / picker to once the bars are gone.
      if (!shown) this.shell.popoverHost.close();
    });
    this.chrome.hold(this.shell.sidePanel.element);
    this.root.classList.add(CHROME_HIDDEN_CLASS);
    this.view = new StageView(this.stage, () => this.session, () => this.input?.activeTool ?? null);

    // ── Clipboard (keys, clipboard pill, image drops on the stage) ────────
    this.clipboard = new ClipboardActions(() => this.session, this.stage);
    this.removeDrop = installDropImport(this.stage, this.clipboard, (text) => this.view.showNote(text));

    // ── Chrome sync (bars, Images tray, help, side panels) ────────────────
    // `cancelDrag` / `releaseFocus` close over `this.input` / `this.keyboard`,
    // assigned below; they are only ever called after construction completes.
    this.sync = new HostSync({
      shell: this.shell,
      getSession: () => this.session,
      optionsChanged: () => this.optionsChanged(),
      cancelDrag: () => this.input.cancel(),
      releaseFocus: () => this.keyboard.reclaimFocus(),
      clipboard: this.clipboard,
      sources,
      pickSource: (entry) => {
        const editor = this.session?.editor;
        if (editor) void insertSourceUrl(editor, entry.url, () => this.session?.editor ?? null, entry.name);
      },
    });
    this.shell.events.on("help", () => this.sync.help.toggle());

    // ── Colour picker ─────────────────────────────────────────────────────
    // Stays open for eyedropper presses on the stage (the tool, or Alt) and
    // follows the sampled colour; while it edits the background, every
    // eyedropper sample goes there (`colors.sampleSlot`, BG cursor badge).
    this.shell.events.on("pick-color", (request) => {
      const colors = this.session?.editor.colors;
      if (!colors) return;
      const slot = request.slot;
      const setSampleSlot = (value: "bg" | null): void => {
        colors.sampleSlot = value;
        this.view.syncCursor();
      };
      const handle = openColorPicker(this.shell.popoverHost, request.anchor, {
        initial: colors[slot],
        title: slot === "fg" ? "Foreground" : "Background",
        onInput: (hex) => colors.set(slot, hex),
        onCommit: (hex) => colors.set(slot, hex),
        onClose: () => setSampleSlot(null),
        follow: (onExternal) => colors.events.on("change", () => onExternal(colors[slot])),
        keepOpenOn: (event) => this.isEyedropperPress(event),
      });
      if (handle) setSampleSlot(slot === "bg" ? "bg" : null);
    });

    this.input = new StageInput(this.stage, {
      session: () => this.session,
      isSpaceDown: () => this.keyboard.isSpaceDown,
      setDragging: (dragging) => this.keyboard.setHeld(dragging),
      setHover: (point) => {
        this.view.hover = point;
        this.view.requestOverlay();
      },
      setAlt: (down) => this.setAlt(down),
      setShift: (down) => this.setShift(down),
      setCtrl: (down) => this.setCtrl(down),
      viewChanged: () => this.view.requestRender(),
    });
    this.keyboard = new KeyboardScope(this.root, {
      onKeyDown: (event) => this.handleKey(event),
      onSpaceChange: (down) => this.stage.classList.toggle("cps-pan-ready", down),
      onAltChange: (down) => this.setAlt(down),
      onShiftChange: (down) => this.setShift(down),
      onCtrlChange: (down) => this.setCtrl(down),
      onSave: () => this.events.onSave?.(),
      onDeactivate: () => this.events.onDisengage?.(),
      onActiveChange: (active, engaged) => {
        this.keyboardActive = active;
        this.keyboardEngaged = active && engaged;
        this.syncChromeVisibility();
      },
    });
    this.shell.popoverHost.events.on("close", () => this.keyboard.reclaimFocus());
    // ── Fullscreen (bottom bar button and `F` emit this) ──────────────────
    this.shell.events.on("fullscreen", () => this.fullscreen.toggle());

    this.textOverlay = new TextOverlay(this.stage, this.root, () => this.sync.strip.refresh());
    this.view.onRendered = () => this.textOverlay.sync();

    this.resizeObserver = new ResizeObserver(() => this.handleResize());
    this.resizeObserver.observe(this.stage);
  }

  // ── Public API ──────────────────────────────────────────────────────────

  /** Session currently shown (the colour picker and panels read its editor and tools). */
  get current(): EditorSession | null {
    return this.session;
  }

  /**
   * Show a session (or nothing).
   * @param session - Session to bind.
   */
  setSession(session: EditorSession | null): void {
    if (session === this.session) return;
    this.input.cancel();
    this.shell.popoverHost.close();
    for (const off of this.unbind) off();
    this.unbind = [];
    this.session = session;
    this.sync.bindEditor(session?.editor ?? null);
    this.textOverlay.bind(session);
    if (session) {
      const { editor, tools } = session;
      this.unbind.push(
        editor.events.on("render", () => this.view.requestRender()),
        editor.events.on("history", () => this.sync.syncHistory()),
        editor.events.on("note", (text) => this.view.showNote(text)),
        editor.events.on("mask", () => this.sync.syncMask()),
        editor.events.on("change", () => this.sync.syncMask()),
        // Rows, current mask / lmask target, solo, text edit, outputs: strip state parts + bottom bar.
        editor.events.on("layers", () => this.sync.syncState()),
        editor.events.on("text", () => this.sync.syncState()),
        editor.events.on("solo", () => this.sync.syncBottomBar()),
        editor.events.on("outputs", () => this.sync.syncBottomBar()),
        // Move tool: live X / Y / Scale fields.
        editor.events.on("placement", () => (this.sync.strip.refresh(), this.sync.resolution.sync())),
        // Drawing resolution notice + bottom bar (image size, loads): cheap / throttled.
        editor.events.on("render", () => (this.sync.resolution.sync(), this.sync.requestBottomBarSync())),
        // Selection: marching ants + "To mask" / "Invert" in the strip.
        editor.events.on("selection", () => (this.sync.syncOptions(), this.view.requestOverlay())),
        // Free Transform: strip swaps to the session options and back (dock dims); handles + cursor follow.
        editor.events.on("transform", () => (this.sync.syncOptions(), this.view.requestOverlay())),
        editor.colors.events.on("change", () => this.sync.syncSwatches()),
        // Tool switch: chrome (dock, strip, sliders, Align, panel tab) + stage cursor/ring now.
        tools.events.on("change", () => (this.sync.syncTools(), this.view.requestOverlay())),
      );
      this.sync.syncTools();
      this.sync.syncMask();
      this.sync.syncHistory();
      this.view.syncView();
    }
    this.view.requestRender();
  }

  /**
   * Re-check the on-screen scale (graph zoom changes don't trigger
   * ResizeObserver) and redraw if the backing store would change.
   */
  refreshScale(): void {
    if (this.view.syncBackingStore()) this.view.requestRender();
  }

  /** Whether the stage is attached and has a non-zero layout size. */
  isVisible(): boolean {
    return this.view.isVisible();
  }

  /** Schedule a redraw on the next animation frame (coalesced). */
  requestRender(): void {
    this.view.requestRender();
  }

  /**
   * Wheel over the editor outside the stage (rail, bar, side panel,
   * popovers); propagation is already stopped by the isolation guard.
   * @param event - Wheel event.
   */
  handleChromeWheel(event: WheelEvent): void {
    this.shell.handleChromeWheel(event);
  }

  /** Whether the editor is fullscreen. */
  get isFullscreen(): boolean {
    return this.fullscreen.isOpen;
  }

  /** Leave fullscreen if open (the root returns to {@link EditorHost.element}). */
  exitFullscreen(): void {
    this.fullscreen.exit();
  }

  /**
   * The node was selected / deselected on the graph (chrome visibility).
   * @param selected - Node selected.
   */
  setNodeSelected(selected: boolean): void {
    if (selected === this.nodeSelected) return;
    this.nodeSelected = selected;
    this.syncChromeVisibility();
  }

  /**
   * In-node height cap of the side panel (graph units = root CSS px). Ignored
   * while fullscreen, where CSS caps it to the editor height.
   * @param px - Maximum height, or `null` for none.
   */
  setPanelHeightCap(px: number | null): void {
    this.panelHeightCap = px;
    if (!this.fullscreen.isOpen) this.shell.sidePanel.setHeightCap(px);
  }

  /**
   * Tear down listeners and canvases (exits fullscreen first) and empty
   * {@link EditorHost.element}. The element itself stays where it is: the
   * owner removes it or hands its slot to a successor. Idempotent.
   */
  dispose(): void {
    if (this.disposed) return;
    this.fullscreen.dispose();
    this.setSession(null);
    this.disposed = true;
    this.resizeObserver.disconnect();
    this.removeDrop();
    this.clipboard.dispose();
    this.input.dispose();
    this.keyboard.dispose();
    this.chrome.dispose();
    this.sync.dispose();
    this.textOverlay.dispose();
    this.view.dispose();
    this.shell.dispose();
    this.root.remove();
  }

  // ── Fullscreen ──────────────────────────────────────────────────────────

  /** Root just moved into (`open`) or out of the overlay. */
  private fullscreenChanged(open: boolean): void {
    const view = this.session?.editor.view;
    this.sync.bottomBar.setFullscreen(open);
    this.root.classList.toggle("cps-is-fullscreen", open);
    // Fullscreen: the CSS cap (editor height); in-node: the node-derived cap.
    this.shell.sidePanel.setHeightCap(open ? null : this.panelHeightCap);
    this.keyboard.setCaptureScope(open ? this.fullscreen.overlayElement : null);
    this.syncChromeVisibility();
    if (open) {
      this.fittingBeforeFullscreen = view?.isFitting ?? true;
      view?.fit();
    } else {
      if (this.fittingBeforeFullscreen) view?.fit();
      this.events.onDisengage?.();
    }
    this.shell.requestLayout();
    // Layout is synchronous: size the backing store for the new stage now
    // (no graph CSS zoom in the overlay) instead of one blurry frame later.
    this.handleResize();
  }

  // ── Chrome visibility ───────────────────────────────────────────────────

  /**
   * Shown while the node is selected, the keyboard scope is active or
   * fullscreen is open. Hover alone (scope active, not engaged) is the only
   * non-deliberate cause, so only it waits the show delay.
   */
  private syncChromeVisibility(): void {
    if (this.disposed) return;
    const deliberate = this.nodeSelected || this.keyboardEngaged || this.fullscreen.isOpen;
    this.chrome.request(deliberate || this.keyboardActive, deliberate);
  }

  // ── Keys ────────────────────────────────────────────────────────────────

  /**
   * A keydown from the keyboard scope. Esc chain step 1 (help) beats the
   * Images tray (step 2, closed before every other handler); the rest of
   * the chain and every other key are `shortcuts.ts`.
   * @returns `true` if handled.
   */
  private handleKey(event: KeyboardEvent): boolean {
    if (event.key === "Escape" && this.sync.help.close()) return true;
    if (this.sync.images.handleKey(event)) return true;
    const session = this.session;
    if (!session) return false;
    return handleShortcut(event, session, {
      optionsChanged: () => this.optionsChanged(),
      viewChanged: () => this.view.requestRender(),
      cancelDrag: () => this.input.cancel(),
      cancelToolDrag: () => this.input.cancelToolDrag(),
      isToolDragging: () => this.input.activeTool !== null,
      fullscreen: () => this.shell.events.emit("fullscreen", undefined),
      toggleOutputs: () => this.sync.toggleOutputs(),
      closeHelp: () => this.sync.help.close(),
      toggleHelp: () => this.sync.help.toggle(),
      closePopover: () => {
        if (!this.shell.popoverHost.isOpen) return false;
        // Esc closes and keeps: an open output colour session commits via its onClose.
        return this.shell.popoverHost.close();
      },
      exitFullscreen: () => {
        if (!this.fullscreen.isOpen) return false;
        this.fullscreen.exit();
        return true;
      },
      clipboard: this.clipboard,
    });
  }

  /**
   * Whether a press is eyedropper use: the dock's eyedropper button, or a
   * left press on the stage (no Space pan) where the tool the stage would
   * resolve (Ctrl > Alt > active, as in `stageInput.ts`) is the eyedropper.
   */
  private isEyedropperPress(event: PointerEvent): boolean {
    const session = this.session;
    const target = event.target;
    if (target instanceof Element && target.closest(".cps-dropper-pill")) return true;
    if (!session || event.button !== 0 || this.keyboard.isSpaceDown) return false;
    if (!(target instanceof Node) || !this.stage.contains(target)) return false;
    return session.tools.resolve(event.altKey, event.ctrlKey || event.metaKey).id === "eyedropper";
  }

  // ── Sizing ──────────────────────────────────────────────────────────────

  private handleResize(): void {
    const visible = this.isVisible();
    if (visible && !this.wasVisible) this.events.onBecameVisible?.();
    this.wasVisible = visible;
    // Resizing the backing store clears it; ResizeObserver runs before
    // paint, so redraw now instead of showing one blank frame (mounts).
    if (this.view.syncBackingStore()) this.view.renderNow();
    else this.view.requestRender();
  }

  // ── Modifier keys ────────────────────────────────────────────────────────

  /** Alt held (keyboard or pointer modifier): the cursor follows `ToolRegistry.resolve`. */
  private setAlt(down: boolean): void {
    if (this.view.altDown === down) return;
    this.view.altDown = down;
    this.view.syncCursor();
    this.view.requestOverlay();
  }

  /** Ctrl/Cmd held (keyboard or pointer modifier): the cursor follows `ToolRegistry.resolve` (temporary Move). */
  private setCtrl(down: boolean): void {
    if (this.view.ctrlDown === down) return;
    this.view.ctrlDown = down;
    this.view.syncCursor();
    this.view.requestOverlay();
  }

  /** Shift held (keyboard or pointer modifier): selection-mode cursor badge. */
  private setShift(down: boolean): void {
    if (this.view.shiftDown === down) return;
    this.view.shiftDown = down;
    this.view.syncCursor();
  }

  // ── Options ─────────────────────────────────────────────────────────────

  private optionsChanged(): void {
    this.sync.optionsChanged();
    this.view.requestOverlay();
  }
}
