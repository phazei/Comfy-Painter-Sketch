/**
 * Text layers in the editor core (SPEC M6b): rendering `textData` into the
 * layer canvas, text history entries ({@link TextEntry}), the text move
 * handler used by the Move tool and the text tool's Ctrl+drag
 * (`layerMovers.ts`), and hit-testing text boxes.
 *
 * The layer canvas always holds the rendered text, so text layers composite,
 * thumbnail and upload exactly like paint layers. Rendering grows the
 * bounds (chunked, capped) to fit the text.
 */

import type { Layer } from "../document/types";
import type { TextData } from "../document/textData";
import type { Point, Rect } from "../geometry/rect";
import type { TextEntry, TextLayerState } from "./editorTypes";
import type { EditorState } from "./editorState";
import { drawText, textLayout } from "./textRender";

/** History cost of a text entry (metadata only), bytes. */
export const TEXT_ENTRY_BYTES = 256;

/** Extra hit margin around a text box, as a fraction of the font size. */
const HIT_MARGIN = 0.15;

// ── Rendering ─────────────────────────────────────────────────────────────────

/**
 * Re-render a text layer's pixels from its `textData` (clears the canvas
 * first). No history, no dirty flag: callers {@link EditorState.runtime}
 * `touch` (edits) or `bump` (live preview) as appropriate.
 * @param s - Editor state.
 * @param layer - Text layer (other kinds are ignored).
 */
export function renderTextLayer(s: EditorState, layer: Readonly<Layer>): void {
  const td = layer.kind === "text" ? layer.textData : undefined;
  if (!td) return;
  const bbox = textLayout(td).bbox;
  if (bbox.width > 0 && bbox.height > 0) s.ensureBounds(bbox, true);
  const surface = s.store.ensure(layer.id);
  surface.ctx.clearRect(0, 0, surface.canvas.width, surface.canvas.height);
  const bounds = s.store.bounds;
  drawText(surface.ctx, td, { x: bounds.x, y: bounds.y });
}

// ── State + history ───────────────────────────────────────────────────────────

/**
 * Snapshot of what a text entry restores.
 * @param layer - Layer.
 * @returns Kind, name and text data.
 */
export function textStateOf(layer: Readonly<Layer>): TextLayerState {
  return layer.kind === "text" && layer.textData
    ? { kind: "text", name: layer.name, textData: layer.textData }
    : { kind: layer.kind, name: layer.name };
}

/**
 * Write a text state into a layer and re-render it when it is text.
 * @param s - Editor state.
 * @param layer - Layer to change.
 * @param state - State to apply.
 */
export function applyTextState(s: EditorState, layer: Layer, state: TextLayerState): void {
  layer.kind = state.kind;
  layer.name = state.name;
  if (state.kind === "text" && state.textData) {
    layer.textData = state.textData;
    renderTextLayer(s, layer);
  } else {
    delete layer.textData;
  }
}

/**
 * Record a text change (merging into the newest entry for the same layer
 * and `gesture`, e.g. arrow nudges).
 * @param s - Editor state.
 * @param layerId - Layer id.
 * @param before - State before the change.
 * @param after - State after it.
 * @param gesture - Merge key, or `undefined`.
 */
export function recordTextChange(
  s: EditorState,
  layerId: string,
  before: TextLayerState,
  after: TextLayerState,
  gesture?: string,
): void {
  const merge = gesture ? s.history.mergeTarget() : undefined;
  if (merge?.kind === "text" && merge.gesture === gesture && merge.layerId === layerId) {
    merge.after = after;
    return;
  }
  const entry: TextEntry = { kind: "text", layerId, before, after, bytes: TEXT_ENTRY_BYTES };
  if (gesture) entry.gesture = gesture;
  s.history.push(entry);
}

/**
 * Undo (`forward = false`) or redo a text entry.
 * @param s - Editor state.
 * @param entry - Entry.
 * @param forward - Redo direction.
 */
export function applyTextEntry(s: EditorState, entry: TextEntry, forward: boolean): void {
  const layer = s.doc.layers.find((l) => l.id === entry.layerId);
  if (!layer) return;
  applyTextState(s, layer, forward ? entry.after : entry.before);
  s.runtime.touch(layer.id);
  s.events.emit("layers", undefined);
}

// ── Move handler ──────────────────────────────────────────────────────────────

/**
 * Move a text layer: shift the anchor, re-render (lossless), record one
 * text entry (merged by `gesture`). Signature of `LayerMover.move`.
 * @param s - Editor state.
 * @param layer - Text layer.
 * @param dx - X shift, document px.
 * @param dy - Y shift, document px.
 * @param gesture - Merge key, or `undefined`.
 * @returns `true` if the text moved.
 */
export function moveTextLayer(s: EditorState, layer: Layer, dx: number, dy: number, gesture?: string): boolean {
  const td = layer.kind === "text" ? layer.textData : undefined;
  if (!td || (dx === 0 && dy === 0)) return false;
  const before = textStateOf(layer);
  layer.textData = { ...td, x: td.x + dx, y: td.y + dy };
  renderTextLayer(s, layer);
  recordTextChange(s, layer.id, before, textStateOf(layer), gesture);
  s.runtime.touch(layer.id);
  return true;
}

// ── Hit test ──────────────────────────────────────────────────────────────────

/**
 * Top-most visible text layer whose text box contains a point (pure: boxes
 * come from `boxOf`).
 * @param layers - Document layers, bottom -> top.
 * @param point - Document point.
 * @param boxOf - Text box of a text data value, document coords.
 * @returns Layer id, or `null`.
 */
export function hitTestText(
  layers: readonly Readonly<Layer>[],
  point: Point,
  boxOf: (td: Readonly<TextData>) => Rect,
): string | null {
  for (let i = layers.length - 1; i >= 0; i--) {
    const layer = layers[i];
    if (!layer || layer.kind !== "text" || !layer.visible || !layer.textData) continue;
    const box = boxOf(layer.textData);
    const m = layer.textData.size * HIT_MARGIN;
    if (point.x >= box.x - m && point.x <= box.x + box.width + m && point.y >= box.y - m && point.y <= box.y + box.height + m) {
      return layer.id;
    }
  }
  return null;
}
