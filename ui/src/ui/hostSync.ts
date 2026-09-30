/**
 * Rail/options-bar sync layer for {@link EditorHost}.
 *
 * {@link HostSync} owns the components that form the toolbar chrome (tool
 * rail, FG/BG swatches, options bar, selection actions, layers and outputs
 * panels) and every private sync method that keeps them up to date when the
 * session, tool, mask state or history changes.
 *
 * Construction: built once by `EditorHost`.
 * Sync calls: the host calls the methods below whenever editor events fire.
 * Disposal: the host calls {@link HostSync.dispose} when it tears down.
 *
 * Region mode (M9, `regionMode.ts`): the Outputs tab and the region tool
 * follow each other -- opening the tab activates the tool, any other tool
 * shows the Layers tab. The Outputs button / `O` toggles it.
 */

import { readFirstMaskStyle } from "../defaults/readDefaults";
import { maskDisplayColor } from "../document/masks";
import type { Editor } from "../engine/editor";
import type { ToolRegistry } from "../tools/registry";
import type { EditorSession } from "../widget/sessions";
import type { ClipboardActions } from "./clipboardActions";
import { openColorPicker } from "./colorPicker";
import { LayersPanel } from "./layersPanel";
import { OptionsBar } from "./optionsBar";
import { SelectionActions } from "./selectionActions";
import type { EditorShell } from "./shell";
import { SwatchWidget } from "./swatches";
import { ToolRail } from "./toolRail";
import { OutputsPanel } from "./outputsPanel";
import { ResolutionNotice } from "./resolutionNotice";
import { LAYERS_TAB, OUTPUTS_TAB, tabForTool, toolForTab } from "./regionMode";
import { REGION_TOOL_ID } from "../tools/region";

// ═══════════════════════════════════════════════════════════════════════════
// HostSync
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Toolbar chrome components and their sync helpers.
 */
export class HostSync {
  /** Left tool rail (tool buttons, Quick Mask, Undo/Redo, …). */
  readonly rail: ToolRail;
  /** FG/BG colour swatches. */
  readonly swatches: SwatchWidget;
  /** Top options bar (bound to the active tool). */
  readonly optionsBar: OptionsBar;
  /** "To mask / Invert" actions shown while a selection exists. */
  readonly selectionActions: SelectionActions;
  /** Layers panel (owned here; side panel content set by EditorHost). */
  readonly layers: LayersPanel;
  /** Output metadata panel, bound alongside Layers. */
  readonly outputs: OutputsPanel;
  /** Drawing-resolution mismatch notice + Match image resolution (options bar). */
  readonly resolution: ResolutionNotice;

  /**
   * Last active rail tool per registry (restored when "Move drawing" is
   * toggled off). Keyed by registry so a host showing another session (tab
   * switch, hand-off, fork) never restores a stale id; the toggle's
   * highlight itself is always derived from `tools.active` ({@link syncMoveMode}).
   */
  private readonly lastRailTool = new WeakMap<ToolRegistry, string>();

  /**
   * @param getSession - Returns the currently active session (or null).
   * @param onOptionsChanged - Called after the user edits a tool option.
   * @param onCancelDrag - Called before mode switches that need a clean state.
   * @param releaseFocus - Hand keyboard focus back after a panel text field blurs.
   * @param shell - Editor shell (regions + popover host).
   * @param clipboard - Copy / cut / paste commands (rail buttons).
   */
  constructor(
    private readonly getSession: () => EditorSession | null,
    private readonly onOptionsChanged: () => void,
    private readonly onCancelDrag: () => void,
    releaseFocus: () => void,
    private readonly shell: EditorShell,
    clipboard: ClipboardActions,
  ) {
    this.rail = new ToolRail(
      shell.rail.tools,
      {
        selectTool: (id) => {
          this.onCancelDrag();
          this.getSession()?.tools.setActive(id);
        },
        toggleQuickMask: () => {
          this.onCancelDrag();
          this.getSession()?.editor.togglePaintTarget();
        },
        undo: () => this.getSession()?.editor.undo(),
        redo: () => this.getSession()?.editor.redo(),
        // `view.fit()` emits `render` itself (engine/view.ts `onChange`).
        fit: () => this.getSession()?.editor.view.fit(),
        clear: () => this.confirmClear(),
        fullscreen: () => this.shell.events.emit("fullscreen", undefined),
        copy: () => (this.onCancelDrag(), clipboard.copy(false)),
        cut: () => (this.onCancelDrag(), clipboard.cut()),
        paste: (request) => (this.onCancelDrag(), void clipboard.pasteFromButton(request)),
      },
      shell.popoverHost,
    );

    // M14: while a layer mask is targeted the swatches are the black / white mask swatches (no picker).
    this.swatches = new SwatchWidget({
      pick: (slot, anchor) => {
        const editor = this.getSession()?.editor;
        if (!editor || editor.layerMask.targeted) return;
        const colors = editor.colors;
        this.shell.requestColorPick(slot, anchor, colors[slot], (hex) => colors.set(slot, hex));
      },
      swap: () => {
        const editor = this.getSession()?.editor;
        if (editor && !editor.layerMask.swapSwatches()) editor.colors.swap();
      },
      reset: () => {
        const editor = this.getSession()?.editor;
        if (editor && !editor.layerMask.resetSwatches()) editor.colors.reset();
      },
    });
    shell.rail.swatchSlot.appendChild(this.swatches.element);

    this.optionsBar = new OptionsBar(shell.bar, shell.popoverHost, () => this.onOptionsChanged());
    this.selectionActions = new SelectionActions();
    shell.bar.leading.append(this.selectionActions.element);

    this.layers = new LayersPanel({
      sidePanel: shell.sidePanel,
      popovers: shell.popoverHost,
      pickColor: (anchor, options) => openColorPicker(shell.popoverHost, anchor, options),
      beforeEdit: () => this.onCancelDrag(),
      releaseFocus,
      toggleMoveDrawing: () => this.toggleMoveDrawing(),
    });
    this.outputs = new OutputsPanel({
      popovers: shell.popoverHost,
      beforeEdit: () => this.onCancelDrag(),
      releaseFocus,
    });
    this.resolution = new ResolutionNotice((on) => this.layers.setMoveDrawingWarning(on), () => this.onCancelDrag());
    shell.bar.trailing.prepend(this.resolution.element);
    shell.sidePanel.setTabs([
      { id: LAYERS_TAB, label: "Layers", panel: this.layers.element },
      { id: OUTPUTS_TAB, label: "Outputs", panel: this.outputs.element },
    ]);
    shell.sidePanel.events.on("tab", (tab) => this.tabChanged(tab));
    shell.events.on("outputs", () => this.toggleOutputs());
  }

  // ── Sync called by EditorHost ─────────────────────────────────────────────

  /**
   * Bind the layers panel and selection actions to a new editor (or null).
   * Called by `EditorHost.setSession`.
   * @param editor - The incoming session's editor, or `null`.
   */
  bindEditor(editor: Editor | null): void {
    this.layers.setEditor(editor);
    this.outputs.setEditor(editor);
    this.selectionActions.setEditor(editor);
    this.resolution.setEditor(editor);
  }

  /** Sync rail, options bar and cursor when the active tool changes. */
  syncTools(): void {
    const session = this.getSession();
    if (!session) return;

    const active = session.tools.active;
    if (active.rail !== false) this.lastRailTool.set(session.tools, active.id);
    const regionMode = active.id === REGION_TOOL_ID;
    this.shell.sidePanel.showTab(tabForTool(active.id));
    this.shell.outputsButton.classList.toggle("cps-active", regionMode);
    this.shell.outputsButton.setAttribute("aria-pressed", String(regionMode));
    this.rail.setTools(session.tools.railTools(), session.tools.active.id, session.tools.groups);
    this.optionsBar.bind(session.tools.barOptions());
    this.syncMoveMode();
  }

  /**
   * Re-bind the options bar (Free Transform session start / end, selection
   * appearing for the selection tools' Transform buttons); a refresh when
   * the options object is unchanged (live transform fields).
   */
  syncOptions(): void {
    const tools = this.getSession()?.tools;
    if (tools) this.optionsBar.bind(tools.barOptions());
  }

  /**
   * Toggle "Move drawing" mode from the registry's state (single source of
   * truth): if the Move tool is active, return to the last rail tool (brush
   * as fallback), else activate Move. Any drag or pending interaction (open
   * text edit, polygonal lasso) is committed/cancelled first so it cannot
   * swallow the switch. Always re-syncs the chrome, even if nothing changed.
   */
  toggleMoveDrawing(): void {
    const session = this.getSession();
    if (!session) return;
    const { tools } = session;
    this.onCancelDrag();
    if (tools.active.id === "move") {
      const lastId = this.lastRailTool.get(tools);
      const prev = (lastId !== undefined ? tools.get(lastId) : undefined) ?? tools.railTools()[0];
      if (prev) tools.setActive(prev.id);
    } else {
      tools.setActive("move");
    }
    this.syncTools();
  }

  /**
   * Outputs button / `O`: open the side panel on the Outputs tab (region
   * mode); when region mode is already showing, go back to Layers.
   */
  toggleOutputs(): void {
    const session = this.getSession();
    if (!session) return;
    const panel = this.shell.sidePanel;
    this.onCancelDrag();
    if (session.tools.active.id === REGION_TOOL_ID && !panel.collapsed) {
      panel.showTab(LAYERS_TAB);
      return;
    }
    panel.setCollapsed(false);
    panel.showTab(OUTPUTS_TAB);
    session.tools.setActive(REGION_TOOL_ID);
  }

  /** Sync the Quick Mask rail button + badge + root class. */
  syncMask(): void {
    const editor = this.getSession()?.editor;
    if (!editor) return;
    const mask = editor.maskLayer;
    // No mask yet (old document): show the colour the lazily added one will get.
    const color = mask ? maskDisplayColor(mask) : readFirstMaskStyle().color;
    const targeting = editor.paintTarget === "mask";
    this.rail.setQuickMask(targeting, color);
    this.shell.root.classList.toggle("cps-quickmask", targeting);
    this.optionsBar.setMask({ targeting, color });
    // M14: the layer mask controls and swatches come and go with the edit target (`tools/layerMaskBar.ts`).
    this.syncOptions();
    this.syncSwatches();
  }

  /**
   * Show the FG/BG colours, or the black / white mask swatches while a
   * layer mask is targeted (M14; the real colours stay untouched).
   */
  syncSwatches(): void {
    const editor = this.getSession()?.editor;
    if (!editor) return;
    const onMask = editor.layerMask.targeted !== null;
    this.swatches.setMaskMode(onMask);
    this.swatches.setColors(onMask ? editor.layerMask.swatches : editor.colors.current);
  }

  /** Sync undo/redo button enable state. */
  syncHistory(): void {
    const editor = this.getSession()?.editor;
    this.rail.setHistory(editor?.canUndo ?? false, editor?.canRedo ?? false);
  }

  /**
   * Notify the options bar and the tool's own options listener that an
   * option changed (e.g. via shortcut).
   */
  optionsChanged(): void {
    this.optionsBar.refresh();
    this.getSession()?.tools.notifyOptions();
  }

  /** Dispose components that need it. */
  dispose(): void {
    this.rail.dispose();
    this.layers.dispose();
    this.outputs.dispose();
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  /** The visible side-panel tab changed: enter or leave region mode. */
  private tabChanged(tab: string): void {
    const tools = this.getSession()?.tools;
    if (!tools) return;
    const fallback = this.lastRailTool.get(tools) ?? tools.railTools()[0]?.id ?? "";
    const next = toolForTab(tab, tools.active.id, fallback);
    if (next === null) return;
    this.onCancelDrag();
    tools.setActive(next);
  }

  /** Sync the "Move drawing" button on the layers panel. */
  private syncMoveMode(): void {
    const active = this.getSession()?.tools.active;
    this.layers.setMoveDrawing(active?.id === "move");
  }

  /** Clear button: confirm, then one undoable Clear. */
  private confirmClear(): void {
    const editor = this.getSession()?.editor;
    if (!editor || editor.loading) return;
    if (!window.confirm("Clear all paint, regions and output options? This can be undone.")) return;
    this.onCancelDrag();
    editor.clear();
  }
}
