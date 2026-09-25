/**
 * Saving and restoring layer pixels (decision 8, saved-file contract).
 *
 * Save: each dirty layer is encoded as WebP (masks lossless, paint layers at
 * `PainterSketch.PaintQuality`; PNG fallback, see `layerEncode.ts`), exactly
 * `bounds` sized with straight alpha, named by a hash of the encoded bytes
 * and uploaded with `POST /upload/image` (`type=input`,
 * `subfolder=painter-sketch`, `overwrite=true`: same name == same bytes).
 * Unchanged content maps to the same name and is not re-uploaded. A layer's
 * `file` is only updated after a successful upload, so the manifest never
 * references a missing file; on failure the layer stays dirty and the pixels
 * stay in memory.
 *
 * Upload timing (saved-file contract): the owner calls {@link LayerUploader.flush}
 * on disengage / fullscreen exit / Ctrl+S / queue; {@link LayerUploader.schedule}
 * is the idle fallback, {@link IDLE_UPLOAD_DELAY_MS} after the last edit.
 *
 * Restore: layer files (any format the browser decodes, so old `.png` and new
 * `.webp` alike) are loaded from `/view` into the layer canvases; loads for a
 * session that was released meanwhile are ignored.
 */

import { api } from "@comfy/scripts/api.js";

import { DOCUMENT_SUBFOLDER } from "../document/types";
import type { LayerKind } from "../document/types";
import type { Editor } from "../engine/editor";
import { log } from "../log";
import { readSetting } from "./comfyApi";
import { contentHash, layerFileName } from "./contentHash";
import { encodeLayer } from "./layerEncode";
import { normalizePaintQuality, PAINT_QUALITY_ID } from "./paintQuality";
import { notify } from "./toast";
import { parseAnnotatedFilename, viewUrl } from "./viewUrl";

/** Idle fallback: upload this long after the last edit. */
export const IDLE_UPLOAD_DELAY_MS = 5000;

// ═══════════════════════════════════════════════════════════════════════════
// Upload
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Uploads dirty layers of one editor; serializes concurrent flushes.
 */
export class LayerUploader {
  private running: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private failureNotified = false;
  private disposed = false;
  private readonly settledListeners = new Set<() => void>();

  /**
   * @param editor - Editor whose layers are uploaded.
   * @param knownFiles - Every file reference this document has used (updated).
   */
  constructor(
    private readonly editor: Editor,
    private readonly knownFiles: Set<string>,
      ) {}

  /** @returns Whether an upload batch is in progress. */
  get busy(): boolean {
    return this.running !== null;
  }

  /**
   * Listen for the end of each upload batch (success or failure; not after
   * dispose). Called before the batch's `flush()` promise settles.
   * @param listener - Callback.
   * @returns Unsubscribe function.
   */
  onSettled(listener: () => void): () => void {
    this.settledListeners.add(listener);
    return () => this.settledListeners.delete(listener);
  }

  /**
   * Idle fallback: upload {@link IDLE_UPLOAD_DELAY_MS} after the last call
   * (debounced; call on every edit). Failures are reported, never thrown.
   */
  schedule(): void {
    if (this.disposed) return;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flushQuietly();
    }, IDLE_UPLOAD_DELAY_MS);
  }

  /** Upload now if dirty (disengage, fullscreen exit); failures only toast. */
  flushQuietly(): void {
    if (this.disposed || !this.editor.dirty) return;
    this.flush().catch(() => undefined);
  }

  /**
   * Upload every dirty layer now.
   * @throws If any upload failed (after a toast); successful layers are kept.
   */
  async flush(): Promise<void> {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    while (this.running) await this.running.catch(() => undefined);
    if (this.disposed || !this.editor.dirty) return;
    this.running = this.uploadDirty();
    try {
      await this.running;
    } finally {
      this.running = null;
      if (!this.disposed) for (const listener of [...this.settledListeners]) listener();
    }
  }

  /** Stop scheduled uploads. In-flight requests finish but are ignored. */
  dispose(): void {
    this.disposed = true;
    this.settledListeners.clear();
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private async uploadDirty(): Promise<void> {
    const failures: string[] = [];
    // Read once per flush: a setting change applies to future uploads only.
    const paintQuality = normalizePaintQuality(readSetting(PAINT_QUALITY_ID));
    for (const layer of [...this.editor.doc.layers]) {
      const rt = this.editor.layerRuntime(layer.id);
      if (!rt?.dirty) continue;
      const version = rt.version;
      try {
        const file = await this.uploadLayer(layer.id, layer.kind, layer.file, paintQuality);
        if (this.disposed) return;
        if (file) this.knownFiles.add(file);
        this.editor.markUploaded(layer.id, version, file);
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (failures.length) {
      if (!this.failureNotified) {
        notify("error", `Could not save paint layers (kept in memory, will retry): ${failures[0]}`);
        this.failureNotified = true;
      }
      throw new Error(`PainterSketch upload failed: ${failures[0]}`);
    }
    this.failureNotified = false;
  }

  /** @returns The file reference for the layer's current pixels (null = empty). */
  private async uploadLayer(
    layerId: string,
    kind: LayerKind,
    currentFile: string | null,
    paintQuality: number,
  ): Promise<string | null> {
    const canvas = this.editor.layerCanvas(layerId);
    if (isCanvasEmpty(canvas)) return null;
    const { blob, bytes, ext } = await encodeLayer(canvas, kind, paintQuality);
    const name = layerFileName(this.editor.doc.docId, contentHash(bytes), ext);
    const expected = `${DOCUMENT_SUBFOLDER}/${name} [input]`;
    // Same bytes as the current or an earlier upload of this document (e.g.
    // after undo): the file already exists, skip the request.
    if (currentFile === expected || this.knownFiles.has(expected)) return expected;
    return uploadImage(blob, name);
  }
}

/** Whether every pixel is fully transparent. */
function isCanvasEmpty(canvas: HTMLCanvasElement): boolean {
  const ctx = canvas.getContext("2d");
  if (!ctx) return false;
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  for (let i = 3; i < data.length; i += 4) if (data[i] !== 0) return false;
  return true;
}

/**
 * POST an encoded layer to `/upload/image`.
 * @returns `"painter-sketch/<name> [input]"` as reported by the server.
 */
async function uploadImage(blob: Blob, name: string): Promise<string> {
  const body = new FormData();
  body.append("image", blob, name);
  body.append("type", "input");
  body.append("subfolder", DOCUMENT_SUBFOLDER);
  body.append("overwrite", "true");
  const response = await api.fetchApi("/upload/image", { method: "POST", body });
  if (response.status !== 200) throw new Error(`upload returned ${response.status} ${response.statusText}`);
  const data: unknown = await response.json();
  if (!isUploadResponse(data)) throw new Error("upload response is missing 'name'");
  const subfolder = data.subfolder || DOCUMENT_SUBFOLDER;
  return `${subfolder}/${data.name} [${data.type || "input"}]`;
}

function isUploadResponse(value: unknown): value is { name: string; subfolder?: string; type?: string } {
  return typeof value === "object" && value !== null && typeof (value as { name?: unknown }).name === "string";
}

// ═══════════════════════════════════════════════════════════════════════════
// Restore
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Load every layer's file (WebP or PNG) into the editor. Painting is disabled until done.
 *
 * @param editor - Target editor (fresh, layers blank).
 * @param isAlive - Returns `false` once the session was released (stale loads are dropped).
 * @returns Resolves when all loads settled.
 */
export async function restoreLayers(editor: Editor, isAlive: () => boolean): Promise<void> {
  const layers = editor.doc.layers.filter((l) => l.file);
  if (!layers.length) return;
  const bounds = editor.bounds;
  editor.beginLoading();
  try {
    await Promise.all(
      layers.map(async (layer) => {
        const item = parseAnnotatedFilename(layer.file, "input");
        if (!item) return;
        try {
          const image = await loadImage(viewUrl(item, (route) => api.apiURL(route)));
          if (!isAlive()) return;
          if (image.naturalWidth !== bounds.width || image.naturalHeight !== bounds.height) {
            log.warn(
              `Layer "${layer.name}" is ${image.naturalWidth}x${image.naturalHeight}, expected ${bounds.width}x${bounds.height}`,
            );
          }
          editor.restoreLayerPixels(layer.id, image);
        } catch {
          if (isAlive()) notify("warn", `Missing paint layer file ${layer.file}; layer "${layer.name}" is empty.`);
        }
      }),
    );
  } finally {
    if (isAlive()) editor.endLoading();
  }
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = "async";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`could not load ${url}`));
    image.src = url;
  });
}
