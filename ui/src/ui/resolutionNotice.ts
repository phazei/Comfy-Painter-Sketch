/**
 * Drawing-resolution mismatch notice (SPEC "Layers" > "Background row and drawing resolution"): when the
 * current image is more than 1.5x finer than the drawing grid, the options bar
 * shows "Drawing grid W px -- image W px (N.Nx)" and a **Match image
 * resolution** button (every tool), the Align drawing footer icon turns red
 * (via `setWarning`) and a one-time toast per document per session points to
 * the button. Second case (same button / icon, own toast): the image area
 * doesn't fit the maximum paint area. If both apply, the resolution message
 * wins (Match fixes both). Never for an empty document (it adopts the size).
 * The math lives in `engine/drawingResolution.ts`.
 */

import type { Editor } from "../engine/editor";
import { notify } from "../widget/toast";

/** Notices already toasted this session (`kind:docId`). */
const toldDocs = new Set<string>();

/** Label (and toast lead) when the image's shape doesn't fit the paint area. */
const FIT_LABEL = "The image's shape doesn't fit the drawing \u2014 parts can't be painted.";

/** Confirm text before resampling. */
const CONFIRM_TEXT = "Resample all layers to the current image resolution? This clears the undo history.";

/** Extra confirm line when paint far outside the image would be cut off. */
const CROP_TEXT = "\n\nSome paint far outside the image exceeds the 16384 px paint-area limit and will be cropped.";

/**
 * Format a ratio for display (`2.3x`).
 * @param ratio - Resample factor.
 * @returns Label.
 */
export function formatRatio(ratio: number): string {
  return `${(Math.floor(ratio * 10) / 10).toFixed(1)}x`;
}

/**
 * The notice element in the options bar plus its side effects.
 */
export class ResolutionNotice {
  /** Root element (goes into the bar's trailing area). */
  readonly element: HTMLDivElement;
  private readonly label: HTMLSpanElement;
  private readonly button: HTMLButtonElement;
  private editor: Editor | null = null;
  /** Last shown label (`""` = hidden); skips DOM writes on unchanged syncs. */
  private shown: string | null = null;

  /**
   * @param setWarning - Turns the Align drawing icon red / back.
   * @param beforeMatch - Cancel drags / pending tool interactions first.
   */
  constructor(
    private readonly setWarning: (on: boolean) => void,
    private readonly beforeMatch: () => void,
  ) {
    this.element = document.createElement("div");
    this.element.className = "cps-resolution-notice";
    this.element.hidden = true;
    this.label = document.createElement("span");
    this.label.className = "cps-resolution-label";
    this.button = document.createElement("button");
    this.button.type = "button";
    this.button.className = "cps-toggle cps-resolution-match";
    this.button.textContent = "Match image resolution";
    this.button.title = "Resample all layers to the current image resolution (clears undo history)";
    this.button.addEventListener("click", () => this.confirmMatch());
    this.element.append(this.label, this.button);
  }

  /**
   * Bind to an editor (or none) and sync.
   * @param editor - Editor shown by the host.
   */
  setEditor(editor: Editor | null): void {
    this.editor = editor;
    this.shown = null;
    this.sync();
  }

  /** Re-evaluate the mismatch (after frame, placement or image-size changes). */
  sync(): void {
    const editor = this.editor;
    const notice = editor && !editor.loading ? editor.resolution.notice() : null;
    const ratio = notice ? formatRatio(notice.info.ratio) : "";
    const text = !notice ? ""
      : notice.kind === "resolution" ? `Drawing grid ${notice.info.gridPx} px \u2014 image ${notice.info.imagePx} px (${ratio})`
      : FIT_LABEL;
    if (text === this.shown) return;
    this.shown = text;
    const show = notice !== null;
    this.element.hidden = !show;
    this.setWarning(show);
    this.label.textContent = text;
    if (!notice || !editor) return;
    const told = `${notice.kind}:${editor.doc.docId}`;
    if (toldDocs.has(told)) return;
    toldDocs.add(told);
    if (notice.kind === "resolution") {
      notify("warn", `The image is ${ratio} the drawing's resolution \u2014 use Match image resolution for full detail.`, {
        key: `resolution-mismatch:${editor.doc.docId}`,
      });
    } else {
      notify("warn", `${FIT_LABEL} Use Match image resolution to fix it.`, { key: `resolution-fit:${editor.doc.docId}` });
    }
  }

  /** Button: confirm, then resample. */
  private confirmMatch(): void {
    const editor = this.editor;
    if (!editor || editor.loading || !editor.resolution.notice()) return;
    const text = CONFIRM_TEXT + (editor.resolution.wouldCrop() ? CROP_TEXT : "");
    if (!window.confirm(text)) return;
    this.beforeMatch();
    editor.matchImageResolution();
    this.sync();
  }
}
