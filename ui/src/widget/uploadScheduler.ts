/**
 * Upload timing for an attached session (SPEC "Upload timing") and the
 * matching ChangeTracker captures (`graphSync.ts`).
 *
 * Dirty layers upload when the editor disengages or leaves fullscreen, when
 * the session detaches (both wired by `controller.ts`), ~5 s after the last
 * edit (idle fallback, {@link bindSessionUploads}), at queue
 * ({@link flushForQueue}) and on Ctrl/Cmd+S ({@link WorkflowSaver}: flush,
 * then ComfyUI's `Comfy.SaveWorkflow`).
 */

import { HIDDEN_MASK_NOTE } from "../engine/editor";
import type { LGraphNode } from "../types/comfy";
import { executeCommand, SAVE_WORKFLOW_COMMAND } from "./comfyApi";
import { EDIT_SYNC_DELAY_MS, requestGraphSync, UPLOAD_SYNC_DELAY_MS } from "./graphSync";
import type { EditorSession } from "./sessions";
import { notify } from "./toast";

/**
 * Keep the widget value and upload schedule in step with a session's edits.
 * Edits sync the value and request a (debounced) ChangeTracker capture;
 * during an upload batch the settled hook captures once at the end.
 *
 * @param node - Node showing the session.
 * @param session - Attached session.
 * @param syncValue - Updates the widget value; returns `true` if it changed.
 * @returns Unbind function.
 */
export function bindSessionUploads(node: LGraphNode, session: EditorSession, syncValue: () => boolean): () => void {
  const { editor } = session;
  const offChange = editor.events.on("change", () => {
    // During an upload batch the settled hook below syncs once at the end.
    if (syncValue() && !session.uploader.busy) requestGraphSync(node, EDIT_SYNC_DELAY_MS);
    if (editor.dirty) session.uploader.schedule();
  });
  const offSettled = session.uploader.onSettled(() => requestGraphSync(node, UPLOAD_SYNC_DELAY_MS));
  return () => {
    offChange();
    offSettled();
  };
}

/**
 * Queue-time flush (decision 8): wait for restore, upload dirty layers, and
 * note a hidden mask that still affects the output.
 *
 * @param session - Attached session.
 * @returns Resolves when the widget value references the uploaded files.
 * @throws If an upload failed (the toast has been shown).
 */
export async function flushForQueue(session: EditorSession): Promise<void> {
  await session.ready;
  await session.uploader.flush();
  if (session.editor.hiddenMaskHasContent()) {
    session.editor.events.emit("note", HIDDEN_MASK_NOTE);
  }
}

/**
 * Ctrl/Cmd+S in the editor: upload dirty layers, then run ComfyUI's save
 * command so the saved workflow references the new files (the widget value
 * is updated by the upload's `change` event before the save serializes).
 * If an upload failed (already toasted), ask before saving the workflow
 * without the latest paint; the pixels stay in memory either way.
 */
export class WorkflowSaver {
  /** A flush + save is in progress. */
  private saving = false;

  /**
   * @param session - Session to flush first, if any.
   * @returns Resolves when done (errors are toasted, never thrown).
   */
  async save(session: EditorSession | null): Promise<void> {
    if (this.saving) return;
    this.saving = true;
    try {
      if (session) {
        try {
          await session.ready;
          await session.uploader.flush();
        } catch {
          if (!window.confirm("Upload failed; save anyway without the latest paint?")) return;
        }
      }
      await executeCommand(SAVE_WORKFLOW_COMMAND);
    } catch (error) {
      notify("error", `Could not save the workflow: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.saving = false;
    }
  }
}
