/**
 * Constructors for fresh documents and layers.
 */

import { frameRect } from "../geometry/rect";
import type { Size } from "../geometry/rect";
import { DOCUMENT_VERSION } from "./types";
import type { Layer, PainterDocument } from "./types";

/**
 * Random id (base36). Uses `crypto.getRandomValues` when available.
 *
 * @param length - Number of characters.
 * @returns Random identifier.
 */
export function createId(length = 12): string {
  const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz";
  const bytes = new Uint8Array(length);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else for (let i = 0; i < length; i++) bytes[i] = Math.floor(Math.random() * 256);
  let out = "";
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

/**
 * A new, empty, visible paint layer.
 *
 * @param name - Display name.
 * @returns Layer with `file: null`.
 */
export function createPaintLayer(name: string): Layer {
  return {
    id: createId(8),
    name,
    kind: "paint",
    visible: true,
    locked: false,
    opacity: 1,
    blendMode: "normal",
    file: null,
  };
}

/** Default mask display colour (decision 5). */
export const DEFAULT_MASK_COLOR = "#ff0000";

/** Default mask display opacity (decision 5). */
export const DEFAULT_MASK_OPACITY = 0.5;

/**
 * A new, empty, visible mask layer (red, 50%, not inverted).
 *
 * @param name - Display name.
 * @returns Mask layer with `file: null`.
 */
export function createMaskLayer(name = "Mask"): Layer {
  return {
    id: createId(8),
    name,
    kind: "mask",
    visible: true,
    locked: false,
    opacity: DEFAULT_MASK_OPACITY,
    blendMode: "normal",
    file: null,
    color: DEFAULT_MASK_COLOR,
    invert: false,
  };
}

/**
 * A new document with one empty paint layer ("Layer 1", active), one empty
 * mask layer ("Mask") above it, and `bounds = frame`.
 *
 * @param frame - Frame size (integer pixels).
 * @param docId - Identity to reuse; a new one is generated when omitted.
 * @returns The document.
 */
export function createEmptyDocument(frame: Size, docId: string = createId()): PainterDocument {
  const layer = createPaintLayer("Layer 1");
  const size = { width: Math.round(frame.width), height: Math.round(frame.height) };
  return {
    version: DOCUMENT_VERSION,
    docId,
    frame: size,
    bounds: frameRect(size),
    regions: [],
    activeLayerId: layer.id,
    layers: [layer, createMaskLayer()],
  };
}
