/**
 * Text tool (T, SPEC "Tools" > "Text (T)"): point text on text layers.
 *
 * - Click empty canvas: new text layer above the active paint layer, opened
 *   in the in-canvas `<textarea>` (`ui/textOverlay.ts`). Quick Mask is
 *   switched back to the paint target first (no type-mask).
 * - Click an existing text (top-most visible text box): re-edit that layer.
 * - While editing, a click on the canvas commits (clicking another text
 *   switches to it); Esc / Ctrl+Enter in the textarea commit too. Switching
 *   tools, layers-panel edits and undo also commit (the edit is a
 *   {@link Tool.pending} interaction, cancelled = committed).
 * - Ctrl+drag moves the text under the pointer (or the active text layer)
 *   through the Move tool's per-kind handler (`engine/layerMovers.ts`).
 * - Options: font (suggestions: recent fonts from
 *   `localStorage["PainterSketch.recentFonts"]`, then a curated list, plus
 *   "Custom font..."), size in image px (converted with the frame-map
 *   scale, like brush size), bold, italic, alignment. Colour = FG. While
 *   editing, option and FG changes apply live to the edited text.
 * - Angle: rotation of the edited text, else of the active text
 *   layer (one merged text step per run of changes, `TextOps.setRotation`).
 */

import { clampSize, MAX_FONT_LENGTH, parseRecentFonts, pushRecentFont } from "../document/textData";
import type { TextAlign, TextData } from "../document/textData";
import type { Editor } from "../engine/editor";
import { dragDelta } from "../engine/translateMath";
import type { Point } from "../geometry/rect";
import { OptionSet } from "./options";
import type { OptionDescriptor, OptionValue } from "./options";
import type { Tool, ToolCursor, ToolPointer } from "./types";

/** Widely available fonts offered in the font menu. */
export const CURATED_FONTS: readonly string[] = [
  "sans-serif",
  "serif",
  "monospace",
  "Arial",
  "Helvetica",
  "Verdana",
  "Tahoma",
  "Trebuchet MS",
  "Segoe UI",
  "Georgia",
  "Times New Roman",
  "Courier New",
  "Impact",
  "Comic Sans MS",
];

/** `localStorage` key of the recent-font list. */
export const RECENT_FONTS_KEY = "PainterSketch.recentFonts";

/** Stored options (size in image px). */
type TextToolValues = {
  font: string;
  size: number;
  bold: boolean;
  italic: boolean;
  align: TextAlign;
  /** Rotation of the selected / edited text layer, degrees (mirrors the layer). */
  angle: number;
};

/** Largest size option, image px. */
const MAX_SIZE_OPTION = 1000;

/**
 * Font menu: recent fonts first, then the curated list (case-insensitive
 * de-duplication).
 * @param recent - Recent fonts, newest first.
 * @returns Menu entries.
 */
export function fontSuggestions(recent: readonly string[]): string[] {
  const seen = new Set(recent.map((f) => f.toLowerCase()));
  return [...recent, ...CURATED_FONTS.filter((f) => !seen.has(f.toLowerCase()))];
}

function readRecentFonts(): string[] {
  try {
    return parseRecentFonts(globalThis.localStorage?.getItem(RECENT_FONTS_KEY) ?? null);
  } catch {
    return [];
  }
}

function rememberFont(font: string): void {
  try {
    globalThis.localStorage?.setItem(RECENT_FONTS_KEY, JSON.stringify(pushRecentFont(readRecentFonts(), font)));
  } catch {
    // Storage full / disabled: recents are a convenience only.
  }
}

/** Options whose successful `set` notifies the tool (live edits). */
class TextOptionSet extends OptionSet {
  constructor(
    descriptors: readonly OptionDescriptor[],
    private readonly store: TextToolValues,
    private readonly changed: (key: string) => void,
    private readonly angle: () => number,
  ) {
    super(descriptors, store);
  }

  /** The angle field always shows the target text layer's rotation. */
  override get(key: string): OptionValue | undefined {
    return key === "angle" ? this.angle() : super.get(key);
  }

  /** @inheritdoc */
  override set(key: string, value: OptionValue): boolean {
    if (key === "angle") this.store.angle = this.angle();
    const changed = super.set(key, value);
    if (changed) this.changed(key);
    return changed;
  }
}

/**
 * The text tool (one per session; it follows its editor's text edits).
 */
export class TextTool implements Tool {
  readonly id = "text";
  readonly label = "Text";
  readonly shortcut = "t";
  readonly icon = "text";
  /** Ctrl+drag moves the text layer itself (below), so Ctrl never swaps in the Move tool. */
  readonly ctrlMove = false;
  /** Ctrl+drag moves the text: show the move cursor as soon as Ctrl is held. */
  readonly ctrlCursor = "move";
  readonly options: OptionSet;
  /** Stored option values (edited in place through {@link options}). */
  readonly values: TextToolValues = { font: "sans-serif", size: 48, bold: false, italic: false, align: "left", angle: 0 };
  /** Ctrl+drag move in progress: pointer-down position, document coords. */
  private moveStart: Point | null = null;
  /** Layer whose edit the option values were last loaded from. */
  private syncedLayerId: string | null = null;
  /** Set while this tool creates a layer (its values already match). */
  private creating = false;

  /**
   * @param editor - Session editor (live option/colour changes, edit sync).
   */
  constructor(private readonly editor: Editor) {
    const descriptors: OptionDescriptor[] = [
      {
        kind: "text",
        key: "font",
        label: "Font",
        title: "Font family (recent fonts first; Custom font\u2026 types any installed font)",
        suggestions: () => fontSuggestions(readRecentFonts()),
        customLabel: "Custom font\u2026",
        maxLength: MAX_FONT_LENGTH,
        previewFont: true,
      },
      { kind: "number", key: "size", label: "Size", title: "Font size in image px ([ / ])", min: 1, max: MAX_SIZE_OPTION, step: 1, unit: "px", curve: "pow" },
      { kind: "toggle", key: "bold", label: "Bold", title: "Bold", icon: "bold", group: "style" },
      { kind: "toggle", key: "italic", label: "Italic", title: "Italic", icon: "italic", group: "style" },
      {
        kind: "select",
        key: "align",
        label: "Align",
        title: "Alignment to the click point",
        group: "style",
        choices: [
          { value: "left", label: "Left" },
          { value: "center", label: "Center" },
          { value: "right", label: "Right" },
        ],
      },
      {
        kind: "number",
        key: "angle",
        label: "Angle",
        title: "Rotation of the edited / selected text layer, degrees (Ctrl+Alt+T: rotate and scale on the canvas)",
        min: -180,
        max: 180,
        step: 0.1,
        unit: "\u00b0",
      },
    ];
    this.options = new TextOptionSet(descriptors, this.values, (key) => this.optionChanged(key), () => this.angleTarget()?.rotation ?? 0);
    editor.events.on("text", () => this.syncFromEdit());
    editor.colors.events.on("change", (colors) => {
      if (editor.text.editing) editor.text.update({ color: colors.fg });
    });
  }

  /** @inheritdoc */
  onPointerDown(editor: Editor, samples: readonly ToolPointer[]): void {
    const p = samples[0];
    if (!p) return;
    if (p.ctrlKey) {
      this.startMove(editor, p);
      return;
    }
    // A text click drops the selection (it would otherwise linger over the new text).
    // Not in the lmask-only view, where the click is refused.
    if (editor.layerMask.viewing === null) editor.selection.deselect();
    const open = editor.text.editing;
    const hit = editor.text.hitTest(p);
    if (open) {
      // Clicking away commits; clicking another text switches to it.
      editor.text.commit();
      if (!hit || hit === open.layerId) return;
    }
    if (editor.paintTarget === "mask") editor.setPaintTarget("paint");
    if (hit) {
      editor.text.edit(hit);
      return;
    }
    this.create(editor, p);
  }

  /** @inheritdoc */
  onPointerMove(editor: Editor, samples: readonly ToolPointer[]): void {
    const last = samples[samples.length - 1];
    if (this.moveStart && last) {
      const d = dragDelta(this.moveStart, last);
      editor.layerMove.preview(d.x, d.y);
    }
  }

  /** @inheritdoc */
  onPointerUp(editor: Editor, sample: ToolPointer): void {
    if (!this.moveStart) return;
    this.onPointerMove(editor, [sample]);
    this.moveStart = null;
    editor.layerMove.commit();
  }

  /** Aborts a Ctrl+drag; otherwise commits the open edit (tool switch, detach, Esc). */
  onCancel(editor: Editor): void {
    if (this.moveStart) {
      this.moveStart = null;
      editor.layerMove.cancel();
      return;
    }
    editor.text.commit();
  }

  /** An open text edit stays open between presses. @returns `true` while editing. */
  pending(): boolean {
    return this.editor.text.editing !== null && !this.moveStart;
  }

  /** @inheritdoc */
  cursor(): ToolCursor {
    if (this.moveStart) return { kind: "icon", icon: "move" };
    // The lmask-only view refuses creating and editing text (no text is visible there).
    return { kind: "icon", icon: "text", ban: this.editor.layerMask.viewing !== null };
  }

  // ── Internals ───────────────────────────────────────────────────────────

  private create(editor: Editor, p: ToolPointer): void {
    const v = this.values;
    this.creating = true;
    try {
      editor.text.create(
        { x: Math.round(p.x), y: Math.round(p.y) },
        { font: v.font, size: this.docSize(editor), color: editor.colors.fg, bold: v.bold, italic: v.italic, align: v.align },
      );
    } finally {
      this.creating = false;
    }
    rememberFont(v.font);
  }

  /** Ctrl+drag: move the text under the pointer, else the active text layer. */
  private startMove(editor: Editor, p: ToolPointer): void {
    editor.text.commit();
    const active = editor.doc.layers.find((l) => l.id === editor.doc.activeLayerId);
    const target = editor.text.hitTest(p) ?? (active?.kind === "text" ? active.id : null);
    if (!target) return;
    if (editor.paintTarget === "mask") editor.setPaintTarget("paint");
    editor.layerOps.setActiveLayer(target);
    if (editor.layerMove.begin()) this.moveStart = { x: p.x, y: p.y };
  }

  /** Size option (image px) in document px for the current image. */
  private docSize(editor: Editor): number {
    return clampSize(this.values.size / editor.frameMap.scale);
  }

  /** A user option change: apply it live to the open edit. */
  private optionChanged(key: string): void {
    const editor = this.editor;
    const v = this.values;
    if (key === "font") rememberFont(v.font);
    if (key === "angle") {
      const id = editor.text.editing?.layerId ?? editor.doc.activeLayerId;
      editor.text.setRotation(id, v.angle);
      return;
    }
    if (!editor.text.editing) return;
    if (key === "font") editor.text.update({ font: v.font });
    else if (key === "size") editor.text.update({ size: this.docSize(editor) });
    else if (key === "bold") editor.text.update({ bold: v.bold });
    else if (key === "italic") editor.text.update({ italic: v.italic });
    else if (key === "align") editor.text.update({ align: v.align });
  }

  /** Text data the angle field shows / sets: the open edit, else the active layer if it is text. */
  private angleTarget(): Readonly<TextData> | undefined {
    const edit = this.editor.text.editing;
    if (edit) return edit.textData;
    const active = this.editor.doc.layers.find((l) => l.id === this.editor.doc.activeLayerId);
    return active?.kind === "text" ? active.textData : undefined;
  }

  /** A re-edit started: show that layer's style in the options and FG swatch. */
  private syncFromEdit(): void {
    const edit = this.editor.text.editing;
    const id = edit?.layerId ?? null;
    if (id === this.syncedLayerId) return;
    this.syncedLayerId = id;
    if (!edit || this.creating) return;
    const td = edit.textData;
    const v = this.values;
    v.font = td.font;
    v.size = Math.min(MAX_SIZE_OPTION, Math.max(1, Math.round(td.size * this.editor.frameMap.scale)));
    v.bold = td.bold;
    v.italic = td.italic;
    v.align = td.align;
    this.editor.colors.set("fg", td.color);
  }
}

/**
 * Create the text tool.
 * @param editor - Session editor.
 * @returns The tool.
 */
export function createTextTool(editor: Editor): TextTool {
  return new TextTool(editor);
}
