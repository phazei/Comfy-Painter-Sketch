/**
 * Frontend of the Python `PainterSketchRegions` helper node: keeps its 12
 * fixed output labels in sync with the regions of the PainterSketch node its
 * `regions` input comes from, without running the graph. Outputs are never
 * added or removed; only `label` changes.
 *
 * Link resolution (ComfyUI_frontend `LGraphNode.getInputNode`): follows the
 * input link's `origin_id` in the helper's own graph. Native (link-level)
 * reroutes are transparent; a legacy Reroute node or a subgraph input
 * boundary yields a node that isn't PainterSketch (or none), so labels fall
 * back to `region N`.
 *
 * Updates on: graph configure (`refreshRegionsNodes`), connection changes on
 * the helper, and `documentEvents` from any PainterSketch controller.
 */

import { parseDocument } from "../document/parse";
import type { LGraphNode, LGraphNodeConstructor } from "../types/comfy";
import { INPUT_NAMES, NODE_NAME } from "./constants";
import { onDocumentChange } from "./documentEvents";
import { REGION_OUTPUT_COUNT, regionOutputLabels } from "./regionLabels";
import type { RegionSource } from "./regionLabels";

/** Backend node id of the helper node. */
export const REGIONS_NODE_NAME = "PainterSketchRegions";

/** Name of the helper's input. */
export const REGIONS_INPUT_NAME = "regions";

const helpers = new Set<LGraphNode>();

// ── Source resolution ─────────────────────────────────────────────────────────

/**
 * Follow a helper's `regions` input to the PainterSketch node and read its
 * document.
 * @param helper - Helper node.
 * @returns Source regions (`[]` for an untouched document), or null when
 *   unresolvable.
 */
export function readRegionSource(helper: LGraphNode): RegionSource {
  if (!helper.graph) return null;
  const index = (helper.inputs ?? []).findIndex((input) => input.name === REGIONS_INPUT_NAME);
  if (index < 0) return null;
  const source = helper.getInputNode(index);
  if (!source || !isPainterSketch(source)) return null;
  const widget = source.widgets?.find((w) => w.name === INPUT_NAMES.document);
  if (!widget) return null;
  const parsed = parseDocument(widget.value);
  if (parsed.status === "empty") return [];
  if (parsed.status === "invalid") return null;
  return parsed.document.regions;
}

function isPainterSketch(node: LGraphNode): boolean {
  return node.comfyClass === NODE_NAME || node.type === NODE_NAME;
}

// ── Labels ────────────────────────────────────────────────────────────────────

/**
 * Set the helper's output labels from its source. Re-splices `outputs` when
 * anything changed (Nodes 2.0 only sees array changes).
 * @param helper - Helper node.
 * @returns Whether any label changed.
 */
export function updateRegionsNode(helper: LGraphNode): boolean {
  const outputs = helper.outputs;
  if (!outputs) return false;
  const labels = regionOutputLabels(readRegionSource(helper));
  const count = Math.min(outputs.length, REGION_OUTPUT_COUNT);
  let changed = false;
  for (let i = 0; i < count; i++) {
    const output = outputs[i];
    const label = labels[i];
    if (!output || label === undefined || output.label === label) continue;
    output.label = label;
    changed = true;
  }
  if (!changed) return false;
  outputs.splice(0, outputs.length, ...outputs);
  helper.setDirtyCanvas?.(true, true);
  return true;
}

/** Relabel every live helper (after a graph finished configuring). */
export function refreshRegionsNodes(): void {
  for (const helper of helpers) updateRegionsNode(helper);
}

function handleDocumentChange(source: LGraphNode): void {
  for (const helper of helpers) {
    if (helper.graph && helper.graph === source.graph) updateRegionsNode(helper);
  }
}

// ── Hooks ─────────────────────────────────────────────────────────────────────

let unsubscribe: (() => void) | null = null;

/**
 * Chain lifecycle callbacks on the helper's prototype (our own node class).
 * @param nodeType - The `PainterSketchRegions` node class.
 */
export function installRegionsNodeHooks(nodeType: LGraphNodeConstructor): void {
  unsubscribe ??= onDocumentChange(handleDocumentChange);
  const proto = nodeType.prototype;

  const onAdded = proto.onAdded;
  proto.onAdded = function (this: LGraphNode, graph): void {
    onAdded?.call(this, graph);
    helpers.add(this);
    updateRegionsNode(this);
  };

  const onConnectionsChange = proto.onConnectionsChange;
  proto.onConnectionsChange = function (this: LGraphNode, ...args): void {
    onConnectionsChange?.apply(this, args);
    updateRegionsNode(this);
  };

  const onRemoved = proto.onRemoved;
  proto.onRemoved = function (this: LGraphNode): void {
    onRemoved?.call(this);
    helpers.delete(this);
  };
}
