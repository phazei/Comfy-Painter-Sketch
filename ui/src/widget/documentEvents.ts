/**
 * Tiny module-level event: "this PainterSketch node's `document` widget value
 * changed". The controller emits it from `syncValue`; the `PainterSketch
 * Regions` helper listens to relabel its outputs without polling.
 */

import type { LGraphNode } from "../types/comfy";

/** Listener for {@link emitDocumentChange}. */
export type DocumentChangeListener = (node: LGraphNode) => void;

const listeners = new Set<DocumentChangeListener>();

/**
 * Subscribe to document value changes of any PainterSketch node.
 * @param listener - Called with the node whose value changed.
 * @returns Unsubscribe function.
 */
export function onDocumentChange(listener: DocumentChangeListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Notify listeners that a node's document value changed.
 * @param node - The PainterSketch node.
 */
export function emitDocumentChange(node: LGraphNode): void {
  for (const listener of listeners) listener(node);
}
