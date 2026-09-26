/**
 * Frame sync for one node: pushes the "current image" (loaded background
 * while `image` is connected, else the `width` x `height` / `background`
 * widgets) to the editor, and keeps those widgets in step with the canvas.
 *
 * An empty editor adopts the current image's size and a painted one only
 * maps onto it (never resampling, decision 4). Pushes are de-duplicated by a
 * content key so polls and repeated refreshes cost a string compare.
 *
 * Owned by `controller.ts`.
 */

import { app } from "@comfy/scripts/app.js";

import type { Size } from "../geometry/rect";
import type { IBaseWidget, LGraphNode } from "../types/comfy";
import type { BackgroundLoader } from "./backgroundLoader";
import { INPUT_NAMES, LINK_INPUT } from "./constants";
import { resolveFallbackFrame, widgetDimension } from "./frameFallback";
import type { FallbackFrame } from "./frameFallback";
import { inputSlotIndex } from "./imageSource";
import type { EditorSession } from "./sessions";

/**
 * Syncs the editor's background/frame with the node's input and widgets.
 */
export class FrameSync {
  private contentKey = "";

  /**
   * @param node - The node whose widgets define the fallback frame.
   * @param loader - Background loader of the same node.
   */
  constructor(
    private readonly node: LGraphNode,
    private readonly loader: BackgroundLoader,
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
   * painted one is shown through the frame map (decision 4).
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
   * A link on the node changed. If `image` lost its link (a user edit, not a
   * load), see {@link adoptSizeOnDisconnect}.
   * @param type - Slot type (`LINK_INPUT` for inputs).
   * @param slot - Slot index.
   * @param isConnected - `false` when a link was removed.
   * @param session - Attached session, if any.
   * @param stillWanted - Checked in the deferred microtask.
   */
  handleLinkChange(
    type: number,
    slot: number,
    isConnected: boolean,
    session: EditorSession | null,
    stillWanted: () => boolean,
  ): void {
    const imageSlot = inputSlotIndex(this.node, INPUT_NAMES.image);
    if (type === LINK_INPUT && slot === imageSlot && !isConnected && session && this.node.graph) {
      this.adoptSizeOnDisconnect(session.editor.imageSize, stillWanted);
    }
  }

  /**
   * `image` lost its link (a user edit, not a load): the widgets take over the
   * last image size so the canvas keeps its size and the node shows it.
   * Deferred a microtask so a link replaced by another (disconnect, then
   * connect in one call) leaves the widgets alone.
   * @param size - Image size shown when the link was removed.
   * @param stillWanted - Checked in the microtask (not disposed, still
   *   disconnected).
   */
  private adoptSizeOnDisconnect(size: Size, stillWanted: () => boolean): void {
    queueMicrotask(() => {
      if (!stillWanted()) return;
      const width = this.setWidgetValue(INPUT_NAMES.width, widgetDimension(size.width));
      const height = this.setWidgetValue(INPUT_NAMES.height, widgetDimension(size.height));
      if (!width && !height) return;
      this.node.graph?.incrementVersion?.();
      app.canvas?.setDirty?.(true, true);
    });
  }

  /**
   * Set a widget's value like a user edit: the value setter (backed by the
   * widget value store, so both renderers update) plus its callback (ours
   * re-applies the frame; see {@link chainWidgetCallbacks}).
   * @returns `true` if the value changed.
   */
  private setWidgetValue(name: string, value: number): boolean {
    const widget = this.findWidget(name);
    if (!widget || widget.value === value) return false;
    widget.value = value;
    widget.callback?.(widget.value);
    return true;
  }

  private findWidget(name: string): IBaseWidget | undefined {
    return this.node.widgets?.find((widget) => widget.name === name);
  }
}
