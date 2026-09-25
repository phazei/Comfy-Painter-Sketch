/**
 * PainterDocument v1: the versioned layer manifest stored (as JSON) in the
 * node's `document` widget. Shapes follow SPEC.md "Document Model (v1 sketch)"
 * and "Saved-file contract". All coordinates are frame pixels.
 */

import type { Rect, Size } from "../geometry/rect";
import type { TextData } from "./textData";

export type { TextData } from "./textData";

/** Current manifest version. Bump + add a migration for breaking changes. */
export const DOCUMENT_VERSION = 1;

/** Upload subfolder under ComfyUI's `input/`. */
export const DOCUMENT_SUBFOLDER = "painter-sketch";

/** Layer kinds (M1 creates only `paint`). */
export type LayerKind = "paint" | "text" | "mask";

/** Blend modes (Normal only in v1, decision 11). */
export type BlendMode = "normal";

/** One layer. Pixel data lives in `file` (WebP or PNG sized exactly `bounds`). */
export interface Layer {
  id: string;
  name: string;
  kind: LayerKind;
  visible: boolean;
  locked: boolean;
  /** 0..1 */
  opacity: number;
  blendMode: BlendMode;
  /** `"painter-sketch/<name>.<webp|png> [input]"`, or `null` for an empty layer. */
  file: string | null;
  /** Mask display colour. */
  color?: string;
  /** Mask layers: invert before union. */
  invert?: boolean;
  /** Text layers only (`kind: "text"`): editable text, see `textData.ts`. */
  textData?: TextData;
}

/** Future output region (reserved; always `[]` in v1). */
export interface Region {
  id: string;
  index: number;
  rect: Rect;
}

/**
 * Move-tool placement of the whole drawing, in document-frame px: a document
 * point `p` is shown at `(p - c) * scale + c + (x, y)`, `c` = frame centre
 * (SPEC "Saved-file contract", Placement). See `document/placement.ts`.
 */
export interface Placement {
  x: number;
  y: number;
  scale: number;
}

/** The layer document. */
export interface PainterDocument {
  version: typeof DOCUMENT_VERSION;
  /**
   * Stable identity of this document across node instances (tab switches,
   * subgraph remounts, graph undo). Frontend-only; Python ignores it.
   */
  docId: string;
  /** Image frame the paint was made on. */
  frame: Size;
  /** Paint area in frame coords; always contains the frame rect. */
  bounds: Rect;
  regions: Region[];
  /** Move tool; `undefined` = identity (saved only when non-identity). */
  placement?: Placement;
  activeLayerId: string;
  /** Bottom -> top; background excluded. */
  layers: Layer[];
}
