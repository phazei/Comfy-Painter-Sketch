/**
 * Magic wand (W, SPEC Tools table + "Selection"): click selects the pixels
 * matching the colour under the pointer -- the paint bucket's flood fill and
 * sampling (`Editor.pixelOps.wandSelection`, `engine/wand.ts`) turned into
 * a selection. Options mirror the bucket (Photoshop defaults: tolerance 32,
 * contiguous, anti-alias; sample defaults to the background). The modifiers at pointer-down pick
 * the mode (`selectionModifiers.ts`: Shift add, Alt subtract, Shift+Alt
 * intersect); Alt is never the eyedropper. One `selection` history entry.
 */

import type { Editor } from "../engine/editor";
import type { SampleSource } from "../engine/pixelOps";
import { SAMPLE_CHOICES } from "./fill";
import { OptionSet } from "./options";
import type { OptionDescriptor } from "./options";
import { SelectionModifiers } from "./selectionModifiers";
import type { Tool, ToolCursor, ToolPointer } from "./types";

/** Stored options of the magic wand. */
export type WandToolOptions = {
  /** 0-255 per-channel tolerance (Photoshop default 32). */
  tolerance: number;
  contiguous: boolean;
  antiAlias: boolean;
  sample: SampleSource;
};

const DESCRIPTORS: readonly OptionDescriptor[] = [
  { kind: "number", key: "tolerance", label: "Tol", title: "Tolerance (0-255 per channel)", min: 0, max: 255, step: 1 },
  { kind: "toggle", key: "contiguous", label: "Contiguous", title: "Only select connected pixels", group: "mode" },
  { kind: "toggle", key: "antiAlias", label: "Anti-alias", title: "Soften the selection edge", group: "mode" },
  { kind: "select", key: "sample", label: "Sample", title: "Pixels the wand looks at", choices: SAMPLE_CHOICES, group: "sample" },
];

/**
 * The magic wand.
 */
export class MagicWandTool implements Tool {
  readonly id = "wand";
  readonly label = "Magic wand";
  readonly shortcut = "w";
  readonly icon = "magicWand";
  /** Sample defaults to the background (select regions of the input image); the setting `PainterSketch.WandSample` can change it. */
  readonly values: WandToolOptions;
  readonly options: OptionSet;

  /**
   * @param sample - Initial sample source (settings default).
   */
  constructor(sample: SampleSource = "background") {
    this.values = { tolerance: 32, contiguous: true, antiAlias: true, sample };
    this.options = new OptionSet(DESCRIPTORS, this.values);
  }
  readonly combinesSelection = true;

  /** @inheritdoc */
  onPointerDown(editor: Editor, samples: readonly ToolPointer[]): void {
    const first = samples[0];
    if (!first || editor.loading) return;
    const { mode } = new SelectionModifiers(first, editor.selection.active);
    const v = this.values;
    const sel = editor.pixelOps.wandSelection({
      point: { x: first.x, y: first.y },
      tolerance: v.tolerance,
      contiguous: v.contiguous,
      antiAlias: v.antiAlias,
      sample: v.sample,
    });
    // Nothing matched (e.g. outside the image and bounds): replace deselects, like Photoshop.
    editor.selection.apply(sel, mode);
  }

  /** @inheritdoc */
  onPointerMove(): void {}

  /** @inheritdoc */
  onPointerUp(): void {}

  /** @inheritdoc */
  onCancel(): void {}

  /** @inheritdoc */
  cursor(): ToolCursor {
    return { kind: "icon", icon: "crosshair" };
  }
}

/**
 * Create a magic wand with default options.
 * @param sample - Initial sample source (settings default).
 * @returns The tool.
 */
export function createMagicWandTool(sample?: SampleSource): MagicWandTool {
  return new MagicWandTool(sample);
}
