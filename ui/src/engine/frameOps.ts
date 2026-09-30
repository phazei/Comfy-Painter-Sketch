/**
 * Frame / background operations of the editor core (decision 4): what is
 * drawn under the paint, adopting a new frame for empty documents, and
 * Clear (one undoable step holding full before/after snapshots).
 */

import { layerMaskKey } from "../document/layerMask";
import type { LayerMask } from "../document/layerMask";
import type { TextData } from "../document/types";
import { frameRect } from "../geometry/rect";
import type { Size } from "../geometry/rect";
import type { FrameBackground } from "./compositor";
import type { DocSnapshot, FrameSource } from "./editorTypes";
import type { EditorState } from "./editorState";
import { minimumFrame } from "./drawingResolution";
import { dropMaskSurface, installMaskSurface, resetMaskSurfaces } from "./layerMask";
import { applyOutputs, captureOutputs, outputsKey } from "./regionHistory";

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
    const before = this.s.imageSize;
    this.s.background = background;
    this.s.backgroundSize = imageSize ? { ...imageSize } : null;
    this.s.syncViewFrame();
    const after = this.s.imageSize;
    // Output cards show image-px sizes and field bounds (regions never rescale).
    if (before.width !== after.width || before.height !== after.height) this.s.events.emit("outputs", undefined);
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
    const target = minimumFrame(size);
    if (target.width === frame.width && target.height === frame.height) {
      s.frameSource = source;
      return;
    }
    if (s.isEmpty) this.adoptFrame(size, source);
  }

  /**
   * Replace the frame of an empty document (no history).
   * @param size - Image size; the frame is its {@link minimumFrame}.
   * @param source - Origin of the size.
   */
  adoptFrame(size: Size, source: FrameSource): void {
    const s = this.s;
    if (s.stroke.active) s.cancelStroke();
    const frame = minimumFrame(size);
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
    resetMaskSurfaces(s);
    this.rebaseHistory(frame, source);
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
    const frame = minimumFrame(size);
    const source: FrameSource = !s.backgroundSize ? s.frameSource : s.background.kind === "image" ? "image" : "widgets";
    const before = this.captureSnapshot();
    const after: DocSnapshot = { frame, bounds: frameRect(frame), source, pixels: null };
    this.applySnapshot(after);
    s.solo.clear();
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
    applyOutputs(s, state.outputs);
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
      // Cleared text layers become (empty) paint layers; undo restores the text.
      const textData = state.text?.get(layer.id);
      if (textData) {
        layer.kind = "text";
        layer.textData = textData;
      } else if (layer.kind === "text") {
        layer.kind = "paint";
        delete layer.textData;
      }
      s.runtime.touch(layer.id);
      // A cleared layer is empty again (it re-uploads blank, but may adopt frames).
      const rt = s.runtime.get(layer.id);
      if (rt) rt.hasContent = data !== undefined || textData !== undefined;
      // Layer masks (M14): Clear removes them; undo brings them back.
      const lm = state.layerMasks?.get(layer.id);
      if (lm) {
        layer.layerMask = { ...lm.mask };
        installMaskSurface(s, layer.id, lm.mask, { x: state.bounds.x, y: state.bounds.y, data: lm.data });
      } else if (layer.layerMask) {
        delete layer.layerMask;
        dropMaskSurface(s, layer.id);
      }
    }
    s.syncViewFrame();
    s.events.emit("placement", undefined);
    s.events.emit("layers", undefined);
  }

  /**
   * History after adopting `frame`: without a Clear step it is dropped (a
   * fresh document). With one, the Clear stays undoable (its `before` holds
   * the old frame, bounds and placement); only the selection steps after it
   * (stale coords) are dropped, and its `after` moves to the adopted frame
   * so redo returns the cleared document as last seen.
   */
  private rebaseHistory(frame: Size, source: FrameSource): void {
    const s = this.s;
    const { barrier } = s.history.since((e) => e.kind === "clear");
    if (barrier?.kind !== "clear") {
      s.history.clear();
      return;
    }
    s.history.truncateAfter(barrier);
    barrier.after = { ...barrier.after, frame: { ...frame }, bounds: frameRect(frame), source };
    s.events.emit("history", undefined);
  }

  private captureSnapshot(): DocSnapshot {
    const s = this.s;
    const pixels = new Map<string, ImageData>();
    const text = new Map<string, TextData>();
    const layerMasks = new Map<string, { mask: LayerMask; data: ImageData }>();
    for (const layer of s.doc.layers) {
      pixels.set(layer.id, s.store.snapshot(layer.id));
      if (layer.kind === "text" && layer.textData) text.set(layer.id, layer.textData);
      if (layer.layerMask) layerMasks.set(layer.id, { mask: { ...layer.layerMask }, data: s.store.snapshot(layerMaskKey(layer.id)) });
    }
    const placement = s.doc.placement ? { ...s.doc.placement } : undefined;
    return {
      frame: { ...s.doc.frame }, bounds: s.store.bounds, source: s.frameSource, ...(placement ? { placement } : {}), pixels, text, outputs: captureOutputs(s),
      ...(layerMasks.size ? { layerMasks } : {}),
    };
  }
}

function snapshotBytes(state: DocSnapshot): number {
  let bytes = state.outputs ? outputsKey(state.outputs).length * 2 : 0;
  if (state.pixels) for (const data of state.pixels.values()) bytes += data.data.byteLength;
  if (state.layerMasks) for (const m of state.layerMasks.values()) bytes += m.data.data.byteLength;
  return bytes;
}
