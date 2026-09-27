/** Pure persistence decisions shared by widget synchronization and session lifetime. */

import { cloneOutputOptions } from "./outputOptions";
import { cloneRegion } from "./regions";
import type { PainterDocument } from "./types";

/**
 * Whether M9 metadata carries user work even with no painted pixels/files.
 * Explicit Main options (even default/inactive fields) count, and so does a hidden background.
 * @param doc - Document.
 * @returns Whether output metadata must survive persistence and detach.
 */
export function hasOutputMetadata(doc: PainterDocument): boolean {
  return doc.regions.length > 0 || doc.mainOutput !== undefined || doc.backgroundVisible === false;
}

/**
 * Whether a document needs a manifest rather than the untouched empty string.
 * File references count even when restoration failed (preserve recovery).
 * @param doc - Document.
 * @param hasPaint - Runtime content flag, including unuploaded paint.
 * @returns True for paint, retained file references or output metadata.
 */
export function hasDocumentContent(doc: PainterDocument, hasPaint = false): boolean {
  return hasPaint || doc.layers.some((layer) => layer.file !== null) || hasOutputMetadata(doc);
}

/**
 * Stable identity of M9 metadata, independent of paint files and preview size.
 * @param doc - Document.
 * @returns Signature normalizing missing Main defaults and region order.
 */
export function outputMetadataSignature(doc: PainterDocument): string {
  return JSON.stringify({
    regions: [...doc.regions].sort((a, b) => a.slot - b.slot).map(cloneRegion),
    mainOutput: cloneOutputOptions(doc.mainOutput),
    backgroundVisible: doc.backgroundVisible !== false,
  });
}
