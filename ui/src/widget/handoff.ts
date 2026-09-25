/**
 * Hand-off from a removed node instance to its re-created successor.
 *
 * Why (verified against ComfyUI_frontend 1.52.7 bundle / 1.55.2 source):
 * graph undo/redo (`ChangeTracker.updateState` -> `app.loadGraphData(state,
 * false, ...)` -> `rootGraph.configure`) clears the graph -- `onRemoved` on
 * every node -- and re-creates every node with the SAME id, all in one
 * synchronous task. In Nodes 2.0 the Vue node components are keyed by node id
 * / widget id, so they are patched, not remounted: `WidgetDOM.vue` only
 * mounts `widget.element` in `onMounted`, keeps showing the OLD element and
 * never picks up the new node's element (blank editor until a tab switch
 * remounts everything). LiteGraph remounts (`DomWidget.vue`, keyed by a fresh
 * widget uuid), but the new instance starts without the loaded background.
 *
 * So a removed controller leaves its (emptied) widget element in place and
 * offers it, its session and its background here, keyed by graph + node id.
 * The successor takes the offer from `onAdded` (before `configure` applies
 * the widget value) and swaps its own element into the old element's slot.
 * Offers expire in a microtask: re-creation happens in the same task, while
 * tab switches, reloads and deletions await first, so they never match.
 * Unclaimed elements are removed then (the old cleanup behaviour).
 */

import type { Size } from "../geometry/rect";
import type { LGraphNode, NodeExecutionOutput } from "../types/comfy";
import type { EditorSession } from "./sessions";

/** A successfully loaded background image. */
export interface LoadedBackground {
  key: string;
  image: HTMLImageElement;
  size: Size;
}

/** What a removed node instance leaves for its successor. */
export interface NodeHandoff {
  /** The old DOM widget element (emptied, still in the renderer's slot). */
  element: HTMLElement;
  /** Live session it showed, if any. */
  session: EditorSession | null;
  /** Last loaded background image. */
  background: LoadedBackground | null;
  /** Last executed output (our own input-image preview). */
  lastExecuted: NodeExecutionOutput | null;
}

const offers = new Map<string, NodeHandoff>();

/**
 * Stable identity of a node slot across re-creation: graph (root, or
 * subgraph id) + node id. The root graph's id can be re-minted by
 * `graph.clear()`, so the root is not keyed by id.
 *
 * @param node - Node (must be in a graph).
 * @returns The key, or `null` without a graph.
 */
export function handoffKey(node: LGraphNode): string | null {
  const graph = node.graph;
  if (!graph) return null;
  return `${graph.isRootGraph === false ? graph.id : "root"}:${String(node.id)}`;
}

/**
 * Offer state to a successor created in the same task.
 *
 * @param key - {@link handoffKey} of the removed node.
 * @param handoff - What to hand over.
 */
export function offerHandoff(key: string, handoff: NodeHandoff): void {
  offers.get(key)?.element.remove();
  offers.set(key, handoff);
  queueMicrotask(() => {
    if (offers.get(key) !== handoff) return;
    offers.delete(key);
    handoff.element.remove();
  });
}

/**
 * Claim the offer for a node slot.
 *
 * @param key - {@link handoffKey} of the new node.
 * @returns The offer, or `undefined`.
 */
export function takeHandoff(key: string): NodeHandoff | undefined {
  const handoff = offers.get(key);
  offers.delete(key);
  return handoff;
}
