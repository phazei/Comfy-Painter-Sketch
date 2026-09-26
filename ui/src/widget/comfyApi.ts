/**
 * Thin guarded access to ComfyUI settings and commands through
 * `app.extensionManager` (both present in the installed 1.52.7 bundle and
 * the 1.55 source, `src/stores/workspaceStore.ts`).
 */

import { app } from "@comfy/scripts/app.js";

import { log } from "../log";

/** ComfyUI's "Save Workflow" command (bound to Ctrl+S by default). */
export const SAVE_WORKFLOW_COMMAND = "Comfy.SaveWorkflow";

/** Setting ids whose read failure was already logged. */
const settingFailures = new Set<string>();

/**
 * Read a setting value.
 * @param id - Setting id.
 * @returns The stored value (or default), `undefined` if unavailable.
 */
export function readSetting(id: string): unknown {
  // Callers normalize `undefined` to their default. A throwing settings
  // store (not ready yet / frontend change) must not break uploads or
  // editor creation, so it is logged once per id and treated as unset.
  try {
    const setting = app.extensionManager?.setting;
    if (typeof setting?.get === "function") return setting.get(id);
    return app.ui?.settings?.getSettingValue?.(id);
  } catch (error) {
    if (!settingFailures.has(id)) log.warn(`could not read setting ${id}; using its default:`, error);
    settingFailures.add(id);
    return undefined;
  }
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
