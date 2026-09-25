/**
 * Persistence-facing operations of the editor core: restore bookkeeping
 * (painting is disabled while layer files load) and upload results. Used by
 * `widget/persistence.ts` through the `Editor` facade.
 */

import type { EditorState } from "./editorState";

/**
 * Restore/upload bookkeeping over a shared {@link EditorState}.
 */
export class DocIO {
  /**
   * @param s - Shared editor state.
   * @param applyBackgroundSize - Re-run a background size change deferred while loading.
   */
  constructor(
    private readonly s: EditorState,
    private readonly applyBackgroundSize: (size: { width: number; height: number }) => void,
  ) {}

  /** Mark the start of an async layer restore (disables painting). */
  beginLoading(): void {
    this.s.loadingCount++;
  }

  /** Mark the end of an async layer restore; applies a deferred frame change. */
  endLoading(): void {
    const s = this.s;
    s.loadingCount = Math.max(0, s.loadingCount - 1);
    s.events.emit("render", undefined);
    if (!s.loading && s.pendingBackgroundSize) {
      const size = s.pendingBackgroundSize;
      s.pendingBackgroundSize = null;
      this.applyBackgroundSize(size);
    }
  }

  /**
   * Draw a restored layer image (WebP or PNG) into a layer (not an undo
   * step, not dirty).
   * @param layerId - Layer id.
   * @param image - Decoded image (sized to `bounds`).
   */
  restoreLayerPixels(layerId: string, image: CanvasImageSource): void {
    const surface = this.s.store.ensure(layerId);
    surface.ctx.clearRect(0, 0, surface.canvas.width, surface.canvas.height);
    surface.ctx.drawImage(image, 0, 0);
    this.s.runtime.bump(layerId);
    this.s.events.emit("render", undefined);
  }

  /**
   * Record a finished upload.
   * @param layerId - Layer id.
   * @param version - Layer version that was uploaded.
   * @param file - Stored file reference (`null` for an empty layer).
   */
  markUploaded(layerId: string, version: number, file: string | null): void {
    const layer = this.s.doc.layers.find((l) => l.id === layerId);
    const rt = this.s.runtime.get(layerId);
    if (!layer || !rt) return;
    layer.file = file;
    if (rt.version === version) rt.dirty = false;
    this.s.events.emit("change", undefined);
  }
}
