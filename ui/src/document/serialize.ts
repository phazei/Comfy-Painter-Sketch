/**
 * Document -> widget value string.
 */

import { serializeImageMask } from "./imageMask";
import { serializeLayerMask } from "./layerMask";
import { isIdentityPlacement } from "./placement";
import { cloneOutputOptions } from "./outputOptions";
import { cloneRegion } from "./regions";
import { serializeTextData } from "./textData";
import type { Layer, PainterDocument } from "./types";

/**
 * Serialize a document with a stable key order (so equal documents produce
 * equal strings) and without `undefined` optional fields.
 *
 * @param doc - Document to serialize.
 * @returns JSON string for the `document` widget.
 */
export function stringifyDocument(doc: PainterDocument): string {
  const p = doc.placement;
  return JSON.stringify({
    version: doc.version,
    docId: doc.docId,
    frame: { width: doc.frame.width, height: doc.frame.height },
    bounds: { x: doc.bounds.x, y: doc.bounds.y, width: doc.bounds.width, height: doc.bounds.height },
    regions: doc.regions.map(cloneRegion),
    ...(doc.mainOutput ? { mainOutput: cloneOutputOptions(doc.mainOutput) } : {}),
    ...(doc.backgroundVisible === false ? { backgroundVisible: false } : {}),
    // Only while the row exists (older manifests stay byte-identical).
    ...(doc.imageMask ? { imageMask: serializeImageMask(doc.imageMask) } : {}),
    // Only when moved: manifests without a placement stay byte-identical.
    ...(p && !isIdentityPlacement(p) ? { placement: { x: p.x, y: p.y, scale: p.scale } } : {}),
    activeLayerId: doc.activeLayerId,
    layers: doc.layers.map(serializeLayer),
  });
}

function serializeLayer(layer: Layer): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: layer.id,
    name: layer.name,
    kind: layer.kind,
    visible: layer.visible,
    locked: layer.locked,
    opacity: layer.opacity,
    blendMode: layer.blendMode,
    file: layer.file,
  };
  if (layer.color !== undefined) out["color"] = layer.color;
  if (layer.subtract) out["subtract"] = true;
  if (layer.kind === "text" && layer.textData !== undefined) out["textData"] = serializeTextData(layer.textData);
  // Only while the layer has one (older manifests stay byte-identical).
  if (layer.layerMask) out["layerMask"] = serializeLayerMask(layer.layerMask);
  return out;
}

/**
 * Deep copy of a document (plain data only).
 *
 * @param doc - Document to copy.
 * @returns Independent copy.
 */
export function cloneDocument(doc: PainterDocument): PainterDocument {
  return {
    ...doc,
    frame: { ...doc.frame },
    bounds: { ...doc.bounds },
    regions: doc.regions.map(cloneRegion),
    ...(doc.mainOutput ? { mainOutput: cloneOutputOptions(doc.mainOutput) } : {}),
    ...(doc.placement ? { placement: { ...doc.placement } } : {}),
    ...(doc.imageMask ? { imageMask: { ...doc.imageMask } } : {}),
    layers: doc.layers.map((l) => ({
      ...l,
      ...(l.textData ? { textData: { ...l.textData } } : {}),
      ...(l.layerMask ? { layerMask: { ...l.layerMask } } : {}),
    })),
  };
}
