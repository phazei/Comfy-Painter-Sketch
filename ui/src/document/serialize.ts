/**
 * Document -> widget value string.
 */

import { isIdentityPlacement } from "./placement";
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
    regions: doc.regions.map((r) => ({
      id: r.id,
      index: r.index,
      rect: { x: r.rect.x, y: r.rect.y, width: r.rect.width, height: r.rect.height },
    })),
    // Only when moved: identity manifests stay byte-identical to pre-M5 ones.
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
  if (layer.invert !== undefined) out["invert"] = layer.invert;
  if (layer.kind === "text" && layer.textData !== undefined) out["textData"] = serializeTextData(layer.textData);
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
    regions: doc.regions.map((r) => ({ ...r, rect: { ...r.rect } })),
    ...(doc.placement ? { placement: { ...doc.placement } } : {}),
    layers: doc.layers.map((l) => ({ ...l, ...(l.textData ? { textData: { ...l.textData } } : {}) })),
  };
}
