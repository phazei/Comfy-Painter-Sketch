/**
 * Names shared between the Python node schema and the frontend, plus widget
 * sizing constants. Changing a name here requires the same change in
 * `nodes/painter_sketch.py`.
 */

/** Extension id registered with `app.registerExtension`. */
export const EXTENSION_NAME = "phazei.PainterSketch";

/** Backend node id (`node_id` in the V3 schema). */
export const NODE_NAME = "PainterSketch";

/** `widgetType` of the `document` input; key returned from `getCustomWidgets`. */
export const WIDGET_SPEC_TYPE = "PAINTERSKETCH";

/**
 * `type` of our DOM widget instance. Must not collide with any name in the
 * Nodes 2.0 widget registry (`painter`, `PAINTER`, ...), or that Vue component
 * would be mounted instead of our element.
 */
export const DOM_WIDGET_TYPE = "paintersketch";

/** Input / widget names from the node schema. */
export const INPUT_NAMES = {
  image: "image",
  document: "document",
  width: "width",
  height: "height",
  background: "background",
  invertMask: "invert_mask",
} as const;

/** Minimum editor widget height in graph units. */
export const WIDGET_MIN_HEIGHT = 256;

/** DOM widget margin (graph units) on each side inside the node. */
export const WIDGET_MARGIN = 6;

/** Size given to freshly created nodes (saved workflows keep their size). */
export const DEFAULT_NODE_SIZE: readonly [number, number] = [512, 640];

/**
 * Fallback re-check interval for background sources that change without any
 * event we can observe (e.g. upstream LoadImage selection or preview-store
 * updates). Each tick only builds a key string and compares it.
 */
export const SOURCE_POLL_MS = 500;
