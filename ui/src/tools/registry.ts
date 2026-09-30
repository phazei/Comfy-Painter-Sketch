/**
 * Tool registry: the set of tools for one editor session and which is active.
 */

import { PRESSURE_DEFAULTS } from "../defaults/pressureDefaults";
import type { PressureDefaults } from "../defaults/pressureDefaults";
import { SAMPLE_DEFAULTS } from "../defaults/sampleDefaults";
import type { SampleDefaults } from "../defaults/sampleDefaults";
import type { Editor } from "../engine/editor";
import { Emitter } from "../engine/emitter";
import { createBrushTool } from "./brush";
import { createEraserTool } from "./eraser";
import { createEyedropperTool } from "./eyedropper";
import { createFillTool } from "./fill";
import { createLassoTool } from "./lasso";
import { createMagicWandTool } from "./magicWand";
import { MARQUEE_GROUP, createMarqueeTools } from "./marquee";
import { createMoveTool } from "./move";
import { createMoveLayerTool } from "./moveLayer";
import { SHAPE_GROUP, createShapeTools } from "./shapeTools";
import { layerMaskBarDecorator } from "./layerMaskBar";
import { createTextTool } from "./text";
import { createRegionTool } from "./region";
import { OutlineDragTool } from "./outlineDrag";
import { ToolGroupState } from "./toolGroups";
import type { ToolOptions } from "./options";
import { createTransformSession } from "./transformTool";
import type { TransformSession } from "./transformTool";
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

  /** Rail tools (tools with `rail !== false`), in registration order. */
  railTools(): Tool[] {
    return [...this.tools.values()].filter((t) => t.rail !== false);
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
      if (tool.rail === false || !tool.shortcut) continue;
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
    this.beforeSwitch?.();
    this.activeId = id;
    this.groups.noteActive(id);
    this.events.emit("change", undefined);
  }

  /** Notify that the active tool's options changed. */
  notifyOptions(): void {
    this.events.emit("change", undefined);
  }

  /** Runs before the active tool changes (commits a floating selection). */
  private beforeSwitch: (() => void) | null = null;

  /**
   * Hook run before every tool switch.
   * @param hook - Callback, or `null`.
   */
  setBeforeSwitch(hook: (() => void) | null): void {
    this.beforeSwitch = hook;
  }

  // ── Free Transform session ──────────────────────────────────────────────

  private session: TransformSession | null = null;

  /**
   * Free Transform hooks: while a session runs its tool takes all stage
   * input and keys ({@link resolve}) and its options fill the bar.
   * @param session - Hooks (`transformTool.ts`), or `null`.
   */
  setSession(session: TransformSession | null): void {
    this.session = session;
  }

  /**
   * Options the bar shows now: the transform session's, the active tool's
   * with the Transform / Flip buttons, or the active tool's own.
   * @returns Options, or `null`.
   */
  barOptions(): ToolOptions | null {
    const options = this.session ? this.session.options(this.active) : this.active.options;
    return this.barDecorator ? this.barDecorator(options, this.active) : options;
  }

  /** Adds context controls to the bar (M14 layer mask controls), or `null`. */
  private barDecorator: ((options: ToolOptions | null, active: Tool) => ToolOptions | null) | null = null;

  /**
   * Install a bar decorator ({@link barOptions} passes its result through it).
   * @param decorator - Returns the options to show (stable objects), or `null` to remove.
   */
  setBarDecorator(decorator: ((options: ToolOptions | null, active: Tool) => ToolOptions | null) | null): void {
    this.barDecorator = decorator;
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

  // ── Ctrl = temporary layer Move ─────────────────────────────────────────

  private ctrlTool: Tool | null = null;
  private readonly outlineTool = new OutlineDragTool();

  /**
   * Tool that takes over while Ctrl is held in tools that opt in (`Tool.ctrlMove`).
   * @param tool - Usually the layer Move tool; `null` disables.
   */
  setCtrlTool(tool: Tool | null): void {
    this.ctrlTool = tool;
  }

  /**
   * Tool that should receive stage input / draw the cursor right now.
   * Precedence: Ctrl first -- the Ctrl tool (layer Move) while Ctrl is held
   * and the active tool opts in ({@link ctrlMoves}); then Alt -- the Alt
   * tool (eyedropper) while Alt is held and the active tool has
   * `Tool.altEyedropper`; else the active tool. So Ctrl+Alt in the brush
   * is Move, not the eyedropper.
   * With no modifier at all, a press inside the selection with a selection
   * tool drags only the outline ({@link OutlineDragTool}).
   * @param altHeld - Alt is down.
   * @param ctrlHeld - Ctrl (or Cmd) is down.
   * @param press - Pointer-down facts: Shift held, press inside the selection.
   * @returns The effective tool.
   */
  resolve(altHeld: boolean, ctrlHeld = false, press?: { shift: boolean; inSelection: boolean }): Tool {
    if (this.session?.active()) return this.session.tool;
    const active = this.active;
    if (press?.inSelection && !press.shift && !altHeld && !ctrlHeld && active.combinesSelection && !(active.pending?.() ?? false)) {
      return this.outlineTool.wrap(active);
    }
    if (ctrlHeld && this.ctrlTool && this.ctrlTool !== active && ctrlMoves(active)) return this.ctrlTool;
    return altHeld && active.altEyedropper && this.altTool ? this.altTool : active;
  }
}

/**
 * Whether Ctrl turns a tool into the temporary layer Move tool: rail tools
 * unless they opt out (`ctrlMove: false`), and never while the tool has a
 * pending multi-press interaction (polygonal lasso).
 * @param tool - Active tool.
 * @returns `true` if Ctrl substitutes the Move tool.
 */
export function ctrlMoves(tool: Tool): boolean {
  return tool.rail !== false && tool.ctrlMove !== false && !(tool.pending?.() ?? false);
}

/**
 * The session tool set (brush first = default active).
 * @param editor - Session editor (the Move tool's options read its placement).
 * @param pressure - Initial brush/eraser pressure options (built-in by default).
 * @param samples - Initial bucket/wand sample sources (built-in by default).
 * @returns New registry.
 */
export function createDefaultTools(
  editor: Editor,
  pressure: Readonly<PressureDefaults> = PRESSURE_DEFAULTS,
  samples: Readonly<SampleDefaults> = SAMPLE_DEFAULTS,
): ToolRegistry {
  const eyedropper = createEyedropperTool();
  const moveLayer = createMoveLayerTool();
  const registry = new ToolRegistry(
    [
      createBrushTool(pressure),
      createEraserTool(pressure),
      createFillTool(samples.bucket),
      eyedropper,
      ...createShapeTools(),
      createTextTool(editor),
      createMoveTool(editor),
      // Photoshop order: Move, then the selection tools.
      moveLayer,
      ...createMarqueeTools(),
      createLassoTool(),
      createMagicWandTool(samples.wand),
      createRegionTool(),
    ],
    [SHAPE_GROUP, MARQUEE_GROUP],
  );
  registry.setAltTool(eyedropper.temporary);
  registry.setCtrlTool(moveLayer);
  registry.setBeforeSwitch(() => editor.settle());
  registry.setSession(createTransformSession(editor));
  registry.setBarDecorator(layerMaskBarDecorator(editor));
  return registry;
}
