/** Pure persistence decisions shared by widget synchronization and session lifetime. */

import { cloneOutputOptions } from "./outputOptions";
import { cloneRegion } from "./regions";
import type { PainterDocument } from "./types";

/**
 * Whether output metadata (Main options, regions) carries user work even with no painted pixels/files.
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
 * An Image Mask row counts: Python needs the manifest to combine it.
 * @returns True for paint, retained file references, output metadata or an Image Mask.
 */
export function hasDocumentContent(doc: PainterDocument, hasPaint = false): boolean {
  return hasPaint || doc.layers.some((layer) => layer.file !== null) || hasOutputMetadata(doc) || doc.imageMask !== undefined;
}

/**
 * Stable identity of output metadata, independent of paint files and preview size.
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
