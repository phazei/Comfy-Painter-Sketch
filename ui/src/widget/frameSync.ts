/**
 * Frame sync for one node: pushes the "current image" (loaded background
 * while `image` is connected, else the `width` x `height` / `background`
 * widgets) to the editor, and keeps those widgets in step with the canvas.
 *
 * An empty editor adopts the current image's size and a painted one only
 * maps onto it (never resampling). Pushes are de-duplicated by a
 * content key so polls and repeated refreshes cost a string compare.
 *
 * Each newly pushed image also writes its size into `width` / `height`
 * (only when they differ), so the fallback frame always equals the last
 * image: disconnecting, an upstream without an image, or a reload without
 * one keep the frame (no copy step on disconnect).
 *
 * Owned by `controller.ts`.
 */

import { log } from "../log";
import type { IBaseWidget, LGraphNode } from "../types/comfy";
import type { BackgroundLoader } from "./backgroundLoader";
import { INPUT_NAMES } from "./constants";
import { resolveFallbackFrame } from "./frameFallback";
import type { FallbackFrame } from "./frameFallback";
import type { LoadedBackground } from "./handoff";
import type { EditorSession } from "./sessions";
import { writeSizeWidgets } from "./sizeWidgets";

/**
 * Syncs the editor's background/frame with the node's input and widgets.
 */
export class FrameSync {
  private contentKey = "";

  /**
   * @param node - The node whose widgets define the fallback frame.
   * @param loader - Background loader of the same node.
   * @param onSizeWritten - Called after `width` / `height` were set to a new
   *   image's size (a value change ComfyUI does not observe).
   */
  constructor(
    private readonly node: LGraphNode,
    private readonly loader: BackgroundLoader,
    private readonly onSizeWritten: () => void,
  ) {}

  /** Forget the last pushed content so the next {@link apply} pushes again. */
  reset(): void {
    this.contentKey = "";
  }

  /**
   * Chain our own frame widgets' callbacks so fallback frame edits apply
   * immediately (the poll catches programmatic changes).
   * @param onChange - Called after the original callback.
   */
  chainWidgetCallbacks(onChange: () => void): void {
    for (const name of [INPUT_NAMES.width, INPUT_NAMES.height, INPUT_NAMES.background]) {
      const widget = this.findWidget(name);
      if (!widget) continue;
      const original = widget.callback;
      widget.callback = (...args: unknown[]) => {
        const [value, ...rest] = args;
        original?.call(widget, value, ...rest);
        onChange();
      };
    }
  }

  /**
   * Push background + frame decisions to the editor when anything relevant
   * changed. The current image is the loaded upstream image while connected,
   * else `width` x `height` filled with `background`; either way an empty
   * editor adopts its size and a painted one only maps onto it.
   * @param session - Attached session.
   * @param connected - Whether the `image` input has a link.
   */
  apply(session: EditorSession, connected: boolean): void {
    const { editor } = session;
    const bg = connected ? this.loader.background : null;
    if (bg) {
      const key = `${session.docId}|image|${bg.key}`;
      if (key === this.contentKey) return;
      this.contentKey = key;
      editor.setBackground({ kind: "image", image: bg.image }, bg.size);
      editor.handleBackgroundSize(bg.size);
      this.followImageSize(bg);
      return;
    }
    // A re-attached session (tab switch) still has its image: keep it until
    // this instance's first load settles instead of flashing the fill colour.
    const awaitingImage = connected && this.loader.awaitingImage;
    if (awaitingImage && editor.background.kind === "image") return;
    const frame = this.fallbackFrame();
    const key = `${session.docId}|fill|${frame.color}|${frame.size.width}x${frame.size.height}`;
    if (key === this.contentKey) return;
    this.contentKey = key;
    editor.setBackground({ kind: "fill", color: frame.color }, frame.size);
    editor.handleBackgroundSize(frame.size);
  }

  /**
   * The current image while disconnected: `width` x `height` filled with
   * `background`. Like any upstream image, an empty document adopts it and a
   * painted one is shown through the frame map.
   * @returns Sanitized fallback frame.
   */
  fallbackFrame(): FallbackFrame {
    return resolveFallbackFrame(
      this.findWidget(INPUT_NAMES.width)?.value,
      this.findWidget(INPUT_NAMES.height)?.value,
      this.findWidget(INPUT_NAMES.background)?.value,
    );
  }

  /**
   * A new image became the current image: `width` / `height` follow its size
   * (see `sizeWidgets.ts`), so losing it later keeps the frame. Skipped for
   * the handed-off background of a graph undo/redo: the restored widget
   * values are part of that state, and writing would make the graph differ
   * from the tracker's snapshot.
   */
  private followImageSize(background: LoadedBackground): void {
    if (this.loader.isHandedOff(background)) return;
    const { changed, clamped } = writeSizeWidgets(this.node, background.size);
    if (clamped) {
      const { width, height } = background.size;
      log.warn(`image ${width}x${height} is outside the width/height widget range; the size widgets were clamped.`);
    }
    if (changed) this.onSizeWritten();
  }

  private findWidget(name: string): IBaseWidget | undefined {
    return this.node.widgets?.find((widget) => widget.name === name);
  }
}
