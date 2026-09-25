/**
 * Tool registry: the set of tools for one editor session and which is active.
 */

import { Emitter } from "../engine/emitter";
import { createBrushTool } from "./brush";
import { createEraserTool } from "./eraser";
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
  constructor(tools: readonly Tool[]) {
    for (const tool of tools) this.tools.set(tool.id, tool);
    this.activeId = tools[0]?.id ?? "";
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
    for (const tool of this.tools.values()) if (tool.shortcut === key) return tool;
    return undefined;
  }

  /**
   * Activate a tool.
   * @param id - Tool id.
   */
  setActive(id: string): void {
    if (!this.tools.has(id) || id === this.activeId) return;
    this.activeId = id;
    this.events.emit("change", undefined);
  }

  /** Notify that the active tool's options changed. */
  notifyOptions(): void {
    this.events.emit("change", undefined);
  }
}

/**
 * The M1 tool set: brush and eraser.
 * @returns New registry.
 */
export function createDefaultTools(): ToolRegistry {
  return new ToolRegistry([createBrushTool(), createEraserTool()]);
}
