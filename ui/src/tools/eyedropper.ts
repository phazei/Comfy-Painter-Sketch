/**
 * Eyedropper tool (I): click or drag to sample a colour into the foreground;
 * Alt+click with the eyedropper itself samples into the background
 * (Photoshop). Samples the active paint layer, everything visible
 * (background included; the default) or only the background, as a point
 * or a 3x3 / 5x5 average. A fully
 * transparent sample leaves the colour unchanged. Quick Mask does not
 * matter: it always picks colours.
 *
 * While dragging, {@link EyedropperTool.overlay} describes a loupe ring
 * (sampled colour on top, the colour before the drag below).
 *
 * The same tool also serves as the temporary Alt eyedropper of tools with
 * `altEyedropper` ({@link EyedropperTool.temporary}: shares the options,
 * always writes the foreground, since Alt is what engaged it).
 */

import type { ColorSlot } from "../engine/colors";
import type { Editor } from "../engine/editor";
import type { SampleSource } from "../engine/pixelOps";
import { SAMPLE_CHOICES } from "./fill";
import { OptionSet } from "./options";
import type { OptionDescriptor } from "./options";
import type { Tool, ToolCursor, ToolOverlay, ToolPointer } from "./types";

/** Stored options of the eyedropper. */
export type EyedropperOptions = {
  sample: SampleSource;
  /** Sample window side: `"1"` (point), `"3"`, `"5"`. */
  size: string;
};

const DESCRIPTORS: readonly OptionDescriptor[] = [
  { kind: "select", key: "sample", label: "Sample", title: "Pixels to pick from", choices: SAMPLE_CHOICES },
  {
    kind: "select",
    key: "size",
    label: "Size",
    title: "Sample size",
    choices: [
      { value: "1", label: "Point" },
      { value: "3", label: "3x3 average" },
      { value: "5", label: "5x5 average" },
    ],
  },
];

/** Drag state. */
interface Picking {
  slot: ColorSlot;
  /** Slot colour when the drag started. */
  previous: string;
  /** Latest sampled colour (or `previous`). */
  color: string;
}

/**
 * The eyedropper.
 */
export class EyedropperTool implements Tool {
  readonly id = "eyedropper";
  readonly label = "Eyedropper";
  readonly shortcut = "i";
  readonly icon = "eyedropper";
  readonly options: OptionSet;
  private picking: Picking | null = null;
  private temp: EyedropperTool | null = null;

  /**
   * @param values - Stored options (shared with the temporary variant).
   * @param isTemporary - Alt-engaged from another tool: always the foreground.
   */
  constructor(
    readonly values: EyedropperOptions = { sample: "all", size: "1" },
    private readonly isTemporary = false,
  ) {
    this.options = new OptionSet(DESCRIPTORS, this.values);
  }

  /** Variant used while Alt is held in brush/bucket/shape tools (same options). */
  get temporary(): EyedropperTool {
    this.temp ??= new EyedropperTool(this.values, true);
    return this.temp;
  }

  /** @inheritdoc */
  onPointerDown(editor: Editor, samples: readonly ToolPointer[]): void {
    const first = samples[0];
    if (!first) return;
    const slot: ColorSlot = first.altKey && !this.isTemporary ? "bg" : "fg";
    const previous = editor.colors[slot];
    this.picking = { slot, previous, color: previous };
    this.pick(editor, first);
  }

  /** @inheritdoc */
  onPointerMove(editor: Editor, samples: readonly ToolPointer[]): void {
    const last = samples[samples.length - 1];
    if (last && this.picking) this.pick(editor, last);
  }

  /** @inheritdoc */
  onPointerUp(editor: Editor, sample: ToolPointer): void {
    if (!this.picking) return;
    this.pick(editor, sample);
    this.picking = null;
  }

  /** @inheritdoc */
  onCancel(): void {
    this.picking = null;
  }

  /** @inheritdoc */
  cursor(): ToolCursor {
    return { kind: "icon", icon: "eyedropper" };
  }

  /** @inheritdoc */
  overlay(): ToolOverlay | null {
    const p = this.picking;
    return p ? { kind: "loupe", color: p.color, previous: p.previous } : null;
  }

  private pick(editor: Editor, at: ToolPointer): void {
    const p = this.picking;
    if (!p) return;
    const hex = editor.pixelOps.sampleColor({ x: at.x, y: at.y }, this.values.sample, Number(this.values.size) || 1);
    if (!hex) return;
    p.color = hex;
    editor.colors.set(p.slot, hex);
  }
}

/**
 * Create an eyedropper with default options (all layers, point sample --
 * picks what you see, background included).
 * @returns The tool.
 */
export function createEyedropperTool(): EyedropperTool {
  return new EyedropperTool();
}
