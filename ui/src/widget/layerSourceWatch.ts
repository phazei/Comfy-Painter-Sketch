/**
 * Feeds one node's {@link SourceHistory} from its `layer_source` input
 * (SPEC "Image sources and the Images panel"), with the same lookup as the background
 * (`imageSource.ts`) applied to the `layer_source` slot:
 *
 * 1. while linked: the upstream node's preview (LoadImage widget value,
 *    preview store, node outputs, legacy `imgs`) -- works before any run;
 * 2. else our own executed output's `layer_source` preview (first image of
 *    the batch; this session's `onExecuted`, else `app.nodeOutputs`).
 *
 * Driven by the controller's refresh (poll, `executed` events, link changes).
 */

import { api } from "@comfy/scripts/api.js";
import { app } from "@comfy/scripts/app.js";

import type { LGraphNode, NodeExecutionOutput } from "../types/comfy";
import { INPUT_NAMES } from "./constants";
import { findUpstreamNode, inputSlotIndex, nodeLocatorId, sourceFromNode } from "./imageSource";
import { layerSourceItem, layerSourceKey, SourceHistory } from "./sourceHistory";
import type { SourceEntry } from "./sourceHistory";
import { viewUrl } from "./viewUrl";

/**
 * Current `layer_source` image of a node, or `null` (unlinked / nothing shown).
 * @param node - Our node.
 * @param lastExecuted - Output captured in `onExecuted` this session, if any.
 * @returns Source entry.
 */
export function resolveLayerSource(node: LGraphNode, lastExecuted: NodeExecutionOutput | null): SourceEntry | null {
  const slot = inputSlotIndex(node, INPUT_NAMES.layerSource);
  if (slot < 0 || node.inputs[slot]?.link == null) return null;
  const upstream = findUpstreamNode(node, slot);
  const live = upstream ? sourceFromNode(upstream) : null;
  if (live) return live.name ? { key: live.key, url: live.url, name: live.name } : { key: live.key, url: live.url };
  const locator = nodeLocatorId(node);
  const item = layerSourceItem(lastExecuted) ?? layerSourceItem(locator ? app.nodeOutputs[locator] : null);
  return item ? { key: layerSourceKey(item), url: viewUrl(item, (route) => api.apiURL(route), app.getRandParam()) } : null;
}

/**
 * The history + its feeding for one node instance.
 */
export class LayerSourceWatch {
  /** Sources seen this session (per node instance, memory only). */
  readonly history = new SourceHistory();
  private executed: NodeExecutionOutput | null = null;
  /**
   * New sources are announced (auto-open) once the initial state is known:
   * after the first source seen, or after a user link change on the input.
   */
  private armed = false;

  /**
   * @param node - Our node.
   */
  constructor(private readonly node: LGraphNode) {}

  /** A link changed after startup: the next new source is announced even if it is the first one. */
  arm(): void {
    this.armed = true;
  }

  /**
   * Our node executed (its output may carry a `layer_source` preview).
   * @param output - Execution output.
   */
  setExecuted(output: NodeExecutionOutput): void {
    this.executed = output;
  }

  /** Look the source up again and record it (cheap; de-duplicated by the history). */
  refresh(): void {
    const entry = resolveLayerSource(this.node, this.executed);
    if (!entry) return;
    this.history.add(entry, this.armed);
    this.armed = true;
  }
}
