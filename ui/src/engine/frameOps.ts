/**
 * Frame / background operations of the editor core (decision 4): what is
 * drawn under the paint, adopting a new frame for empty documents, and
 * Clear (one undoable step holding full before/after snapshots).
 */

import { frameRect } from "../geometry/rect";
import type { Size } from "../geometry/rect";
import type { FrameBackground } from "./compositor";
import type { DocSnapshot, FrameSource } from "./editorTypes";
import type { EditorState } from "./editorState";

/**
 * Background, frame and Clear handling over a shared {@link EditorState}.
 */
export class FrameOps {
  /**
   * @param s - Shared editor state.
   */
  constructor(private readonly s: EditorState) {}

  /**
   * Set what is drawn under the paint; the view re-fits (in fit mode).
   * @param background - Image or fill.
   * @param imageSize - Size of the current image: the natural size of an
   *   image background, or the `width` x `height` widgets for a fill (no
   *   image connected). `null` = show `doc.frame`.
   */
  setBackground(background: FrameBackground, imageSize: Size | null): void {
    this.s.background = background;
    this.s.backgroundSize = imageSize ? { ...imageSize } : null;
    this.s.syncViewFrame();
    this.s.events.emit("render", undefined);
  }

  /**
   * A new current-image size arrived (upstream image, or the widgets while
   * disconnected; call after {@link setBackground}): an empty document
   * adopts it, otherwise it is only a display mapping (decision 4).
   * Deferred while layer files are loading.
   * @param size - Current image size.
   */
  handleBackgroundSize(size: Size): void {
    const s = this.s;
    if (s.loading) {
      s.pendingBackgroundSize = { ...size };
      return;
    }
    const source: FrameSource = s.background.kind === "image" ? "image" : "widgets";
    const frame = s.doc.frame;
    if (size.width === frame.width && size.height === frame.height) {
      s.frameSource = source;
      return;
    }
    if (s.isEmpty) this.adoptFrame(size, source);
  }

  /**
   * Replace the frame of an empty document (no history).
   * @param size - New frame.
   * @param source - Origin of the size.
   */
  adoptFrame(size: Size, source: FrameSource): void {
    const s = this.s;
    if (s.stroke.active) s.cancelStroke();
    const frame = { width: Math.round(size.width), height: Math.round(size.height) };
    s.doc.frame = frame;
    s.doc.bounds = frameRect(frame);
    delete s.doc.placement;
    s.frameSource = source;
    s.store.reset(s.doc.bounds);
    for (const layer of s.doc.layers) {
      s.store.ensure(layer.id);
      layer.file = null;
      s.runtime.reset(layer.id, false);
      s.runtime.bump(layer.id);
    }
    s.history.clear();
    s.selection.set(null); // document coords changed meaning
    s.lastStrokeEnd = null;
    s.syncViewFrame();
    s.events.emit("placement", undefined);
    s.afterEdit();
  }

  /**
   * Clear all paint and reset the frame to the current image size and the
   * placement to identity, as one undoable step.
   */
  clear(): void {
    const s = this.s;
    if (s.loading) return;
    if (s.stroke.active) s.cancelStroke();
    const size = s.imageSize;
    const frame = { width: Math.max(1, Math.round(size.width)), height: Math.max(1, Math.round(size.height)) };
    const source: FrameSource = !s.backgroundSize ? s.frameSource : s.background.kind === "image" ? "image" : "widgets";
    const before = this.captureSnapshot();
    const after: DocSnapshot = { frame, bounds: frameRect(frame), source, pixels: null };
    this.applySnapshot(after);
    s.history.push({ kind: "clear", before, after, bytes: snapshotBytes(before) });
    s.lastStrokeEnd = null;
    s.afterEdit();
  }

  /**
   * Restore a full document snapshot (Clear undo/redo).
   * @param state - Snapshot to apply.
   */
  applySnapshot(state: DocSnapshot): void {
    const s = this.s;
    s.doc.frame = { ...state.frame };
    s.doc.bounds = { ...state.bounds };
    if (state.placement) s.doc.placement = { ...state.placement };
    else delete s.doc.placement;
    s.frameSource = state.source;
    s.store.reset(state.bounds);
    for (const layer of s.doc.layers) {
      const data = state.pixels?.get(layer.id);
      if (data) s.store.write(layer.id, state.bounds.x, state.bounds.y, data);
      else s.store.ensure(layer.id);
      s.runtime.touch(layer.id);
    }
    s.syncViewFrame();
    s.events.emit("placement", undefined);
  }

  private captureSnapshot(): DocSnapshot {
    const s = this.s;
    const pixels = new Map<string, ImageData>();
    for (const layer of s.doc.layers) pixels.set(layer.id, s.store.snapshot(layer.id));
    const placement = s.doc.placement ? { ...s.doc.placement } : undefined;
    return { frame: { ...s.doc.frame }, bounds: s.store.bounds, source: s.frameSource, ...(placement ? { placement } : {}), pixels };
  }
}

function snapshotBytes(state: DocSnapshot): number {
  let bytes = 0;
  if (state.pixels) for (const data of state.pixels.values()) bytes += data.data.byteLength;
  return bytes;
}
