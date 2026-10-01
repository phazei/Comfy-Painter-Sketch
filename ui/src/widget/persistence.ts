/**
 * Saving and restoring layer pixels (SPEC "Persistence and sync", saved-file contract).
 *
 * Save: each dirty layer is encoded as WebP (masks lossless, paint layers at
 * `PainterSketch.PaintQuality`; PNG fallback, see `layerEncode.ts`), exactly
 * `bounds` sized with straight alpha, named by a hash of the encoded bytes
 * and uploaded with `POST /upload/image` (`type=input`,
 * `subfolder=painter-sketch`, `overwrite=true`: same name == same bytes).
 * Unchanged content maps to the same name and is not re-uploaded while the
 * name is fresh in the session's {@link KnownFiles} (uploaded less than
 * {@link KNOWN_FILE_MAX_AGE_MS} ago; the settings cleanup deletes unreferenced
 * files older than 24 h, so an older name is uploaded again, which bumps the
 * server mtime; names from the loaded manifest count as fresh). A layer's
 * `file` is only updated after a successful upload, so the manifest never
 * references a missing file; on failure the layer stays dirty, the pixels
 * stay in memory, one error toast is shown per failure streak (de-duplicated
 * across documents) and the batch is retried automatically with backoff
 * (15 s doubling to 2 min); the first success after a toasted failure says so.
 *
 * The Image Mask uploads the same way (PNG) when its coverage is dirty,
 * i.e. after its source changed (`imageMaskSync.ts`); it is never edited.
 * Layer masks upload and restore like mask layers too (PNG,
 * `Editor.layerMask`), their file in the layer's `layerMask.file`.
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
import type { Layer, LayerKind, PainterDocument } from "../document/types";
import type { Editor } from "../engine/editor";
import { log } from "../log";
import { readSetting } from "./comfyApi";
import { contentHash, layerFileName } from "./contentHash";
import { classifyError, DecodeError, EncodeError, HttpError, restoreSummary, uploadFailureMessage } from "./failures";
import type { RestoreProblem } from "./failures";
import { encodeLayer } from "./layerEncode";
import { normalizePaintQuality, PAINT_QUALITY_ID } from "./paintQuality";
import { notify } from "./toast";
import { parseAnnotatedFilename, viewUrl } from "./viewUrl";

/** Idle fallback: upload this long after the last edit. */
export const IDLE_UPLOAD_DELAY_MS = 5000;

/** First automatic retry after a failed upload batch; doubles per failure. */
const RETRY_MIN_MS = 15_000;
/** Longest automatic retry interval. */
const RETRY_MAX_MS = 120_000;

/**
 * A file this session uploaded is trusted to still exist this long; older
 * names are uploaded again (the cleanup deletes unreferenced files > 24 h).
 */
export const KNOWN_FILE_MAX_AGE_MS = 20 * 60 * 60 * 1000;

/**
 * Every file reference a document has loaded or uploaded -> when it was last
 * uploaded or loaded (epoch ms). Files referenced by the loaded manifest are
 * recorded as fresh (see {@link manifestKnownFiles}); the age check only
 * matters for names uploaded earlier in the session and revived by undo.
 */
export type KnownFiles = Map<string, number>;

/**
 * The known files of a just-loaded document: every file its manifest
 * references, recorded as fresh. The open workflow / draft references them,
 * so the settings cleanup keeps them; reusing one (a text layer re-rendered
 * on load to the same bytes, undo back to the saved state) needs no upload.
 *
 * @param doc - Loaded document.
 * @param now - Clock (epoch ms).
 * @returns A new known-files map.
 */
export function manifestKnownFiles(doc: Readonly<PainterDocument>, now: number = Date.now()): KnownFiles {
  const known: KnownFiles = new Map();
  for (const layer of doc.layers) {
    if (layer.file) known.set(layer.file, now);
    if (layer.layerMask?.file) known.set(layer.layerMask.file, now);
  }
  const imageMaskFile = doc.imageMask?.file;
  if (imageMaskFile) known.set(imageMaskFile, now);
  return known;
}

/** Toast keys shared by all documents (one outage = one toast). */
const UPLOAD_FAILED_KEY = "upload-failed";
const UPLOAD_RECOVERED_KEY = "upload-recovered";
/** Upload failure / recovery toasts repeat at most this often. */
const UPLOAD_TOAST_WINDOW_MS = 60_000;

// ═══════════════════════════════════════════════════════════════════════════
// Upload
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Uploads dirty layers of one editor; serializes concurrent flushes.
 */
export class LayerUploader {
  private running: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** The current failure streak has been toasted. */
  private failureNotified = false;
  /** Current automatic retry interval (0 = last batch succeeded). */
  private retryDelay = 0;
  private disposed = false;
  private readonly settledListeners = new Set<() => void>();

  /**
   * @param editor - Editor whose layers are uploaded.
   * @param knownFiles - Every file reference this document has used, with upload times (updated).
   * @param now - Clock (epoch ms); tests inject one.
   */
  constructor(
    private readonly editor: Editor,
    private readonly knownFiles: KnownFiles,
    private readonly now: () => number = Date.now,
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
    const failures: unknown[] = [];
    // Read once per flush: a setting change applies to future uploads only.
    const paintQuality = normalizePaintQuality(readSetting(PAINT_QUALITY_ID));
    for (const layer of [...this.editor.doc.layers]) {
      const rt = this.editor.layerRuntime(layer.id);
      if (!rt?.dirty) continue;
      const version = rt.version;
      try {
        const file = await this.uploadLayer(layer, paintQuality);
        if (this.disposed) return;
        if (file) this.knownFiles.set(file, this.now());
        this.editor.markUploaded(layer.id, version, file);
      } catch (error) {
        failures.push(error);
      }
    }
    await this.uploadLayerMasks(paintQuality, failures);
    await this.uploadImageMask(paintQuality, failures);
    if (this.disposed) return;
    if (failures.length) {
      const message = uploadFailureMessage(failures[0]);
      // One toast per failure streak per document, and one per window
      // across documents (several nodes failing on the same outage).
      if (!this.failureNotified) {
        notify("error", message, { key: UPLOAD_FAILED_KEY, windowMs: UPLOAD_TOAST_WINDOW_MS, details: failures });
        this.failureNotified = true;
      } else {
        log.warn("upload retry failed:", ...failures);
      }
      this.scheduleRetry();
      throw new Error(`PainterSketch: ${message}`);
    }
    this.retryDelay = 0;
    if (this.failureNotified) {
      this.failureNotified = false;
      notify("info", "Paint layers saved again.", { key: UPLOAD_RECOVERED_KEY, windowMs: UPLOAD_TOAST_WINDOW_MS });
    }
  }

  /** After a failed batch: retry with backoff unless an edit already scheduled an upload. */
  private scheduleRetry(): void {
    this.retryDelay = Math.min(RETRY_MAX_MS, Math.max(RETRY_MIN_MS, this.retryDelay * 2));
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flushQuietly();
    }, this.retryDelay);
  }

  /**
   * Dirty layer masks, like mask layers (PNG, same folder and naming;
   * a fully hidden mask stores no file).
   */
  private async uploadLayerMasks(paintQuality: number, failures: unknown[]): Promise<void> {
    for (const job of this.editor.layerMask.uploads()) {
      if (this.disposed) return;
      try {
        const file = await this.uploadLayer({ id: job.layerId, name: job.name, kind: "mask", file: job.file }, paintQuality, job.canvas);
        if (this.disposed) return;
        if (file) this.knownFiles.set(file, this.now());
        this.editor.layerMask.markUploaded(job.layerId, job.version, file);
      } catch (error) {
        failures.push(error);
      }
    }
  }

  /**
   * The Image Mask coverage, like a mask layer (PNG, same folder and
   * naming); dirty only after its source changed.
   */
  private async uploadImageMask(paintQuality: number, failures: unknown[]): Promise<void> {
    const mask = this.editor.imageMask;
    const info = mask.info;
    const canvas = mask.dirty ? mask.canvas() : null;
    if (this.disposed || !info || !canvas) return;
    const version = mask.version;
    try {
      const file = await this.uploadLayer(info, paintQuality, canvas);
      if (this.disposed) return;
      if (file) this.knownFiles.set(file, this.now());
      mask.markUploaded(version, file);
    } catch (error) {
      failures.push(error);
    }
  }

  /** @returns The file reference for the layer's current pixels (null = empty). */
  private async uploadLayer(
    layer: { id: string; name: string; kind: LayerKind; file: string | null },
    paintQuality: number,
    // Pre-lift pixels while a floating selection is open (never half-saved).
    canvas: HTMLCanvasElement = this.editor.savedLayerCanvas(layer.id),
  ): Promise<string | null> {
    if (isCanvasEmpty(canvas)) return null;
    const { blob, bytes, ext } = await encodeLayer(canvas, layer.kind, paintQuality).catch((error: unknown) => {
      log.warn(`encoding layer "${layer.name}" (${canvas.width}x${canvas.height}) failed:`, error);
      throw new EncodeError(layer.name);
    });
    const name = layerFileName(this.editor.doc.docId, contentHash(bytes), ext);
    const expected = `${DOCUMENT_SUBFOLDER}/${name} [input]`;
    // Same bytes as the current or an earlier upload of this document (e.g.
    // after undo): the file exists unless the cleanup may have deleted it by
    // now, so skip the request only while the name is fresh.
    const uploadedAt = this.knownFiles.get(expected);
    if (uploadedAt !== undefined && this.now() - uploadedAt < KNOWN_FILE_MAX_AGE_MS) return expected;
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
  if (response.status !== 200) {
    // ComfyUI answers upload errors with a short plain-text body; skip HTML pages (proxies).
    const text = (await response.text().catch(() => "")).trim();
    throw new HttpError(response.status, response.statusText, text && !text.startsWith("<") ? text.slice(0, 200) : undefined);
  }
  const data: unknown = await response.json().catch(() => null);
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
 * A layer whose file cannot be loaded (404, server down, corrupt bytes)
 * stays in the document, empty, and keeps its `file` reference untouched
 * (not dirty) until the user edits that layer, so nothing is overwritten
 * silently and a file restored on disk loads again next time. Text layers
 * are re-rendered from `textData` instead (their source of truth) and
 * re-uploaded. All problems of one document produce a single toast.
 *
 * A file that failed to load is dropped from `knownFiles` (it may be gone),
 * so content encoding to that name is uploaded again. A text layer re-rendered
 * after a successful load (size mismatch) keeps its fresh entry: when it
 * encodes to the existing name, no request is made.
 *
 * @param editor - Target editor (fresh, layers blank).
 * @param isAlive - Returns `false` once the session was released (stale loads are dropped).
 * @param knownFiles - The session's known files (failed loads are removed).
 * @returns Resolves when all loads settled.
 */
export async function restoreLayers(editor: Editor, isAlive: () => boolean, knownFiles?: KnownFiles): Promise<void> {
  const layers = editor.doc.layers.filter((l) => l.file);
  const masks = editor.doc.layers.filter((l) => l.layerMask?.file);
  if (!layers.length && !masks.length) return;
  const bounds = editor.bounds;
  const problems: RestoreProblem[] = [];
  editor.beginLoading();
  try {
    await Promise.all([
      ...masks.map((layer) => restoreLayerMask(editor, layer, isAlive, problems, knownFiles)),
      ...layers.map(async (layer) => {
        const item = parseAnnotatedFilename(layer.file, "input");
        if (!item) return;
        const url = viewUrl(item, (route) => api.apiURL(route));
        try {
          const image = await fetchImage(url);
          if (!isAlive()) return;
          if (image.naturalWidth !== bounds.width || image.naturalHeight !== bounds.height) {
            log.warn(
              `layer "${layer.name}" file is ${image.naturalWidth}x${image.naturalHeight}, expected ` +
                `${bounds.width}x${bounds.height}:`,
              layer.file,
            );
            if (!(layer.kind === "text" && layer.textData)) problems.push({ name: layer.name, kind: "stale" });
          }
          editor.restoreLayerPixels(layer.id, image);
        } catch (error) {
          if (!isAlive()) return;
          if (layer.file) knownFiles?.delete(layer.file);
          log.warn(`could not restore layer "${layer.name}" from ${layer.file}:`, error);
          if (!editor.recoverMissingLayer(layer.id)) problems.push({ name: layer.name, kind: classifyError(error) });
        }
      }),
    ]);
  } finally {
    if (isAlive()) editor.endLoading();
  }
  const summary = isAlive() ? restoreSummary(problems) : null;
  if (summary) notify(summary.severity, summary.message, { key: `restore:${editor.doc.docId}:${summary.message}` });
}

/**
 * Restore one layer mask. A failed load shows the layer unmasked (as
 * Python ignores an unreadable mask) and keeps the file reference.
 */
async function restoreLayerMask(
  editor: Editor,
  layer: Readonly<Layer>,
  isAlive: () => boolean,
  problems: RestoreProblem[],
  knownFiles: KnownFiles | undefined,
): Promise<void> {
  const file = layer.layerMask?.file ?? null;
  const item = parseAnnotatedFilename(file, "input");
  if (!item) return;
  const name = `${layer.name} mask`;
  try {
    const image = await fetchImage(viewUrl(item, (route) => api.apiURL(route)));
    if (!isAlive()) return;
    const b = editor.bounds;
    if (image.naturalWidth !== b.width || image.naturalHeight !== b.height) {
      log.warn(`layer mask "${name}" file is ${image.naturalWidth}x${image.naturalHeight}, expected ${b.width}x${b.height}:`, file);
      problems.push({ name, kind: "stale" });
    }
    editor.layerMask.restore(layer.id, image);
  } catch (error) {
    if (!isAlive()) return;
    if (file) knownFiles?.delete(file);
    log.warn(`could not restore layer mask "${name}" from ${file}:`, error);
    editor.layerMask.restoreFailed(layer.id);
    problems.push({ name, kind: classifyError(error) });
  }
}

/**
 * Download and decode an image, keeping the failure kind: HTTP status
 * ({@link HttpError}), network failure (`TypeError` from `fetch`) or
 * undecodable bytes ({@link DecodeError}). An `<img>` alone reports all of
 * these as the same `error` event.
 */
async function fetchImage(url: string): Promise<HTMLImageElement> {
  const response = await fetch(url);
  if (!response.ok) throw new HttpError(response.status, response.statusText);
  const objectUrl = URL.createObjectURL(await response.blob());
  try {
    return await new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      image.decoding = "async";
      image.onload = () => resolve(image);
      image.onerror = () => reject(new DecodeError(url));
      image.src = objectUrl;
    });
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}
