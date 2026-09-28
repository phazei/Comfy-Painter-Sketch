/**
 * Shows the `width` / `height` widgets only while the `image` input is
 * unlinked: they are the fallback image size, and Python ignores them when an
 * image is connected (`nodes/painter_sketch.py`, step 1 of `execute`).
 *
 * Uses `widget.hidden`, the frontend's renderer-neutral visibility flag (the
 * same one core `CreateBoundingBoxes` toggles for its width/height): both
 * LiteGraph and Nodes 2.0 skip hidden widgets, while widget order, type and
 * `widgets_values` serialization are untouched. Idempotent and cheap, so the
 * controller calls it on every refresh (workflow load, link changes, poll).
 */

import type { LGraphNode } from "../types/comfy";
import { INPUT_NAMES } from "./constants";
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
