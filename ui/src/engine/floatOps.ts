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
 *
 * Free Transform (M11) extends a float with an affine matrix
 * ({@link FloatOps.setTransform}; sessions live in `transformOps.ts`,
 * exposed as {@link FloatOps.transform}): the preview draws the float canvas
 * through the matrix (smoothed), the commit resamples ONCE from the lifted
 * pixels (`transformResample.ts`) into the same single patch. A whole-layer
 * lift ({@link FloatOps.liftWhole}) has no selection. When a session over a
 * selection float ends, the float stays with its matrix and a resampled
 * display ({@link FloatOps.bake}); a later session restarts from the lifted
 * pixels with the cumulative matrix. Lifting itself is in `floatLift.ts`.
 */

import type { EditorState } from "./editorState";
import { bakeFloat, dropBake, floatPreviewCanvas, releaseFloat, writeFloatPatch } from "./floatCommit";
import { checkLift, holeOf, liftFloat, liftKept, prepareLift } from "./floatLift";
import { layerContentRect } from "./layerTranslate";
import { isEmptyRect } from "../geometry/rect";
import type { FloatState } from "./floatLift";
import { offsetSelection, selectionHit } from "./floatMath";
import type { Selection } from "./selection";
import { affineEquals, multiply, paramsMatrix, transformedAabb, translation } from "./transformMath";
import type { Affine, TransformParams } from "./transformMath";
import { TransformOps } from "./transformOps";
import { transformSelection } from "./transformResample";

export { EMPTY_FLOAT_NOTE } from "./floatLift";
export type { FloatState } from "./floatLift";

/**
 * Floating-selection commands over a shared {@link EditorState}.
 */
export class FloatOps {
  private f: FloatState | null = null;
  /** Free Transform sessions over this float (M11). */
  readonly transform: TransformOps;

  /**
   * @param s - Shared editor state (installs the settle hook and the preview).
   */
  constructor(private readonly s: EditorState) {
    s.settleFloat = () => {
      this.commit();
    };
    s.floatPreview = (layerId) => this.preview(layerId);
    this.transform = new TransformOps(s, this);
  }

  /** The float itself (read-only view for `transformOps.ts`), or `null`. */
  get state(): Readonly<FloatState> | null {
    return this.f;
  }

  /**
   * The float's full float-local -> document matrix (offset included).
   * @returns Matrix, or `null` without a float.
   */
  matrix(): Affine | null {
    const f = this.f;
    if (!f) return null;
    return multiply(translation(f.dx, f.dy), f.xf ?? translation(f.area.x, f.area.y));
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
    return this.f ? "ok" : checkLift(this.s);
  }

  /**
   * Outside any gesture: run the pixel-edit gate for a lift (the text
   * rasterize confirm; Yes = its own undo step). Nothing is lifted.
   */
  prepareLift(): void {
    prepareLift(this.s);
  }

  /**
   * Lift the selected pixels of the current edit layer into a float (the
   * pixel-edit gate runs first: lock / hidden notes, text rasterize prompt).
   * @param copy - `true` = copy (no hole).
   * @returns `true` if a float exists afterwards.
   */
  lift(copy: boolean): boolean {
    if (this.f) return true;
    const sel = this.s.selection.current;
    return sel ? this.liftFrom(copy, sel) : false;
  }

  /**
   * Lift the whole content of the current edit layer (Free Transform without
   * a selection): the hole is the whole layer until commit. Same gate as {@link lift}.
   * @returns `true` if a float exists afterwards.
   */
  liftWhole(): boolean {
    return this.f ? true : this.liftFrom(false, null);
  }

  /**
   * Whole-layer lift from the layer's kept original (M11b), if it has a
   * valid one and there is no selection.
   * @returns `true` if a float exists afterwards.
   */
  liftKept(): boolean {
    return this.f ? true : this.adopt(liftKept(this.s));
  }

  private liftFrom(copy: boolean, sel: Selection | null): boolean {
    return this.adopt(liftFloat(this.s, copy, sel));
  }

  private adopt(f: FloatState | null): boolean {
    if (!f) return false;
    this.f = f;
    this.s.events.emit("history", undefined);
    this.s.events.emit("render", undefined);
    return true;
  }

  /**
   * Set the float's matrix (Free Transform); the offset is folded in (reset to 0).
   * @param m - Float-local -> document matrix.
   * @param sel - New selection at that matrix (`undefined` = keep the current one).
   * @param params - Session parameters that give `m` (kept for an exact restart), if any.
   */
  setTransform(m: Affine, sel?: Selection | null, params?: TransformParams): void {
    const f = this.f;
    if (!f) return;
    const s = this.s;
    s.ensureBounds(transformedAabb(m, f.area.width, f.area.height), true);
    f.xf = m;
    f.params = params ? { ...params } : undefined;
    dropBake(f);
    f.dx = 0;
    f.dy = 0;
    if (sel !== undefined) {
      f.selBase = sel;
      s.selection.set(sel);
    }
    s.runtime.bump(f.layerId);
    s.events.emit("render", undefined);
  }

  /**
   * The lift-time selection carried through a matrix (`null` for whole-layer lifts).
   * @param m - Float-local -> document matrix.
   * @returns Transformed selection.
   */
  selectionAt(m: Affine): Selection | null {
    const f = this.f;
    return f?.selBefore ? transformSelection(f.selBefore, f.area, m) : null;
  }

  /**
   * Resample the ORIGINAL lifted pixels once through the current matrix for
   * display (a transform session ended, the float stays). Later whole-px
   * moves reuse it; a new session / flip drops it (`setTransform`).
   */
  bake(): void {
    const f = this.f;
    const m = this.matrix();
    if (!f || !m || !f.xf) return;
    dropBake(f);
    f.baked = bakeFloat(f, m);
    this.s.runtime.bump(f.layerId);
    this.s.events.emit("render", undefined);
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
    // No float: a text transform session (M11b) may be open instead.
    if (!f) return this.transform.textActive ? this.transform.commit() : false;
    const s = this.s;
    const m = this.matrix() ?? translation(f.area.x, f.area.y);
    if (affineEquals(m, f.liftM ?? translation(f.area.x, f.area.y))) {
      this.cancel();
      return false;
    }
    if (f.xf && f.selBefore) s.selection.set(this.selectionAt(m));
    this.f = null;
    // Kept original (M11b): only when the float is ALL the layer will hold.
    const keep = f.xf !== null && isEmptyRect(layerContentRect(s, f.layerId));
    writeFloatPatch(s, f, m);
    releaseFloat(f);
    if (keep) {
      const params = f.params && affineEquals(paramsMatrix(f.params, f.area.width, f.area.height), m) ? f.params : undefined;
      s.kept.keep(f.layerId, { pixels: f.pixels, area: { ...f.area }, m, params, revision: s.runtime.revision(f.layerId) });
    }
    s.afterEdit();
    s.events.emit("transform", undefined);
    return true;
  }

  /** Put everything back exactly as before the lift (Esc, Ctrl+Z). */
  cancel(): void {
    const f = this.f;
    if (!f) {
      this.transform.cancel();
      return;
    }
    const s = this.s;
    this.f = null;
    const hole = holeOf(f);
    s.store.write(f.layerId, hole.x, hole.y, f.original);
    s.runtime.bump(f.layerId);
    s.selection.set(f.selBefore);
    releaseFloat(f);
    s.events.emit("history", undefined);
    s.events.emit("render", undefined);
    s.events.emit("transform", undefined);
  }

  /**
   * Layer pixels as they were before the lift, for saving while floating.
   * @param layerId - Layer id.
   * @returns Original pixels over the lifted area, or `null` if the layer has no float.
   */
  savedPatch(layerId: string): { x: number; y: number; data: ImageData } | null {
    const f = this.f;
    const hole = f ? holeOf(f) : null;
    return f && hole && f.layerId === layerId ? { x: hole.x, y: hole.y, data: f.original } : null;
  }

  // ── Internals ───────────────────────────────────────────────────────────

  private setOffset(dx: number, dy: number): void {
    const f = this.f;
    if (!f || (f.dx === dx && f.dy === dy)) return;
    const s = this.s;
    const m = multiply(translation(dx, dy), f.xf ?? translation(f.area.x, f.area.y));
    s.ensureBounds(transformedAabb(m, f.area.width, f.area.height), true);
    f.dx = dx;
    f.dy = dy;
    // New revision: display caches keyed by it (mask tint, thumbnails) refresh.
    s.runtime.bump(f.layerId);
    if (f.selBase) s.selection.set(offsetSelection(f.selBase, dx, dy));
    s.events.emit("render", undefined);
  }


  private preview(layerId: string): HTMLCanvasElement | null {
    const f = this.f;
    if (!f || f.layerId !== layerId) return null;
    return floatPreviewCanvas(this.s, f, this.matrix() ?? translation(f.area.x, f.area.y));
  }
}
