/**
 * Marquee selection tools (M / Shift+M, SPEC Tools table + "Selection").
 * One {@link MarqueeTool} class; each member of the group supplies a
 * {@link MarqueeKind} (how a dragged box becomes coverage + its preview
 * outline): rectangle (hard edge) and ellipse (anti-aliased,
 * `engine/selectionRaster.ts`), both in {@link MARQUEE_GROUP}.
 *
 * Drag = new box in document coords (the stage already converts the pointer
 * through the view + document map). Modifiers follow
 * `selectionModifiers.ts`: mode from the keys at pointer-down (Shift add,
 * Alt subtract, Shift+Alt intersect), then Shift = square and Alt = from
 * centre. Alt at pointer-down is the subtract modifier, never the
 * eyedropper (no `altEyedropper`). A click without a drag deselects
 * (replace mode only, Photoshop). Esc cancels (stage `cancelToolDrag`).
 * The result is ONE `selection` history entry (`Editor.selection.apply`).
 */

import type { Editor } from "../engine/editor";
import { imageLengthToDoc } from "../engine/frameMap";
import { rectSelection, snapRect } from "../engine/selection";
import type { Selection } from "../engine/selection";
import { ellipseSelection } from "../engine/selectionRaster";
import { boxFromDrag } from "../engine/shapes";
import type { Point, Rect } from "../geometry/rect";
import { SelectionModifiers } from "./selectionModifiers";
import type { ToolGroupSpec } from "./toolGroups";
import type { SelectionShape, Tool, ToolCursor, ToolOverlay, ToolPointer } from "./types";

/** Drag distance (stage CSS px) below which a press counts as a click. */
const CLICK_SLOP_PX = 3;

/** How a marquee turns its box into a selection. */
export interface MarqueeKind {
  /**
   * Coverage for a box.
   * @param box - Pixel-snapped box, document coords.
   * @returns Selection, or `null` when it covers no pixel.
   */
  coverage(box: Rect): Selection | null;
  /**
   * Preview outline while dragging.
   * @param box - Pixel-snapped box, document coords.
   * @returns Shape drawn as marching ants.
   */
  preview(box: Rect): SelectionShape;
}

/** Static description of a marquee tool. */
export interface MarqueeToolSpec {
  id: string;
  label: string;
  icon: string;
  kind: MarqueeKind;
}

/** Rectangle: hard edges (AA off). */
export const RECT_MARQUEE: MarqueeKind = {
  coverage: (box) => rectSelection(box),
  preview: (box) => ({ kind: "rect", rect: box }),
};

/** Ellipse inscribed in the box: anti-aliased edge (Photoshop default). */
export const ELLIPSE_MARQUEE: MarqueeKind = {
  coverage: (box) => ellipseSelection(box),
  preview: (box) => ({ kind: "ellipse", rect: box }),
};

/** Rail group of the marquees (M / Shift+M cycles). */
export const MARQUEE_GROUP: ToolGroupSpec = { id: "marquee", label: "Marquee", toolIds: ["marquee-rect", "marquee-ellipse"] };

/** One drag in progress. */
interface MarqueeDrag {
  start: Point;
  mods: SelectionModifiers;
  /** Click slop in document px. */
  slop: number;
  moved: boolean;
  /** Current snapped box. */
  box: Rect;
}

/**
 * Drag-a-box selection tool.
 */
export class MarqueeTool implements Tool {
  readonly id: string;
  readonly label: string;
  readonly shortcut = "m";
  readonly icon: string;
  readonly options = null;
  readonly combinesSelection = true;
  private readonly kind: MarqueeKind;
  private drag: MarqueeDrag | null = null;

  /**
   * @param spec - Id, label, icon and box -> coverage kind.
   */
  constructor(spec: MarqueeToolSpec) {
    this.id = spec.id;
    this.label = spec.label;
    this.icon = spec.icon;
    this.kind = spec.kind;
  }

  /** @inheritdoc */
  onPointerDown(editor: Editor, samples: readonly ToolPointer[]): void {
    const first = samples[0];
    if (!first || this.drag) return;
    const viewScale = editor.view.current.scale;
    this.drag = {
      start: { x: first.x, y: first.y },
      mods: new SelectionModifiers(first, editor.selection.active),
      slop: imageLengthToDoc(editor.frameMap, CLICK_SLOP_PX / (viewScale > 0 ? viewScale : 1)),
      moved: false,
      box: { x: first.x, y: first.y, width: 0, height: 0 },
    };
    this.update(samples);
  }

  /** @inheritdoc */
  onPointerMove(_editor: Editor, samples: readonly ToolPointer[]): void {
    this.update(samples);
  }

  /** @inheritdoc */
  onPointerUp(editor: Editor, sample: ToolPointer): void {
    const drag = this.drag;
    if (!drag) return;
    this.update([sample]);
    this.drag = null;
    if (!drag.moved) {
      // Click: Photoshop deselects (only in replace mode).
      if (drag.mods.mode === "replace") editor.selection.deselect();
      return;
    }
    editor.selection.apply(this.kind.coverage(drag.box), drag.mods.mode);
  }

  /** @inheritdoc */
  onCancel(): void {
    this.drag = null;
  }

  /** @inheritdoc */
  cursor(): ToolCursor {
    return { kind: "icon", icon: "crosshair" };
  }

  /** @inheritdoc */
  overlay(): ToolOverlay | null {
    const drag = this.drag;
    return drag?.moved ? { kind: "selection", shape: this.kind.preview(drag.box) } : null;
  }

  private update(samples: readonly ToolPointer[]): void {
    const drag = this.drag;
    if (!drag) return;
    for (const p of samples) {
      const { square, fromCentre } = drag.mods.update(p);
      if (!drag.moved && Math.hypot(p.x - drag.start.x, p.y - drag.start.y) > drag.slop) drag.moved = true;
      drag.box = snapRect(boxFromDrag(drag.start, p, square, fromCentre));
    }
  }
}

/**
 * Create the marquee tools in {@link MARQUEE_GROUP} order.
 * @returns New tools.
 */
export function createMarqueeTools(): Tool[] {
  return [
    new MarqueeTool({ id: "marquee-rect", label: "Rectangular marquee", icon: "marqueeRect", kind: RECT_MARQUEE }),
    new MarqueeTool({ id: "marquee-ellipse", label: "Elliptical marquee", icon: "marqueeEllipse", kind: ELLIPSE_MARQUEE }),
  ];
}
