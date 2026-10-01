/**
 * PainterDocument v1: the versioned layer manifest stored (as JSON) in the
 * node's `document` widget. Shapes follow
 * SPEC "Document and saved files". Paint uses frame pixels; regions use current-image pixels.
 */

import type { Rect, Size } from "../geometry/rect";
import type { ImageMask } from "./imageMask";
import type { LayerMask } from "./layerMask";
import type { TextData } from "./textData";

export type { TextData } from "./textData";

/** Current manifest version. Bump + add a migration for breaking changes. */
export const DOCUMENT_VERSION = 1;

/** Upload subfolder under ComfyUI's `input/`. */
export const DOCUMENT_SUBFOLDER = "painter-sketch";

/** Layer kinds: raster `paint`, editable `text` (rasterized for saving) and cmask `mask`. */
export type LayerKind = "paint" | "text" | "mask";

/** Blend modes (Normal only in v1). */
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
  /** Paint layers only: the layer mask, see `layerMask.ts`. */
  layerMask?: LayerMask;
}

/** Independent processing of Main or one region, after region slicing. */
export interface OutputOptions {
  applyMask: "none" | "fill" | "crop" | "border";
  /** Opaque `#rrggbb`. */
  fillColor: string;
  /** Nonnegative integer pixels in the current output. */
  cropPadding: number;
  /** Integer px added on all four sides by `border` (1..MAX_BORDER_SIZE). */
  borderSize: number;
  /** Opaque `#rrggbb` border colour. */
  borderColor: string;
  /** Border area in the MASK: true = 1 (outpainting), false = 0. */
  borderMask: boolean;
  /**
   * Alpha option: IMAGE as RGBA, alpha = 1 - this output's final mask (ignored with
   * `fill`). Normalized copies only carry it when `true`, so the manifest
   * writes it only when on; absent / `false` = off.
   */
  alpha?: boolean;
}

/** Stable output pair, independent of paint placement and overlay visibility. */
export interface Region {
  id: string;
  /** 1..6; holes are never renumbered. */
  slot: number;
  /** Blank (older documents) means `Region N`; see `regionName`. */
  name: string;
  /** Integer image px from the top-left; never rescaled. May extend outside the image. */
  rect: Rect;
  visible: boolean;
  output: OutputOptions;
}

/**
 * Move-tool placement of the whole drawing, in document-frame px: a document
 * point `p` is shown at `(p - c) * scale + c + (x, y)`, `c` = frame centre
 * (SPEC "Document and saved files"). See `document/placement.ts`.
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
  /** Output regions, at most one per slot. */
  regions: Region[];
  /** Missing = none / black / zero padding. */
  mainOutput?: OutputOptions;
  /**
   * Background row eye: `false` = the editor shows transparency and outputs use
   * the `background` widget colour instead of the input image. Missing = visible
   * (saved only when `false`).
   */
  backgroundVisible?: boolean;
  /** Image Mask row (background alpha, image px); saved only while it exists (`imageMask.ts`). */
  imageMask?: ImageMask;
  /** Move tool; `undefined` = identity (saved only when non-identity). */
  placement?: Placement;
  activeLayerId: string;
  /** Bottom -> top; background excluded. */
  layers: Layer[];
}
