/**
 * PainterSketch frontend entry point: registers the extension, the custom
 * `PAINTERSKETCH` widget, and the node prototype hooks (PainterSketch and its
 * `PainterSketchRegions` helper). Registration only; all behavior lives in
 * `widget/`, `engine/` and `ui/`.
 */

import { app } from "@comfy/scripts/app.js";

import { SETTINGS } from "./settings";
import { EXTENSION_NAME, NODE_NAME, WIDGET_SPEC_TYPE } from "./widget/constants";
import { installNodeHooks } from "./widget/nodeHooks";
import { installPageGuards } from "./widget/pageGuards";
import { createPainterSketchWidget } from "./widget/painterWidget";
import { installRegionsNodeHooks, refreshRegionsNodes, REGIONS_NODE_NAME } from "./widget/regionsNode";

installPageGuards();

app.registerExtension({
  name: EXTENSION_NAME,

  settings: SETTINGS,
  afterConfigureGraph: refreshRegionsNodes,

  getCustomWidgets: () => ({
    [WIDGET_SPEC_TYPE]: (node, inputName, inputData) => createPainterSketchWidget(node, inputName, inputData),
  }),

  beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name === NODE_NAME) installNodeHooks(nodeType);
    else if (nodeData.name === REGIONS_NODE_NAME) installRegionsNodeHooks(nodeType);
  },
});
