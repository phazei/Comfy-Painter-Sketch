/**
 * Shared implementation of brush-like tools (brush, eraser): turns pointer
 * samples into spaced dabs (`engine/brush.ts`) and feeds them to the editor's
 * stroke buffer. Shift+click draws a straight segment from where the previous
 * stroke ended (Photoshop behavior), then continues as a normal stroke.
 *
 * `options.size` is in image px (what the user sees on the current
 * background); it is divided by the frame-map scale to get document px, so a
 * 20 px brush looks 20 px on any image size (decision 4).
 */

import { createSpacer, placeDabs } from "../engine/brush";
import { imageLengthToDoc } from "../engine/frameMap";
import type { BrushDynamics, Dab, SpacerState, StrokeSample } from "../engine/brush";
import type { Editor } from "../engine/editor";
import type { StrokeMode } from "../engine/stroke";
import type { PaintOptions, Tool, ToolCursor, ToolPointer } from "./types";

/** Pressure curve used until M7 exposes settings. */
const PRESSURE_CURVE = { minSizeRatio: 0.1, gamma: 1 };

/**
 * A brush-like tool.
 */
export class PaintTool implements Tool {
  readonly options: PaintOptions;
  private spacer: SpacerState | null = null;
  private last: ToolPointer | null = null;
  /** Current stroke's full-pressure diameter in document px. */
  private docSize = 1;

  /**
   * @param id - Tool id.
   * @param label - Display label.
   * @param shortcut - Single-key shortcut.
   * @param mode - Paint or erase.
   * @param defaults - Initial options.
   */
  constructor(
    readonly id: string,
    readonly label: string,
    readonly shortcut: string,
    private readonly mode: StrokeMode,
    defaults: PaintOptions,
  ) {
    this.options = { ...defaults };
  }

  /** @inheritdoc */
  onPointerDown(editor: Editor, samples: readonly ToolPointer[]): void {
    const first = samples[0];
    if (!first) return;
    const style = {
      mode: this.mode,
      opacity: this.options.opacity,
      hardness: this.options.hardness,
      color: this.options.color ?? "#000000",
    };
    // Size is fixed per stroke in doc px (the image may change size mid-stroke).
    this.docSize = imageLengthToDoc(editor.frameMap, this.options.size);
    if (!editor.beginStroke(style, this.docSize)) return;
    this.spacer = createSpacer();
    const lineStart = first.shiftKey ? editor.lastStrokeEnd : null;
    if (lineStart) this.feed(editor, [{ ...first, x: lineStart.x, y: lineStart.y }]);
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

  /** @inheritdoc */
  cursor(): ToolCursor {
    return { kind: "ring", diameter: this.options.size };
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
    return {
      size: this.docSize,
      flow: this.options.flow,
      spacing: this.options.spacing,
      pressureSize: this.options.pressureSize,
      pressureOpacity: this.options.pressureOpacity,
      ...PRESSURE_CURVE,
    };
  }
}
