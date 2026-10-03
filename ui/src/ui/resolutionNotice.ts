/**
 * Drawing-resolution mismatch notice (SPEC "Layers" > "Background row and
 * drawing resolution"; design handoff section 6 "Resolution notice"): an
 * amber floating pill above the bottom bar's right end (`shell.noticeSlot`)
 * with a warning icon, "Drawing grid G px -- image I px (N.Nx)", a light
 * **Match image resolution** button and a × that hides the pill until the
 * notice text changes. While the condition holds, `setWarning(true)` turns
 * the bottom bar's Align button amber -- also while the pill is hidden. A
 * one-time toast per document per session points to the button. Second case
 * (same button, own toast): the image area doesn't fit the maximum paint
 * area. If both apply, the resolution message wins (Match fixes both).
 * Never for an empty document (it adopts the size) or while loading. The
 * math lives in `engine/drawingResolution.ts`.
 */

import type { Editor } from "../engine/editor";
import { notify } from "../widget/toast";
import { setIcon } from "./icons";

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
 * The notice pill plus its side effects.
 */
export class ResolutionNotice {
  /** Root element (mount in `shell.noticeSlot`). */
  readonly element: HTMLDivElement;
  private readonly label: HTMLSpanElement;
  private editor: Editor | null = null;
  /** Current notice text (`""` = no notice); `null` = not synced yet. */
  private text: string | null = null;
  /** Text the user hid with ×; the pill stays hidden until the text changes. */
  private dismissed: string | null = null;

  /**
   * @param setWarning - Turns the Align drawing button amber / back.
   * @param beforeMatch - Cancel drags / pending tool interactions first.
   */
  constructor(
    private readonly setWarning: (on: boolean) => void,
    private readonly beforeMatch: () => void,
  ) {
    this.element = document.createElement("div");
    this.element.className = "cps-notice-pill";
    this.element.hidden = true;
    const icon = document.createElement("span");
    icon.className = "cps-notice-icon";
    setIcon(icon, "warning", 16);
    this.label = document.createElement("span");
    this.label.className = "cps-notice-label";
    const match = document.createElement("button");
    match.type = "button";
    match.className = "cps-light-button cps-notice-match";
    match.textContent = "Match image resolution";
    match.title = "Resample all layers to the current image resolution (clears undo history)";
    match.addEventListener("click", () => this.confirmMatch());
    const hide = document.createElement("button");
    hide.type = "button";
    hide.className = "cps-icon-button cps-notice-hide";
    hide.title = "Hide (Align drawing stays amber)";
    hide.setAttribute("aria-label", "Hide");
    setIcon(hide, "close", 16);
    hide.addEventListener("click", () => this.dismiss());
    this.element.append(icon, this.label, match, hide);
  }

  /**
   * Bind to an editor (or none) and sync.
   * @param editor - Editor shown by the host.
   */
  setEditor(editor: Editor | null): void {
    this.editor = editor;
    this.text = null;
    this.dismissed = null;
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
    if (text === this.text) return;
    this.text = text;
    // A different notice (or none) ends the user's hide.
    if (text !== this.dismissed) this.dismissed = null;
    const show = notice !== null;
    this.element.hidden = !show || this.dismissed !== null;
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

  /** ×: hide the pill until the notice text changes (the Align button stays amber). */
  private dismiss(): void {
    if (!this.text) return;
    this.dismissed = this.text;
    this.element.hidden = true;
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
