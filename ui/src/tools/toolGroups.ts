/**
 * Photoshop-style tool groups: several tools share one rail slot and one
 * shortcut key. The key selects the group's last-used tool; Shift+key
 * cycles through the group (e.g. shapes: U / Shift+U; M5 marquees: M /
 * Shift+M). Member tools all declare the group's key as their `shortcut`.
 * Pure state, no DOM (the rail slot + flyout is `ui/toolGroupSlot.ts`).
 */

/** Static description of a group. */
export interface ToolGroupSpec {
  id: string;
  /** Slot label, e.g. `"Shape"` (tooltip: `"Shape (U, Shift+U cycles)"`). */
  label: string;
  /** Member tool ids in cycle / flyout order (at least one). */
  toolIds: readonly string[];
}

/** Read access used by the rail. */
export interface ToolGroupView {
  /** Groups in registration order. */
  readonly specs: readonly ToolGroupSpec[];
  /**
   * Group containing a tool.
   * @param toolId - Tool id.
   * @returns The group or `undefined`.
   */
  groupOf(toolId: string): ToolGroupSpec | undefined;
  /**
   * The group's last-used tool (initially its first member).
   * @param groupId - Group id.
   * @returns Tool id or `undefined` for unknown groups.
   */
  currentOf(groupId: string): string | undefined;
}

/**
 * Last-used tool per group.
 */
export class ToolGroupState implements ToolGroupView {
  readonly specs: readonly ToolGroupSpec[];
  private readonly current = new Map<string, string>();
  private readonly byTool = new Map<string, ToolGroupSpec>();

  /**
   * @param specs - Groups (empty groups are ignored).
   */
  constructor(specs: readonly ToolGroupSpec[] = []) {
    this.specs = specs.filter((g) => g.toolIds.length > 0);
    for (const group of this.specs) {
      this.current.set(group.id, group.toolIds[0] ?? "");
      for (const id of group.toolIds) this.byTool.set(id, group);
    }
  }

  /** @inheritdoc */
  groupOf(toolId: string): ToolGroupSpec | undefined {
    return this.byTool.get(toolId);
  }

  /** @inheritdoc */
  currentOf(groupId: string): string | undefined {
    return this.current.get(groupId);
  }

  /**
   * Record that a tool became active (it becomes its group's current tool).
   * @param toolId - Tool id.
   */
  noteActive(toolId: string): void {
    const group = this.byTool.get(toolId);
    if (group) this.current.set(group.id, toolId);
  }

  /**
   * Tool Shift+key switches to: the member after the active tool when the
   * active tool is in the group, else the member after the group's current
   * tool (Shift+key always advances, wrapping).
   * @param groupId - Group id.
   * @param activeId - Currently active tool id.
   * @returns Next tool id, or `undefined` for unknown groups.
   */
  next(groupId: string, activeId: string): string | undefined {
    const group = this.specs.find((g) => g.id === groupId);
    if (!group) return undefined;
    const from = group.toolIds.includes(activeId) ? activeId : (this.current.get(groupId) ?? "");
    const index = group.toolIds.indexOf(from);
    return group.toolIds[(index + 1) % group.toolIds.length];
  }
}
