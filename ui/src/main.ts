/**
 * PainterSketch frontend entry point: registers the extension, the custom
 * `PAINTERSKETCH` widget, and the node prototype hooks. Registration only;
 * all behavior lives in `widget/`, `engine/` and `ui/`.
 */

import { app } from "@comfy/scripts/app.js";

import { EXTENSION_NAME, NODE_NAME, WIDGET_SPEC_TYPE } from "./widget/constants";
import { installNodeHooks } from "./widget/nodeHooks";
import { createPainterSketchWidget } from "./widget/painterWidget";

app.registerExtension({
  name: EXTENSION_NAME,

  getCustomWidgets: () => ({
    [WIDGET_SPEC_TYPE]: (node, inputName, inputData) => createPainterSketchWidget(node, inputName, inputData),
  }),

  beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_NAME) return;
    installNodeHooks(nodeType);
  },
});
