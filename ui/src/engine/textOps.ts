/**
 * Text tool operations of the editor core (SPEC M6b), exposed as
 * {@link Editor.text}: create a text layer, (re-)edit one, apply live
 * changes, commit.
 *
 * - One edit session at a time. While it is open, text and style changes
 *   re-render the layer live without history; {@link TextOps.commit} records
 *   the whole session as ONE undo step (text data before/after).
 * - A new text layer is an undoable add; its commit folds the final text into
 *   that add entry, so "create + type" undoes in one step. Committing empty
 *   text removes the layer: a new layer's add entry is simply dropped (no
 *   history at all); an emptied existing layer is deleted undoably (with its
 *   previous text).
 * - Layer names follow the text (first ~20 characters) unless the user
 *   renamed the layer (`commitName`).
 * - The UI (text tool + `ui/textOverlay.ts`) listens to the `text` event.
 */

import { createTextLayer } from "../document/create";
import { commitName, nameFromText, sameTextData } from "../document/textData";
import type { TextData } from "../document/textData";
import type { Layer } from "../document/types";
import type { Point } from "../geometry/rect";
import { editBlockNote } from "./rasterize";
import type { EditorState } from "./editorState";
import { emitLayerEvents, releaseRemovedLayers } from "./layerHistory";
import type { LayerOps } from "./layerOps";
import { hitTestText, recordTextChange, renderTextLayer, textStateOf } from "./textLayer";
import { isFontAvailable, textLayout } from "./textRender";

/**
 * Note shown when a text edit starts with a font the browser lacks.
 * @param font - Font name.
 * @returns Note text.
 */
export function missingFontNote(font: string): string {
  return `Font '${font}' isn't installed; editing will use a fallback.`;
}

/** Style of a new text (size in document px). */
export type TextStyle = Omit<TextData, "text" | "x" | "y" | "lineHeight">;

/** The open edit, as seen by the UI. */
export interface TextEditState {
  layerId: string;
  /** Current (live) text data. */
  textData: TextData;
}

/** Internal session bookkeeping. */
interface EditSession {
  layerId: string;
  /** The layer was created by this session (its add entry is the newest). */
  created: boolean;
  /** Text data and name when the session started. */
  before: TextData;
  beforeName: string;
}

/**
 * Text layer editing over a shared {@link EditorState}.
 */
export class TextOps {
  private session: EditSession | null = null;

  /**
   * @param s - Shared editor state.
   * @param layers - Layer commands (undoable add / delete / active layer).
   */
  constructor(
    private readonly s: EditorState,
    private readonly layers: LayerOps,
  ) {}

  /** The open edit, or `null`. */
  get editing(): Readonly<TextEditState> | null {
    const e = this.session;
    const layer = e ? this.find(e.layerId) : undefined;
    return e && layer?.kind === "text" && layer.textData ? { layerId: e.layerId, textData: layer.textData } : null;
  }

  /**
   * Install the rasterize prompt (the engine has no DOM UI; `rasterize.ts`).
   * @param confirm - Returns `true` when the user agrees.
   */
  setConfirmRasterize(confirm: () => boolean): void {
    this.s.confirmRasterize = confirm;
  }

  /**
   * Top-most visible text layer under a point.
   * @param point - Document coords.
   * @returns Layer id, or `null`.
   */
  hitTest(point: Point): string | null {
    return hitTestText(this.s.doc.layers, point, (td) => textLayout(td).box);
  }

  /**
   * Create an empty text layer above the active paint layer (undoable add)
   * and open it for editing. Commits any open edit first.
   * @param at - Anchor (first baseline), document coords.
   * @param style - Font, size (document px), colour, bold/italic, alignment.
   * @returns New layer id, or `null` while loading / stroking.
   */
  create(at: Point, style: TextStyle): string | null {
    this.commit();
    const s = this.s;
    if (s.loading || s.stroke.active) return null;
    const textData: TextData = { ...style, text: "", x: at.x, y: at.y };
    const layer = createTextLayer(textData);
    if (!this.layers.addLayer(layer)) return null;
    this.session = { layerId: layer.id, created: true, before: textData, beforeName: layer.name };
    s.events.emit("text", undefined);
    this.noteMissingFont(textData.font);
    return layer.id;
  }

  /**
   * Open an existing text layer for editing (makes it active). Commits any
   * other open edit first; locked / hidden layers show a note.
   * @param layerId - Text layer id.
   * @returns `true` if the edit is open.
   */
  edit(layerId: string): boolean {
    if (this.session?.layerId === layerId) return true;
    this.commit();
    const s = this.s;
    const layer = this.find(layerId);
    if (s.loading || s.stroke.active || layer?.kind !== "text" || !layer.textData) return false;
    const note = editBlockNote(s, layer);
    if (note) {
      s.events.emit("note", note);
      return false;
    }
    this.layers.setActiveLayer(layerId);
    this.session = { layerId, created: false, before: layer.textData, beforeName: layer.name };
    s.events.emit("text", undefined);
    this.noteMissingFont(layer.textData.font);
    return true;
  }

  /**
   * Live change of the open edit (text or style); re-renders, no history.
   * @param patch - Fields to change.
   */
  update(patch: Partial<TextData>): void {
    const e = this.session;
    const layer = e ? this.find(e.layerId) : undefined;
    const td = layer?.kind === "text" ? layer.textData : undefined;
    if (!layer || !td) return;
    const next: TextData = { ...td, ...patch };
    if (sameTextData(next, td)) return;
    layer.textData = next;
    renderTextLayer(this.s, layer);
    this.s.runtime.bump(layer.id);
    this.s.events.emit("text", undefined);
    this.s.events.emit("render", undefined);
    if (next.font !== td.font) this.noteMissingFont(next.font);
  }

  /**
   * Close the open edit: record it as one undo step (or remove an empty
   * layer). No-op without an edit.
   * @returns `true` if the history gained / changed an undo step.
   */
  commit(): boolean {
    const e = this.session;
    if (!e) return false;
    this.session = null;
    const layer = this.find(e.layerId);
    let recorded = false;
    if (layer?.kind === "text" && layer.textData) {
      recorded = layer.textData.text.trim() ? this.record(layer, layer.textData, e) : this.removeEmpty(layer, e);
    }
    this.s.events.emit("text", undefined);
    return recorded;
  }

  // ── Internals ───────────────────────────────────────────────────────────

  /** Note when the edited font is not installed (the canvas falls back). */
  private noteMissingFont(font: string): void {
    if (!isFontAvailable(font)) this.s.events.emit("note", missingFontNote(font));
  }

  private find(layerId: string): Layer | undefined {
    return this.s.doc.layers.find((l) => l.id === layerId);
  }

  /** The newest history entry if it is this session's own "add layer". */
  private ownAddEntry(layerId: string) {
    const top = this.s.history.mergeTarget();
    const change = top?.kind === "layers" && top.changes.length === 1 ? top.changes[0] : undefined;
    return top?.kind === "layers" && change?.op === "insert" && change.layer.id === layerId ? { entry: top, change } : null;
  }

  private record(layer: Layer, td: TextData, e: EditSession): boolean {
    const s = this.s;
    const name = e.created ? nameFromText(td.text) : commitName(layer.name, e.before.text, td.text);
    const own = e.created ? this.ownAddEntry(layer.id) : null;
    if (own) {
      // Create + type = one "add layer" step holding the final text.
      layer.name = name;
      own.change.layer = { ...layer };
    } else {
      if (sameTextData(td, e.before) && name === layer.name) return false;
      const before = { kind: "text" as const, name: e.beforeName, textData: e.before };
      layer.name = name;
      recordTextChange(s, layer.id, before, textStateOf(layer));
    }
    s.runtime.touch(layer.id);
    s.afterEdit();
    emitLayerEvents(s);
    return true;
  }

  private removeEmpty(layer: Layer, e: EditSession): boolean {
    const s = this.s;
    const own = e.created ? this.ownAddEntry(layer.id) : null;
    if (own) {
      // Create + remove is a no-op: drop the add entry and the layer.
      s.history.discardNewest();
      s.doc.layers.splice(s.doc.layers.indexOf(layer), 1);
      s.runtime.remove(layer.id);
      releaseRemovedLayers(s);
      if (s.doc.layers.some((l) => l.id === own.entry.activeBefore)) s.doc.activeLayerId = own.entry.activeBefore;
      emitLayerEvents(s);
      s.afterEdit();
      return false;
    }
    // An emptied existing layer: restore its text, then delete it undoably
    // (the last paint-like layer can't be deleted: it keeps its old text).
    layer.textData = e.before;
    renderTextLayer(s, layer);
    s.runtime.bump(layer.id);
    if (this.layers.remove(layer.id)) return true;
    s.events.emit("render", undefined);
    return false;
  }
}
