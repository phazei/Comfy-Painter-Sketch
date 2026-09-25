/**
 * Tool registry: the set of tools for one editor session and which is active.
 */

import { Emitter } from "../engine/emitter";
import { createBrushTool } from "./brush";
import { createEraserTool } from "./eraser";
import { createEyedropperTool } from "./eyedropper";
import { createFillTool } from "./fill";
import { SHAPE_GROUP, createShapeTools } from "./shapeTools";
import { ToolGroupState } from "./toolGroups";
import type { ToolGroupSpec } from "./toolGroups";
import type { Tool } from "./types";

/** Registry events. */
export interface ToolRegistryEvents {
  [key: string]: unknown;
  /** Active tool or its options changed. */
  change: undefined;
}

/**
 * Tools keyed by id, with one active tool.
 */
export class ToolRegistry {
  readonly events = new Emitter<ToolRegistryEvents>();
  private readonly tools = new Map<string, Tool>();
  private activeId: string;

  /**
   * @param tools - Tools in rail order; the first becomes active.
   */
  constructor(tools: readonly Tool[], groups: readonly ToolGroupSpec[] = []) {
    for (const tool of tools) this.tools.set(tool.id, tool);
    this.activeId = tools[0]?.id ?? "";
    this.groups = new ToolGroupState(groups);
  }

  /** Tool groups sharing one rail slot + key (last-used tool per group). */
  readonly groups: ToolGroupState;

  /**
   * Shift+key: the next tool of the group bound to `key` (cycles).
   * @param key - Lowercase key.
   * @returns The tool, or `undefined` if `key` is not a group key.
   */
  cycleShortcut(key: string): Tool | undefined {
    const tool = [...this.tools.values()].find((t) => t.shortcut === key);
    const group = tool ? this.groups.groupOf(tool.id) : undefined;
    const next = group ? this.groups.next(group.id, this.activeId) : undefined;
    return next ? this.tools.get(next) : undefined;
  }

  /** Active tool. */
  get active(): Tool {
    const tool = this.tools.get(this.activeId);
    if (!tool) throw new Error("ToolRegistry has no tools");
    return tool;
  }

  /** All tools in registration order. */
  list(): Tool[] {
    return [...this.tools.values()];
  }

  /**
   * Tool by id.
   * @param id - Tool id.
   * @returns The tool or `undefined`.
   */
  get(id: string): Tool | undefined {
    return this.tools.get(id);
  }

  /**
   * Tool bound to a single-key shortcut.
   * @param key - Lowercase key.
   * @returns The tool or `undefined`.
   */
  byShortcut(key: string): Tool | undefined {
    for (const tool of this.tools.values()) {
      if (tool.shortcut !== key) continue;
      // Group keys pick the group's last-used tool.
      const group = this.groups.groupOf(tool.id);
      return (group && this.tools.get(this.groups.currentOf(group.id) ?? "")) || tool;
    }
    return undefined;
  }

  /**
   * Activate a tool.
   * @param id - Tool id.
   */
  setActive(id: string): void {
    if (!this.tools.has(id) || id === this.activeId) return;
    this.activeId = id;
    this.groups.noteActive(id);
    this.events.emit("change", undefined);
  }

  /** Notify that the active tool's options changed. */
  notifyOptions(): void {
    this.events.emit("change", undefined);
  }

  // ── Alt = temporary eyedropper ──────────────────────────────────────────

  private altTool: Tool | null = null;

  /**
   * Tool that takes over while Alt is held in tools with `altEyedropper`.
   * @param tool - Usually `EyedropperTool.temporary`; `null` disables.
   */
  setAltTool(tool: Tool | null): void {
    this.altTool = tool;
  }

  /**
   * Tool that should receive stage input / draw the cursor right now: the
   * Alt tool while Alt is held and the active tool opts in
   * (`Tool.altEyedropper`), else the active tool.
   * @param altHeld - Alt is down.
   * @returns The effective tool.
   */
  resolve(altHeld: boolean): Tool {
    const active = this.active;
    return altHeld && active.altEyedropper && this.altTool ? this.altTool : active;
  }
}

/**
 * The M1 tool set: brush and eraser.
 * @returns New registry.
 */
export function createDefaultTools(): ToolRegistry {
  const eyedropper = createEyedropperTool();
  const registry = new ToolRegistry(
    [createBrushTool(), createEraserTool(), createFillTool(), eyedropper, ...createShapeTools()],
    [SHAPE_GROUP],
  );
  registry.setAltTool(eyedropper.temporary);
  return registry;
}
