/**
 * The editor's DOM host: builds the shell layout (`shell.ts`) and wires its
 * components -- tool rail, options bar, FG/BG swatches, stage renderer,
 * pointer input and keyboard scope -- to one session at a time. Redraws are
 * driven by editor events, never by graph repaints.
 *
 * Knows nothing about ComfyUI; the widget layer attaches sessions.
 * Later stages plug in through {@link EditorHost.shell} (side panel, popover
 * host, `pick-color` and `fullscreen` events, root element).
 *
 * M3.2: handles `pick-color` from the shell by opening the custom
 * {@link openColorPicker} popover; sets `request.handled = true` to suppress
 * the native `<input type=color>` fallback in `shell.ts`.
 *
 * M3.4: the `fullscreen` event toggles {@link FullscreenMount}, which moves
 * `root` between the stable DOM widget element ({@link EditorHost.element})
 * and a body-level overlay. Entering opens the side panel and re-fits;
 * leaving restores the panel state and re-fits if the view was fitting.
 */

import { DEFAULT_MASK_COLOR } from "../document/create";
import { maskDisplayColor } from "../document/masks";
import type { EditorSession } from "../widget/sessions";
import { openColorPicker } from "./colorPicker";
import { FullscreenMount } from "./fullscreen";
import { KeyboardScope } from "./keyboard";
import { LayersPanel } from "./layersPanel";
import { OptionsBar } from "./optionsBar";
import { EditorShell } from "./shell";
import type { SidePanel } from "./sidePanel";
import { handleShortcut } from "./shortcuts";
import { StageInput } from "./stageInput";
import { StageView } from "./stageView";
import { SwatchWidget } from "./swatches";
import { ToolRail } from "./toolRail";

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

/** State saved on entering fullscreen, restored on leaving. */
interface FullscreenRestore {
  panel: ReturnType<SidePanel["snapshot"]>;
  fitting: boolean;
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
  private readonly rail: ToolRail;
  private readonly optionsBar: OptionsBar;
  private readonly swatches: SwatchWidget;
  private readonly layers: LayersPanel;
  private readonly keyboard: KeyboardScope;
  private readonly resizeObserver: ResizeObserver;
  private readonly fullscreen: FullscreenMount;
  private restoreState: FullscreenRestore | null = null;

  private session: EditorSession | null = null;
  private unbind: Array<() => void> = [];
  private wasVisible = false;
  private disposed = false;

  /**
   * @param events - Owner callbacks.
   */
  constructor(private readonly events: EditorHostEvents = {}) {
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
    this.view = new StageView(this.stage, () => this.session);

    this.rail = new ToolRail(this.shell.rail.tools, {
      selectTool: (id) => {
        this.input.cancel();
        this.session?.tools.setActive(id);
      },
      toggleQuickMask: () => {
        this.input.cancel();
        this.session?.editor.togglePaintTarget();
      },
      undo: () => this.session?.editor.undo(),
      redo: () => this.session?.editor.redo(),
      fit: () => {
        this.session?.editor.view.fit();
        this.view.requestRender();
      },
      clear: () => this.confirmClear(),
      fullscreen: () => this.shell.events.emit("fullscreen", undefined),
    });
    this.swatches = new SwatchWidget({
      pick: (slot, anchor) => {
        const colors = this.session?.editor.colors;
        if (colors) this.shell.requestColorPick(slot, anchor, colors[slot], (hex) => colors.set(slot, hex));
      },
      swap: () => this.session?.editor.colors.swap(),
      reset: () => this.session?.editor.colors.reset(),
    });
    this.shell.rail.swatchSlot.appendChild(this.swatches.element);
    this.optionsBar = new OptionsBar(this.shell.bar, this.shell.popoverHost, () => this.optionsChanged());

    // ── M3.3: layers panel in the side panel ──────────────────────────────
    this.layers = new LayersPanel({
      sidePanel: this.shell.sidePanel,
      popovers: this.shell.popoverHost,
      pickColor: (anchor, options) => openColorPicker(this.shell.popoverHost, anchor, options),
      beforeEdit: () => this.input.cancel(),
      releaseFocus: () => this.keyboard.reclaimFocus(),
    });
    this.shell.sidePanel.content.replaceChildren(this.layers.element);

    // ── M3.2: wire the colour picker ──────────────────────────────────────
    this.shell.events.on("pick-color", (request) => {
      const colors = this.session?.editor.colors;
      if (!colors) return;
      const slot = request.slot;
      request.handled = true;
      openColorPicker(this.shell.popoverHost, request.anchor, {
        initial: colors[slot],
        title: slot === "fg" ? "Foreground" : "Background",
        onInput: (hex) => colors.set(slot, hex),
        onCommit: (hex) => colors.set(slot, hex),
      });
    });

    this.input = new StageInput(this.stage, {
      session: () => this.session,
      isSpaceDown: () => this.keyboard.isSpaceDown,
      setDragging: (dragging) => this.keyboard.setHeld(dragging),
      setHover: (point) => {
        this.view.hover = point;
        this.view.requestOverlay();
      },
      viewChanged: () => this.view.requestRender(),
    });
    this.keyboard = new KeyboardScope(this.root, {
      onKeyDown: (event) =>
        this.session
          ? handleShortcut(event, this.session, {
              optionsChanged: () => this.optionsChanged(),
              viewChanged: () => this.view.requestRender(),
              cancelDrag: () => this.input.cancel(),
              fullscreen: () => this.shell.events.emit("fullscreen", undefined),
              closePopover: () => this.shell.popoverHost.close(),
              exitFullscreen: () => {
                if (!this.fullscreen.isOpen) return false;
                this.fullscreen.exit();
                return true;
              },
            })
          : false,
      onSpaceChange: (down) => this.stage.classList.toggle("cps-pan-ready", down),
      onSave: () => this.events.onSave?.(),
      onDeactivate: () => this.events.onDisengage?.(),
    });
    this.shell.popoverHost.events.on("close", () => this.keyboard.reclaimFocus());
    // ── M3.4: fullscreen (rail button and `F` emit this) ─────────────────
    this.shell.events.on("fullscreen", () => this.fullscreen.toggle());


    this.resizeObserver = new ResizeObserver(() => this.handleResize());
    this.resizeObserver.observe(this.stage);
  }

  // ── Public API ──────────────────────────────────────────────────────────

  /** Session currently shown (M3.2/M3.3 read its editor and tools). */
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
    this.layers.setEditor(session?.editor ?? null);
    if (session) {
      const { editor, tools } = session;
      this.unbind.push(
        editor.events.on("render", () => this.view.requestRender()),
        editor.events.on("history", () => this.syncHistory()),
        editor.events.on("note", (text) => this.view.showNote(text)),
        editor.events.on("mask", () => this.syncMask()),
        editor.events.on("change", () => this.syncMask()),
        editor.colors.events.on("change", (colors) => this.swatches.setColors(colors)),
        tools.events.on("change", () => this.syncTools()),
      );
      this.rail.setTools(tools.list(), tools.active.id);
      this.swatches.setColors(editor.colors.current);
      this.syncTools();
      this.syncMask();
      this.syncHistory();
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
    this.input.dispose();
    this.keyboard.dispose();
    this.layers.dispose();
    this.view.dispose();
    this.shell.dispose();
    this.root.remove();
  }

  // ── Sync ────────────────────────────────────────────────────────────────

  private syncTools(): void {
    const session = this.session;
    if (!session) return;
    this.rail.setActive(session.tools.active.id);
    this.optionsBar.bind(session.tools.active.options);
    this.view.requestOverlay();
  }

  /** Quick Mask button and "Mask" badge (the eye lives in the layers panel). */
  private syncMask(): void {
    const editor = this.session?.editor;
    if (!editor) return;
    const mask = editor.maskLayer;
    const color = mask ? maskDisplayColor(mask) : DEFAULT_MASK_COLOR;
    const targeting = editor.paintTarget === "mask";
    this.rail.setQuickMask(targeting, color);
    this.root.classList.toggle("cps-quickmask", targeting);
    this.optionsBar.setMask({ targeting, color });
  }

  private syncHistory(): void {
    const editor = this.session?.editor;
    this.rail.setHistory(editor?.canUndo ?? false, editor?.canRedo ?? false);
  }

  private optionsChanged(): void {
    this.optionsBar.refresh();
    this.session?.tools.notifyOptions();
    this.view.requestOverlay();
  }

  /** Clear button: confirm, then one undoable Clear (SPEC Behavior Notes). */
  private confirmClear(): void {
    const editor = this.session?.editor;
    if (!editor || editor.loading) return;
    if (!window.confirm("Clear all paint? This can be undone.")) return;
    this.input.cancel();
    editor.clear();
  }

  // ── Fullscreen ──────────────────────────────────────────────────────────

  /** Root just moved into (`open`) or out of the overlay. */
  private fullscreenChanged(open: boolean): void {
    const panel = this.shell.sidePanel;
    const view = this.session?.editor.view;
    this.rail.setFullscreen(open);
    this.root.classList.toggle("cps-is-fullscreen", open);
    this.keyboard.setCaptureScope(open ? this.fullscreen.overlayElement : null);
    if (open) {
      this.restoreState = { panel: panel.snapshot(), fitting: view?.isFitting ?? true };
      panel.setCollapsed(false);
      view?.fit();
    } else {
      const saved = this.restoreState;
      this.restoreState = null;
      if (saved) panel.restore(saved.panel);
      if (saved?.fitting) view?.fit();
      this.events.onDisengage?.();
    }
    // Layout is synchronous: size the backing store for the new stage now
    // (no graph CSS zoom in the overlay) instead of one blurry frame later.
    this.handleResize();
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
}
