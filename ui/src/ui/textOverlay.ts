/**
 * In-canvas text editor of the Text tool (SPEC M6b): a `<textarea>` laid
 * over the edited text layer while `Editor.text` has an open edit, plus the
 * UI half of the rasterize prompt (`window.confirm`, installed on the
 * editor since the engine has no DOM UI).
 *
 * WYSIWYG: the canvas shows the real rendering (the layer re-renders on
 * every input); the textarea's own text is transparent and only provides
 * the caret, selection highlight and native editing (incl. Ctrl+Z = text
 * undo). It is laid out in DOCUMENT px -- same font string, line height and
 * alignment as `engine/textRender.ts` -- and mapped onto the stage with one
 * CSS transform: document -> image through `Editor.frameMap` (frame fit +
 * placement), image -> stage through the view. So the caret lines up with
 * the glyphs at any zoom, pan, image size or graph zoom (the stage's own
 * CSS scale applies to the textarea too). It re-positions after every
 * stage render (`StageView.onRendered`).
 *
 * Keys: Enter = new line; Esc or Ctrl+Enter commit. The keyboard scope
 * leaves keys from text fields alone (`focusPolicy.ts`), so no editor
 * shortcut fires while typing. Focus: clicking non-text editor controls
 * (e.g. Bold) moves focus to the key sink; the textarea takes it back.
 * Focus leaving the editor commits.
 */

import { MAX_TEXT_LENGTH } from "../document/textData";
import type { TextData } from "../document/textData";
import type { Editor } from "../engine/editor";
import { RASTERIZE_PROMPT } from "../engine/rasterize";
import { fontString, textLayout } from "../engine/textRender";
import type { EditorSession } from "../widget/sessions";

/** Caret room added to the widest line, as a fraction of the font size (min 2 doc px). */
const CARET_PAD = 0.1;

/**
 * Text editing UI of one editor host.
 */
export class TextOverlay {
  private editor: Editor | null = null;
  private area: HTMLTextAreaElement | null = null;
  private layerId: string | null = null;
  private unbind: (() => void) | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly rootFocusIn = (event: FocusEvent): void => {
    // The key sink took focus from the textarea (a click on a non-text control): take it back.
    const target = event.target;
    if (this.area && target instanceof HTMLElement && target.classList.contains("cps-focus-sink")) this.later(() => this.area?.focus({ preventScroll: true }));
  };

  /**
   * @param stage - Stage element (the textarea is placed in it).
   * @param root - Editor root (focus tracking).
   * @param onEditChange - An edit opened/changed/closed (refresh the options bar).
   */
  constructor(
    private readonly stage: HTMLElement,
    private readonly root: HTMLElement,
    private readonly onEditChange: () => void,
  ) {
    root.addEventListener("focusin", this.rootFocusIn);
  }

  /**
   * Follow a session's text edits (or none).
   * @param session - Session shown by the host.
   */
  bind(session: EditorSession | null): void {
    this.unbind?.();
    this.unbind = null;
    this.editor = session?.editor ?? null;
    if (this.editor) {
      this.editor.text.setConfirmRasterize(() => window.confirm(RASTERIZE_PROMPT));
      this.unbind = this.editor.events.on("text", () => {
        this.onEditChange();
        this.sync();
      });
    }
    this.sync();
  }

  /** Open, update, re-position or close the textarea to match the editor. */
  sync(): void {
    const editor = this.editor;
    const edit = editor?.text.editing ?? null;
    if (!editor || !edit) {
      this.close();
      return;
    }
    if (!this.area || this.layerId !== edit.layerId) {
      this.close();
      this.open(edit.layerId, edit.textData.text);
    }
    const area = this.area;
    if (!area) return;
    if (area.value !== edit.textData.text) area.value = edit.textData.text;
    this.layout(area, editor, edit.textData);
  }

  /** Remove the textarea and listeners. */
  dispose(): void {
    this.bind(null);
    this.root.removeEventListener("focusin", this.rootFocusIn);
  }

  // ── Internals ───────────────────────────────────────────────────────────

  private open(layerId: string, text: string): void {
    const area = document.createElement("textarea");
    area.className = "cps-text-edit";
    area.wrap = "off";
    area.spellcheck = false;
    area.autocomplete = "off";
    area.setAttribute("autocapitalize", "off");
    area.setAttribute("aria-label", "Text");
    area.rows = 1;
    area.maxLength = MAX_TEXT_LENGTH;
    area.value = text;
    area.addEventListener("input", () => this.editor?.text.update({ text: area.value }));
    area.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" && !(event.key === "Enter" && (event.ctrlKey || event.metaKey))) return;
      event.preventDefault();
      event.stopPropagation();
      this.editor?.text.commit();
    });
    // Caret placement inside the text must not reach the stage (it would commit).
    area.addEventListener("pointerdown", (event) => event.stopPropagation());
    area.addEventListener("blur", () => this.later(() => this.focusLeft()));
    // The box always fits the text: never let it scroll its content.
    area.addEventListener("scroll", () => {
      area.scrollTop = 0;
      area.scrollLeft = 0;
    });
    this.stage.appendChild(area);
    this.area = area;
    this.layerId = layerId;
    area.focus({ preventScroll: true });
    area.setSelectionRange(area.value.length, area.value.length);
  }

  /** Commit when focus went outside the editor (graph, another node, the page). */
  private focusLeft(): void {
    const active = document.activeElement;
    if (!this.area || active === this.area) return;
    if (active && active !== document.body && this.root.contains(active)) return;
    this.editor?.text.commit();
  }

  private layout(area: HTMLTextAreaElement, editor: Editor, td: Readonly<TextData>): void {
    const lay = textLayout(td);
    const map = editor.frameMap;
    const view = editor.view.current;
    // Stage CSS px per document px.
    const k = map.scale * view.scale;
    const pad = Math.max(2, td.size * CARET_PAD);
    const left = lay.box.x - (td.align === "right" ? pad : td.align === "center" ? pad / 2 : 0);
    const sx = (map.offsetX + left * map.scale) * view.scale + view.offsetX;
    const sy = (map.offsetY + lay.box.y * map.scale) * view.scale + view.offsetY;
    const style = area.style;
    style.transform = `translate(${sx}px, ${sy}px) scale(${k})`;
    style.width = `${lay.box.width + pad}px`;
    style.height = `${lay.box.height}px`;
    style.font = fontString(td);
    style.lineHeight = `${lay.lineHeight}px`;
    style.textAlign = td.align;
    style.caretColor = td.color;
    style.outlineWidth = `${1 / Math.max(k, 1e-6)}px`;
    style.outlineOffset = `${pad / 2}px`;
  }

  private close(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    const area = this.area;
    if (!area) return;
    this.area = null;
    this.layerId = null;
    if (document.activeElement === area) area.blur();
    area.remove();
  }

  /** Run after the current event (focus has settled). */
  private later(fn: () => void): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      fn();
    }, 0);
  }
}
