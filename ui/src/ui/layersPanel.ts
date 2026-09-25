/**
 * Layers panel (M3.3, SPEC "### Layers"), mounted into the shell's side
 * panel. Top -> bottom: the mask row (colour swatch, invert, overlay
 * opacity), paint layers, and the static Background row. Header: the
 * opacity of the selected row's layer; footer: New / Duplicate / Delete.
 *
 * Selection follows the paint target: clicking a paint row makes it the
 * active layer and turns Quick Mask off; clicking the mask row turns Quick
 * Mask on (so `Q`, the rail button and the panel stay in sync). All edits go
 * through `editor.layerOps`; the panel re-renders from editor events only.
 */

import type { Editor } from "../engine/editor";
import { imageRectToDoc } from "../engine/frameMap";
import { maskDisplayColor } from "../document/masks";
import { isPaintLike } from "../document/layerList";
import type { Layer } from "../document/types";
import { setIcon } from "./icons";
import { LayerDrag } from "./layerDrag";
import { layerOpacityControl, MaskColorPicker } from "./layerControls";
import type { ColorPickFn, LayerTarget } from "./layerControls";
import { LayerRow } from "./layerRow";
import type { RowActions, RowKind, RowModel } from "./layerRow";
import type { OptionControl } from "./optionControls";
import type { PopoverHost } from "./popover";
import type { SidePanel } from "./sidePanel";
import { RefreshThrottle } from "./thumbnails";

/** Id of the Background row. */
const BACKGROUND_ID = "\u0000background";

/** What the panel needs from its host. */
export interface LayersPanelContext {
  /** Side panel it lives in (collapse state). */
  sidePanel: SidePanel;
  /** Popover host (opacity slider popovers). */
  popovers: PopoverHost;
  /** Colour UI for the mask swatch. */
  pickColor: ColorPickFn;
  /** Before a panel edit: cancel an in-progress stage drag. */
  beforeEdit(): void;
  /** A text field of the panel lost focus: hand keyboard focus back. */
  releaseFocus(): void;
  /** Toggle the "Move drawing" mode (activates / deactivates the Move tool). */
  toggleMoveDrawing(): void;
}

// ═══════════════════════════════════════════════════════════════════════════

/**
 * The layers panel of one editor host (bound to one editor at a time).
 */
export class LayersPanel {
  readonly element: HTMLDivElement;
  private readonly list: HTMLDivElement;
  private readonly opacity: OptionControl;
  private readonly addButton: HTMLButtonElement;
  private readonly duplicateButton: HTMLButtonElement;
  private readonly deleteButton: HTMLButtonElement;
  private readonly moveDrawingButton: HTMLButtonElement;
  private readonly rows = new Map<string, LayerRow>();
  private readonly maskControls = new Map<string, OptionControl>();
  private readonly drag: LayerDrag;
  private readonly thumbs = new RefreshThrottle(() => this.refreshThumbs());
  private readonly maskColor: MaskColorPicker;
  private readonly actions: RowActions;
  private editor: Editor | null = null;
  private unbind: Array<() => void> = [];
  private editorUnbind: Array<() => void> = [];
  private renaming = false;
  private backgroundKeys = new WeakMap<object, number>();
  private backgroundCounter = 0;

  /**
   * @param ctx - Host services.
   */
  constructor(private readonly ctx: LayersPanelContext) {
    this.element = el("div", "cps-layers");
    const header = el("div", "cps-layers-header");
    const title = el("span", "cps-layers-title");
    title.textContent = "Layers";
    this.opacity = layerOpacityControl("Opacity", "Opacity of the selected layer (drag the label to scrub)", () => this.selectedTarget(), ctx.popovers);
    header.append(title, this.opacity.element);

    this.list = el("div", "cps-layers-list");
    const footer = el("div", "cps-layers-footer");
    this.addButton = footerButton("plus", "New layer (above the active layer)", () => this.addLayer());
    this.duplicateButton = footerButton("duplicate", "Duplicate layer", () => this.withEditor((e) => e.layerOps.duplicate()));
    this.deleteButton = footerButton("trash", "Delete layer", () => this.withEditor((e) => e.layerOps.remove()));
    this.moveDrawingButton = moveDrawingBtn(() => this.ctx.toggleMoveDrawing());
    const footerDivider = document.createElement("div");
    footerDivider.className = "cps-layers-footer-divider";
    footer.append(this.moveDrawingButton, footerDivider, this.addButton, this.duplicateButton, this.deleteButton);
    this.element.append(header, this.list, footer);

    this.maskColor = new MaskColorPicker(ctx.pickColor);
    this.actions = this.rowActions();
    this.drag = new LayerDrag(this.list, (id, drop) =>
      this.withEditor((e) => e.layerOps.move(id, drop.targetId, drop.above)),
    );
    this.unbind.push(ctx.sidePanel.events.on("collapse", (collapsed) => !collapsed && this.thumbs.request()));
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
    this.maskControls.clear();
    if (editor) {
      this.editorUnbind = [
        editor.events.on("layers", () => this.sync()),
        editor.events.on("mask", () => this.sync()),
        editor.events.on("render", () => this.thumbs.request()),
        editor.events.on("change", () => this.thumbs.request()),
      ];
    }
    this.sync();
  }

  /**
   * Sync the "Move drawing" toggle button highlight to the current mode.
   * @param active - The Move drawing tool is currently active.
   */
  setMoveDrawing(active: boolean): void {
    this.moveDrawingButton.classList.toggle("cps-active", active);
    this.moveDrawingButton.setAttribute("aria-pressed", String(active));
  }

  /** Remove listeners and DOM. */
  dispose(): void {
    this.setEditor(null);
    for (const off of this.unbind) off();
    this.unbind = [];
    this.thumbs.dispose();
    this.drag.dispose();
    this.element.remove();
  }

  // ── Rendering ───────────────────────────────────────────────────────────

  private unbindEditor(): void {
    for (const off of this.editorUnbind) off();
    this.editorUnbind = [];
  }

  /** Rebuild row state from the editor (rows are reused by id). */
  private sync(): void {
    if (this.renaming) return;
    const editor = this.editor;
    const wanted: LayerRow[] = [];
    if (editor) {
      const doc = editor.doc;
      const targeting = editor.paintTarget === "mask";
      const maskId = editor.maskLayer?.id;
      for (let i = doc.layers.length - 1; i >= 0; i--) {
        const layer = doc.layers[i];
        if (!layer) continue;
        const kind: RowKind = isPaintLike(layer) ? "paint" : "mask";
        const row = this.rowFor(kind, layer.id);
        const active = layer.id === doc.activeLayerId;
        const selected = kind === "mask" ? targeting && layer.id === maskId : !targeting && active;
        row.update(rowModel(layer, selected, targeting && active));
        wanted.push(row);
      }
      const bg = this.rowFor("background", BACKGROUND_ID);
      bg.update({ id: BACKGROUND_ID, name: "Background", visible: true, locked: true, selected: false, standby: false });
      wanted.push(bg);
    }
    const keep = new Set(wanted.map((r) => r.id));
    for (const [id, row] of this.rows) {
      if (keep.has(id)) continue;
      row.element.remove();
      this.rows.delete(id);
      this.maskControls.delete(id);
    }
    const current = [...this.list.children];
    if (current.length !== wanted.length || wanted.some((r, i) => current[i] !== r.element)) {
      this.list.replaceChildren(...wanted.map((r) => r.element));
    }
    for (const control of this.maskControls.values()) control.refresh();
    this.syncFooter();
    this.thumbs.request();
  }

  private syncFooter(): void {
    const editor = this.editor;
    const target = this.selectedTarget();
    const paintId = editor && target && editor.paintTarget !== "mask" ? target.layerId : null;
    this.addButton.disabled = !editor;
    this.duplicateButton.disabled = !(editor && paintId && editor.layerOps.canDuplicate(paintId));
    this.deleteButton.disabled = !(editor && paintId && editor.layerOps.canDelete(paintId));
    this.opacity.refresh();
    this.opacity.element.classList.toggle("cps-dim", !target);
    const label = this.opacity.element.querySelector(".cps-num-label");
    if (label) label.textContent = editor?.paintTarget === "mask" ? "Overlay" : "Opacity";
  }

  private rowFor(kind: RowKind, id: string): LayerRow {
    const existing = this.rows.get(id);
    if (existing && existing.kind === kind) return existing;
    existing?.element.remove();
    let maskOpacity: OptionControl | undefined;
    if (kind === "mask") {
      maskOpacity = layerOpacityControl("Overlay", "Mask overlay opacity (display only)", () => this.targetFor(id), this.ctx.popovers);
      this.maskControls.set(id, maskOpacity);
    }
    const row = new LayerRow(kind, id, this.actions, maskOpacity);
    this.rows.set(id, row);
    return row;
  }

  /** Redraw thumbnails whose pixels/geometry changed (throttled caller). */
  private refreshThumbs(): void {
    const editor = this.editor;
    if (!editor || this.ctx.sidePanel.collapsed || !this.element.isConnected) return;
    const doc = editor.doc;
    const bounds = editor.bounds;
    const imageSize = editor.imageSize;
    // Use the full document->image map (frame fit + Move-tool placement) so
    // thumbnails show each layer as it sits over the current image, matching
    // the Background thumbnail framing. imageRectToDoc maps the image footprint
    // back to document coords; subtracting bounds gives canvas-pixel coords.
    const fmap = editor.frameMap;
    const imgInDoc = imageRectToDoc(fmap, { x: 0, y: 0, width: imageSize.width, height: imageSize.height });
    const region = { x: imgInDoc.x - bounds.x, y: imgInDoc.y - bounds.y, width: imgInDoc.width, height: imgInDoc.height };
    // Placement encoded in fmap; include it in the cache key so a placement
    // change (x/y/scale) invalidates without waiting for a pixel revision bump.
    const placement = doc.placement;
    const placementKey = placement ? `${placement.x},${placement.y},${placement.scale}` : "0,0,1";
    const geometry = `${bounds.x},${bounds.y},${bounds.width},${bounds.height}|${imageSize.width}x${imageSize.height}|${placementKey}`;
    for (const layer of doc.layers) {
      const row = this.rows.get(layer.id);
      if (!row) continue;
      const mask = layer.kind === "mask";
      const invert = mask && layer.invert === true;
      const key = `${editor.layerOps.revision(layer.id)}|${geometry}|${invert}`;
      row.thumb.update(key, imageSize, { kind: "layer", canvas: editor.layerCanvas(layer.id), region, mask, invert });
    }
    const bg = this.rows.get(BACKGROUND_ID);
    if (bg) {
      const background = editor.background;
      const id = background.kind === "fill" ? background.color : this.backgroundId(background.image);
      bg.thumb.update(`${id}|${imageSize.width}x${imageSize.height}`, imageSize, { kind: "background", background, size: imageSize });
    }
  }

  private backgroundId(image: object): string {
    let id = this.backgroundKeys.get(image);
    if (id === undefined) {
      id = ++this.backgroundCounter;
      this.backgroundKeys.set(image, id);
    }
    return `img${id}`;
  }

  // ── Actions ─────────────────────────────────────────────────────────────

  private rowActions(): RowActions {
    return {
      select: (id) =>
        this.withEditor((e) => {
          if (e.maskLayer?.id === id) {
            e.setPaintTarget("mask");
            return;
          }
          e.layerOps.setActiveLayer(id);
          e.setPaintTarget("paint");
        }),
      toggleVisible: (id) => this.withEditor((e) => e.layerOps.setVisible(id, !findLayer(e, id)?.visible)),
      toggleLocked: (id) => this.withEditor((e) => e.layerOps.setLocked(id, !findLayer(e, id)?.locked)),
      rename: (id, name) => this.withEditor((e) => e.layerOps.rename(id, name)),
      toggleInvert: (id) => this.withEditor((e) => e.layerOps.setMaskInvert(id, findLayer(e, id)?.invert !== true)),
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

  private withEditor(fn: (editor: Editor) => unknown): void {
    const editor = this.editor;
    if (!editor) return;
    this.ctx.beforeEdit();
    fn(editor);
  }

  /** Layer the header opacity edits: the mask in Quick Mask, else the active paint layer. */
  private selectedTarget(): LayerTarget | null {
    const editor = this.editor;
    if (!editor) return null;
    const id = editor.paintTarget === "mask" ? editor.maskLayer?.id : editor.doc.activeLayerId;
    return id ? this.targetFor(id) : null;
  }

  private targetFor(id: string): LayerTarget | null {
    const editor = this.editor;
    return editor && findLayer(editor, id) ? { editor, layerId: id } : null;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function rowModel(layer: Readonly<Layer>, selected: boolean, standby: boolean): RowModel {
  const model: RowModel = { id: layer.id, name: layer.name, visible: layer.visible, locked: layer.locked, selected, standby };
  if (layer.kind === "mask") {
    model.color = maskDisplayColor(layer);
    model.invert = layer.invert === true;
  }
  if (layer.kind === "text") model.text = true;
  return model;
}

function findLayer(editor: Editor, id: string): Readonly<Layer> | undefined {
  return editor.doc.layers.find((l) => l.id === id);
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.className = className;
  return element;
}

function footerButton(icon: string, title: string, onClick: () => void): HTMLButtonElement {
  const button = el("button", "cps-icon-button cps-layers-action");
  button.type = "button";
  button.title = title;
  setIcon(button, icon, 16);
  button.addEventListener("click", onClick);
  return button;
}

/**
 * Build the "Move drawing" toggle button for the footer left side.
 * @param onClick - Called when the button is clicked.
 * @returns The button.
 */
function moveDrawingBtn(onClick: () => void): HTMLButtonElement {
  const button = el("button", "cps-icon-button cps-layers-action cps-layers-move-drawing");
  button.type = "button";
  button.title = "Move drawing \u2014 reposition/scale all layers against the image";
  button.setAttribute("aria-label", "Move drawing \u2014 reposition/scale all layers against the image");
  button.setAttribute("aria-pressed", "false");
  setIcon(button, "moveDrawing", 16);
  button.addEventListener("click", onClick);
  return button;
}
