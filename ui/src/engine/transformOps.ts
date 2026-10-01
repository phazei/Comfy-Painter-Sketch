/**
 * Free Transform sessions (SPEC "Free Transform and flips"), exposed as
 * `Editor.float.transform`. A session IS a floating selection with a matrix:
 *
 * - {@link TransformOps.enter}: lifts the selection (the floating-selection lift, same gate)
 *   or the whole edit layer (`FloatOps.liftWhole`); an existing float is
 *   adopted (its offset / matrix become the start parameters).
 * - Drags (`transformSession.ts`), nudges, fields and flips only change the
 *   parameters, shown through the float matrix; resampling at commit.
 * - {@link TransformOps.commit}: a whole-layer session lands (one step); a
 *   selection session leaves a transformed float. Tool switches / other
 *   edits settle session and float; cancel is the float's.
 * - The ants follow the transformed coverage (hidden during a drag).
 * - Flips outside a session: mirror matrix on a float, else `layerFlip.ts`.
 *
 * A text layer gets a float-less session over its text box
 * (`textTransform.ts`; non-uniform drag / unlinked field (`textFieldEdit.ts`)
 * / flip -> {@link TransformOps.resolvePending}); a kept original restarts
 * whole-layer sessions (`FloatOps.liftKept`).
 */

import { documentMap } from "./frameMap";
import { fieldValue, withField } from "./transformFields";
import type { TransformField } from "./transformFields";
import type { EditorState } from "./editorState";
import type { FloatOps } from "./floatOps";
import { flipOutsideSession } from "./layerFlip";
import { hitTransform, resizeAxis } from "./transformHit";
import type { ResizeAxis, TransformHit } from "./transformHit";
import { dragParams } from "./transformSession";
import type { Session, TransformDrag } from "./transformSession";
import { affineEquals, decomposeAffine, flipParams, paramsMatrix } from "./transformMath";
import type { Affine, TransformParams } from "./transformMath";
import type { Point } from "../geometry/rect";
import { endTextFieldEdit, isScaleField, rescaleFromText } from "./textFieldEdit";
import type { TextFieldEdit, TextFieldRequest } from "./textFieldEdit";
import { rasterizeText, TextTransform } from "./textTransform";

export type { TransformField } from "./transformFields";

/**
 * Free Transform commands over the editor's float.
 */
export class TransformOps {
  private session: Session | null = null;
  private drag: TransformDrag | null = null;
  /** A text session asked for a non-uniform change / flip (rasterize prompt pending). */
  private wantRaster: { flip: "h" | "v" | null; fields?: TextFieldRequest } | null = null;
  /** Open unlinked W / H field session of a text session ({@link endField}). */
  private fieldEdit: TextFieldEdit | null = null;
  /** Proportion lock (options bar); Shift inverts it while dragging a handle. */
  proportional = true;

  /**
   * @param s - Shared editor state.
   * @param float - The editor's float commands.
   */
  constructor(
    private readonly s: EditorState,
    private readonly float: FloatOps,
  ) {}

  /** Whether a session is running. */
  get active(): boolean {
    return this.current() !== null;
  }

  /** Whether a TEXT layer session is running (no float). */
  get textActive(): boolean {
    return this.current()?.text != null;
  }

  /** Whether a text session is waiting for the rasterize prompt ({@link resolvePending}). */
  get pending(): boolean {
    return this.wantRaster !== null && this.textActive;
  }

  /** Current parameters, or `null` outside a session. */
  get params(): Readonly<TransformParams> | null {
    return this.current()?.params ?? null;
  }

  /** Whether a handle drag is in progress. */
  get dragging(): boolean {
    return this.drag !== null && this.active;
  }

  /**
   * Float-local -> document matrix and float size of the session.
   * @returns Box geometry, or `null` outside a session.
   */
  box(): { m: Affine; w: number; h: number } | null {
    const session = this.current();
    if (!session) return null;
    const { w, h } = session;
    return { m: paramsMatrix(session.params, w, h), w, h };
  }

  /**
   * Start a session (see module doc). Notes explain refusals.
   * @returns `true` if a session is running afterwards.
   */
  enter(): boolean {
    if (this.active) return true;
    const s = this.s;
    if (s.loading || s.stroke.active) return false;
    s.commitTextEdit();
    this.drag = null;
    this.wantRaster = null;
    this.fieldEdit = null;
    if (!this.float.active) {
      const text = TextTransform.begin(s);
      if (text === "blocked") return false;
      if (text) {
        const p = text.startParams;
        this.session = { float: null, text, w: text.w, h: text.h, params: { ...p }, startM: paramsMatrix(p, text.w, text.h), startSel: null };
        s.events.emit("transform", undefined);
        return true;
      }
      const lifted = s.selection.current ? this.float.lift(false) : this.float.liftKept() || this.float.liftWhole();
      if (!lifted) return false;
    }
    const f = this.float.state;
    const m = this.float.matrix();
    if (!f || !m) return false;
    const { width: w, height: h } = f.area;
    // Known parameters (kept original) restart exactly; else decompose the matrix.
    const known = f.params && affineEquals(paramsMatrix(f.params, w, h), m) ? { ...f.params } : null;
    const params = known ?? decomposeAffine(m, w, h);
    this.session = { float: f, text: null, w, h, params, startM: m, startSel: s.selection.current };
    this.float.setTransform(m, undefined, params);
    s.events.emit("transform", undefined);
    return true;
  }

  /**
   * Commit the session. Whole-layer sessions land in the layer (the float's
   * commit, one undo step). Selection sessions end but the float STAYS: its
   * matrix is kept over the original lifted pixels (a later session resumes
   * from it, no accumulated resampling), the display is resampled once
   * (`FloatOps.bake`), and the float commits by the floating-selection rules later.
   * @returns `true` if layer pixels changed (never for a selection session).
   */
  commit(): boolean {
    const session = this.current();
    if (!session) return false;
    if (session.text) return this.endText(session.text, true);
    if (!session.float?.selBefore) return this.float.commit();
    if (this.drag) this.endDrag();
    this.apply(session.params, true);
    this.session = null;
    this.float.bake();
    this.s.events.emit("transform", undefined);
    return false;
  }

  /** Cancel the session: everything back as before it (and before its lift). */
  cancel(): void {
    const session = this.current();
    if (session?.text) this.endText(session.text, false);
    else if (session) this.float.cancel();
  }

  /**
   * Outside any gesture: a text session's non-uniform change / flip asks to
   * rasterize (`EditorState.confirmRasterize`). Yes = the text changes so
   * far commit, the layer is rasterized (its own step) and a whole-layer
   * pixel session continues from it (a pending flip / field W H is
   * re-applied; a drag's shape is not). No = the change is dropped (it was
   * never shown / was reverted); the text session stays.
   * @returns `true` if the session turned into a pixel session.
   */
  resolvePending(): boolean {
    const want = this.wantRaster;
    this.wantRaster = null;
    const session = this.current();
    if (!want || !session?.text || this.drag) return false;
    if (!this.s.confirmRasterize()) return false;
    const layerId = session.text.layerId;
    this.commit();
    if (!rasterizeText(this.s, layerId) || !this.float.liftWhole() || !this.enter()) return false;
    if (want.flip) this.flip(want.flip);
    const p = this.params;
    if (want.fields && p) this.apply(rescaleFromText(p, want.fields), true);
    return true;
  }

  // ── Handles ─────────────────────────────────────────────────────────────

  /**
   * Hit zone at a document point.
   * @param at - Document point.
   * @param handleTol - Handle radius, document px.
   * @param rotateTol - Rotate reach beyond a corner, document px.
   * @returns Hit (`outside` without a session).
   */
  hit(at: Point, handleTol: number, rotateTol: number): TransformHit {
    const box = this.box();
    return box ? hitTransform(box.m, box.w, box.h, at, handleTol, rotateTol) : { kind: "outside" };
  }

  /**
   * Resize cursor axis of a handle for the current rotation / flips.
   * @param handle - Handle index.
   * @returns Axis.
   */
  resizeAxis(handle: number): ResizeAxis {
    const box = this.box();
    return box ? resizeAxis(box.m, box.w, box.h, handle) : "ew";
  }

  /** Hit of the drag in progress (cursor during a drag), or `null`. */
  get dragHit(): TransformHit | null {
    return this.dragging ? (this.drag?.hit ?? null) : null;
  }

  /**
   * Start a drag.
   * @param hit - Zone pressed ({@link hit}); `outside` starts nothing.
   * @param at - Pointer, document px.
   * @returns `true` if a drag started.
   */
  beginDrag(hit: TransformHit, at: Point): boolean {
    const session = this.current();
    if (!session || hit.kind === "outside") return false;
    // Nothing changes until the pointer moves (`apply` hides the ants then).
    this.drag = { hit, start: { ...session.params }, from: { ...at } };
    return true;
  }

  /**
   * Update the drag.
   * @param at - Pointer, document px.
   * @param mods - Shift (free scale / 15 deg snap) and Alt (around the centre).
   */
  dragTo(at: Point, mods: { shift: boolean; alt: boolean }): void {
    const drag = this.drag;
    const session = this.current();
    if (!drag || !session) return;
    this.apply(dragParams(drag, session.w, session.h, at, mods, this.proportional), false);
  }

  /** End the drag (the session stays open). */
  endDrag(): void {
    if (!this.drag) return;
    this.drag = null;
    const session = this.current();
    if (session) this.apply(session.params, true);
  }

  /** Abort the drag: back to its start parameters. */
  cancelDrag(): void {
    const drag = this.drag;
    this.drag = null;
    if (drag && this.current()) this.apply(drag.start, true);
    this.wantRaster = null;
  }

  /**
   * Arrow nudge of the session.
   * @param dx - Whole document px.
   * @param dy - Whole document px.
   * @returns `true` if a session moved.
   */
  nudge(dx: number, dy: number): boolean {
    const session = this.current();
    if (!session || this.drag) return false;
    this.apply({ ...session.params, cx: session.params.cx + dx, cy: session.params.cy + dy }, true);
    return true;
  }

  // ── Flips ───────────────────────────────────────────────────────────────

  /**
   * Flip H / V: part of a running session; else mirror a float (lifting the
   * selection first) as a still-floating exact mirror; else mirror the whole
   * current layer about its content centre (one undo step).
   * @param axis - `"h"` or `"v"`.
   * @returns `true` if something flipped.
   */
  flip(axis: "h" | "v"): boolean {
    const session = this.current();
    if (session?.text) {
      // Text can't be mirrored: ask to rasterize (a button click, no gesture is live).
      this.wantRaster = { flip: axis };
      return this.resolvePending();
    }
    if (session) {
      this.apply(flipParams(session.params, axis), true);
      return true;
    }
    return flipOutsideSession(this.s, this.float, axis);
  }

  // ── Option fields ───────────────────────────────────────────────────────

  /**
   * An options-bar value (`transformFields.ts`: X / Y = box centre in image
   * px, W / H = scale fractions, angle in degrees).
   * @param key - Field.
   * @returns Value, or `undefined` outside a session.
   */
  field(key: TransformField): number | undefined {
    const p = this.params;
    return p ? fieldValue(p, documentMap(this.s.doc, this.s.imageSize), key) : undefined;
  }

  /**
   * Set an options-bar value (same units as {@link field}); W / H keep the
   * ratio while the proportion lock is on; flips are kept. Text sessions
   * with the lock off preview W / H linked and resolve the unlinked value
   * when the field session ends ({@link endField}).
   * @param key - Field.
   * @param value - New value.
   * @returns `true` if the session changed.
   */
  setField(key: TransformField, value: number): boolean {
    const session = this.current();
    if (!session || this.drag) return false;
    const p = withField(session.params, documentMap(this.s.doc, this.s.imageSize), key, value, this.proportional || session.text !== null);
    if (!p) return false;
    if (session.text && !this.proportional && isScaleField(key) && this.fieldEdit?.key !== key) this.fieldEdit = { key, before: { ...session.params } };
    this.apply(p, true);
    return true;
  }

  /**
   * A field session ended (Enter / blur / scrub release). An unlinked text
   * W / H edit that is not uniform reverts to its start and becomes a
   * pending rasterize request ({@link resolvePending}, run it deferred).
   * @returns `true` if a prompt is pending.
   */
  endField(): boolean {
    const edit = this.fieldEdit;
    this.fieldEdit = null;
    const session = this.current();
    if (!edit || !session?.text || this.drag) return false;
    const req = endTextFieldEdit(edit, session.params, documentMap(this.s.doc, this.s.imageSize));
    if (!req) return false;
    this.apply(req.before, true);
    this.wantRaster = { flip: null, fields: req };
    return true;
  }

  // ── Internals ───────────────────────────────────────────────────────────

  /** End a text session: commit (one text step) or cancel. @returns `true` if a step was recorded. */
  private endText(text: TextTransform, commit: boolean): boolean {
    this.drag = null;
    this.session = null;
    this.wantRaster = null;
    this.fieldEdit = null;
    const changed = commit ? text.commit() : (text.cancel(), false);
    this.s.events.emit("transform", undefined);
    return changed;
  }

  /** The running session, dropping a stale one (its float was committed / cancelled). */
  private current(): Session | null {
    const session = this.session;
    const stale = session?.text ? !session.text.valid || this.float.active : session && this.float.state !== session.float;
    if (session && stale) {
      this.session = null;
      this.drag = null;
      return null;
    }
    return session;
  }

  /** Show parameters; `settled` = also re-rasterize the transformed selection. */
  private apply(p: TransformParams, settled: boolean): void {
    const session = this.current();
    if (!session) return;
    if (session.text) {
      // Non-uniform / flipped: keep the last text state; ask once the gesture ends.
      if (session.text.apply(p)) {
        session.params = p;
        // Back to uniform mid-drag: no prompt at release.
        if (this.drag) this.wantRaster = null;
      } else this.wantRaster = { flip: null };
      this.s.events.emit("transform", undefined);
      return;
    }
    session.params = p;
    const m = paramsMatrix(p, session.w, session.h);
    if (!session.float?.selBefore) this.float.setTransform(m, undefined, p);
    // Identity keeps the start selection object; during a drag the ants hide.
    else if (affineEquals(m, session.startM)) this.float.setTransform(m, session.startSel, p);
    else this.float.setTransform(m, settled ? this.float.selectionAt(m) : null, p);
    this.s.events.emit("transform", undefined);
  }
}
