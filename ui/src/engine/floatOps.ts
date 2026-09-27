/**
 * Floating selections (SPEC M10a "Floats"), exposed as `Editor.float`.
 *
 * A float is transient editor state -- never a document layer, never saved,
 * not in the layer list. Lifting reads the selected pixels of the current
 * edit layer (the active paint-like layer, or the current mask under Quick
 * Mask), coverage-weighted (`floatMath.liftPixels`): a move leaves the
 * remainder on the layer at once (the hole is live), a copy leaves the layer
 * untouched. The float is drawn above its layer, inside the layer's own
 * display (`EditorState.floatPreview` -> `layerDisplay.ts`), so it follows the
 * layer's opacity, visibility and mask tint. The selection outline moves
 * with it. Offsets are whole document px; nothing is resampled. Bounds grow
 * (chunked, capped) while it moves, like painting, so what is shown is
 * exactly what lands; pixels beyond the paint-area cap are cropped.
 *
 * No history entry exists while floating:
 * - {@link FloatOps.commit} records ONE patch over (source area U destination)
 *   holding the pre-lift pixels and the result, joined with the selection
 *   move (group entry). It is installed as `EditorState.settleFloat`, the
 *   central hook every other edit / history action calls first.
 * - {@link FloatOps.cancel} (Esc, Ctrl+Z) writes the pre-lift pixels back and
 *   restores the selection: nothing happened.
 * - A float left at its lift position commits as a cancel (no-op step).
 */

import { activeEditLayer } from "../document/masks";
import { intersectRect, isEmptyRect, unionRect } from "../geometry/rect";
import type { Rect } from "../geometry/rect";
import type { EditorState } from "./editorState";
import { compositeOver, copyPixels, liftPixels, offsetSelection, selectionHit } from "./floatMath";
import { layerContentRect } from "./layerTranslate";
import { editBlockNote, preparePixelEdit } from "./rasterize";
import { coverageFor, selectionExtent } from "./selection";
import type { Selection } from "./selection";
import { recordSelectionMove } from "./selectionFollow";
import { createSurface, releaseSurface } from "./surface";
import type { Surface } from "./surface";

/** Note when the selection holds no pixels of the layer. */
export const EMPTY_FLOAT_NOTE = "No pixels are selected.";

/** One floating selection. */
interface FloatState {
  layerId: string;
  /** Lifted document rect (inside the bounds at lift time). */
  area: Rect;
  /** Layer pixels over `area` before the lift (cancel / undo). */
  original: ImageData;
  /** Floating pixels over `area` (straight alpha). */
  pixels: ImageData;
  /** `pixels` on a canvas (display). */
  surface: Surface;
  /** Current offset, whole document px. */
  dx: number;
  dy: number;
  /** Selection at lift time (moves with the float). */
  selBefore: Selection;
  /** Offset at drag start while a drag is in progress. */
  dragBase: { dx: number; dy: number } | null;
  /** Display cache: layer + float, sized to the bounds. */
  preview: { surface: Surface; key: string } | null;
}

/**
 * Floating-selection commands over a shared {@link EditorState}.
 */
export class FloatOps {
  private f: FloatState | null = null;

  /**
   * @param s - Shared editor state (installs the settle hook and the preview).
   */
  constructor(private readonly s: EditorState) {
    s.settleFloat = () => {
      this.commit();
    };
    s.floatPreview = (layerId) => this.preview(layerId);
  }

  /** Whether a float exists. */
  get active(): boolean {
    return this.f !== null;
  }

  /** Current offset of the float from where it was lifted (document px), or `null`. */
  get offset(): { dx: number; dy: number } | null {
    return this.f ? { dx: this.f.dx, dy: this.f.dy } : null;
  }

  /** Layer the float belongs to, or `null`. */
  get layerId(): string | null {
    return this.f?.layerId ?? null;
  }

  /**
   * Whether a document point is inside the float's (moved) selection.
   * @param x - Document x.
   * @param y - Document y.
   * @returns `true` if inside.
   */
  hit(x: number, y: number): boolean {
    return this.f !== null && selectionHit(this.s.selection.current, x, y);
  }

  /**
   * What a lift of the current edit layer would do, decided at pointer-down
   * before anything changes (no modal dialog here): `"blocked"` (note shown:
   * locked / hidden / no selected pixels), `"confirm"` (text layer: the
   * rasterize prompt must run outside the gesture, {@link prepareLift}) or
   * `"ok"`.
   * @returns Check result.
   */
  check(): "ok" | "blocked" | "confirm" {
    const s = this.s;
    if (this.f) return "ok";
    const sel = s.selection.current;
    if (s.loading || s.stroke.active || !sel) return "blocked";
    const layer = activeEditLayer(s.doc, s.target, s.currentMaskId);
    if (!layer) return "blocked";
    const note = editBlockNote(s, layer);
    if (note) {
      s.events.emit("note", note);
      return "blocked";
    }
    if (layer.kind === "text") return "confirm";
    const area = intersectRect(selectionExtent(sel, s.store.bounds), layerContentRect(s, layer.id));
    if (isEmptyRect(area)) return this.empty() || "blocked";
    return "ok";
  }

  /**
   * Outside any gesture: run the pixel-edit gate for a lift (the text
   * rasterize confirm; Yes = its own undo step). Nothing is lifted.
   */
  prepareLift(): void {
    const s = this.s;
    const layer = activeEditLayer(s.doc, s.target, s.currentMaskId);
    if (layer) preparePixelEdit(s, layer);
  }

  /**
   * Lift the selected pixels of the current edit layer into a float (the
   * pixel-edit gate runs first: lock / hidden notes, text rasterize prompt).
   * @param copy - `true` = copy (no hole).
   * @returns `true` if a float exists afterwards.
   */
  lift(copy: boolean): boolean {
    const s = this.s;
    if (this.f) return true;
    const sel = s.selection.current;
    if (s.loading || s.stroke.active || !sel) return false;
    const layer = activeEditLayer(s.doc, s.target, s.currentMaskId);
    if (!layer || preparePixelEdit(s, layer) === "blocked") return false;
    const area = intersectRect(selectionExtent(sel, s.store.bounds), layerContentRect(s, layer.id));
    const read = isEmptyRect(area) ? null : s.store.read(layer.id, area);
    if (!read) return this.empty();
    const { float, rest } = liftPixels(read.data.data, coverageFor(sel, read.rect), !copy);
    if (!hasAlpha(float)) return this.empty();
    const w = read.rect.width;
    const h = read.rect.height;
    const pixels = new ImageData(float, w, h);
    if (!copy) {
      s.store.write(layer.id, read.rect.x, read.rect.y, new ImageData(rest, w, h));
      s.runtime.bump(layer.id);
    }
    const surface = createSurface(w, h);
    surface.ctx.putImageData(pixels, 0, 0);
    this.f = { layerId: layer.id, area: read.rect, original: read.data, pixels, surface, dx: 0, dy: 0, selBefore: sel, dragBase: null, preview: null };
    s.events.emit("history", undefined);
    s.events.emit("render", undefined);
    return true;
  }

  // ── Moving ──────────────────────────────────────────────────────────────

  /** Start a drag of the float. @returns `false` without a float. */
  beginDrag(): boolean {
    if (!this.f) return false;
    this.f.dragBase = { dx: this.f.dx, dy: this.f.dy };
    return true;
  }

  /**
   * Drag offset from the drag start (whole document px).
   * @param dx - X from the drag start.
   * @param dy - Y from the drag start.
   */
  dragTo(dx: number, dy: number): void {
    const base = this.f?.dragBase;
    if (base) this.setOffset(base.dx + dx, base.dy + dy);
  }

  /** End the drag (the float stays; nothing is committed). */
  endDrag(): void {
    if (this.f) this.f.dragBase = null;
  }

  /** Abort the drag: back to where the drag started. */
  cancelDrag(): void {
    const base = this.f?.dragBase;
    if (!base || !this.f) return;
    this.f.dragBase = null;
    this.setOffset(base.dx, base.dy);
  }

  /**
   * Arrow nudge.
   * @param dx - Whole document px.
   * @param dy - Whole document px.
   * @returns `true` if a float moved.
   */
  nudge(dx: number, dy: number): boolean {
    const f = this.f;
    if (!f || f.dragBase) return false;
    this.setOffset(f.dx + dx, f.dy + dy);
    return true;
  }

  // ── Ending ──────────────────────────────────────────────────────────────

  /**
   * Drop the float into its layer: ONE undo step (patch over source U
   * destination + the selection move). A float at its lift position cancels.
   * @returns `true` if pixels changed.
   */
  commit(): boolean {
    const f = this.f;
    if (!f) return false;
    const s = this.s;
    if (f.dx === 0 && f.dy === 0) {
      this.cancel();
      return false;
    }
    this.f = null;
    const dest: Rect = { ...f.area, x: f.area.x + f.dx, y: f.area.y + f.dy };
    s.ensureBounds(dest, true);
    const union = intersectRect(unionRect(f.area, dest), s.store.bounds);
    const current = s.store.read(f.layerId, union);
    if (current) {
      const r = current.rect;
      const before = new Uint8ClampedArray(current.data.data);
      copyPixels(before, r, f.original.data, f.area);
      const next = new Uint8ClampedArray(current.data.data);
      compositeOver(next, r.width, r.height, f.pixels.data, f.area.width, f.area.height, dest.x - r.x, dest.y - r.y);
      s.store.write(f.layerId, r.x, r.y, new ImageData(next, r.width, r.height));
      // Re-read so the patch holds exactly what the canvas stores.
      const after = s.store.read(f.layerId, r);
      if (after) {
        const beforeData = new ImageData(before, r.width, r.height);
        const bytes = before.byteLength + after.data.data.byteLength;
        s.history.push({ kind: "patch", layerId: f.layerId, x: r.x, y: r.y, before: beforeData, after: after.data, bytes });
        recordSelectionMove(s, f.selBefore, s.selection.current, true);
      }
      s.runtime.touch(f.layerId);
    }
    release(f);
    s.afterEdit();
    return true;
  }

  /** Put everything back exactly as before the lift (Esc, Ctrl+Z). */
  cancel(): void {
    const f = this.f;
    if (!f) return;
    const s = this.s;
    this.f = null;
    s.store.write(f.layerId, f.area.x, f.area.y, f.original);
    s.runtime.bump(f.layerId);
    s.selection.set(f.selBefore);
    release(f);
    s.events.emit("history", undefined);
    s.events.emit("render", undefined);
  }

  /**
   * Layer pixels as they were before the lift, for saving while floating.
   * @param layerId - Layer id.
   * @returns Original pixels over the lifted area, or `null` if the layer has no float.
   */
  savedPatch(layerId: string): { x: number; y: number; data: ImageData } | null {
    const f = this.f;
    return f && f.layerId === layerId ? { x: f.area.x, y: f.area.y, data: f.original } : null;
  }

  // ── Internals ───────────────────────────────────────────────────────────

  private empty(): false {
    this.s.events.emit("note", EMPTY_FLOAT_NOTE);
    return false;
  }

  private setOffset(dx: number, dy: number): void {
    const f = this.f;
    if (!f || (f.dx === dx && f.dy === dy)) return;
    const s = this.s;
    s.ensureBounds({ ...f.area, x: f.area.x + dx, y: f.area.y + dy }, true);
    f.dx = dx;
    f.dy = dy;
    // New revision: display caches keyed by it (mask tint, thumbnails) refresh.
    s.runtime.bump(f.layerId);
    s.selection.set(offsetSelection(f.selBefore, dx, dy));
    s.events.emit("render", undefined);
  }

  private preview(layerId: string): HTMLCanvasElement | null {
    const f = this.f;
    if (!f || f.layerId !== layerId) return null;
    const s = this.s;
    const b = s.store.bounds;
    const key = `${s.runtime.revision(layerId)}:${b.x},${b.y},${b.width},${b.height}`;
    if (f.preview?.key === key) return f.preview.surface.canvas;
    if (f.preview) releaseSurface(f.preview.surface);
    const surface = createSurface(b.width, b.height);
    surface.ctx.drawImage(s.store.ensure(layerId).canvas, 0, 0);
    surface.ctx.drawImage(f.surface.canvas, f.area.x + f.dx - b.x, f.area.y + f.dy - b.y);
    f.preview = { surface, key };
    return surface.canvas;
  }
}

function hasAlpha(px: Uint8ClampedArray): boolean {
  for (let p = 3; p < px.length; p += 4) if (px[p] !== 0) return true;
  return false;
}

function release(f: FloatState): void {
  releaseSurface(f.surface);
  if (f.preview) releaseSurface(f.preview.surface);
  f.preview = null;
}
