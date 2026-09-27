/**
 * Copy / cut / paste glue of one editor host (SPEC M10 Clipboard). The engine
 * (`Editor.clipboard`) makes and consumes pixels; this module owns the
 * clipboards:
 *
 * - The INTERNAL clipboard is module-level (shared by every PainterSketch
 *   node on the page): the copied pixels, their document rect (paste in
 *   place) and image scale, a fingerprint of the PNG written to the system
 *   clipboard, and whether that write succeeded.
 * - The SYSTEM clipboard gets a PNG via `navigator.clipboard.write` (the blob
 *   is passed as a promise, so the user gesture still counts); failures go
 *   to the console and leave the copy internal-only.
 * - Ctrl+V: the keydown is NOT prevented (so the browser fires `paste`);
 *   {@link ClipboardActions.armPaste} adds a one-shot capture `paste`
 *   listener on `window`, which exists only between an editor-owned Ctrl+V
 *   keydown and its `paste` event (removed after it, after a timeout, or on
 *   dispose) and stops that event from reaching ComfyUI.
 *
 * Pastes: 1 source px = 1 IMAGE px (internal copies keep their own size),
 * centred on the current image (drops: at the drop point), a new "Pasted" layer, one
 * undo step each (the selection is dropped in it). Sources:
 * - Ctrl+V / Paste button "System": `pasteChoice.ts` (system image, else
 *   the internal copy, else clipspace).
 * - Ctrl+Shift+V: the internal copy in place, handled on keydown (the
 *   system clipboard is ignored); without one it behaves like Ctrl+V.
 * - Paste button "Clipspace": the clipspace image only.
 */

import { imageCentreDoc } from "../engine/clipboardMath";
import type { ClipImage, PastePlacement } from "../engine/clipboardOps";
import type { Editor } from "../engine/editor";
import { imageToDoc } from "../engine/frameMap";
import { stageToDoc } from "../engine/viewport";
import type { Point } from "../geometry/rect";
import { log } from "../log";
import { notify } from "../widget/toast";
import type { EditorSession } from "../widget/sessions";
import { choosePasteSource, signaturesMatch } from "./pasteChoice";
import type { ImageSignature, PasteFacts } from "./pasteChoice";
import { clipspaceImageUrl, decodeBlob, decodeUrl, imageSignature, readSystemImage } from "./pasteSources";

/** Note when no source has an image. */
export const NOTHING_TO_PASTE_NOTE = "Nothing to paste.";

/** Note when the clipspace holds no image (Paste button / menu "Clipspace"). */
export const CLIPSPACE_EMPTY_NOTE = "Clipspace has no image -- nothing to paste.";

/** Note when the Paste button / menu "System" finds no image anywhere. */
export const SYSTEM_EMPTY_NOTE = "The clipboard has no image -- nothing to paste.";

/** How long an armed Ctrl+V waits for its `paste` event, ms. */
const PASTE_WAIT_MS = 1000;

/** What the rail's Paste button (or its menu) asks for: the Ctrl+V order, or clipspace only. */
export type PasteRequest = "system" | "clipspace";

/** The internal clipboard (module-level, see module doc). */
interface InternalClip {
  clip: ClipImage;
  signature: ImageSignature | null;
  /** The PNG reached the system clipboard. */
  systemWritten: boolean;
}

let internal: InternalClip | null = null;

/** A decoded image ready to paste. */
interface PasteImage {
  source: CanvasImageSource;
  width: number;
  height: number;
  /** Source px -> image px factor (1 for foreign images). */
  imagePerSource: number;
  /** Top-left for paste in place (internal copies only). */
  topLeft: Point | null;
  release(): void;
}

// ═══════════════════════════════════════════════════════════════════════════

/**
 * Clipboard commands for one editor host.
 */
export class ClipboardActions {
  private armed: { plainText: boolean; timer: ReturnType<typeof setTimeout> } | null = null;
  private readonly onPaste = (event: ClipboardEvent): void => this.handlePaste(event);

  /**
   * @param getSession - Current session.
   * @param stage - Stage element (drop points).
   */
  constructor(
    private readonly getSession: () => EditorSession | null,
    private readonly stage: HTMLElement,
  ) {}

  /** Whether an internal copy exists (Ctrl+Shift+V pastes it in place). */
  get hasInternal(): boolean {
    return internal !== null;
  }

  /**
   * Ctrl+C / Ctrl+Shift+C / Copy button.
   * @param merged - Copy merged (what is visible, incl. the image).
   */
  copy(merged: boolean): void {
    const clip = this.getSession()?.editor.clipboard.copy(merged);
    if (clip) store(clip);
  }

  /** Ctrl+X / Cut button. */
  cut(): void {
    const clip = this.getSession()?.editor.clipboard.cut();
    if (clip) store(clip);
  }

  /**
   * Ctrl+V keydown (editor owns the keyboard; also Ctrl+Shift+V without an
   * internal copy): wait for the browser's `paste` event.
   * @param plainText - Chrome's Ctrl+Shift+V ("paste as plain text") carries
   *   no image: read the async clipboard instead when the event has none.
   */
  armPaste(plainText: boolean): void {
    this.disarm();
    const timer = setTimeout(() => this.disarm(), PASTE_WAIT_MS);
    this.armed = { plainText, timer };
    window.addEventListener("paste", this.onPaste, true);
  }

  /**
   * Ctrl+Shift+V: the internal copy at its copied position; the system
   * clipboard is ignored.
   * @returns `false` without an internal copy (the caller pastes like Ctrl+V).
   */
  pasteInPlace(): boolean {
    const editor = this.getSession()?.editor;
    if (!editor || !internal) return false;
    this.place(editor, internalImage(internal.clip), true);
    return true;
  }

  /**
   * Rail Paste button (a user gesture: `navigator.clipboard.read()` may ask
   * for permission) or one of its menu entries.
   * @param request - `"system"` (Ctrl+V order: system, internal, clipspace) or `"clipspace"` only.
   */
  async pasteFromButton(request: PasteRequest): Promise<void> {
    const editor = this.getSession()?.editor;
    if (!editor) return;
    if (request === "clipspace") return this.pasteClipspace(editor);
    await this.pasteFacts(editor, await readSystemImage(), SYSTEM_EMPTY_NOTE);
  }

  /**
   * Dropped images: one layer each, in order, centred at the drop point.
   * @param images - Image files / blobs (decoded here) or decoded bitmaps.
   * @param clientPoint - Drop point (client px).
   * @returns `true` if at least one image decoded.
   */
  async pasteDropped(images: readonly (Blob | ImageBitmap)[], clientPoint: Point): Promise<boolean> {
    const editor = this.getSession()?.editor;
    if (!editor) return false;
    const at = this.docPoint(editor, this.toStage(clientPoint));
    let any = false;
    for (const item of images) {
      const bitmap = item instanceof Blob ? await decodeBlob(item) : item;
      if (!bitmap) continue;
      any = true;
      this.place(editor, foreignImage(bitmap), false, at);
    }
    return any;
  }

  /** Remove the armed paste listener. */
  dispose(): void {
    this.disarm();
  }

  // ── Internals ───────────────────────────────────────────────────────────

  private disarm(): void {
    if (!this.armed) return;
    clearTimeout(this.armed.timer);
    this.armed = null;
    window.removeEventListener("paste", this.onPaste, true);
  }

  private handlePaste(event: ClipboardEvent): void {
    const plainText = this.armed?.plainText ?? false;
    this.disarm();
    event.preventDefault();
    event.stopPropagation();
    const editor = this.getSession()?.editor;
    if (!editor) return;
    const file = Array.from(event.clipboardData?.items ?? []).find((i) => i.kind === "file" && i.type.startsWith("image/"));
    const blob = file?.getAsFile() ?? null;
    void (async () => this.pasteFacts(editor, blob ?? (plainText ? await readSystemImage() : null)))();
  }

  /** Ctrl+V order (`pasteChoice.ts`): decode the system image (if any), choose the source, paste. */
  private async pasteFacts(editor: Editor, systemBlob: Blob | null, emptyNote = NOTHING_TO_PASTE_NOTE): Promise<void> {
    const bitmap = systemBlob ? await decodeBlob(systemBlob) : null;
    const signature = bitmap ? imageSignature(bitmap, bitmap.width, bitmap.height) : null;
    const clipspaceUrl = clipspaceImageUrl();
    const facts: PasteFacts = {
      systemImage: bitmap !== null,
      systemIsOurs: signaturesMatch(signature, internal?.signature ?? null),
      internal: internal !== null,
      clipspace: clipspaceUrl !== null,
    };
    const kind = choosePasteSource(facts);
    if (kind !== "system") bitmap?.close();
    if (kind === "system" && bitmap) return this.place(editor, foreignImage(bitmap), false);
    if (kind === "internal" && internal) return this.place(editor, internalImage(internal.clip), false);
    if (kind === "clipspace") return this.pasteClipspace(editor);
    editor.events.emit("note", emptyNote);
  }

  /** The ComfyUI clipspace image, centred on the image. */
  private async pasteClipspace(editor: Editor): Promise<void> {
    const url = clipspaceImageUrl();
    const image = url ? await decodeUrl(url) : null;
    if (image) return this.place(editor, foreignImage(image), false);
    editor.events.emit("note", CLIPSPACE_EMPTY_NOTE);
  }

  /** Paste one decoded image as a new layer; toasts when cropped. */
  private place(editor: Editor, image: PasteImage, inPlace: boolean, centre?: Point): void {
    const map = editor.frameMap;
    const docPerSource = image.imagePerSource / map.scale;
    const at: PastePlacement =
      inPlace && image.topLeft ? { topLeft: image.topLeft } : { centre: centre ?? imageCentreDoc(editor.imageSize, map) };
    const result = editor.clipboard.paste(image.source, { width: image.width, height: image.height }, docPerSource, at);
    image.release();
    if (result?.cropped) {
      notify("warn", "The pasted image is larger than the paint area and was cropped.", { key: "paste-cropped" });
    }
  }

  private toStage(client: Point): Point {
    const rect = this.stage.getBoundingClientRect();
    const sx = rect.width > 0 ? this.stage.clientWidth / rect.width : 1;
    const sy = rect.height > 0 ? this.stage.clientHeight / rect.height : 1;
    return { x: (client.x - rect.left) * sx, y: (client.y - rect.top) * sy };
  }

  private docPoint(editor: Editor, stagePoint: Point): Point {
    return imageToDoc(editor.frameMap, stageToDoc(editor.view.current, stagePoint));
  }
}

// ── Internal clipboard ────────────────────────────────────────────────────────

/** Keep a copy internally and write its PNG to the system clipboard. */
function store(clip: ClipImage): void {
  const canvas = document.createElement("canvas");
  canvas.width = clip.data.width;
  canvas.height = clip.data.height;
  canvas.getContext("2d")?.putImageData(clip.data, 0, 0);
  const entry: InternalClip = { clip, signature: imageSignature(canvas, canvas.width, canvas.height), systemWritten: false };
  internal = entry;
  const png = new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("PNG encoding failed"))), "image/png");
  });
  const release = (): void => {
    canvas.width = canvas.height = 0;
  };
  if (typeof ClipboardItem !== "function" || typeof navigator.clipboard?.write !== "function") {
    log.warn("System clipboard unavailable; the copy is kept inside PainterSketch only.");
    void png.then(release, release);
    return;
  }
  navigator.clipboard
    .write([new ClipboardItem({ "image/png": png })])
    .then(() => {
      entry.systemWritten = true;
    })
    .catch((error: unknown) => log.warn("Could not write the system clipboard; the copy is kept inside PainterSketch only.", error))
    .finally(release);
}

function internalImage(clip: ClipImage): PasteImage {
  const canvas = document.createElement("canvas");
  canvas.width = clip.data.width;
  canvas.height = clip.data.height;
  canvas.getContext("2d")?.putImageData(clip.data, 0, 0);
  return {
    source: canvas,
    width: canvas.width,
    height: canvas.height,
    imagePerSource: clip.imageScale,
    topLeft: { x: clip.rect.x, y: clip.rect.y },
    release: () => {
      canvas.width = canvas.height = 0;
    },
  };
}

function foreignImage(bitmap: ImageBitmap): PasteImage {
  return { source: bitmap, width: bitmap.width, height: bitmap.height, imagePerSource: 1, topLeft: null, release: () => bitmap.close() };
}
