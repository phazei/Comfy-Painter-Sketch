/**
 * Shared types and constants of the editor core (`editor.ts` and the
 * modules it delegates to). Re-exported from `editor.ts` for callers.
 */

import type { LayerChange } from "../document/layerList";
import type { Rect, Size } from "../geometry/rect";

/** Where the document frame size came from. */
export type FrameSource = "widgets" | "image" | "document";

/** Per-layer runtime bookkeeping (not saved). */
export interface LayerRuntime {
  /** Pixels differ from the uploaded `file`. */
  dirty: boolean;
  /** Bumped on every pixel change (lets uploads detect concurrent edits). */
  version: number;
  /** Layer has ever held paint (an empty document may adopt a new frame). */
  hasContent: boolean;
}

/** Full document geometry + pixels (Clear undo). */
export interface DocSnapshot {
  frame: Size;
  bounds: Rect;
  source: FrameSource;
  /** Per-layer pixels covering `bounds`; `null` = every layer empty. */
  pixels: Map<string, ImageData> | null;
}

/** Whole-layer pixels kept by a structural entry (document coords). */
export interface LayerPixels {
  /** Document position of `data`'s top-left (the bounds origin when captured). */
  x: number;
  y: number;
  data: ImageData;
}

/**
 * Structural layer operation (add/delete/duplicate/reorder/rename/opacity/
 * mask colour/invert): a list of reversible changes applied in order (undo
 * reverts them in reverse) plus the active layer on either side.
 */
export interface LayersEntry {
  kind: "layers";
  changes: LayerChange<LayerPixels>[];
  activeBefore: string;
  activeAfter: string;
  /** Pixels held + a small fixed cost for the metadata. */
  bytes: number;
  /** Gesture key: consecutive edits with the same key merge into this entry. */
  gesture?: string;
}

/** One undoable operation. */
export type HistoryEntry =
  | { kind: "patch"; layerId: string; x: number; y: number; before: ImageData; after: ImageData; bytes: number }
  | { kind: "clear"; before: DocSnapshot; after: DocSnapshot; bytes: number }
  | LayersEntry;

/** Editor events. */
export interface EditorEvents {
  [key: string]: unknown;
  /** Pixels, background or view changed: redraw the stage. */
  render: undefined;
  /** Document content/metadata changed: re-emit widget value, schedule upload. */
  change: undefined;
  /** Undo/redo availability changed. */
  history: undefined;
  /** Transient user-facing note. */
  note: string;
  /** Paint target or mask layer state (visibility, existence) changed. */
  mask: undefined;
  /** Layer list or layer metadata changed (order, names, visibility, lock, opacity, active layer). */
  layers: undefined;
}

/** Note shown when painting on a locked layer. */
export const LOCKED_LAYER_NOTE = "Layer is locked.";

/** Stroke colour on mask layers: coverage lives in alpha, RGB kept white. */
export const MASK_STROKE_COLOR = "#ffffff";

/** Note shown when a hidden mask layer blocks painting or is queued while hidden. */
export const HIDDEN_MASK_NOTE = "The mask is hidden; show it to output it.";
