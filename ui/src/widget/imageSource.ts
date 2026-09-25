/**
 * Finds the URL of the image that should be the editor background.
 *
 * The frontend never sees the input tensor, so we look for something that
 * shows it (see AGENTS.md "Getting the Input Image into the Editor"):
 *
 * 1. The upstream node feeding our `image` input (following legacy Reroute /
 *    other virtual nodes), checked in this order:
 *    a. `LoadImage`-style nodes: their `image` widget value -> `/view?type=input`
 *       (works before any run and reacts to selection immediately);
 *    b. `app.nodePreviewImages[locator]` (blob previews);
 *    c. `app.nodeOutputs[locator].images` (the public mirror of the store the
 *       core Painter reads via `nodeOutputStore.getNodeImageUrls`);
 *    d. legacy `node.imgs[0].src`.
 * 2. Our own node's last executed `ui` preview (`onExecuted`, falling back to
 *    `app.nodeOutputs[ourLocator]`, which survives tab switches).
 *
 * Every candidate carries a stable `key` (no random cache-buster) so callers
 * can poll cheaply and only reload when the key changes.
 */

import { api } from "@comfy/scripts/api.js";
import { app } from "@comfy/scripts/app.js";

import type { LGraphNode, NodeExecutionOutput, ResultItem } from "../types/comfy";
import { firstOutputImage, parseAnnotatedFilename, viewQuery, viewUrl } from "./viewUrl";

// ── Types ─────────────────────────────────────────────────────────────────────

/** Where a background candidate came from (for debugging / precedence). */
export type ImageSourceOrigin = "upstream" | "executed";

/** A resolved background image candidate. */
export interface ImageSource {
  /** Stable identity; reload only when this changes. */
  key: string;
  /** URL to load (may include a cache-buster; not stable). */
  url: string;
  origin: ImageSourceOrigin;
}

// ── Constants ─────────────────────────────────────────────────────────────────

/** Node classes whose `image` combo widget names a file we can show directly. */
const FILE_WIDGET_NODES: Readonly<Record<string, { widget: string; type: string }>> = {
  LoadImage: { widget: "image", type: "input" },
  LoadImageOutput: { widget: "image", type: "output" },
};

/** Max virtual nodes (reroutes) to walk through before giving up. */
const MAX_VIRTUAL_HOPS = 16;

// ── Locator ids ───────────────────────────────────────────────────────────────

/**
 * NodeLocatorId used to key `app.nodeOutputs` / `app.nodePreviewImages`:
 * `"<id>"` in the root graph, `"<subgraph-uuid>:<id>"` inside a subgraph
 * (mirrors frontend `workflowStore.nodeToNodeLocatorId`).
 *
 * @param node - Any graph node.
 * @returns The locator id, or `null` when the node is not in a graph yet.
 */
export function nodeLocatorId(node: LGraphNode): string | null {
  const graph = node.graph;
  if (!graph) return null;
  return graph.isRootGraph === false ? `${graph.id}:${String(node.id)}` : String(node.id);
}

// ── Upstream ──────────────────────────────────────────────────────────────────

/**
 * Index of the input slot with the given name.
 *
 * @param node - Node to inspect.
 * @param name - Input name.
 * @returns Slot index or -1.
 */
export function inputSlotIndex(node: LGraphNode, name: string): number {
  return (node.inputs ?? []).findIndex((input) => input.name === name);
}

/**
 * Whether the named input has a link (regardless of what feeds it).
 *
 * @param node - Node to inspect.
 * @param name - Input name.
 * @returns `true` when linked.
 */
export function isInputConnected(node: LGraphNode, name: string): boolean {
  const slot = inputSlotIndex(node, name);
  return slot >= 0 && node.inputs[slot]?.link != null;
}

/**
 * The real (non-virtual) node feeding `node`'s input `slot`, following
 * frontend-only pass-through nodes such as the legacy Reroute. Returns `null`
 * when unconnected, not yet in a graph, or fed from a subgraph input.
 *
 * @param node - Our node.
 * @param slot - Input slot index.
 * @returns Upstream node or `null`.
 */
export function findUpstreamNode(node: LGraphNode, slot: number): LGraphNode | null {
  let current = node;
  let currentSlot = slot;
  for (let hop = 0; hop <= MAX_VIRTUAL_HOPS; hop++) {
    if (!current.graph || currentSlot < 0 || currentSlot >= (current.inputs ?? []).length) return null;
    if (current.inputs[currentSlot]?.link == null) return null;
    const upstream = current.getInputNode(currentSlot);
    if (!upstream) return null;
    if (!upstream.isVirtualNode) return upstream;
    current = upstream;
    currentSlot = 0;
  }
  return null;
}

/**
 * Background candidate from an upstream node, or `null` if it shows nothing.
 *
 * @param upstream - The node feeding our `image` input.
 * @returns Candidate source.
 */
export function sourceFromNode(upstream: LGraphNode): ImageSource | null {
  const fileWidget = FILE_WIDGET_NODES[upstream.comfyClass ?? upstream.type ?? ""];
  if (fileWidget) {
    const widget = upstream.widgets?.find((w) => w.name === fileWidget.widget);
    const item = parseAnnotatedFilename(widget?.value, fileWidget.type);
    if (item) return resultItemSource(item, "upstream");
  }

  const locator = nodeLocatorId(upstream);
  if (locator) {
    const preview = app.nodePreviewImages[locator]?.[0];
    if (typeof preview === "string" && preview) return { key: preview, url: preview, origin: "upstream" };

    const item = firstOutputImage(app.nodeOutputs[locator]);
    if (item) return resultItemSource(item, "upstream");
  }

  const legacy = upstream.imgs?.[0]?.src;
  if (legacy) return { key: legacy, url: legacy, origin: "upstream" };
  return null;
}

// ── Own executed preview ──────────────────────────────────────────────────────

/**
 * Background candidate from our node's own executed `ui` output.
 *
 * @param node - Our node.
 * @param lastExecuted - Output captured in `onExecuted` this session, if any.
 * @returns Candidate source.
 */
export function sourceFromExecuted(
  node: LGraphNode,
  lastExecuted: NodeExecutionOutput | null,
): ImageSource | null {
  const fromSession = firstOutputImage(lastExecuted);
  if (fromSession) return resultItemSource(fromSession, "executed");
  const locator = nodeLocatorId(node);
  const stored = locator ? firstOutputImage(app.nodeOutputs[locator]) : null;
  return stored ? resultItemSource(stored, "executed") : null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Wrap a `/view` result item as a source; the cache-buster is URL-only. */
function resultItemSource(item: ResultItem, origin: ImageSourceOrigin): ImageSource {
  return {
    key: viewQuery(item),
    url: viewUrl(item, (route) => api.apiURL(route), app.getRandParam()),
    origin,
  };
}
