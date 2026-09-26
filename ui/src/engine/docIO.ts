/**
 * Persistence-facing operations of the editor core: restore bookkeeping
 * (painting is disabled while layer files load) and upload results. Used by
 * `widget/persistence.ts` through the `Editor` facade.
 */

import type { Size } from "../geometry/rect";
import type { EditorState } from "./editorState";
import { renderTextLayer } from "./textLayer";

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
   *
   * A file whose size differs from `bounds` was saved before a bounds
   * growth, so its origin is unknown. A text layer is then re-rendered from
   * its `textData` (the source of truth; otherwise its first move would
   * jump by the growth) and marked dirty so a matching file is uploaded.
   * @param layerId - Layer id.
   * @param image - Decoded image (sized to `bounds`).
   */
  restoreLayerPixels(layerId: string, image: CanvasImageSource): void {
    const s = this.s;
    const layer = s.doc.layers.find((l) => l.id === layerId);
    const bounds = s.store.bounds;
    const size = imageSize(image);
    if (layer?.kind === "text" && layer.textData && (size.width !== bounds.width || size.height !== bounds.height)) {
      renderTextLayer(s, layer);
      s.runtime.touch(layerId);
      s.events.emit("render", undefined);
      return;
    }
    const surface = s.store.ensure(layerId);
    surface.ctx.clearRect(0, 0, surface.canvas.width, surface.canvas.height);
    surface.ctx.drawImage(image, 0, 0);
    s.runtime.bump(layerId);
    s.events.emit("render", undefined);
  }

  /**
   * A layer's file could not be restored. A text layer is re-rendered from
   * its `textData` (the source of truth) and marked dirty so a new file is
   * uploaded; any other layer stays empty with its `file` reference intact.
   * @param layerId - Layer id.
   * @returns `true` if the layer was recovered (text layer).
   */
  recoverMissingLayer(layerId: string): boolean {
    const s = this.s;
    const layer = s.doc.layers.find((l) => l.id === layerId);
    if (layer?.kind !== "text" || !layer.textData) return false;
    renderTextLayer(s, layer);
    s.runtime.touch(layerId);
    s.events.emit("render", undefined);
    return true;
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

/** Pixel size of a decoded image (`naturalWidth` for `<img>`, else `width`). */
function imageSize(image: CanvasImageSource): Size {
  if (typeof HTMLImageElement !== "undefined" && image instanceof HTMLImageElement) {
    return { width: image.naturalWidth, height: image.naturalHeight };
  }
  const sized = image as { width?: unknown; height?: unknown };
  return {
    width: typeof sized.width === "number" ? sized.width : 0,
    height: typeof sized.height === "number" ? sized.height : 0,
  };
}
