/**
 * Dropping images on the stage = paste at the drop point (SPEC
 * "Clipboard and drop"): each image becomes its own "Pasted" layer (in order, one undo
 * step each), centred on the drop point.
 *
 * Which drags are claimed is the pure `pasteChoice.shouldClaimDrag`: image
 * file items, or URL / HTML drags from a web page. An image dragged from a
 * Chrome page carries `text/uri-list` + `text/html` and (on Windows usually)
 * `Files` with the image itself, whose item type may read `""` before the
 * drop. The previous rule refused every drag with `Files` unless an item
 * said `image/*`, so the browser's default ran (open the image in a tab).
 * Desktop drags of workflow JSON etc. are left to ComfyUI.
 *
 * Listeners are CAPTURE phase on the stage, so they run before anything
 * inside it, and claimed events are stopped so neither the Nodes 2.0 node
 * (`LGraphNode.vue`), ComfyUI's document `drop` handler (LoadImage node) nor
 * the fullscreen overlay's "no drop" guard sees them. `dragenter` AND
 * `dragover` are prevented (the browser only allows a drop, and skips its
 * navigate-to-image default, when both are).
 *
 * On drop: image files first; else the `<img src>` of the HTML, else the
 * first uri-list entry, fetched to a blob like ComfyUI's graph drop
 * (`fetchDroppedAsset`). A site without CORS headers: warn toast.
 *
 * `console.debug` lines (`[PainterSketch] drop: ...`) show which path fired.
 */

import { notify } from "../widget/toast";
import type { ClipboardActions } from "./clipboardActions";
import { shouldClaimDrag } from "./pasteChoice";
import { dragTypes, droppedImageUrl, fetchImageBlob, imageFiles } from "./pasteSources";

/** Toast when a web image can't be fetched (CORS). */
export const DRAG_BLOCKED_TEXT = "Couldn't load the dragged image (the site doesn't allow it). Save it and drop the file instead.";

/** Stage note when the dropped URL is not an image. */
export const DRAG_NOT_IMAGE_NOTE = "The dropped item is not an image.";

/** Diagnostic line (DevTools "Verbose" level). */
function debug(...args: unknown[]): void {
  console.debug("[PainterSketch] drop:", ...args);
}

/**
 * Install the drop handlers on a stage.
 * @param stage - Stage element.
 * @param actions - Clipboard commands (paste).
 * @param note - Shows a stage note.
 * @returns Removes the handlers.
 */
export function installDropImport(stage: HTMLElement, actions: ClipboardActions, note: (text: string) => void): () => void {
  let lastLogged = "";
  const over = (event: DragEvent): void => {
    const data = event.dataTransfer;
    const { types, fileTypes } = dragTypes(data);
    const claim = shouldClaimDrag(types, fileTypes);
    const summary = `${event.type} claim=${claim} types=[${types.join(", ")}] files=[${fileTypes.join(", ")}]`;
    if (event.type === "dragenter" || summary !== lastLogged) debug(summary);
    lastLogged = summary;
    if (!claim) return;
    event.preventDefault();
    event.stopPropagation();
    if (data) data.dropEffect = "copy";
  };
  const drop = (event: DragEvent): void => {
    lastLogged = "";
    const data = event.dataTransfer;
    const { types, fileTypes } = dragTypes(data);
    if (!shouldClaimDrag(types, fileTypes)) {
      debug("not claimed, left to ComfyUI", types, fileTypes);
      return;
    }
    // Never let the browser open the dragged image in place of the page.
    event.preventDefault();
    event.stopPropagation();
    const point = { x: event.clientX, y: event.clientY };
    const files = imageFiles(data);
    const url = droppedImageUrl(data);
    debug(files.length > 0 ? `files (${files.map((f) => `${f.name} ${f.type}`).join(", ")})` : url ? `url ${url.slice(0, 120)}` : "nothing usable");
    void pasteDrop(actions, files, url, point, note);
  };
  const opts = { capture: true };
  stage.addEventListener("dragenter", over, opts);
  stage.addEventListener("dragover", over, opts);
  stage.addEventListener("drop", drop, opts);
  return () => {
    stage.removeEventListener("dragenter", over, opts);
    stage.removeEventListener("dragover", over, opts);
    stage.removeEventListener("drop", drop, opts);
  };
}

/** Paste dropped files, else the fetched URL, at the drop point. */
async function pasteDrop(
  actions: ClipboardActions,
  files: File[],
  url: string | null,
  point: { x: number; y: number },
  note: (text: string) => void,
): Promise<void> {
  if (files.length > 0 && (await actions.pasteDropped(files, point))) return;
  if (!url) {
    note(DRAG_NOT_IMAGE_NOTE);
    return;
  }
  const result = await fetchImageBlob(url);
  if ("error" in result) {
    debug(`fetch failed (${result.error})`);
    if (result.error === "blocked") notify("warn", DRAG_BLOCKED_TEXT, { key: "drag-image-blocked" });
    else note(DRAG_NOT_IMAGE_NOTE);
    return;
  }
  if (!(await actions.pasteDropped([result.blob], point))) note(DRAG_NOT_IMAGE_NOTE);
}
