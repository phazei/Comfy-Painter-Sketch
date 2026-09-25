/**
 * PainterDocument v1: the versioned layer manifest stored (as JSON) in the
 * node's `document` widget. Shapes follow SPEC.md "Document Model (v1 sketch)"
 * and "Saved-file contract". All coordinates are frame pixels.
 */

import type { Rect, Size } from "../geometry/rect";

/** Current manifest version. Bump + add a migration for breaking changes. */
export const DOCUMENT_VERSION = 1;

/** Upload subfolder under ComfyUI's `input/`. */
export const DOCUMENT_SUBFOLDER = "painter-sketch";

/** Layer kinds (M1 creates only `paint`). */
export type LayerKind = "paint" | "text" | "mask";

/** Blend modes (Normal only in v1, decision 11). */
export type BlendMode = "normal";

/** Opaque text-layer data (defined in M6). */
export type TextData = Record<string, unknown>;

/** One layer. Pixel data lives in `file` (PNG sized exactly `bounds`). */
export interface Layer {
  id: string;
  name: string;
  kind: LayerKind;
  visible: boolean;
  locked: boolean;
  /** 0..1 */
  opacity: number;
  blendMode: BlendMode;
  /** `"painter-sketch/<name>.png [input]"`, or `null` for an empty layer. */
  file: string | null;
  /** Mask display colour. */
  color?: string;
  /** Mask layers: invert before union. */
  invert?: boolean;
  textData?: TextData;
}

/** Future output region (reserved; always `[]` in v1). */
export interface Region {
  id: string;
  index: number;
  rect: Rect;
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
  activeLayerId: string;
  /** Bottom -> top; background excluded. */
  layers: Layer[];
}
