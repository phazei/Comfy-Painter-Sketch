/**
 * Base of the {@link Editor} facade (`editor.ts`): builds the core state and
 * the sub-ops every other part depends on (`editorState.ts`, `frameOps.ts`,
 * `paintOps.ts`, `docIO.ts`, `layerDisplay.ts`), and hosts the facade
 * sections that only forward to them -- background / frame, restore
 * bookkeeping (persistence) and strokes.
 *
 * Not used directly: `Editor` extends it and adds the remaining sub-op APIs,
 * undo/redo, forking and teardown. Split out only to keep `editor.ts` small;
 * the public surface is `Editor`'s.
 */

import type { PainterDocument } from "../document/types";
import type { Point, Size } from "../geometry/rect";
import type { Dab } from "./brush";
import { ColorState } from "./colors";
import type { FrameBackground } from "./compositor";
import { DocIO } from "./docIO";
import type { EditorEvents, FrameSource } from "./editorTypes";
import { EditorState } from "./editorState";
import type { Emitter } from "./emitter";
import { FrameOps } from "./frameOps";
import { LayerDisplay } from "./layerDisplay";
import type { LayerStore } from "./layerStore";
import { PaintOps } from "./paintOps";
import type { ShapeSpec } from "./shapes";
import { StampCache } from "./stampCache";
import type { StrokeStyle } from "./stroke";
import type { ViewState } from "./view";

/**
 * Core state + forwarding sections of the editor facade.
 */
export abstract class EditorBase {
  readonly events: Emitter<EditorEvents>;
  readonly view: ViewState;
  readonly stamps = new StampCache();
  /** FG/BG colours (session-scoped, not saved). */
  readonly colors: ColorState;

  protected readonly s: EditorState;
  protected readonly frames: FrameOps;
  protected readonly paint: PaintOps;
  protected readonly io: DocIO;
  protected readonly display: LayerDisplay;

  /**
   * @param doc - Document (copied).
   * @param source - Origin of its frame size.
   * @param store - Existing pixels (for clones); a blank store is created otherwise.
   * @param colors - Colour state to start from (forks copy their source's).
   */
  protected constructor(doc: PainterDocument, source: FrameSource, store?: LayerStore, colors?: ColorState) {
    this.s = new EditorState(doc, source, store);
    this.events = this.s.events;
    this.view = this.s.view;
    this.colors = new ColorState(colors?.current);
    this.frames = new FrameOps(this.s);
    this.paint = new PaintOps(this.s, this.frames, this.stamps);
    this.io = new DocIO(this.s, (size) => this.frames.handleBackgroundSize(size));
    this.display = new LayerDisplay(this.s);
  }

  // ── Background / frame ──────────────────────────────────────────────────

  /**
   * Set what is drawn under the paint; layer pixels are untouched.
   * @param background - Image or fill.
   * @param imageSize - Current image size: the image's natural size, or the
   *   `width` x `height` widgets for a fill; `null` = show `doc.frame`.
   */
  setBackground(background: FrameBackground, imageSize: Size | null): void {
    this.frames.setBackground(background, imageSize);
  }

  /**
   * A new current-image size arrived (an empty document adopts it; a painted
   * one is only displayed through the frame map). Call after `setBackground`.
   * @param size - Current image size.
   */
  handleBackgroundSize(size: Size): void {
    this.frames.handleBackgroundSize(size);
  }

  /**
   * Replace the frame of an empty document (no history).
   * @param size - New frame.
   * @param source - Origin of the size.
   */
  adoptFrame(size: Size, source: FrameSource): void {
    this.frames.adoptFrame(size, source);
  }

  /** Clear all paint (masks included) and reset the frame; one undo step. */
  clear(): void {
    this.frames.clear();
  }

  // ── Restore bookkeeping (persistence) ───────────────────────────────────

  /** Mark the start of an async layer restore (disables painting). */
  beginLoading(): void { this.io.beginLoading(); }

  /** Mark the end of an async layer restore; applies a deferred frame change. */
  endLoading(): void { this.io.endLoading(); }

  /**
   * Draw a restored PNG into a layer (not an undo step, not dirty).
   * @param layerId - Layer id.
   * @param image - Decoded PNG (sized to `bounds`).
   */
  restoreLayerPixels(layerId: string, image: CanvasImageSource): void {
    this.io.restoreLayerPixels(layerId, image);
  }

  /**
   * A layer file failed to restore: re-render a text layer from `textData`
   * (marked dirty); other layers stay empty with their `file` kept.
   * @param layerId - Layer id.
   * @returns `true` if the layer was recovered.
   */
  recoverMissingLayer(layerId: string): boolean {
    return this.io.recoverMissingLayer(layerId);
  }

  /**
   * Record a finished upload.
   * @param layerId - Layer id.
   * @param version - Layer version that was uploaded.
   * @param file - Stored file reference (`null` for an empty layer).
   */
  markUploaded(layerId: string, version: number, file: string | null): void {
    this.io.markUploaded(layerId, version, file);
  }

  // ── Strokes ─────────────────────────────────────────────────────────────

  /**
   * Start a stroke on the paint target.
   * @param style - Stroke appearance.
   * @param maxDiameter - Largest dab diameter this stroke can produce, document px.
   * @returns `false` if painting is not possible (loading, locked, hidden).
   */
  beginStroke(style: StrokeStyle, maxDiameter: number): boolean {
    return this.paint.beginStroke(style, maxDiameter);
  }

  /**
   * Add dabs to the current stroke.
   * @param dabs - Dabs in document coords.
   */
  addDabs(dabs: readonly Dab[]): void {
    this.paint.addDabs(dabs);
  }

  /**
   * Replace the current stroke's content with one shape (shape tools: live
   * preview on every move, rasterized into the layer by {@link endStroke}).
   * @param shape - Shape in document coords.
   */
  drawShape(shape: ShapeSpec): void {
    this.paint.drawShape(shape);
  }

  /**
   * Commit the stroke to its layer as one undo step.
   * @param end - Where the stroke ended, document coords (for Shift+click lines).
   */
  endStroke(end: Point | null): void {
    this.paint.endStroke(end);
  }

  /** Abort the current stroke. */
  cancelStroke(): void {
    this.s.cancelStroke();
  }
}
