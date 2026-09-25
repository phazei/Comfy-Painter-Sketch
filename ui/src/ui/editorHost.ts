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
 * Rail/options-bar sync (tool changes, mask state, history) is delegated to
 * {@link HostSync} (`hostSync.ts`), which owns those five sub-components
 * (rail, swatches, options bar, selection actions, layers panel).
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

import type { EditorSession } from "../widget/sessions";
import { openColorPicker } from "./colorPicker";
import { FullscreenMount } from "./fullscreen";
import { HostSync } from "./hostSync";
import { KeyboardScope } from "./keyboard";
import { EditorShell } from "./shell";
import type { SidePanel } from "./sidePanel";
import { handleShortcut } from "./shortcuts";
import { StageInput } from "./stageInput";
import { StageView } from "./stageView";
import { TextOverlay } from "./textOverlay";

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
  /** Rail/options-bar sync layer (owns rail, swatches, options bar, selection actions, layers). */
  private readonly sync: HostSync;
  /** Text tool's in-canvas `<textarea>` + rasterize prompt. */
  private readonly textOverlay: TextOverlay;
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
    this.view = new StageView(this.stage, () => this.session, () => this.input?.activeTool ?? null);

    // ── Rail / options-bar sync (owns layers panel too) ───────────────────
    // `releaseFocus` closes over `this.keyboard` which is assigned below;
    // it is only ever called after construction completes.
    this.sync = new HostSync(
      () => this.session,
      () => this.optionsChanged(),
      () => this.input.cancel(),
      () => this.keyboard.reclaimFocus(),
      this.shell,
    );
    this.shell.sidePanel.content.replaceChildren(this.sync.layers.element);

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
      setAlt: (down) => this.setAlt(down),
      setShift: (down) => this.setShift(down),
      setCtrl: (down) => this.setCtrl(down),
      viewChanged: () => this.view.requestRender(),
    });
    this.keyboard = new KeyboardScope(this.root, {
      onKeyDown: (event) =>
        this.session
          ? handleShortcut(event, this.session, {
              optionsChanged: () => this.optionsChanged(),
              viewChanged: () => this.view.requestRender(),
              cancelDrag: () => this.input.cancel(),
              cancelToolDrag: () => this.input.cancelToolDrag(),
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
      onAltChange: (down) => this.setAlt(down),
      onShiftChange: (down) => this.setShift(down),
      onCtrlChange: (down) => this.setCtrl(down),
      onSave: () => this.events.onSave?.(),
      onDeactivate: () => this.events.onDisengage?.(),
    });
    this.shell.popoverHost.events.on("close", () => this.keyboard.reclaimFocus());
    // ── M3.4: fullscreen (rail button and `F` emit this) ─────────────────
    this.shell.events.on("fullscreen", () => this.fullscreen.toggle());

    this.textOverlay = new TextOverlay(this.stage, this.root, () => this.sync.optionsBar.refresh());
    this.view.onRendered = () => this.textOverlay.sync();

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
        // Move tool: live X / Y / Scale fields.
        editor.events.on("placement", () => this.sync.optionsBar.refresh()),
        // Selection: marching ants + "To mask" button.
        editor.events.on("selection", () => (this.sync.selectionActions.sync(), this.view.requestOverlay())),
        editor.colors.events.on("change", (colors) => this.sync.swatches.setColors(colors)),
        // Tool switch: chrome (rail, options, Move drawing toggle) + stage cursor/ring now.
        tools.events.on("change", () => (this.sync.syncTools(), this.view.requestOverlay())),
      );
      this.sync.swatches.setColors(editor.colors.current);
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
    this.sync.dispose();
    this.textOverlay.dispose();
    this.view.dispose();
    this.shell.dispose();
    this.root.remove();
  }

  // ── Fullscreen ──────────────────────────────────────────────────────────

  /** Root just moved into (`open`) or out of the overlay. */
  private fullscreenChanged(open: boolean): void {
    const panel = this.shell.sidePanel;
    const view = this.session?.editor.view;
    this.sync.rail.setFullscreen(open);
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
