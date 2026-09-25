/**
 * Thin guarded access to ComfyUI settings and commands through
 * `app.extensionManager` (both present in the installed 1.52.7 bundle and
 * the 1.55 source, `src/stores/workspaceStore.ts`).
 */

import { app } from "@comfy/scripts/app.js";

/** ComfyUI's "Save Workflow" command (bound to Ctrl+S by default). */
export const SAVE_WORKFLOW_COMMAND = "Comfy.SaveWorkflow";

/**
 * Read a setting value.
 * @param id - Setting id.
 * @returns The stored value (or default), `undefined` if unavailable.
 */
export function readSetting(id: string): unknown {
  const setting = app.extensionManager?.setting;
  if (typeof setting?.get === "function") return setting.get(id);
  return app.ui?.settings?.getSettingValue?.(id);
}

/**
 * Run a frontend command by id.
 * @param id - Command id.
 * @returns Resolves when the command finished.
 * @throws If the command API is unavailable or the command failed.
 */
export async function executeCommand(id: string): Promise<void> {
  const command = app.extensionManager?.command;
  if (typeof command?.execute !== "function") throw new Error("command API unavailable");
  await command.execute(id);
}
