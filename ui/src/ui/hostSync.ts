/**
 * Rail/options-bar sync layer for {@link EditorHost}.
 *
 * {@link HostSync} owns the five components that form the toolbar chrome
 * (tool rail, FG/BG swatches, options bar, selection actions, layers panel)
 * and every private sync method that keeps them up to date when the session,
 * tool, mask state or history changes.
 *
 * Construction: built once by `EditorHost`.
 * Sync calls: the host calls the methods below whenever editor events fire.
 * Disposal: the host calls {@link HostSync.dispose} when it tears down.
 *
 * Extracted from `editorHost.ts` (M3.x refactor) so that file stays < 380
 * lines; no behaviour changed.
 */

import { DEFAULT_MASK_COLOR } from "../document/create";
import { maskDisplayColor } from "../document/masks";
import type { Editor } from "../engine/editor";
import type { ToolRegistry } from "../tools/registry";
import type { EditorSession } from "../widget/sessions";
import { openColorPicker } from "./colorPicker";
import { LayersPanel } from "./layersPanel";
import { OptionsBar } from "./optionsBar";
import { SelectionActions } from "./selectionActions";
import type { EditorShell } from "./shell";
import { SwatchWidget } from "./swatches";
import { ToolRail } from "./toolRail";

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
   */
  constructor(
    private readonly getSession: () => EditorSession | null,
    private readonly onOptionsChanged: () => void,
    private readonly onCancelDrag: () => void,
    releaseFocus: () => void,
    private readonly shell: EditorShell,
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
      },
      shell.popoverHost,
    );

    this.swatches = new SwatchWidget({
      pick: (slot, anchor) => {
        const colors = this.getSession()?.editor.colors;
        if (colors)
          this.shell.requestColorPick(slot, anchor, colors[slot], (hex) => colors.set(slot, hex));
      },
      swap: () => this.getSession()?.editor.colors.swap(),
      reset: () => this.getSession()?.editor.colors.reset(),
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
  }

  // ── Sync called by EditorHost ─────────────────────────────────────────────

  /**
   * Bind the layers panel and selection actions to a new editor (or null).
   * Called by `EditorHost.setSession`.
   * @param editor - The incoming session's editor, or `null`.
   */
  bindEditor(editor: Editor | null): void {
    this.layers.setEditor(editor);
    this.selectionActions.setEditor(editor);
  }

  /** Sync rail, options bar and cursor when the active tool changes. */
  syncTools(): void {
    const session = this.getSession();
    if (!session) return;

    const active = session.tools.active;
    if (active.rail !== false) this.lastRailTool.set(session.tools, active.id);
    this.rail.setTools(session.tools.railTools(), session.tools.active.id, session.tools.groups);
    this.optionsBar.bind(session.tools.active.options);
    this.syncMoveMode();
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

  /** Sync the Quick Mask rail button + badge + root class. */
  syncMask(): void {
    const editor = this.getSession()?.editor;
    if (!editor) return;
    const mask = editor.maskLayer;
    const color = mask ? maskDisplayColor(mask) : DEFAULT_MASK_COLOR;
    const targeting = editor.paintTarget === "mask";
    this.rail.setQuickMask(targeting, color);
    this.shell.root.classList.toggle("cps-quickmask", targeting);
    this.optionsBar.setMask({ targeting, color });
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
    this.layers.dispose();
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  /** Sync the "Move drawing" button on the layers panel. */
  private syncMoveMode(): void {
    const active = this.getSession()?.tools.active;
    this.layers.setMoveDrawing(active?.id === "move");
  }

  /** Clear button: confirm, then one undoable Clear. */
  private confirmClear(): void {
    const editor = this.getSession()?.editor;
    if (!editor || editor.loading) return;
    if (!window.confirm("Clear all paint? This can be undone.")) return;
    this.onCancelDrag();
    editor.clear();
  }
}
