/**
 * Free Transform of a text layer (SPEC M11b): the session box is the text's
 * unrotated edit box at session start, and the session parameters map onto
 * `textData` instead of pixels:
 *
 * - rotation -> `textData.rotation` (degrees, about the box centre);
 * - proportional scale -> `textData.size` (scaled, clamped), the anchor
 *   scaled about the box centre so the box centre follows the transform;
 * - move -> anchor shift.
 *
 * Every change re-renders the layer live (no history); {@link TextTransform.commit}
 * records ONE text step, and the layer stays editable text. Non-uniform
 * scale or a flip can't be represented: {@link TextTransform.apply} refuses
 * them (the caller asks to rasterize, `transformOps.ts`).
 */

import { activeEditLayer } from "../document/masks";
import { clampSize, sameTextData, withRotation } from "../document/textData";
import type { TextData } from "../document/textData";
import type { Layer } from "../document/types";
import type { EditorState } from "./editorState";
import { editBlockNote, rasterizeLayer } from "./rasterize";
import { recordTextChange, renderTextLayer } from "./textLayer";
import { textLayout } from "./textRender";
import type { TransformParams } from "./transformMath";

/** Relative tolerance for "uniform" scale factors. */
const UNIFORM_EPS = 1e-6;

/**
 * Whether session parameters are a uniform, unflipped scale (+ rotation, move).
 * @param p - Parameters.
 * @returns `true` if a text layer can represent them.
 */
export function isUniform(p: Readonly<TransformParams>): boolean {
  const ax = Math.abs(p.sx);
  const ay = Math.abs(p.sy);
  return Math.sign(p.sx) === Math.sign(p.sy) && Math.abs(ax - ay) <= UNIFORM_EPS * Math.max(ax, ay, 1);
}

/**
 * Text data for session parameters (pure; `p` must be {@link isUniform}).
 * @param start - Text data at session start.
 * @param centre - Its box centre, document px.
 * @param p - Parameters (box centre, scale, angle in radians).
 * @returns New text data.
 */
export function textDataAt(start: Readonly<TextData>, centre: { x: number; y: number }, p: Readonly<TransformParams>): TextData {
  // Both scales negative = a 180 deg turn at positive scale.
  const angle = p.sx < 0 ? p.angle + Math.PI : p.angle;
  const size = clampSize(start.size * Math.abs(p.sx));
  const k = size / start.size;
  const moved: TextData = { ...start, size, x: p.cx + k * (start.x - centre.x), y: p.cy + k * (start.y - centre.y) };
  return withRotation(moved, (angle * 180) / Math.PI);
}

/**
 * Rasterize a text layer as its OWN undo step (a later transform commit
 * must not join it, unlike the paint-on-text case).
 * @param s - Editor state.
 * @param layerId - Text layer id.
 * @returns `false` if the layer is not text (any more).
 */
export function rasterizeText(s: EditorState, layerId: string): boolean {
  const layer = s.doc.layers.find((l) => l.id === layerId);
  if (layer?.kind !== "text") return false;
  rasterizeLayer(s, layer);
  s.history.joinNext(() => false);
  return true;
}

/**
 * One text transform session.
 */
export class TextTransform {
  /** Session box: unrotated edit box size, document px. */
  readonly w: number;
  readonly h: number;
  /** Parameters at session start. */
  readonly startParams: TransformParams;
  private readonly centre: { x: number; y: number };

  private constructor(
    private readonly s: EditorState,
    readonly layerId: string,
    private readonly start: TextData,
    private readonly name: string,
  ) {
    const lay = textLayout(start);
    this.w = Math.max(1, lay.box.width);
    this.h = Math.max(1, lay.box.height);
    this.centre = { ...lay.centre };
    this.startParams = { cx: lay.centre.x, cy: lay.centre.y, sx: 1, sy: 1, angle: ((start.rotation ?? 0) * Math.PI) / 180 };
  }

  /**
   * Start a session on the current edit layer if it is text (a selection is
   * ignored: Photoshop transforms the text layer as a whole).
   * @param s - Editor state.
   * @returns Session, `"blocked"` (hidden / locked note shown) or `null` (not a text layer).
   */
  static begin(s: EditorState): TextTransform | "blocked" | null {
    const layer = activeEditLayer(s.doc, s.target, s.currentMaskId);
    if (layer?.kind !== "text" || !layer.textData) return null;
    const note = editBlockNote(s, layer);
    if (note) {
      s.events.emit("note", note);
      return "blocked";
    }
    return new TextTransform(s, layer.id, layer.textData, layer.name);
  }

  /** Whether the layer is still this session's text layer. */
  get valid(): boolean {
    return this.layer() !== undefined;
  }

  /**
   * Show parameters (re-render, no history).
   * @param p - Parameters.
   * @returns `false` (nothing changed) when `p` is not uniform.
   */
  apply(p: Readonly<TransformParams>): boolean {
    const layer = this.layer();
    if (!layer || !isUniform(p)) return false;
    this.show(layer, textDataAt(this.start, this.centre, p));
    return true;
  }

  /**
   * End the session: ONE text step when anything changed.
   * @returns `true` if a step was recorded.
   */
  commit(): boolean {
    const layer = this.layer();
    const td = layer?.textData;
    if (!layer || !td || sameTextData(td, this.start)) return false;
    const s = this.s;
    recordTextChange(s, layer.id, { kind: "text", name: this.name, textData: this.start }, { kind: "text", name: layer.name, textData: td });
    s.runtime.touch(layer.id);
    s.afterEdit();
    s.events.emit("layers", undefined);
    return true;
  }

  /** Put the start text back. */
  cancel(): void {
    const layer = this.layer();
    if (layer) this.show(layer, this.start);
  }

  private show(layer: Layer, td: TextData): void {
    if (layer.textData && sameTextData(layer.textData, td)) return;
    layer.textData = td;
    renderTextLayer(this.s, layer);
    this.s.runtime.bump(layer.id);
    this.s.events.emit("render", undefined);
  }

  private layer(): Layer | undefined {
    const layer = this.s.doc.layers.find((l) => l.id === this.layerId);
    return layer?.kind === "text" && layer.textData ? layer : undefined;
  }
}
