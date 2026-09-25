/**
 * Prototype hooks for OUR node class only (installed from
 * `beforeRegisterNodeDef` behind a `nodeData.name` guard). Each hook calls the
 * original first, then forwards to the node's controller.
 *
 * Never used on `LGraphNode.prototype` or other node types.
 */

import type { LGraphNode, LGraphNodeConstructor } from "../types/comfy";
import { DEFAULT_NODE_SIZE } from "./constants";
import { getController } from "./controller";

/**
 * Chain lifecycle callbacks on the PainterSketch node prototype.
 *
 * @param nodeType - The PainterSketch node class.
 */
export function installNodeHooks(nodeType: LGraphNodeConstructor): void {
  const proto = nodeType.prototype;

  const onNodeCreated = proto.onNodeCreated;
  proto.onNodeCreated = function (this: LGraphNode): void {
    onNodeCreated?.call(this);
    // Nodes 2.0: don't render execution output images under our widget.
    this.hideOutputImages = true;
    // Runs before `configure`, so saved workflows overwrite this size.
    const [width, height] = this.size;
    this.setSize([Math.max(width, DEFAULT_NODE_SIZE[0]), Math.max(height, DEFAULT_NODE_SIZE[1])]);
    getController(this)?.handleNodeCreated();
  };

  const onAdded = proto.onAdded;
  proto.onAdded = function (this: LGraphNode, graph): void {
    onAdded?.call(this, graph);
    getController(this)?.handleAdded();
  };

  const onExecuted = proto.onExecuted;
  proto.onExecuted = function (this: LGraphNode, output): void {
    onExecuted?.call(this, output);
    getController(this)?.handleExecuted(output);
  };

  const onConnectionsChange = proto.onConnectionsChange;
  proto.onConnectionsChange = function (this: LGraphNode, ...args): void {
    onConnectionsChange?.apply(this, args);
    const [type, slot, isConnected] = args;
    getController(this)?.handleConnectionsChange(type, slot, isConnected);
  };

  const onRemoved = proto.onRemoved;
  proto.onRemoved = function (this: LGraphNode): void {
    onRemoved?.call(this);
    getController(this)?.dispose();
  };

  // LiteGraph renderer: the frontend installs `onDrawBackground` on every
  // ComfyUI node class (before `beforeRegisterNodeDef`) solely to turn
  // execution outputs into an image-preview widget under the node.
  // `hideOutputImages` is only honoured by Nodes 2.0, so without this the
  // preview of our own `ui` output would be appended below the editor.
  // Deliberately NOT chained: the original only does that preview work.
  proto.onDrawBackground = function (this: LGraphNode): void {};
}
