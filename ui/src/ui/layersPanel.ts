/**
 * Layers tab of the side panel (SPEC "Layers" > "Layers panel"; design
 * handoff "Layers tab"). Collapsible sections (`layerSections.ts`,
 * `layerSectionHeader.ts`): MASKS (cmask rows), LAYERS (paint and
 * text rows), SOURCE (the Image / Input Mask row, `imageMaskRow.ts`, and the
 * Background). The MASKS and LAYERS headers carry "+" and Delete (the
 * selected row of that section). The opacity of the selected row's layer is
 * {@link LayersPanel.headerControl}, shown in the side panel header; the
 * footer is `layersFooter.ts`.
 *
 * Selection follows the paint target: clicking a paint row makes it the
 * active layer and turns Quick Mask off; clicking a mask row makes it the
 * current mask and turns Quick Mask on (so `Q`, the Quick Mask button and
 * the panel stay in sync); clicking the Background row selects it read-only
 * (`Editor.selectBackground`: edits refused, Duplicate makes a paint layer). The current mask always has a left bar in its
 * colour; solo buttons (view only) dim the other rows. Paint rows carry the
 * layer mask slot (add icon / mask thumbnail; its clicks select the row
 * first). All edits go through the editor; the panel re-renders from editor
 * events only. Section collapse is session UI state (not saved).
 */

import type { Editor } from "../engine/editor";
import { BACKGROUND_SOLO_ID } from "../engine/solo";
import { findAnyLayer, IMAGE_MASK_ID } from "../document/imageMask";
import { maskDisplayColor } from "../document/masks";
import { canDuplicateRow, duplicateRow, imageMaskHint } from "./imageMaskRow";
import { isPaintLike } from "../document/layerList";
import type { Layer } from "../document/types";
import { LayerDrag } from "./layerDrag";
import { layerOpacityControl, MaskColorPicker } from "./layerControls";
import type { ColorPickFn, LayerTarget } from "./layerControls";
import { LayerRow } from "./layerRow";
import type { RowActions, RowKind } from "./layerRow";
import { arrangeSections, sectionDeleteState } from "./layerSections";
import type { SectionId } from "./layerSections";
import { SectionHeader } from "./layerSectionHeader";
import { LayerSelectHover } from "./layerSelectHover";
import { ImageKeys, refreshLayerThumbs } from "./layerThumbs";
import { LayersFooter, newMaskTitle } from "./layersFooter";
import { el, rowModel, soloMark } from "./layersPanelParts";
import type { OptionControl } from "./optionControls";
import type { PopoverHost } from "./popover";
import type { SidePanel } from "./sidePanel";
import { RefreshThrottle } from "./thumbnails";

/** Id of the Background row (also its solo id). */
const BACKGROUND_ID = BACKGROUND_SOLO_ID;

/** What the panel needs from its host. */
export interface LayersPanelContext {
  /** Side panel it lives in (thumbnails refresh when it becomes visible / expands / shows this tab). */
  sidePanel: SidePanel;
  /** Popover host (opacity slider popovers). */
  popovers: PopoverHost;
  /** Colour UI for the mask swatch. */
  pickColor: ColorPickFn;
  /** Before a panel edit: cancel an in-progress stage drag. */
  beforeEdit(): void;
  /** A text field of the panel lost focus: hand keyboard focus back. */
  releaseFocus(): void;
  /**
   * Show a transient stage note (the pill refused edits use), e.g. why a
   * header Delete was refused.
   * @param text - Note text.
   */
  showNote(text: string): void;
}

// ═══════════════════════════════════════════════════════════════════════════

/**
 * The layers tab of one editor host (bound to one editor at a time).
 */
export class LayersPanel {
  /** Tab body: the scrolling list and the footer. */
  readonly element: HTMLDivElement;
  /** "Opacity" / "Overlay" + value chip for the side panel header (`SidePanelTab.headerExtra`). */
  readonly headerControl: HTMLDivElement;
  private readonly list: HTMLDivElement;
  private readonly opacity: OptionControl;
  private readonly footer: LayersFooter;
  private readonly headers: Readonly<Record<SectionId, SectionHeader>>;
  private readonly collapsed: Record<SectionId, boolean> = { masks: false, layers: false, source: false };
  private readonly rows = new Map<string, LayerRow>();
  private readonly drag: LayerDrag;
  private readonly thumbs = new RefreshThrottle(() => this.refreshThumbs());
  private readonly imageKeys = new ImageKeys();
  private readonly maskColor: MaskColorPicker;
  private readonly actions: RowActions;
  private editor: Editor | null = null;
  private unbind: Array<() => void> = [];
  private editorUnbind: Array<() => void> = [];
  private renaming = false;

  /**
   * @param ctx - Host services.
   */
  constructor(private readonly ctx: LayersPanelContext) {
    this.element = el("div", "cps-layers");
    this.headerControl = el("div", "cps-layers-headop");
    this.opacity = layerOpacityControl("Opacity", "Opacity of the selected layer (drag the label to scrub)", () => this.selectedTarget(), ctx.popovers);
    this.headerControl.append(this.opacity.element);

    this.list = el("div", "cps-layers-list");
    // A refused Delete (last layer, Image Mask, nothing of that section selected) explains itself as the stage note.
    const remove = { onDelete: () => this.deleteSelected(), onRefused: (reason: string) => ctx.showNote(reason) };
    this.headers = {
      masks: new SectionHeader("masks", () => this.toggleSection("masks"), { title: "New mask", onClick: () => this.addMask() }, remove),
      layers: new SectionHeader("layers", () => this.toggleSection("layers"), { title: "New layer", onClick: () => this.addLayer() }, remove),
      source: new SectionHeader("source", () => undefined),
    };
    this.footer = new LayersFooter({
      addLayer: () => this.addLayer(),
      addMask: () => this.addMask(),
      duplicate: () => this.withEditor((e) => duplicateRow(e, this.selectedRowId())),
      mergeDown: () => this.withEditor((e) => e.mergeDown()),
    });
    this.element.append(this.list, this.footer.element);

    this.maskColor = new MaskColorPicker(ctx.pickColor);
    this.actions = this.rowActions();
    this.drag = new LayerDrag(this.list, (id, drop) =>
      this.withEditor((e) => e.layerOps.move(id, drop.targetId, drop.above)),
    );
    const side = ctx.sidePanel;
    this.unbind.push(
      side.events.on("visible", (shown) => shown && this.thumbs.request()),
      side.events.on("shrink", (shrunk) => !shrunk && this.thumbs.request()),
      side.events.on("tab", () => this.thumbs.request()),
    );
    const hover = new LayerSelectHover(this.list);
    this.unbind.push(() => hover.dispose());
  }

  /**
   * Show an editor's layers (or nothing).
   * @param editor - Editor to bind.
   */
  setEditor(editor: Editor | null): void {
    if (editor === this.editor) {
      // Same editor object: rows and listeners are already wired; just
      // re-sync display state (selection, standby, thumbnail keys).
      this.sync();
      return;
    }
    this.unbindEditor();
    this.editor = editor;
    // A rename input removed with its row may never blur.
    this.renaming = false;
    for (const row of this.rows.values()) row.element.remove();
    this.rows.clear();
    if (editor) {
      this.editorUnbind = [
        editor.events.on("layers", () => this.sync()),
        editor.events.on("mask", () => this.sync()),
        editor.events.on("solo", () => this.sync()),
        editor.events.on("render", () => this.thumbs.request()),
        editor.events.on("change", () => this.thumbs.request()),
      ];
    }
    this.sync();
  }

  /** Remove listeners and DOM. */
  dispose(): void {
    this.setEditor(null);
    for (const off of this.unbind) off();
    this.unbind = [];
    this.thumbs.dispose();
    this.drag.dispose();
    this.element.remove();
    this.headerControl.remove();
  }

  // ── Rendering ───────────────────────────────────────────────────────────

  private unbindEditor(): void {
    for (const off of this.editorUnbind) off();
    this.editorUnbind = [];
  }

  private toggleSection(id: SectionId): void {
    this.collapsed[id] = !this.collapsed[id];
    this.sync();
  }

  /** Rebuild row state from the editor (rows are reused by id). */
  private sync(): void {
    if (this.renaming) return;
    const editor = this.editor;
    const wanted: LayerRow[] = [];
    if (editor) {
      const doc = editor.doc;
      const targeting = editor.paintTarget === "mask";
      const bgSelected = editor.backgroundSelected;
      const maskId = editor.maskLayer?.id;
      const add = (kind: RowKind, layer: Readonly<Layer>, extra?: { hint?: string; canDuplicate?: boolean }): void => {
        const row = this.rowFor(kind, layer.id);
        const active = layer.id === doc.activeLayerId;
        const isCurrentMask = kind !== "paint" && layer.id === maskId;
        const selected = kind !== "paint" ? targeting && isCurrentMask : !targeting && !bgSelected && active;
        const solo = soloMark(layer, editor.solo);
        const maskTarget = editor.layerMask.target(layer.id) === "mask";
        const maskViewing = editor.layerMask.viewing === layer.id;
        const flags = { selected, standby: (targeting || bgSelected) && active, current: isCurrentMask, solo, maskTarget, maskViewing };
        const model = rowModel(layer, flags);
        if (extra?.hint) model.hint = extra.hint;
        if (extra?.canDuplicate !== undefined) model.canDuplicate = extra.canDuplicate;
        row.update(model);
        wanted.push(row);
      };
      for (let i = doc.layers.length - 1; i >= 0; i--) {
        const layer = doc.layers[i];
        if (layer) add(isPaintLike(layer) ? "paint" : "mask", layer);
      }
      // The Image Mask (the Input Mask while `mask` is connected) row sits directly above the Background.
      if (doc.imageMask) {
        const hint = imageMaskHint(editor);
        add("imageMask", doc.imageMask, { canDuplicate: editor.imageMask.canDuplicate(), ...(hint ? { hint } : {}) });
      }
      const bg = this.rowFor("background", BACKGROUND_ID);
      const bgSolo = editor.solo.paint === BACKGROUND_ID ? "on" : "off";
      const visible = doc.backgroundVisible !== false;
      bg.update({ id: BACKGROUND_ID, name: "Background", visible, locked: true, selected: bgSelected, standby: false, solo: bgSolo, canDuplicate: canDuplicateRow(editor, BACKGROUND_ID) });
      wanted.push(bg);
    }
    const keep = new Set(wanted.map((r) => r.id));
    for (const [id, row] of this.rows) {
      if (keep.has(id)) continue;
      row.element.remove();
      this.rows.delete(id);
    }
    this.syncHeaders();
    const children = arrangeSections<LayerRow, HTMLElement>(
      wanted,
      (r) => r.kind,
      (id) => this.headers[id].element,
      (id) => this.collapsed[id],
    ).map((item) => (item instanceof LayerRow ? item.element : item));
    const current = [...this.list.children];
    if (current.length !== children.length || children.some((c, i) => current[i] !== c)) this.list.replaceChildren(...children);
    this.syncFooter();
    this.thumbs.request();
  }

  private syncHeaders(): void {
    const editor = this.editor;
    const current = editor?.maskLayer ?? null;
    // Delete acts on the selected row (as the footer's did): allowed or refused per section.
    const targeting = editor?.paintTarget === "mask";
    const targetId = this.selectedRowId();
    const deletable = !!(editor && targetId && editor.layerOps.canDelete(targetId));
    const rowName = editor?.imageMask.info?.name;
    this.headers.masks.update({
      collapsed: this.collapsed.masks,
      currentMask: current ? { name: current.name, color: maskDisplayColor(current) } : null,
      addDisabled: editor && !editor.layerOps.canAddMask() ? { title: newMaskTitle(editor) } : null,
      remove: sectionDeleteState("masks", targeting, targetId, deletable, rowName),
    });
    const active = editor ? findAnyLayer(editor.doc, editor.doc.activeLayerId) : undefined;
    this.headers.layers.update({
      collapsed: this.collapsed.layers,
      ...(active ? { activeName: active.name } : {}),
      remove: sectionDeleteState("layers", targeting, targetId, deletable, rowName),
    });
    this.headers.source.update({ collapsed: false });
  }

  private syncFooter(): void {
    const editor = this.editor;
    const target = this.selectedTarget();
    this.footer.sync(editor, this.selectedRowId());
    this.opacity.refresh();
    this.headerControl.classList.toggle("cps-dim", !target);
    const label = this.opacity.element.querySelector(".cps-num-label");
    if (label) label.textContent = editor?.paintTarget === "mask" ? "Overlay" : "Opacity";
  }

  private rowFor(kind: RowKind, id: string): LayerRow {
    const existing = this.rows.get(id);
    if (existing && existing.kind === kind) return existing;
    existing?.element.remove();
    const row = new LayerRow(kind, id, this.actions);
    this.rows.set(id, row);
    return row;
  }

  /** Redraw thumbnails whose pixels/geometry changed (throttled caller); skipped while not on screen. */
  private refreshThumbs(): void {
    const editor = this.editor;
    const side = this.ctx.sidePanel;
    if (!editor || !side.visible || side.shrunk || this.element.hidden || !this.element.isConnected) return;
    refreshLayerThumbs(editor, this.rows, BACKGROUND_ID, this.imageKeys);
  }

  // ── Actions ─────────────────────────────────────────────────────────────

  private rowActions(): RowActions {
    return {
      // The lmask-only view follows these in the engine (`LayerMaskOps`): it ends on a
      // cmask row / a paint row targeting its pixels and moves to a row targeting its mask.
      select: (id) => {
        this.withEditor((e) => {
          // Read-only like the Image Mask row (its selection also ends the lmask-only view).
          if (id === BACKGROUND_ID) return e.selectBackground();
          if (e.selectMask(id)) return;
          selectPaint(e, id);
        });
      },
      // Selection only: the current layer, Quick Mask and solo stay as they are.
      loadSelection: (id, mode) => this.withEditor((e) => e.selection.fromLayer(id, mode)),
      // ── Layer masks (row slot, `layerMaskThumb.ts`); these also select the row ──
      targetLayer: (id) => this.withEditor((e) => e.layerMask.setTarget(id, "layer")),
      targetMask: (id) => this.withEditor((e) => e.layerMask.setTarget(id, "mask")),
      addLayerMask: (id, hideAll) =>
        this.withEditor((e) => {
          selectPaint(e, id);
          e.layerMask.add(id, hideAll ? "hide" : e.selection.active ? "selection" : "reveal");
        }),
      toggleMaskEnabled: (id) => this.withEditor((e) => e.layerMask.setEnabled(id, e.layerMask.info(id)?.enabled === false)),
      toggleMaskView: (id) => this.withEditor((e) => e.layerMask.toggleView(id)),
      // Soft coverage (a grayscale mask, not a pixel layer); selection only, like row Ctrl+click.
      maskSelection: (id, mode) => this.withEditor((e) => e.layerMask.toSelection(id, mode)),
      toggleVisible: (id) =>
        this.withEditor((e) =>
          id === BACKGROUND_ID ? e.layerOps.setBackgroundVisible(e.doc.backgroundVisible === false) : e.layerOps.setVisible(id, !findLayer(e, id)?.visible),
        ),
      // View only: no beforeEdit (a stage drag in progress is not an edit conflict).
      toggleSolo: (id) => this.editor?.toggleSolo(id),
      toggleLocked: (id) => this.withEditor((e) => e.layerOps.setLocked(id, !findLayer(e, id)?.locked)),
      rename: (id, name) => this.withEditor((e) => e.layerOps.rename(id, name)),
      toggleSubtract: (id) => this.withEditor((e) => e.layerOps.setMaskSubtract(id, findLayer(e, id)?.subtract !== true)),
      // Read-only rows: the Image / Input Mask (an editable cmask) and the Background (a paint layer).
      duplicate: (id) => this.withEditor((e) => (id === IMAGE_MASK_ID || id === BACKGROUND_ID) && duplicateRow(e, id)),
      pickColor: (id, anchor) => {
        const editor = this.editor;
        const layer = editor && findLayer(editor, id);
        if (editor && layer) this.maskColor.open(anchor, { editor, layerId: id }, maskDisplayColor(layer));
      },
      renaming: (active) => {
        this.renaming = active;
        if (active) return;
        this.ctx.releaseFocus();
        this.sync();
      },
    };
  }

  private addLayer(): void {
    this.withEditor((e) => {
      if (e.layerOps.add()) e.setPaintTarget("paint");
    });
  }

  private addMask(): void {
    this.withEditor((e) => {
      const id = e.layerOps.addMask();
      if (id) e.selectMask(id);
    });
  }

  /** Delete the selected row's layer (the current mask in Quick Mask, else the active layer); the section headers' trash buttons. */
  private deleteSelected(): void {
    this.withEditor((e) => {
      const target = this.selectedTarget();
      if (target) e.layerOps.remove(target.layerId);
    });
  }

  private withEditor(fn: (editor: Editor) => unknown): void {
    const editor = this.editor;
    if (!editor) return;
    this.ctx.beforeEdit();
    fn(editor);
  }

  /** Layer the header opacity edits: the mask in Quick Mask, else the active paint layer; none with the Background selected. */
  private selectedTarget(): LayerTarget | null {
    const id = this.selectedRowId();
    return id ? this.targetFor(id) : null;
  }

  /** Id of the selected row: {@link BACKGROUND_ID}, the mask in Quick Mask, else the active paint layer. */
  private selectedRowId(): string | null {
    const editor = this.editor;
    if (!editor) return null;
    if (editor.backgroundSelected) return BACKGROUND_ID;
    return (editor.paintTarget === "mask" ? editor.maskLayer?.id : editor.doc.activeLayerId) ?? null;
  }

  private targetFor(id: string): LayerTarget | null {
    const editor = this.editor;
    return editor && findLayer(editor, id) ? { editor, layerId: id } : null;
  }
}

/** A layer or the Image Mask row by id. */
function findLayer(editor: Editor, id: string): Readonly<Layer> | undefined {
  return findAnyLayer(editor.doc, id);
}

/** Make a paint layer the active one with Quick Mask off (a paint row click). */
function selectPaint(editor: Editor, id: string): void {
  editor.layerOps.setActiveLayer(id);
  editor.setPaintTarget("paint");
}
