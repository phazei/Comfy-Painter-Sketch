/**
 * Paint bucket tool (G): click to flood fill the paint target (Quick Mask
 * aware) with the foreground colour at the tool opacity. The fill itself is
 * `Editor.pixelOps.fill` (pure scanline fill in `engine/floodFill.ts`).
 * Alt held = temporary eyedropper (`altEyedropper`).
 */

import type { Editor } from "../engine/editor";
import type { SampleSource } from "../engine/pixelOps";
import { OptionSet } from "./options";
import type { OptionDescriptor } from "./options";
import type { Tool, ToolCursor, ToolPointer } from "./types";

/** Stored options of the paint bucket. */
export type FillOptions = {
  /** 0-255 per-channel tolerance (Photoshop default 32). */
  tolerance: number;
  /** 0..1 */
  opacity: number;
  contiguous: boolean;
  antiAlias: boolean;
  sample: SampleSource;
};

/** Sample-source choices shared by the bucket and eyedropper. */
export const SAMPLE_CHOICES = [
  { value: "layer", label: "Current layer" },
  { value: "all", label: "All layers" },
] as const;

const DESCRIPTORS: readonly OptionDescriptor[] = [
  { kind: "number", key: "tolerance", label: "Tol", title: "Tolerance (0-255 per channel)", min: 0, max: 255, step: 1 },
  { kind: "number", key: "opacity", label: "Opac", title: "Opacity (1..9, 0)", min: 1, max: 100, step: 1, unit: "%", scale: 100 },
  { kind: "toggle", key: "contiguous", label: "Contiguous", title: "Only fill connected pixels", group: "mode" },
  { kind: "toggle", key: "antiAlias", label: "Anti-alias", title: "Soften the fill edge", group: "mode" },
  { kind: "select", key: "sample", label: "Sample", title: "Pixels the fill looks at", choices: SAMPLE_CHOICES, group: "sample" },
];

/**
 * The paint bucket.
 */
export class FillTool implements Tool {
  readonly id = "bucket";
  readonly label = "Paint bucket";
  readonly shortcut = "g";
  readonly icon = "bucket";
  readonly altEyedropper = true;
  readonly values: FillOptions = { tolerance: 32, opacity: 1, contiguous: true, antiAlias: true, sample: "all" };
  readonly options = new OptionSet(DESCRIPTORS, this.values);

  /** @inheritdoc */
  onPointerDown(editor: Editor, samples: readonly ToolPointer[]): void {
    const first = samples[0];
    if (!first) return;
    const v = this.values;
    editor.pixelOps.fill({
      point: { x: first.x, y: first.y },
      tolerance: v.tolerance,
      contiguous: v.contiguous,
      antiAlias: v.antiAlias,
      sample: v.sample,
      opacity: v.opacity,
      color: editor.colors.fg,
    });
  }

  /** @inheritdoc */
  onPointerMove(): void {}

  /** @inheritdoc */
  onPointerUp(): void {}

  /** @inheritdoc */
  onCancel(): void {}

  /** @inheritdoc */
  cursor(): ToolCursor {
    return { kind: "icon", icon: "bucket" };
  }
}

/**
 * Create a paint bucket with default options.
 * @returns The tool.
 */
export function createFillTool(): FillTool {
  return new FillTool();
}
