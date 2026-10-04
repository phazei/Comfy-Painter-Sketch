/**
 * Chrome sync layer for {@link EditorHost}.
 *
 * {@link HostSync} owns the components that float over the stage (design
 * handoff "Screens / views") and every sync method that keeps them up to
 * date when the session, tool, mask state or history changes:
 *
 * | Component | Shell slot |
 * |---|---|
 * | {@link HistoryPill} (Undo / Redo / Clear) | `top.history` |
 * | {@link ToolDock} (tools + FG/BG swatches) | `top.dock` |
 * | {@link OptionsStrip} (tool options, state parts) | `top.strip` |
 * | {@link ClipGroup} + {@link ImagesPanel} (Images, Copy, Cut, Paste) | `top.clip` |
 * | {@link SlidersPill} (Size / Hardness) | `slidersSlot` |
 * | {@link BottomBar} (chip, Quick Mask, lmask options, Align, Fit, ...) | `bottomSlot` |
 * | {@link ResolutionNotice} | `noticeSlot` |
 * | {@link HelpOverlay} | `overlaySlot` |
 * | {@link LayersPanel} + {@link OutputsPanel} | `sidePanel` tabs |
 *
 * Construction: built once by `EditorHost`.
 * Sync calls: the host calls the methods below whenever editor events fire.
 * Disposal: the host calls {@link HostSync.dispose} when it tears down.
 *
 * Region mode (SPEC "Outputs and regions (editor)", `regionMode.ts`): the Outputs tab and the region tool
 * follow each other -- opening the tab activates the tool, any other tool
 * shows the Layers tab. The Outputs tab / `O` toggles it.
 *
 * Modal states (Free Transform, region mode, Align drawing) dim the dock and
 * hide the sliders pill.
 *
 * Mode (SPEC "Simple mode"): {@link HostSync.setMode} hides the simple-mode
 * tools in the dock and trims the bottom bar; the clipboard buttons hide by
 * CSS (`.cps-simple`); the edit chip adds a visibility toggle.
 */

import type { EditorMode } from "../defaults/modeDefaults";
import type { Editor } from "../engine/editor";
import { REGION_TOOL_ID } from "../tools/region";
import type { ToolRegistry } from "../tools/registry";
import type { EditorSession } from "../widget/sessions";
import type { SourceEntry, SourceHistory } from "../widget/sourceHistory";
import { BottomBar } from "./bottomBar";
import { ClipGroup } from "./clipGroup";
import type { ClipboardActions } from "./clipboardActions";
import { openColorPicker } from "./colorPicker";
import { HelpOverlay } from "./helpOverlay";
import { HistoryPill } from "./historyPill";
import { ImagesPanel } from "./imagesPanel";
import { LayersPanel } from "./layersPanel";
import { OptionsStrip } from "./optionsStrip";
import { OutputsPanel } from "./outputsPanel";
import { LAYERS_TAB, OUTPUTS_TAB, tabForTool, toolForTab } from "./regionMode";
import { ResolutionNotice } from "./resolutionNotice";
import type { EditorShell } from "./shell";
import { SlidersPill } from "./slidersPill";
import { RefreshThrottle } from "./thumbnails";
import { ToolDock } from "./toolDock";

/** Id of the hidden Align drawing tool (`tools/move.ts`). */
const ALIGN_TOOL_ID = "move";

/** What {@link HostSync} needs from the host. */
export interface HostSyncContext {
  /** Editor shell (slots, side panel, popover host, events). */
  shell: EditorShell;
  /** Returns the currently shown session (or null). */
  getSession(): EditorSession | null;
  /** Called after the user edits a tool option (strip, sliders). */
  optionsChanged(): void;
  /** Cancel drags / pending tool interactions before mode switches and edits. */
  cancelDrag(): void;
  /** Hand keyboard focus back after a panel text field blurs. */
  releaseFocus(): void;
  /** Copy / cut / paste commands (clipboard pill). */
  clipboard: ClipboardActions;
  /** The node's `layer_source` history (Images tray), or `null`. */
  sources: SourceHistory | null;
  /** An Images tray thumbnail was clicked. */
  pickSource(entry: SourceEntry): void;
  /** The bottom bar's (fullscreen) mode toggle was clicked. */
  pickMode(mode: EditorMode): void;
}

// ═══════════════════════════════════════════════════════════════════════════
// HostSync
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Editor chrome components and their sync helpers.
 */
export class HostSync {
  /** Undo / Redo / Clear pill. */
  readonly history: HistoryPill;
  /** Tool dock (tools + FG/BG swatches). */
  readonly dock: ToolDock;
  /** Images button + tray (button lives in the clipboard pill). */
  readonly images: ImagesPanel;
  /** Images / Copy / Cut / Paste pill. */
  readonly clip: ClipGroup;
  /** Options strip under the dock (bound to the active tool). */
  readonly strip: OptionsStrip;
  /** Size / Hardness sliders pill. */
  readonly sliders: SlidersPill;
  /** Bottom bar. */
  readonly bottomBar: BottomBar;
  /** Shortcuts help overlay. */
  readonly help: HelpOverlay;
  /** Drawing-resolution mismatch notice (amber pill + Align warning). */
  readonly resolution: ResolutionNotice;
  /** Layers tab. */
  readonly layers: LayersPanel;
  /** Outputs tab. */
  readonly outputs: OutputsPanel;

  /**
   * Last active rail tool per registry (restored when "Align drawing" is
   * toggled off or region mode ends). Keyed by registry so a host showing
   * another session (tab switch, hand-off, fork) never restores a stale id;
   * the Align highlight itself is always derived from `tools.active`.
   */
  private readonly lastRailTool = new WeakMap<ToolRegistry, string>();
  /** Render-driven bottom bar syncs, coalesced. */
  private readonly bottomThrottle: RefreshThrottle;
  private readonly shell: EditorShell;
  private readonly getSession: () => EditorSession | null;
  private readonly cancelDrag: () => void;
  private mode: EditorMode = "advanced";

  /**
   * @param ctx - Host services.
   */
  constructor(ctx: HostSyncContext) {
    const { shell, clipboard } = ctx;
    const popovers = shell.popoverHost;
    this.shell = shell;
    this.getSession = () => ctx.getSession();
    this.cancelDrag = () => ctx.cancelDrag();
    const changed = (): void => ctx.optionsChanged();

    // ── Top row ───────────────────────────────────────────────────────────
    this.history = new HistoryPill(shell.top.history, {
      undo: () => this.getSession()?.editor.undo(),
      redo: () => this.getSession()?.editor.redo(),
      clear: () => this.confirmClear(),
    });
    this.dock = new ToolDock(
      shell.top.dock,
      {
        selectTool: (id) => {
          this.cancelDrag();
          this.getSession()?.tools.setActive(id);
        },
        // While a layer mask is targeted the swatches are the black / white mask swatches (no picker).
        swatches: {
          pick: (slot, anchor) => {
            const editor = this.getSession()?.editor;
            if (!editor || editor.layerMask.targeted) return;
            shell.requestColorPick(slot, anchor);
          },
          swap: () => {
            const editor = this.getSession()?.editor;
            if (editor && !editor.layerMask.swapSwatches()) editor.colors.swap();
          },
          reset: () => {
            const editor = this.getSession()?.editor;
            if (editor && !editor.layerMask.resetSwatches()) editor.colors.reset();
          },
        },
      },
      popovers,
    );
    this.images = new ImagesPanel({
      history: ctx.sources,
      popovers,
      root: shell.root,
      stage: shell.stage,
      toolBox: this.dock.toolBox,
      anchor: shell.top.clip,
      beforeOpen: () => this.cancelDrag(),
      pick: (entry) => ctx.pickSource(entry),
    });
    this.clip = new ClipGroup(
      shell.top.clip,
      {
        copy: (merged) => (this.cancelDrag(), clipboard.copy(merged)),
        cut: () => (this.cancelDrag(), clipboard.cut()),
        paste: (request) => (this.cancelDrag(), void clipboard.pasteFromButton(request)),
      },
      popovers,
      { imagesButton: this.images.button },
    );
    this.strip = new OptionsStrip(shell.top.strip, {
      popovers,
      getSession: () => this.getSession(),
      changed,
      leaveRegionMode: () => this.leaveRegionMode(),
      toggleMoveDrawing: () => this.toggleMoveDrawing(),
    });
    this.sliders = new SlidersPill(shell.slidersSlot, changed);

    // ── Bottom ────────────────────────────────────────────────────────────
    this.bottomBar = new BottomBar(shell.bottomSlot, {
      popovers,
      getSession: () => this.getSession(),
      beforeEdit: () => this.cancelDrag(),
      leaveRegionMode: () => this.leaveRegionMode(),
      rasterizeText: (id) => void this.getSession()?.editor.text.rasterize(id),
      toggleMoveDrawing: () => this.toggleMoveDrawing(),
      fullscreen: () => shell.events.emit("fullscreen", undefined),
      toggleHelp: () => shell.events.emit("help", undefined),
      requestLayout: () => shell.requestLayout(),
      isSimple: () => this.mode === "simple",
      pickMode: (mode) => ctx.pickMode(mode),
    });
    this.bottomThrottle = new RefreshThrottle(() => this.bottomBar.sync());
    this.resolution = new ResolutionNotice((on) => this.bottomBar.setResolutionWarning(on), () => this.cancelDrag());
    shell.noticeSlot.appendChild(this.resolution.element);
    this.help = new HelpOverlay(shell.overlaySlot);

    // ── Side panel ────────────────────────────────────────────────────────
    this.layers = new LayersPanel({
      sidePanel: shell.sidePanel,
      popovers,
      pickColor: (anchor, options) => openColorPicker(popovers, anchor, options),
      beforeEdit: () => this.cancelDrag(),
      releaseFocus: () => ctx.releaseFocus(),
      // Same channel as the engine's refused edits: the editor's "note" event -> EditorHost -> StageView.showNote.
      showNote: (text) => this.getSession()?.editor.events.emit("note", text),
    });
    this.outputs = new OutputsPanel({
      popovers,
      beforeEdit: () => this.cancelDrag(),
      releaseFocus: () => ctx.releaseFocus(),
    });
    shell.sidePanel.setTabs([
      { id: LAYERS_TAB, label: "Layers", panel: this.layers.element, headerExtra: this.layers.headerControl },
      { id: OUTPUTS_TAB, label: "Outputs", panel: this.outputs.element, title: "Outputs (O)" },
    ]);
    shell.sidePanel.events.on("tab", (tab) => this.tabChanged(tab));
    shell.events.on("outputs", () => this.toggleOutputs());
  }

  // ── Sync called by EditorHost ─────────────────────────────────────────────

  /**
   * Bind the panels and the resolution notice to a new editor (or null).
   * Called by `EditorHost.setSession`.
   * @param editor - The incoming session's editor, or `null`.
   */
  bindEditor(editor: Editor | null): void {
    this.layers.setEditor(editor);
    this.outputs.setEditor(editor);
    this.resolution.setEditor(editor);
    this.syncBottomBar();
  }

  /**
   * Apply Simple / Advanced to the dock and the bottom bar.
   * @param mode - Editor mode.
   */
  setMode(mode: EditorMode): void {
    this.mode = mode;
    this.dock.setSimple(mode === "simple");
    this.bottomBar.setMode(mode);
  }

  /** Sync dock, strip, sliders, panel tab and bottom bar when the active tool changes. */
  syncTools(): void {
    const session = this.getSession();
    if (!session) return;
    const { tools } = session;
    const active = tools.active;
    if (active.rail !== false) this.lastRailTool.set(tools, active.id);
    this.shell.sidePanel.showTab(tabForTool(active.id));
    this.dock.setTools(tools.railTools(), active.id, tools.groups);
    this.syncOptions();
  }

  /**
   * Re-bind the strip and sliders (Free Transform session start / end, a
   * selection appearing for the selection tools' Transform buttons); a
   * refresh when the options object is unchanged (live transform fields).
   * Also re-evaluates the modal dimming and the bottom bar.
   */
  syncOptions(): void {
    const session = this.getSession();
    if (!session) return;
    const options = session.tools.barOptions();
    this.strip.bind(options);
    this.sliders.bind(options);
    const id = session.tools.active.id;
    const modal = session.editor.float.transform.active || id === REGION_TOOL_ID || id === ALIGN_TOOL_ID;
    this.dock.setModal(modal);
    this.sliders.setModal(modal);
    this.syncBottomBar();
  }

  /**
   * Toggle "Align drawing" mode from the registry's state (single source of
   * truth): if the Move tool is active, return to the last rail tool (brush
   * as fallback), else activate Move. Any drag or pending interaction (open
   * text edit, polygonal lasso) is committed/cancelled first so it cannot
   * swallow the switch. Always re-syncs the chrome, even if nothing changed.
   */
  toggleMoveDrawing(): void {
    const session = this.getSession();
    if (!session) return;
    const { tools } = session;
    this.cancelDrag();
    if (tools.active.id === ALIGN_TOOL_ID) {
      const lastId = this.lastRailTool.get(tools);
      const prev = (lastId !== undefined ? tools.get(lastId) : undefined) ?? tools.railTools()[0];
      if (prev) tools.setActive(prev.id);
    } else {
      tools.setActive(ALIGN_TOOL_ID);
      // A hidden (×) notice comes back with Align: that is where it is fixed.
      this.resolution.redisplay();
    }
    this.syncTools();
  }

  /**
   * Outputs tab / `O`: in region mode go back to Layers; otherwise expand
   * the side panel on the Outputs tab and activate the region tool.
   */
  toggleOutputs(): void {
    const session = this.getSession();
    if (!session) return;
    const panel = this.shell.sidePanel;
    this.cancelDrag();
    if (session.tools.active.id === REGION_TOOL_ID) {
      panel.showTab(LAYERS_TAB);
      return;
    }
    panel.setShrunk(false);
    panel.showTab(OUTPUTS_TAB);
    session.tools.setActive(REGION_TOOL_ID);
  }

  /** Sync the Quick Mask root class, the strip's mask swatch, the swatches and the bottom bar. */
  syncMask(): void {
    const editor = this.getSession()?.editor;
    if (!editor) return;
    this.shell.root.classList.toggle("cps-quickmask", editor.paintTarget === "mask");
    this.syncOptions();
    this.syncSwatches();
  }

  /**
   * Show the FG/BG colours, or the black / white mask swatches while a
   * layer mask is targeted (the real colours stay untouched).
   */
  syncSwatches(): void {
    const editor = this.getSession()?.editor;
    if (!editor) return;
    const onMask = editor.layerMask.targeted !== null;
    this.dock.swatches.setMaskMode(onMask);
    this.dock.swatches.setColors(onMask ? editor.layerMask.swatches : editor.colors.current);
  }

  /** Sync the Undo / Redo enable state and the bottom bar. */
  syncHistory(): void {
    const editor = this.getSession()?.editor;
    this.history.setHistory(editor?.canUndo ?? false, editor?.canRedo ?? false);
    this.syncBottomBar();
  }

  /** Re-read the strip's state parts (selection, text edit, mask) and the bottom bar. */
  syncState(): void {
    this.strip.sync();
    this.syncBottomBar();
  }

  /** Re-read the bottom bar now. */
  syncBottomBar(): void {
    this.bottomBar.sync();
  }

  /** Re-read the bottom bar on a coalesced frame (render-driven: called often). */
  requestBottomBarSync(): void {
    this.bottomThrottle.request();
  }

  /**
   * An option changed (via the strip, sliders or a shortcut): refresh both
   * and notify the tool's own options listener.
   */
  optionsChanged(): void {
    this.strip.refresh();
    this.sliders.refresh();
    this.getSession()?.tools.notifyOptions();
  }

  /** Dispose components that need it. */
  dispose(): void {
    this.bottomThrottle.dispose();
    this.images.dispose();
    this.clip.dispose();
    this.dock.dispose();
    this.strip.dispose();
    this.bottomBar.dispose();
    this.help.dispose();
    this.layers.dispose();
    this.outputs.dispose();
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  /** Region mode Done / chip "Back to …": show the Layers tab (`tabChanged` restores the last rail tool). */
  private leaveRegionMode(): void {
    this.shell.sidePanel.showTab(LAYERS_TAB);
  }

  /** The visible side-panel tab changed: enter or leave region mode. */
  private tabChanged(tab: string): void {
    const tools = this.getSession()?.tools;
    if (!tools) return;
    const fallback = this.lastRailTool.get(tools) ?? tools.railTools()[0]?.id ?? "";
    const next = toolForTab(tab, tools.active.id, fallback);
    if (next === null) return;
    this.cancelDrag();
    tools.setActive(next);
  }

  /** Clear button: confirm, then one undoable Clear. */
  private confirmClear(): void {
    const editor = this.getSession()?.editor;
    if (!editor || editor.loading) return;
    if (!window.confirm("Clear all paint, layer masks, regions and output options? Text layers become empty paint layers. This can be undone.")) return;
    this.cancelDrag();
    editor.clear();
  }
}
