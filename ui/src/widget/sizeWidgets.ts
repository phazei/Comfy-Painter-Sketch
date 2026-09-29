/**
 * The `width` / `height` widgets: the fallback image size while `image` is
 * unlinked (Python ignores them when an image is connected,
 * `nodes/painter_sketch.py`, step 1 of `execute`).
 *
 * - {@link syncSizeWidgets}: shows them only while `image` is unlinked. Uses
 *   `widget.hidden`, the frontend's renderer-neutral visibility flag (the same
 *   one core `CreateBoundingBoxes` toggles for its width/height): both
 *   LiteGraph and Nodes 2.0 skip hidden widgets, while widget order, type and
 *   `widgets_values` serialization are untouched. Idempotent and cheap, so the
 *   controller calls it on every refresh (workflow load, link changes, poll).
 * - {@link writeSizeWidgets}: keeps their values at the size of the loaded
 *   image, so disconnecting it (or an upstream with no image, or a reload
 *   without one) keeps the frame where it is.
 */

import type { Size } from "../geometry/rect";
import type { IBaseWidget, LGraphNode } from "../types/comfy";
import { INPUT_NAMES } from "./constants";
import { FRAME_SIDE_LIMITS, widgetDimension } from "./frameFallback";
import type { SideLimits } from "./frameFallback";
import { isInputConnected } from "./imageSource";

const SIZE_WIDGETS: ReadonlySet<string> = new Set([INPUT_NAMES.width, INPUT_NAMES.height]);

/**
 * Hide or show the fallback size widgets for the current `image` link state.
 * Showing them grows the node if it is now too short; hiding never shrinks it
 * (the editor takes the freed height).
 * @param node - Our node.
 * @returns `true` if any widget changed.
 */
export function syncSizeWidgets(node: LGraphNode): boolean {
  const hidden = isInputConnected(node, INPUT_NAMES.image);
  let changed = false;
  for (const widget of node.widgets ?? []) {
    if (!SIZE_WIDGETS.has(widget.name) || (widget.hidden ?? false) === hidden) continue;
    widget.hidden = hidden;
    changed = true;
  }
  if (!changed) return false;
  const needed = node.computeSize?.();
  const [width, height] = node.size;
  if (!hidden && needed && needed[1] > height) node.setSize([width, needed[1]]);
  node.setDirtyCanvas?.(true, true);
  return true;
}

/** Outcome of {@link writeSizeWidgets}. */
export interface SizeWrite {
  /** A widget value changed. */
  changed: boolean;
  /** A side exceeded its widget's range and was clamped (the frame will differ once the image is gone). */
  clamped: boolean;
}

/**
 * Set `width` / `height` to an image size, rounded and clamped as the INT
 * widgets would (their own `min` / `max` / `step2`, else the schema's).
 * Only differing values are written, through the value setter (widget value
 * store, both renderers) and without the widget callback, so nothing
 * re-enters the refresh path.
 * @param node - Our node.
 * @param size - Image size in pixels.
 * @returns What happened.
 */
export function writeSizeWidgets(node: LGraphNode, size: Size): SizeWrite {
  const result: SizeWrite = { changed: false, clamped: false };
  const sides: Array<[string, number]> = [[INPUT_NAMES.width, size.width], [INPUT_NAMES.height, size.height]];
  for (const [name, side] of sides) {
    const widget = node.widgets?.find((w) => w.name === name);
    if (!widget) continue;
    const limits = widgetLimits(widget);
    const value = widgetDimension(side, limits);
    if (side > limits.max || side < limits.min) result.clamped = true;
    if (widget.value === value) continue;
    widget.value = value;
    result.changed = true;
  }
  return result;
}

/** A widget's INT limits; missing or invalid options fall back to the schema's. */
function widgetLimits(widget: IBaseWidget): SideLimits {
  const { min, max, step2 } = widget.options ?? {};
  const num = (value: unknown, fallback: number): number =>
    typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return {
    min: num(min, FRAME_SIDE_LIMITS.min),
    max: num(max, FRAME_SIDE_LIMITS.max),
    step: num(step2, FRAME_SIDE_LIMITS.step),
  };
}
