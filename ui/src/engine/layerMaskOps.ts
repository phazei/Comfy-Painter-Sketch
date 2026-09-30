/**
 * Layer mask commands (M14a; Apply M14b), exposed as {@link Editor.layerMask}: add
 * (reveal all / selection / hide all), delete, invert and apply (one
 * history step each), enable (not undoable, like the layer eye), the per-layer
 * target (layer pixels vs mask), the Alt+click grayscale view, the black /
 * white mask swatches (X swaps, D resets), Ctrl+click selection from the
 * mask, the area pixel command of Delete / Alt+Backspace
 * ({@link paintMaskArea}), and restore / upload bookkeeping
 * for `widget/persistence.ts`. Pixels, target state and the compositor cache
 * are in `layerMask.ts`; mask strokes and their patches go through the
 * normal stroke / patch paths in `paintOps.ts`.
 *
 * Polarity (ComfyUI / mask layers): white = hidden, black = shown; the mask
 * canvas holds the hidden amount in alpha.
 */

import { canHaveLayerMask, createLayerMask, layerMaskKey } from "../document/layerMask";
import type { LayerMask, MaskFill } from "../document/layerMask";
import type { Layer } from "../document/types";
import { intersectRect, isEmptyRect } from "../geometry/rect";
import type { ColorPair } from "./colors";
import type { EditorState } from "./editorState";
import { groupEntries } from "./editorTypes";
import type { HistoryEntry, LayerMaskEntry, LayerMaskSide, LayerPixels } from "./editorTypes";
import { dropMaskSurface, installMaskSurface, MASK_WHITE, targetedMaskLayer } from "./layerMask";
import { applyMaskAlpha } from "./layerMaskCarry";
import { emitLayerEvents } from "./layerHistory";
import { readyCheck } from "./layerOpsHelpers";
import { layerContentRect } from "./layerTranslate";
import { preparePixelEdit } from "./rasterize";
import { blendCoverage, hexToRgb } from "./pixelColor";
import { coverageFor, eraseCoverage, selectionExtent, trimSelection } from "./selection";
import type { Selection, SelectionMode } from "./selection";
import { fillOutside } from "./surface";

/** Note when Ctrl+click loads a mask that shows nothing (empty selection). */
const EMPTY_MASK_NOTE = "The layer mask shows nothing.";

/** Mask swatch colours. */
const WHITE = "#ffffff";
const BLACK = "#000000";

/** Fixed history cost of a mask entry's metadata. */
const ENTRY_BASE_BYTES = 256;

/** Which part of a masked layer strokes edit. */
export type MaskTarget = "layer" | "mask";

/** A mask that needs uploading. */
export interface MaskUpload {
  layerId: string;
  /** Layer name (error messages). */
  name: string;
  /** Mask version being uploaded. */
  version: number;
  canvas: HTMLCanvasElement;
  file: string | null;
}

/**
 * Layer mask commands over a shared {@link EditorState}.
 */
export class LayerMaskOps {
  /**
   * @param s - Shared editor state.
   * @param applySelection - Combine a selection with the current one as one undo step (`SelectionOps.apply`).
   * @param selectLayer - Make a paint layer the active one with Quick Mask off (a paint row click).
   * @param savedCanvas - Canvas to save for a store key (`Editor.savedLayerCanvas`: pre-lift pixels while an lmask float is up).
   */
  constructor(
    private readonly s: EditorState,
    private readonly applySelection: (sel: Selection | null, mode: SelectionMode) => boolean,
    private readonly selectLayer: (layerId: string) => void,
    private readonly savedCanvas: (key: string) => HTMLCanvasElement = (key) => s.store.ensure(key).canvas,
  ) {
    // The lmask-only view follows the targeted mask (see followView); caches follow the masks.
    s.events.on("layers", () => {
      this.followView();
      s.layerMasks.prune(new Set(s.doc.layers.filter((l) => l.layerMask).map((l) => l.id)));
    });
    s.events.on("mask", () => this.followView());
  }

  // ── Queries ─────────────────────────────────────────────────────────────

  /**
   * A layer's mask record.
   * @param layerId - Layer id.
   * @returns The record, or `undefined`.
   */
  info(layerId: string): Readonly<LayerMask> | undefined {
    return this.find(layerId)?.layerMask;
  }

  /**
   * Whether a layer can get a mask now (a paint layer without one).
   * @param layerId - Layer id.
   * @returns `true` if {@link add} would work.
   */
  canAdd(layerId: string): boolean {
    const layer = this.find(layerId);
    return !!layer && canHaveLayerMask(layer) && !layer.layerMask;
  }

  /**
   * What strokes on a layer edit (per layer, session only).
   * @param layerId - Layer id.
   * @returns `"mask"` when its mask is the target.
   */
  target(layerId: string): MaskTarget {
    return this.info(layerId) && this.s.layerMasks.targets.has(layerId) ? "mask" : "layer";
  }

  /** The layer whose mask the paint target edits now (Quick Mask off), or `null`. */
  get targeted(): string | null {
    return targetedMaskLayer(this.s)?.id ?? null;
  }

  /** The layer whose mask the Alt+click view shows, or `null`. */
  get viewing(): string | null {
    return this.s.layerMasks.view;
  }

  /** The foreground mask swatch is white: brush / bucket hide (`false` = black, reveal). */
  get foregroundHides(): boolean {
    return this.s.layerMasks.fgWhite;
  }

  /** The mask swatches as colours (`#ffffff` / `#000000`), shown instead of FG/BG while a mask is targeted. */
  get swatches(): ColorPair {
    const white = this.s.layerMasks.fgWhite;
    return { fg: white ? WHITE : BLACK, bg: white ? BLACK : WHITE };
  }

  /**
   * Mask pixel revision (thumbnail cache key).
   * @param layerId - Layer id.
   * @returns Revision.
   */
  revision(layerId: string): number {
    return this.s.runtime.revision(layerMaskKey(layerId));
  }

  /**
   * The mask canvas (alpha = mask value), for thumbnails and uploads.
   * @param layerId - Layer id.
   * @returns Canvas, or `null` without a mask.
   */
  canvas(layerId: string): HTMLCanvasElement | null {
    return this.info(layerId) ? this.s.store.ensure(layerMaskKey(layerId)).canvas : null;
  }

  // ── Structural (undoable) ───────────────────────────────────────────────

  /**
   * Add a mask to a paint layer and target it, as one undo step.
   * @param layerId - Paint layer id.
   * @param fill - Reveal all (all black), hide all (all white), or show only
   *   the selection (white = `255 - coverage`; reveal all without one).
   * @returns `true` if added.
   */
  add(layerId: string, fill: MaskFill): boolean {
    const s = this.s;
    const layer = this.find(layerId);
    if (!layer || !this.canAdd(layerId) || !readyCheck(s)) return false;
    const sel = fill === "selection" ? s.selection.current : null;
    // Cover the whole selection (like a selection fill), so Ctrl+click on the mask gives it back exactly.
    if (sel && !sel.outside) s.ensureBounds(sel.rect, true);
    const b = s.store.bounds;
    let pixels: LayerPixels | null = null;
    let outside: LayerMask["outside"] = fill === "hide" ? "hide" : "reveal";
    if (sel) {
      const hidden = coverageFor(sel, b).map((c) => 255 - c);
      pixels = { x: b.x, y: b.y, data: coverageImage(hidden, b.width, b.height) };
      outside = sel.outside ? "reveal" : "hide";
    }
    const mask = createLayerMask(outside);
    layer.layerMask = mask;
    installMaskSurface(s, layerId, mask, pixels);
    s.layerMasks.targets.add(layerId);
    this.record(layerId, { mask: null, pixels: null }, { mask: { ...mask }, pixels });
    return true;
  }

  /**
   * Delete a layer's mask (the pixels stay in the undo step).
   * @param layerId - Layer id.
   * @returns `true` if deleted.
   */
  remove(layerId: string): boolean {
    const s = this.s;
    const layer = this.find(layerId);
    const mask = layer?.layerMask;
    if (!layer || !mask || !readyCheck(s)) return false;
    const b = s.store.bounds;
    const pixels: LayerPixels = { x: b.x, y: b.y, data: s.store.snapshot(layerMaskKey(layerId)) };
    delete layer.layerMask;
    dropMaskSurface(s, layerId);
    this.record(layerId, { mask: { ...mask }, pixels }, { mask: null, pixels: null });
    return true;
  }

  /**
   * Apply (options bar, M14b): bake the mask as it acts -- invert applied,
   * the `outside` value beyond the stored pixels -- into the layer's alpha
   * and remove the mask, as ONE undo step (`[patch on the layer, mask
   * removal]`). The layer gate runs first (hidden / locked notes).
   * @param layerId - Layer id.
   * @returns `true` if applied.
   */
  apply(layerId: string): boolean {
    const s = this.s;
    const layer = this.find(layerId);
    const mask = layer?.layerMask;
    if (!layer || !mask || !readyCheck(s) || preparePixelEdit(s, layer, "whole") === "blocked") return false;
    const key = layerMaskKey(layerId);
    const entries: HistoryEntry[] = [];
    const rect = layerContentRect(s, layerId);
    const before = isEmptyRect(rect) ? null : s.store.read(layerId, rect);
    const hidden = before ? s.store.read(key, before.rect) : null;
    if (before && hidden) {
      const r = before.rect;
      const next = new Uint8ClampedArray(before.data.data);
      applyMaskAlpha(next, hidden.data.data, mask.invert);
      s.store.write(layerId, r.x, r.y, new ImageData(next, r.width, r.height));
      const after = s.store.read(layerId, r);
      if (after) entries.push({ kind: "patch", layerId, x: r.x, y: r.y, before: before.data, after: after.data, bytes: before.data.data.byteLength + after.data.data.byteLength });
      s.runtime.touch(layerId);
    }
    const b = s.store.bounds;
    const pixels: LayerPixels = { x: b.x, y: b.y, data: s.store.snapshot(key) };
    delete layer.layerMask;
    dropMaskSurface(s, layerId);
    const removal: HistoryEntry = { kind: "layerMask", layerId, before: { mask: { ...mask }, pixels }, after: { mask: null, pixels: null }, bytes: ENTRY_BASE_BYTES + pixels.data.data.byteLength };
    s.history.push(entries[0] ? groupEntries(entries[0], removal) : removal);
    this.changed(true);
    return true;
  }

  /**
   * Invert setting (display + output use `1 - mask`; pixels unchanged), one undo step.
   * @param layerId - Layer id.
   * @param invert - New state.
   * @returns `true` if changed.
   */
  setInvert(layerId: string, invert: boolean): boolean {
    const s = this.s;
    const layer = this.find(layerId);
    const mask = layer?.layerMask;
    if (!layer || !mask || mask.invert === invert || s.loading) return false;
    s.settleFloat();
    layer.layerMask = { ...mask, invert };
    this.record(layerId, { mask: { ...mask }, pixels: null }, { mask: { ...layer.layerMask }, pixels: null });
    return true;
  }

  // ── Not undoable ────────────────────────────────────────────────────────

  /**
   * Turn a mask off / on (Shift+click; off = the layer shows unmasked). Not
   * undoable, like the layer eye.
   * @param layerId - Layer id.
   * @param enabled - New state.
   */
  setEnabled(layerId: string, enabled: boolean): void {
    const layer = this.find(layerId);
    const mask = layer?.layerMask;
    if (!layer || !mask || mask.enabled === enabled) return;
    this.s.settleFloat();
    layer.layerMask = { ...mask, enabled };
    this.changed(false);
  }

  /**
   * Thumbnail clicks: choose what strokes on a layer edit, then make it the
   * active layer (Quick Mask off). The lmask-only view follows: it moves to
   * this layer when its mask is the target and ends on its pixels.
   * @param layerId - Layer id.
   * @param target - Layer pixels or its mask (ignored without a mask).
   */
  setTarget(layerId: string, target: MaskTarget): void {
    const s = this.s;
    if (!this.find(layerId)) return;
    const next = target === "mask" && this.info(layerId) !== undefined;
    // Target first: selecting a layer whose target is its pixels would end the view.
    if (s.layerMasks.targets.has(layerId) !== next) {
      if (s.stroke.active) s.cancelStroke();
      if (next) s.layerMasks.targets.add(layerId);
      else s.layerMasks.targets.delete(layerId);
      s.events.emit("mask", undefined);
    }
    this.selectLayer(layerId);
  }

  /**
   * Alt+click on the mask thumbnail: show the mask alone (grayscale) on the
   * stage and edit it (targets the mask, selects the layer; from another
   * layer's view it switches), or end the view when it already shows this
   * mask. Display only.
   * @param layerId - Layer id.
   */
  toggleView(layerId: string): void {
    const s = this.s;
    if (s.layerMasks.view === layerId) return this.endView();
    if (!this.info(layerId)) return;
    this.setTarget(layerId, "mask");
    if (s.layerMasks.view === layerId || targetedMaskLayer(s)?.id !== layerId) return;
    s.layerMasks.view = layerId;
    s.events.emit("mask", undefined);
    s.events.emit("render", undefined);
  }

  /** End the Alt+click view (no-op when not viewing). */
  endView(): void {
    const s = this.s;
    if (s.layerMasks.view === null) return;
    s.layerMasks.view = null;
    s.events.emit("mask", undefined);
    s.events.emit("render", undefined);
  }

  /**
   * X / the swap button while a layer mask is targeted: swap the mask
   * swatches (the real colours are untouched).
   * @returns `false` when no mask is targeted (X keeps its normal meaning).
   */
  swapSwatches(): boolean {
    if (!this.targeted) return false;
    this.s.layerMasks.fgWhite = !this.s.layerMasks.fgWhite;
    this.s.events.emit("mask", undefined);
    return true;
  }

  /**
   * D / the reset button while a layer mask is targeted: foreground white
   * (hide), background black.
   * @returns `false` when no mask is targeted (D keeps its normal meaning).
   */
  resetSwatches(): boolean {
    if (!this.targeted) return false;
    if (!this.s.layerMasks.fgWhite) {
      this.s.layerMasks.fgWhite = true;
      this.s.events.emit("mask", undefined);
    }
    return true;
  }

  /**
   * Ctrl(+Shift / +Alt / +Shift+Alt)+click on the mask thumbnail: the mask's
   * SOFT SHOWN (black) part -- `255 - value` after invert, the `outside`
   * value beyond the bounds (outside hidden = not selected) -- becomes the
   * selection, combined by `mode`; one selection step. The inverse of a
   * cmask's Ctrl+click (white), so selection -> add mask -> Ctrl+click
   * round-trips.
   * @param layerId - Layer id.
   * @param mode - Combination mode.
   * @returns `true` if the selection changed.
   */
  toSelection(layerId: string, mode: SelectionMode): boolean {
    const s = this.s;
    const mask = this.info(layerId);
    if (!mask || s.loading || s.stroke.active) return false;
    s.settleFloat();
    const b = s.store.bounds;
    const px = s.store.read(layerMaskKey(layerId), b);
    // Alpha = hidden amount; shown = 255 - hidden (invert flips hidden first).
    const coverage = new Uint8Array(b.width * b.height).fill(mask.invert ? 0 : 255);
    if (px) for (let i = 0; i < coverage.length; i++) {
      const a = px.data.data[i * 4 + 3] as number;
      coverage[i] = mask.invert ? a : 255 - a;
    }
    const outside = (mask.outside === "hide") !== mask.invert ? 0 : 255;
    const sel = trimSelection({ rect: b, data: coverage, outside });
    if (!sel) {
      s.events.emit("note", EMPTY_MASK_NOTE);
      return false;
    }
    return this.applySelection(sel, mode);
  }

  // ── Persistence ─────────────────────────────────────────────────────────

  /** Masks whose pixels differ from their saved file. */
  uploads(): MaskUpload[] {
    const s = this.s;
    const out: MaskUpload[] = [];
    for (const layer of s.doc.layers) {
      const key = layerMaskKey(layer.id);
      const rt = s.runtime.get(key);
      if (!layer.layerMask || !rt?.dirty) continue;
      out.push({ layerId: layer.id, name: `${layer.name} mask`, version: rt.version, canvas: this.savedCanvas(key), file: layer.layerMask.file });
    }
    return out;
  }

  /**
   * Record a finished mask upload.
   * @param layerId - Layer id.
   * @param version - Mask version uploaded.
   * @param file - File reference (`null` = every pixel 0 = shown).
   */
  markUploaded(layerId: string, version: number, file: string | null): void {
    const layer = this.find(layerId);
    const rt = this.s.runtime.get(layerMaskKey(layerId));
    if (!layer?.layerMask || !rt) return;
    layer.layerMask = { ...layer.layerMask, file };
    if (rt.version === version) rt.dirty = false;
    this.s.events.emit("change", undefined);
  }

  /**
   * Draw a restored mask file (not an undo step, not dirty). A file smaller
   * than the bounds (stale) gets the mask's `outside` value beyond it.
   * @param layerId - Layer id.
   * @param image - Decoded PNG.
   */
  restore(layerId: string, image: CanvasImageSource & { width: number; height: number }): void {
    const mask = this.info(layerId);
    if (!mask) return;
    const s = this.s;
    const key = layerMaskKey(layerId);
    const surface = s.store.ensure(key);
    surface.ctx.clearRect(0, 0, surface.canvas.width, surface.canvas.height);
    if (mask.outside === "hide") fillOutside(surface, { x: 0, y: 0, width: image.width, height: image.height }, MASK_WHITE);
    surface.ctx.drawImage(image, 0, 0);
    s.runtime.bump(key);
    s.events.emit("render", undefined);
  }

  /**
   * A mask file could not be restored: the layer shows unmasked (all 0, as
   * Python ignores an unreadable mask); the file reference is kept, not dirty.
   * @param layerId - Layer id.
   */
  restoreFailed(layerId: string): void {
    if (!this.info(layerId)) return;
    const key = layerMaskKey(layerId);
    const surface = this.s.store.ensure(key);
    surface.ctx.clearRect(0, 0, surface.canvas.width, surface.canvas.height);
    this.s.runtime.bump(key);
    this.s.events.emit("render", undefined);
  }

  // ── Internals ───────────────────────────────────────────────────────────

  private find(layerId: string): Layer | undefined {
    return this.s.doc.layers.find((l) => l.id === layerId);
  }

  /**
   * Keep the lmask-only view on the targeted mask (SPEC): it follows the
   * active paint layer while that layer targets its mask (another lmask
   * thumbnail, a row whose target is its mask), and ends otherwise -- a
   * layer without a mask or targeting its pixels, a text layer, any cmask
   * row / Quick Mask, the mask deleted.
   */
  private followView(): void {
    const s = this.s;
    const view = s.layerMasks.view;
    if (view === null) return;
    const next = targetedMaskLayer(s)?.id ?? null;
    if (next === view) return;
    if (next === null) return this.endView();
    s.layerMasks.view = next;
    s.events.emit("mask", undefined);
    s.events.emit("render", undefined);
  }

  private record(layerId: string, before: LayerMaskSide, after: LayerMaskSide): void {
    const bytes = ENTRY_BASE_BYTES + (before.pixels?.data.data.byteLength ?? 0) + (after.pixels?.data.data.byteLength ?? 0);
    this.s.history.push({ kind: "layerMask", layerId, before, after, bytes });
    this.changed(true);
  }

  private changed(history: boolean): void {
    const s = this.s;
    if (history) s.events.emit("history", undefined);
    emitLayerEvents(s);
    s.events.emit("change", undefined);
    s.events.emit("render", undefined);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// History + pixel command (module functions: paintOps / pixelOps / selectionOps)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Undo (`forward = false`) or redo a mask entry. Non-undoable state
 * (enabled, file) of the live mask is carried into the record it replaces.
 * @param s - Editor state.
 * @param entry - Entry.
 * @param forward - Redo direction.
 */
export function applyLayerMaskEntry(s: EditorState, entry: LayerMaskEntry, forward: boolean): void {
  const layer = s.doc.layers.find((l) => l.id === entry.layerId);
  if (!layer) return;
  const side = forward ? entry.after : entry.before;
  const other = forward ? entry.before : entry.after;
  const live = layer.layerMask;
  if (!side.mask) {
    if (!live) return;
    if (other.mask) other.mask = { ...live, invert: other.mask.invert };
    delete layer.layerMask;
    dropMaskSurface(s, layer.id);
  } else if (live) {
    layer.layerMask = { ...live, invert: side.mask.invert };
  } else {
    layer.layerMask = { ...side.mask };
    installMaskSurface(s, layer.id, layer.layerMask, side.pixels);
    s.layerMasks.targets.add(layer.id);
  }
  emitLayerEvents(s);
}

/**
 * Hide (paint white) or reveal (clear to black) part of the targeted layer
 * mask: the selection (soft coverage, times `opacity`), or the whole mask
 * without one unless `needSelection`. Delete reveals and Alt / Ctrl+Backspace
 * hide, like Delete / fill on a mask layer (the bucket floods instead:
 * `pixelOps.ts`). One patch on the mask key; a no-op change is no step.
 * @param s - Editor state.
 * @param layer - Layer whose mask is targeted (the gate already passed).
 * @param opacity - 0..1 strength.
 * @param needSelection - Do nothing without a selection (Delete / Backspace).
 * @param hide - Paint white (hide); `false` = erase (reveal).
 * @returns `true` if pixels changed.
 */
export function paintMaskArea(s: EditorState, layer: Layer, opacity: number, needSelection: boolean, hide: boolean): boolean {
  const key = layerMaskKey(layer.id);
  const sel = s.selection.current;
  if (!sel && needSelection) return false;
  if (sel && !sel.outside) s.ensureBounds(sel.rect, true);
  const area = sel ? selectionExtent(sel, s.store.bounds) : s.store.bounds;
  const before = isEmptyRect(area) ? null : s.store.read(key, area);
  if (!before) return false;
  const rect = intersectRect(before.rect, area);
  const coverage = sel ? coverageFor(sel, rect) : new Uint8Array(rect.width * rect.height).fill(255);
  const k = Math.min(1, Math.max(0, opacity));
  if (k < 1) for (let i = 0; i < coverage.length; i++) coverage[i] = Math.round((coverage[i] as number) * k);
  const next = new ImageData(new Uint8ClampedArray(before.data.data), before.data.width, before.data.height);
  const local = { x: 0, y: 0, width: rect.width, height: rect.height };
  if (hide) blendCoverage(next.data, local, coverage, rect.width, hexToRgb(MASK_WHITE), 1);
  else eraseCoverage(next.data, local, coverage, rect.width);
  s.store.write(key, rect.x, rect.y, next);
  const after = s.store.read(key, rect);
  if (!after || sameBytes(before.data.data, after.data.data)) return false;
  const bytes = before.data.data.byteLength + after.data.data.byteLength;
  s.history.push({ kind: "patch", layerId: key, x: rect.x, y: rect.y, before: before.data, after: after.data, bytes });
  s.runtime.touch(key);
  s.afterEdit();
  return true;
}

/** White RGBA with alpha = hidden amount (the mask pixel format). */
function coverageImage(coverage: Uint8Array, width: number, height: number): ImageData {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < coverage.length; i++) {
    const a = coverage[i] as number;
    if (a === 0) continue;
    data.set([255, 255, 255, a], i * 4);
  }
  return new ImageData(data, width, height);
}

function sameBytes(a: Uint8ClampedArray, b: Uint8ClampedArray): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
