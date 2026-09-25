/**
 * Shared types and constants of the editor core (`editor.ts` and the
 * modules it delegates to). Re-exported from `editor.ts` for callers.
 */

import type { LayerChange } from "../document/layerList";
import type { LayerKind, Placement, TextData } from "../document/types";
import type { Rect, Size } from "../geometry/rect";
import type { Selection } from "./selection";

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
  /** Move-tool placement (`undefined` = identity); Clear resets it. */
  placement?: Placement;
  /** Per-layer pixels covering `bounds`; `null` = every layer empty. */
  pixels: Map<string, ImageData> | null;
  /** Text layers' data (layers not listed are paint; Clear turns text layers into paint). */
  text?: ReadonlyMap<string, TextData>;
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

/**
 * Lossless whole-layer pixel translation (Move tool, `translateMath.ts`).
 * Only recorded when nothing was clipped, so it is exactly reversible
 * without storing pixels. Document coords, like patches.
 */
export interface TranslateEntry {
  kind: "translate";
  layerId: string;
  /** Total shift, document px (integers). */
  dx: number;
  dy: number;
  /**
   * Content bbox (alpha > 0) BEFORE the move, document coords. Re-applying
   * first grows bounds (exact, uncapped) to cover the side it lands on.
   */
  content: Rect;
  /** Small fixed metadata cost. */
  bytes: number;
  /** Gesture key: consecutive nudges with the same key merge into this entry. */
  gesture?: string;
}

/** What a text entry restores on a layer (pixels are re-rendered from `textData`). */
export interface TextLayerState {
  kind: LayerKind;
  name: string;
  /** Present for `kind: "text"`. */
  textData?: TextData;
}

/**
 * Text layer change (SPEC M6b): an edit commit, a move, or rasterizing
 * (`after.kind === "paint"`). Applying a text-kind side re-renders the layer.
 */
export interface TextEntry {
  kind: "text";
  layerId: string;
  before: TextLayerState;
  after: TextLayerState;
  /** Small fixed metadata cost. */
  bytes: number;
  /** Gesture key: consecutive moves with the same key merge into this entry. */
  gesture?: string;
}

/** Several entries undone/redone as one step (rasterize + the edit that follows). */
export interface GroupEntry {
  kind: "group";
  /** Oldest first. */
  entries: HistoryEntry[];
  bytes: number;
}

/** One undoable operation. */
export type HistoryEntry =
  | { kind: "patch"; layerId: string; x: number; y: number; before: ImageData; after: ImageData; bytes: number }
  | { kind: "clear"; before: DocSnapshot; after: DocSnapshot; bytes: number }
  | LayersEntry
  | TranslateEntry
  | TextEntry
  | GroupEntry
  /** Selection change (new / all / deselect / invert); no pixels. */
  | { kind: "selection"; before: Selection | null; after: Selection | null; bytes: number };

/**
 * One history step made of two (see `HistoryStack.joinNext`).
 * @param older - Earlier entry.
 * @param newer - Later entry.
 * @returns Group entry.
 */
export function groupEntries(older: HistoryEntry, newer: HistoryEntry): GroupEntry {
  const entries = older.kind === "group" ? [...older.entries, newer] : [older, newer];
  return { kind: "group", entries, bytes: older.bytes + newer.bytes };
}

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
  /** Move-tool placement changed (live during a drag; not a history event). */
  placement: undefined;
  /** Selection changed (redraw the marching ants, selection actions). */
  selection: undefined;
  /** Text edit started, changed (text / style) or ended (`Editor.text`). */
  text: undefined;
}

/** Note shown when painting on a locked layer. */
export const LOCKED_LAYER_NOTE = "Layer is locked.";

/** Stroke colour on mask layers: coverage lives in alpha, RGB kept white. */
export const MASK_STROKE_COLOR = "#ffffff";

/** Note shown when editing a hidden (non-mask) layer is refused. */
export const HIDDEN_LAYER_NOTE = "The layer is hidden.";

/** Note shown when a hidden mask layer blocks painting or is queued while hidden. */
export const HIDDEN_MASK_NOTE = "The mask is hidden; show it to output it.";
