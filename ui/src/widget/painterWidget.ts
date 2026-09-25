/**
 * The custom widget constructor for `widgetType: "PAINTERSKETCH"`.
 *
 * Mechanism (frontend 1.55.2, `services/litegraphService.ts` `addInputWidget`):
 * an input's `widgetType` replaces its `type` when looking up a constructor in
 * the widget store, which includes everything returned from an extension's
 * `getCustomWidgets()`. The constructor is called during the node constructor
 * with the V1 spec `[type, options]`. If the returned widget's
 * `options.socketless` is truthy, no input socket is added for it.
 *
 * Persistence timing (verified in 1.55.2 `utils/executionUtil.ts`,
 * `scripts/changeTracker.ts`): `serializeValue` runs ONLY when building the
 * API prompt (queue), after `graph.serialize()`. Workflow save, tab switch
 * and export read `widget.value` (via `changeTracker.captureCanvasState()`).
 * So the widget value is kept current after every edit, and dirty layers are
 * also uploaded on a short debounce after each edit; `serializeValue` just
 * flushes whatever is still pending.
 */

import type { DOMWidget, InputSpecV1, LGraphNode } from "../types/comfy";
import { injectStyles } from "../styles/inject";
import { DOM_WIDGET_TYPE, WIDGET_MARGIN, WIDGET_MIN_HEIGHT } from "./constants";
import { PainterSketchController } from "./controller";

/**
 * Create the editor DOM widget on `node`.
 *
 * @param node - The PainterSketch node under construction.
 * @param inputName - Input name (`document`); becomes the widget name.
 * @param inputData - V1 input spec `[type, options]`.
 * @returns `{ widget }` as expected by the frontend widget store.
 */
export function createPainterSketchWidget(
  node: LGraphNode,
  inputName: string,
  inputData: InputSpecV1,
): { widget: DOMWidget<HTMLDivElement, string> } {
  injectStyles();
  const options = inputData[1] ?? {};
  const controller = new PainterSketchController(node);
  controller.setValue(options.default ?? "");

  const widget = node.addDOMWidget<HTMLDivElement, string>(inputName, DOM_WIDGET_TYPE, controller.host.root, {
    getValue: () => controller.getValue(),
    setValue: (value) => controller.setValue(value),
    getMinHeight: () => WIDGET_MIN_HEIGHT,
    margin: WIDGET_MARGIN,
    socketless: options.socketless ?? true,
    serialize: true,
  });

  widget.serializeValue = () => controller.serialize();

  return { widget };
}
