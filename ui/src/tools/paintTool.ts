/**
 * Shared implementation of brush-like tools (brush, eraser): turns pointer
 * samples into spaced dabs (`engine/brush.ts`) and feeds them to the editor's
 * stroke buffer. Shift+click draws a straight segment from where the previous
 * stroke ended (Photoshop behavior), then continues as a normal stroke.
 *
 * `size` is in image px (what the user sees on the current background); it
 * is divided by the frame-map scale to get document px, so a 20 px brush
 * looks 20 px on any image size (decision 4). The paint colour is the
 * editor's foreground colour (`editor.colors.fg`).
 */

import { createSpacer, placeDabs, ringDiameter } from "../engine/brush";
import { imageLengthToDoc } from "../engine/frameMap";
import type { BrushDynamics, Dab, SpacerState, StrokeSample } from "../engine/brush";
import type { Editor } from "../engine/editor";
import type { StrokeMode } from "../engine/stroke";
import { OptionSet } from "./options";
import type { OptionDescriptor, OptionGroup } from "./options";
import type { PaintOptions, Tool, ToolCursor, ToolPointer } from "./types";

/** Options bar layout shared by brush-like tools (SPEC Tools table, Pressure). */
export const PAINT_OPTION_DESCRIPTORS: readonly OptionDescriptor[] = [
  { kind: "number", key: "size", label: "Size", title: "Brush size ([ / ])", min: 1, max: 1000, step: 1, unit: "px", curve: "pow" },
  { kind: "number", key: "hardness", label: "Hard", title: "Hardness (Shift+[ / ])", min: 0, max: 100, step: 1, unit: "%", scale: 100 },
  { kind: "number", key: "opacity", label: "Opac", title: "Opacity (1..9, 0)", min: 1, max: 100, step: 1, unit: "%", scale: 100 },
  { kind: "number", key: "flow", label: "Flow", title: "Flow (per-dab strength)", min: 1, max: 100, step: 1, unit: "%", scale: 100 },
  { kind: "number", key: "spacing", label: "Spc", title: "Spacing (% of diameter)", min: 1, max: 400, step: 1, unit: "%", scale: 100 },
  { kind: "toggle", key: "pressureSize", label: "Size", title: "Pen pressure controls size", group: "pressure" },
  { kind: "toggle", key: "pressureOpacity", label: "Opacity", title: "Pen pressure controls opacity", group: "pressure" },
  {
    kind: "number",
    key: "minSize",
    label: "Min size",
    title: "Size at zero pressure (% of size)",
    min: 0,
    max: 100,
    step: 1,
    unit: "%",
    scale: 100,
    group: "pressure",
    dependsOn: ["pressureSize"],
  },
  {
    kind: "number",
    key: "gamma",
    label: "Curve \u03b3",
    title: "Pressure curve (1 = linear, > 1 = softer start)",
    min: 0.2,
    max: 5,
    step: 0.05,
    group: "pressure",
    dependsOn: ["pressureSize", "pressureOpacity"],
  },
];

/** The pressure options live behind one stylus button in the bar. */
export const PAINT_OPTION_GROUPS: readonly OptionGroup[] = [
  { id: "pressure", icon: "stylus", title: "Pen pressure", activeWhen: ["pressureSize", "pressureOpacity"] },
];

/** Static description of a brush-like tool. */
export interface PaintToolSpec {
  id: string;
  label: string;
  shortcut: string;
  icon: string;
  mode: StrokeMode;
  defaults: PaintOptions;
  /** Alt = temporary eyedropper (brush yes; eraser no, like Photoshop). */
  altEyedropper?: boolean;
}

/**
 * A brush-like tool.
 */
export class PaintTool implements Tool {
  readonly id: string;
  readonly label: string;
  readonly shortcut: string;
  readonly icon: string;
  readonly options: OptionSet;
  readonly altEyedropper: boolean;
  /** Stored option values (edited in place through {@link options}). */
  readonly values: PaintOptions;
  private readonly mode: StrokeMode;
  private spacer: SpacerState | null = null;
  private last: ToolPointer | null = null;
  /** Distance travelled since the last dab when the previous stroke ended (a Shift-click line carries it on). */
  private residual = 0;
  /** Current stroke's full-pressure diameter in document px. */
  private docSize = 1;

  /**
   * @param spec - Id, label, shortcut, icon, mode and default options.
   */
  constructor(spec: PaintToolSpec) {
    this.id = spec.id;
    this.label = spec.label;
    this.shortcut = spec.shortcut;
    this.icon = spec.icon;
    this.mode = spec.mode;
    this.altEyedropper = spec.altEyedropper ?? false;
    this.values = { ...spec.defaults };
    this.options = new OptionSet(PAINT_OPTION_DESCRIPTORS, this.values, PAINT_OPTION_GROUPS);
  }

  /** @inheritdoc */
  onPointerDown(editor: Editor, samples: readonly ToolPointer[]): void {
    const first = samples[0];
    if (!first) return;
    const style = {
      mode: this.mode,
      opacity: this.values.opacity,
      hardness: this.values.hardness,
      color: editor.colors.fg,
    };
    // Size is fixed per stroke in doc px (the image may change size mid-stroke).
    this.docSize = imageLengthToDoc(editor.frameMap, this.values.size);
    const lineStart = first.shiftKey ? editor.lastStrokeEnd : null;
    if (!editor.beginStroke(style, this.docSize)) return;
    // A Shift-click line runs from where the last stroke ended, its dabs
    // starting where that stroke's spacing left off (no extra dab at the
    // joint). It is its own stroke and undo step, composited over the
    // previous one -- Photoshop's behaviour (one history state per click).
    this.spacer = lineStart
      ? createSpacer({ x: lineStart.x, y: lineStart.y, pressure: first.pressure }, this.residual)
      : createSpacer();
    this.feed(editor, samples);
  }

  /** @inheritdoc */
  onPointerMove(editor: Editor, samples: readonly ToolPointer[]): void {
    if (this.spacer) this.feed(editor, samples);
  }

  /** @inheritdoc */
  onPointerUp(editor: Editor, sample: ToolPointer): void {
    if (!this.spacer) return;
    this.feed(editor, [sample]);
    const end = this.last ? { x: this.last.x, y: this.last.y } : { x: sample.x, y: sample.y };
    this.residual = this.spacer.residual;
    this.spacer = null;
    this.last = null;
    editor.endStroke(end);
  }

  /** @inheritdoc */
  onCancel(editor: Editor): void {
    if (!this.spacer) return;
    this.spacer = null;
    this.last = null;
    editor.cancelStroke();
  }

  /** @inheritdoc -- like Photoshop's cursor, the ring shrinks with softness (`ringDiameter`). */
  cursor(): ToolCursor {
    return { kind: "ring", diameter: ringDiameter(this.values.size, this.values.hardness) };
  }

  private feed(editor: Editor, samples: readonly ToolPointer[]): void {
    const spacer = this.spacer;
    if (!spacer) return;
    const dyn = this.dynamics();
    const dabs: Dab[] = [];
    for (const s of samples) {
      const sample: StrokeSample = { x: s.x, y: s.y, pressure: s.pressure };
      dabs.push(...placeDabs(spacer, sample, dyn));
      this.last = s;
    }
    editor.addDabs(dabs);
  }

  /** Spacing is a fraction of the diameter, so it scales with `docSize` too. */
  private dynamics(): BrushDynamics {
    const v = this.values;
    return {
      size: this.docSize,
      flow: v.flow,
      spacing: v.spacing,
      pressureSize: v.pressureSize,
      pressureOpacity: v.pressureOpacity,
      minSizeRatio: v.minSize,
      gamma: v.gamma,
    };
  }
}
