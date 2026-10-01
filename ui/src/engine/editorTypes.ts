/**
 * Shared types and constants of the editor core (`editor.ts` and the
 * modules it delegates to). Re-exported from `editor.ts` for callers.
 */

import type { LayerChange } from "../document/layerList";
import type { LayerMask } from "../document/layerMask";
import type { LayerKind, Placement, TextData } from "../document/types";
import type { Rect, Size } from "../geometry/rect";
import type { Selection } from "./selection";
import type { OutputMetadata } from "./regionHistory";

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
  /** Region geometry/reference and Main processing (no pixels). */
  outputs?: OutputMetadata;
  /** Layer masks by layer id, pixels covering `bounds`; layers not listed have none (Clear removes them). */
  layerMasks?: ReadonlyMap<string, { mask: LayerMask; data: ImageData }>;
  /** Selection (document coords of this snapshot's frame); absent = none (Clear drops it). */
  selection?: Selection | null;
}

/** Whole-layer pixels kept by a structural entry (document coords). */
export interface LayerPixels {
  /** Document position of `data`'s top-left (the bounds origin when captured). */
  x: number;
  y: number;
  data: ImageData;
  /** The layer's mask pixels, same origin and size as `data`. */
  mask?: ImageData;
}

/** One side of a layer-mask entry: the record and its pixels. */
export interface LayerMaskSide {
  /** `null` = the layer has no mask on this side. */
  mask: LayerMask | null;
  /** Mask pixels to install; `null` = fill with `mask.outside` (or none needed: invert only). */
  pixels: LayerPixels | null;
}

/** Layer mask added / deleted / inverted (pixel edits are plain patches on its key). */
export interface LayerMaskEntry {
  kind: "layerMask";
  layerId: string;
  before: LayerMaskSide;
  after: LayerMaskSide;
  bytes: number;
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
  /**
   * The layer's lmask moved along: its content bbox (values other
   * than its `outside`) BEFORE the move; the vacated part gets `outside`.
   */
  mask?: Rect;
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
 * Text layer change (SPEC "Tools" > "Text (T)"): an edit commit, a move, or rasterizing
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
  | LayerMaskEntry
  | { kind: "outputs"; before: OutputMetadata; after: OutputMetadata; bytes: number }
  /** Selection change (new / all / deselect / invert / outline move); no pixels. `gesture` merges arrow nudges. */
  | { kind: "selection"; before: Selection | null; after: Selection | null; bytes: number; gesture?: string };

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
  /** Solo (view only) changed (`Editor.solo`). */
  solo: undefined;
  /** Output metadata or selected output changed. */
  outputs: undefined;
  /** Free Transform session started / changed / ended, or a float ended (Editor.float.transform). */
  transform: undefined;
}

/** Note shown when painting on a locked layer. */
export const LOCKED_LAYER_NOTE = "Layer is locked.";

/** Stroke colour on mask layers: coverage lives in alpha, RGB kept white. */
export const MASK_STROKE_COLOR = "#ffffff";

/** Note shown when editing a hidden (non-mask) layer is refused. */
export const HIDDEN_LAYER_NOTE = "The layer is hidden.";

/** Note shown when editing a layer that a solo (on another layer) hides. */
export const SOLO_HIDDEN_NOTE = "The layer is hidden by solo.";

/**
 * Note shown when any pixel edit targets the Image Mask / Input Mask row.
 * @param name - Row name.
 * @returns Note text.
 */
export function imageMaskNote(name: string): string {
  return `${name} can't be edited \u2014 duplicate it to edit.`;
}

/** {@link imageMaskNote} of the Image Mask row. */
export const IMAGE_MASK_NOTE = imageMaskNote("Image Mask");

/** Note shown when a hidden mask layer blocks painting or is queued while hidden. */
export const HIDDEN_MASK_NOTE = "The mask is hidden.";
