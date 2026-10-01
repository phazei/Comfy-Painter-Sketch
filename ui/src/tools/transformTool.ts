/**
 * Free Transform on the tool side (SPEC "Free Transform and flips"):
 *
 * - {@link TransformTool}: a hidden tool that receives ALL stage input while
 *   a session runs (`ToolRegistry.setSession`: it wins over the active tool,
 *   Ctrl and Alt) -- handle drags, hover cursors per zone, arrow nudges.
 *   It never becomes the active tool, so switching tools still commits the
 *   session through the float's settle hook. In a shape's session
 *   (`engine/shapeFloat.ts`) with a shape tool active, a press outside the
 *   box and rotate zone commits it and is handed to the shape tool, which
 *   draws the next shape in the same gesture. An Alt press outside the box
 *   with a tool that has `altEyedropper` runs the temporary eyedropper (the
 *   registry's Alt rule) without committing or cancelling the session.
 * - {@link TransformSessionOptions}: the options bar while transforming
 *   (X / Y = box centre in image px, W / H %, angle, proportion lock, Flip H /
 *   V, commit, cancel), replacing the tool's own options.
 * - {@link TransformButtons}: the Transform / Flip H / Flip V buttons appended
 *   to the Move tool's bar, and to the selection tools' bar while a
 *   selection exists.
 *
 * Grab sizes are in SCREEN px (view zoom x frame scale x graph zoom).
 */

import type { Editor } from "../engine/editor";
import { nudgeStep } from "../engine/translateMath";
import type { TransformField } from "../engine/transformOps";
import type { Point } from "../geometry/rect";
import type { OptionDescriptor, OptionValue, ToolOptions } from "./options";
import type { Tool, ToolCursor, ToolPointer } from "./types";

/** Tool id of the (hidden) transform tool. */
export const TRANSFORM_TOOL_ID = "transform";

/** Handle grab radius, screen px. */
const HANDLE_GRAB_PX = 8;
/** Rotate zone reach beyond a corner, screen px. */
const ROTATE_REACH_PX = 16;
/** Largest X / Y field value, image px. */
const OFFSET_LIMIT = 32768;

/** Arrow key -> unit direction. */
const ARROWS: Readonly<Record<string, readonly [number, number]>> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

/**
 * Document px per screen px at the current view (for screen-sized grab zones).
 * @param editor - Editor.
 * @returns Document px.
 */
export function docPerScreenPx(editor: Editor): number {
  const scale = editor.view.current.scale * editor.frameMap.scale * editor.view.graphScale;
  return scale > 0 ? 1 / scale : 1;
}

// ── Tool ──────────────────────────────────────────────────────────────────────

/**
 * Stage input during a Free Transform session.
 */
export class TransformTool implements Tool {
  readonly id = TRANSFORM_TOOL_ID;
  readonly label = "Free transform";
  readonly shortcut = "";
  readonly icon = "transform";
  readonly rail = false;
  readonly ctrlMove = false;
  readonly options: ToolOptions;
  private pressed = false;
  /** Active rail tool (set by the registry on every resolve). */
  private active: Tool | null = null;
  /** Temporary eyedropper for an Alt press outside the box (the registry's Alt rule), or `null`. */
  private altOutside: Tool | null = null;
  /** Tool the current press was handed to (shape after shape, Alt eyedropper). */
  private passed: Tool | null = null;

  /**
   * @param editor - Session editor (the options read its transform).
   */
  constructor(editor: Editor) {
    this.options = new TransformSessionOptions(editor);
  }

  /**
   * Remember the active rail tool (a shape tool continues a press outside a
   * shape session's box) and the registry's Alt substitute for it.
   * @param active - Active rail tool.
   * @param altOutside - Temporary eyedropper to run for an Alt press outside
   *   the box (`null` = Alt is not the eyedropper for `active`). Alt on a
   *   handle, inside the box or in the rotate zone keeps its transform meaning.
   * @returns This tool.
   */
  withActive(active: Tool, altOutside: Tool | null = null): this {
    this.active = active;
    this.altOutside = altOutside;
    return this;
  }

  /** @inheritdoc */
  onPointerDown(editor: Editor, samples: readonly ToolPointer[]): void {
    const first = samples[0];
    if (!first) return;
    this.passed = null;
    const t = editor.float.transform;
    const k = docPerScreenPx(editor);
    const hit = t.hit(first, HANDLE_GRAB_PX * k, ROTATE_REACH_PX * k);
    const next = this.active;
    if (hit.kind === "outside" && first.altKey && this.altOutside) {
      // Alt outside the box: the temporary eyedropper; the session stays open.
      this.passed = this.altOutside;
      this.altOutside.onPointerDown(editor, samples);
      return;
    }
    if (hit.kind === "outside" && next?.drawsShapes && editor.float.shape) {
      // Shape after shape: land this one, the press draws the next.
      t.commit();
      this.passed = next;
      next.onPointerDown(editor, samples);
      return;
    }
    this.pressed = t.beginDrag(hit, first);
  }

  /** @inheritdoc */
  onPointerMove(editor: Editor, samples: readonly ToolPointer[]): void {
    if (this.passed) {
      this.passed.onPointerMove(editor, samples);
      return;
    }
    const last = samples[samples.length - 1];
    if (this.pressed && last) editor.float.transform.dragTo(last, { shift: last.shiftKey, alt: last.altKey });
  }

  /** @inheritdoc */
  onPointerUp(editor: Editor, sample: ToolPointer): void {
    const passed = this.passed;
    this.passed = null;
    if (passed) {
      passed.onPointerUp(editor, sample);
      return;
    }
    if (!this.pressed) return;
    this.pressed = false;
    editor.float.transform.dragTo(sample, { shift: sample.shiftKey, alt: sample.altKey });
    editor.float.transform.endDrag();
    // Text session: a non-uniform drag asks to rasterize once the press has fully ended.
    if (editor.float.transform.pending) setTimeout(() => editor.float.transform.resolvePending(), 0);
  }

  /** @inheritdoc */
  onCancel(editor: Editor): void {
    const passed = this.passed;
    this.passed = null;
    if (passed) {
      passed.onCancel(editor);
      return;
    }
    if (!this.pressed) return;
    this.pressed = false;
    editor.float.transform.cancelDrag();
  }

  /** @inheritdoc */
  onKey(editor: Editor, event: KeyboardEvent): boolean {
    const dir = ARROWS[event.key];
    if (!dir) return false;
    const step = nudgeStep(event.shiftKey ? 10 : 1, editor.frameMap.scale);
    editor.float.transform.nudge(dir[0] * step, dir[1] * step);
    return true;
  }

  /** @inheritdoc */
  cursor(): ToolCursor {
    return { kind: "icon", icon: "move" };
  }

  /** @inheritdoc */
  cursorAt(editor: Editor, at: Point): ToolCursor {
    const t = editor.float.transform;
    const k = docPerScreenPx(editor);
    const hit = t.dragHit ?? t.hit(at, HANDLE_GRAB_PX * k, ROTATE_REACH_PX * k);
    switch (hit.kind) {
      case "move":
        return { kind: "icon", icon: "move" };
      case "scale":
        return { kind: "icon", icon: `resize-${t.resizeAxis(hit.handle)}` };
      case "rotate":
        return { kind: "icon", icon: "rotate" };
      case "outside":
        return this.altOutside && !t.dragHit ? this.altOutside.cursor() : { kind: "icon", icon: "crosshair" };
    }
  }
}

// ── Options while transforming ────────────────────────────────────────────────

const SESSION_DESCRIPTORS: readonly OptionDescriptor[] = [
  { kind: "number", key: "x", label: "X", title: "Box centre, image px (arrows nudge)", min: -OFFSET_LIMIT, max: OFFSET_LIMIT, step: 0.1, unit: "px", group: "pos" },
  { kind: "number", key: "y", label: "Y", title: "Box centre, image px (arrows nudge)", min: -OFFSET_LIMIT, max: OFFSET_LIMIT, step: 0.1, unit: "px", group: "pos" },
  { kind: "number", key: "w", label: "W", title: "Width scale", min: 1, max: 10000, step: 0.1, unit: "%", scale: 100, curve: "pow", group: "size" },
  { kind: "number", key: "h", label: "H", title: "Height scale", min: 1, max: 10000, step: 0.1, unit: "%", scale: 100, curve: "pow", group: "size" },
  { kind: "toggle", key: "lock", label: "Link", title: "Keep proportions (Shift while dragging a handle inverts)", group: "size" },
  { kind: "number", key: "angle", label: "Angle", title: "Rotation, degrees (Shift while rotating = 15 deg steps)", min: -180, max: 180, step: 0.1, unit: "\u00b0", group: "angle" },
  { kind: "button", key: "flipH", label: "Flip horizontal", icon: "flipH", group: "flip" },
  { kind: "button", key: "flipV", label: "Flip vertical", icon: "flipV", group: "flip" },
  { kind: "button", key: "commit", label: "Commit transform", title: "Commit transform (Enter)", icon: "check", group: "end" },
  { kind: "button", key: "cancel", label: "Cancel transform", title: "Cancel transform (Esc)", icon: "close", group: "end" },
];

const FIELDS: ReadonlySet<string> = new Set<TransformField>(["x", "y", "w", "h", "angle"]);

function isField(key: string): key is TransformField {
  return FIELDS.has(key);
}

/**
 * Options bar of a running session: live views of `Editor.float.transform`.
 */
export class TransformSessionOptions implements ToolOptions {
  readonly descriptors = SESSION_DESCRIPTORS;

  /**
   * @param editor - Session editor.
   */
  constructor(private readonly editor: Editor) {}

  /** @inheritdoc */
  get(key: string): OptionValue | undefined {
    const t = this.editor.float.transform;
    if (isField(key)) return t.field(key);
    if (key === "lock") return t.proportional;
    return SESSION_DESCRIPTORS.some((d) => d.key === key) ? true : undefined;
  }

  /** @inheritdoc */
  set(key: string, value: OptionValue): boolean {
    const t = this.editor.float.transform;
    if (isField(key)) return typeof value === "number" && t.setField(key, value);
    if (key === "lock") {
      if (typeof value !== "boolean" || value === t.proportional) return false;
      t.proportional = value;
      return true;
    }
    if (value !== true) return false;
    if (key === "flipH") return t.flip("h");
    if (key === "flipV") return t.flip("v");
    if (key === "commit") {
      t.commit();
      return true;
    }
    if (key !== "cancel") return false;
    t.cancel();
    return true;
  }

  /**
   * A field session ended: an unlinked text W / H change asks to rasterize,
   * deferred past the ending event.
   * @param key - Option key.
   */
  endEdit(key: string): void {
    const t = this.editor.float.transform;
    if (isField(key) && t.endField()) setTimeout(() => t.resolvePending(), 0);
  }
}

// ── Transform / flip buttons on other tools ───────────────────────────────────

const BUTTON_DESCRIPTORS: readonly OptionDescriptor[] = [
  { kind: "button", key: "transform", label: "Free transform", title: "Transform (Ctrl+Alt+T)", icon: "transform", group: "transform" },
  { kind: "button", key: "flipH", label: "Flip horizontal", icon: "flipH", group: "transform" },
  { kind: "button", key: "flipV", label: "Flip vertical", icon: "flipV", group: "transform" },
];

/**
 * A tool's options plus the Transform / Flip H / Flip V buttons.
 */
export class TransformButtons implements ToolOptions {
  readonly descriptors: readonly OptionDescriptor[];

  /**
   * @param editor - Session editor.
   * @param base - The tool's own options (or `null`).
   */
  constructor(
    private readonly editor: Editor,
    private readonly base: ToolOptions | null,
  ) {
    this.descriptors = [...(base?.descriptors ?? []), ...BUTTON_DESCRIPTORS];
  }

  /** Groups of the tool's own options. */
  get groups(): ToolOptions["groups"] {
    return this.base?.groups;
  }

  /** @inheritdoc */
  get(key: string): OptionValue | undefined {
    return BUTTON_DESCRIPTORS.some((d) => d.key === key) ? true : this.base?.get(key);
  }

  /** @inheritdoc */
  set(key: string, value: OptionValue): boolean {
    const t = this.editor.float.transform;
    if (key === "transform") return value === true && t.enter();
    if (key === "flipH" || key === "flipV") return value === true && t.flip(key === "flipH" ? "h" : "v");
    return this.base?.set(key, value) ?? false;
  }
}

// ── Registry hooks ────────────────────────────────────────────────────────────

/** What the tool registry needs to route input and the bar during sessions. */
export interface TransformSession {
  /** The tool that takes all stage input while {@link TransformSession.active} (pass it the active tool, {@link TransformTool.withActive}). */
  readonly tool: TransformTool;
  /** Whether a session runs. */
  active(): boolean;
  /**
   * Options for the bar: the session options, or the active tool's with the
   * transform buttons where they apply, else the tool's own.
   * @param active - Active tool.
   * @returns Options (stable objects, so the bar only rebuilds on real changes).
   */
  options(active: Tool): ToolOptions | null;
}

/**
 * Build the session hooks for an editor.
 * @param editor - Session editor.
 * @returns Hooks for `ToolRegistry.setSession`.
 */
export function createTransformSession(editor: Editor): TransformSession {
  const tool = new TransformTool(editor);
  const wrapped = new Map<string, TransformButtons>();
  const withButtons = (active: Tool): TransformButtons => {
    let options = wrapped.get(active.id);
    if (!options) {
      options = new TransformButtons(editor, active.options);
      wrapped.set(active.id, options);
    }
    return options;
  };
  return {
    tool,
    active: () => editor.float.transform.active,
    options: (active) => {
      if (editor.float.transform.active) return tool.options;
      const buttons = active.id === "move-layer" || (active.combinesSelection === true && editor.selection.active);
      return buttons ? withButtons(active) : active.options;
    },
  };
}
