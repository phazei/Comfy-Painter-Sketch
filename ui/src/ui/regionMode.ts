/**
 * Region mode = the Outputs tab (M9, pure rules). Opening the Outputs tab
 * activates the hidden region tool; choosing any other tool shows the Layers
 * tab; leaving the Outputs tab returns to the last rail tool.
 */

import { REGION_TOOL_ID } from "../tools/region";

/** Side panel tab ids. */
export const LAYERS_TAB = "layers";
export const OUTPUTS_TAB = "outputs";

/**
 * Tab that matches the active tool.
 * @param toolId - Active tool id.
 * @returns `outputs` for the region tool, else `layers`.
 */
export function tabForTool(toolId: string): string {
  return toolId === REGION_TOOL_ID ? OUTPUTS_TAB : LAYERS_TAB;
}

/**
 * Tool to activate after the visible tab changed.
 * @param tab - Newly visible tab.
 * @param activeId - Active tool id.
 * @param lastRailId - Last active rail tool (fallback when leaving region mode).
 * @returns Tool id to activate, or null to keep the active tool.
 */
export function toolForTab(tab: string, activeId: string, lastRailId: string): string | null {
  if (tab === OUTPUTS_TAB) return activeId === REGION_TOOL_ID ? null : REGION_TOOL_ID;
  return activeId === REGION_TOOL_ID ? lastRailId : null;
}
