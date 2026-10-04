/**
 * Options strip under the tool dock (design handoff "Options strip"). It
 * renders the bound options' descriptors generically (`optionControls.ts`,
 * collapsed groups via `optionGroup.ts`, layout from {@link layoutOptions})
 * between a leading and a trailing part that depend on the editor state
 * (first match wins):
 *
 * 1. Free Transform: the session's options only (Commit as a light button,
 *    the proportion lock as a link icon).
 * 2. Region mode (the hidden region tool): "Regions" label + hint + Done
 *    (back to Layers).
 * 3. Align drawing (the hidden Move tool): "Align drawing" label, the
 *    tool's X / Y / Scale / Reset, Done.
 * 4. Otherwise: while a selection exists, "To mask" (adds the selection to
 *    the current cmask, or hides it on a targeted lmask; one undo step) and
 *    "Invert" lead (not for a pasted float's outline); then the tool's options; while a text edit is open, a
 *    trailing Done commits it.
 *
 * Size / Hardness / Width live on the sliders pill and are left out here
 * ({@link sliderKeys}). The strip never wraps; it is removed from its slot
 * while empty. Buttons never keep DOM focus (the keyboard scope redirects).
 */

import { readFirstMaskStyle } from "../defaults/readDefaults";
import { maskDisplayColor } from "../document/masks";
import type { Editor } from "../engine/editor";
import { REGION_TOOL_ID } from "../tools/region";
import { layoutOptions } from "../tools/options";
import type { OptionDescriptor, ToolOptions } from "../tools/options";
import type { EditorSession } from "../widget/sessions";
import { setIcon } from "./icons";
import { createControl } from "./optionControls";
import type { ControlContext, OptionControl } from "./optionControls";
import { groupControl } from "./optionGroup";
import type { PopoverHost } from "./popover";
import { sliderKeys } from "./slidersPill";

/** "To mask" tooltip with a mask layer (cmask) as the destination. */
const TO_MASK_TITLE = "Selection to mask: add the selection to the mask";
/** "To mask" tooltip while a layer mask (lmask) is targeted. */
const TO_LMASK_TITLE = "Selection to layer mask: hide the selection";
/** Text edit Done tooltip. */
const TEXT_DONE_TITLE = "Commit text (Esc \u00b7 Ctrl Enter) \u00b7 Enter adds a new line";
/** Id of the Align drawing tool. */
const ALIGN_TOOL_ID = "move";
/** Hint shown by the selection tools while nothing is selected (the strip would be empty otherwise). */
const SELECT_HINT = "Drag on the canvas \u00b7 \u21e7 add \u00b7 Alt subtract";
/** The magic wand's version. */
const WAND_HINT = "Click to select \u00b7 \u21e7 add \u00b7 Alt subtract";

/** What the strip needs from the host. */
export interface OptionsStripContext {
  popovers: PopoverHost;
  getSession(): EditorSession | null;
  /** An option changed (refresh sliders, cursor, notify the registry). */
  changed(): void;
  /** Region mode Done: back to the Layers tab. */
  leaveRegionMode(): void;
  /** Align drawing Done: toggle the mode off. */
  toggleMoveDrawing(): void;
}

/** Editor state that decides the strip's leading / trailing parts. */
type StripMode = "transform" | "region" | "align" | "normal";

/**
 * The options strip.
 */
export class OptionsStrip {
  /** The strip element (attached to the slot only while it has content). */
  readonly element: HTMLDivElement;
  private readonly lead: HTMLDivElement;
  private readonly body: HTMLDivElement;
  private readonly trail: HTMLDivElement;
  private options: ToolOptions | null = null;
  private controls: OptionControl[] = [];
  private stateKey = "";
  private toMask: { button: HTMLButtonElement; swatch: HTMLSpanElement } | null = null;

  /**
   * @param container - Shell slot (`shell.top.strip`).
   * @param ctx - Host callbacks.
   */
  constructor(
    private readonly container: HTMLElement,
    private readonly ctx: OptionsStripContext,
  ) {
    this.element = document.createElement("div");
    this.element.className = "cps-strip";
    this.lead = part("cps-strip-lead");
    this.body = part("cps-strip-body");
    this.trail = part("cps-strip-trail");
    this.element.append(this.lead, this.body, this.trail);
  }

  /**
   * Show options (rebuilds controls only when the options object changes,
   * so an in-progress scrub survives refreshes), then {@link sync}.
   * @param options - Options to edit (`ToolRegistry.barOptions()`), or `null`.
   */
  bind(options: ToolOptions | null): void {
    if (options !== this.options) {
      this.ctx.popovers.closeAnchoredIn(this.body);
      this.options = options;
      this.controls = [];
      this.body.replaceChildren();
      if (options) this.build(options);
    } else {
      this.refresh();
    }
    this.sync();
  }

  /** Re-read values from the bound options (after shortcuts changed them). */
  refresh(): void {
    for (const control of this.controls) control.refresh();
  }

  /**
   * Re-evaluate the state parts: selection actions, text Done, region /
   * align labels (call on selection, text, mask and tool changes).
   */
  sync(): void {
    const editor = this.ctx.getSession()?.editor ?? null;
    const mode = this.mode();
    // A pasted float's outline is no selection to act on: no To mask / Invert.
    const selection = mode === "normal" && editor?.selection.active === true && !editor.float.pasted;
    const text = mode === "normal" && editor?.text.editing != null;
    const tool = this.ctx.getSession()?.tools.active;
    // Selection tools with nothing selected: say what a drag / click does.
    const selectHint = mode === "normal" && !selection && tool?.combinesSelection === true ? (tool.id === "wand" ? WAND_HINT : SELECT_HINT) : "";
    const key = `${mode}|${selection}|${text}|${selectHint}`;
    if (key !== this.stateKey) {
      this.stateKey = key;
      this.ctx.popovers.closeAnchoredIn(this.lead);
      this.ctx.popovers.closeAnchoredIn(this.trail);
      this.buildLead(mode);
      this.buildTrail(mode, selection, text, selectHint);
    }
    if (editor) this.syncToMask(editor);
    this.attach();
  }

  /** Close popovers anchored in the strip and detach it. */
  dispose(): void {
    this.ctx.popovers.closeAnchoredIn(this.element);
    this.element.remove();
  }

  // ── State ───────────────────────────────────────────────────────────────

  private mode(): StripMode {
    const session = this.ctx.getSession();
    if (!session) return "normal";
    if (session.editor.float.transform.active) return "transform";
    const id = session.tools.active.id;
    if (id === REGION_TOOL_ID) return "region";
    if (id === ALIGN_TOOL_ID) return "align";
    return "normal";
  }

  /** In the slot while anything shows; out of it (no empty pill) otherwise. */
  private attach(): void {
    const empty = this.lead.childElementCount + this.body.childElementCount + this.trail.childElementCount === 0;
    if (empty) this.element.remove();
    else if (this.element.parentElement !== this.container) this.container.appendChild(this.element);
  }

  // ── Body (tool options) ─────────────────────────────────────────────────

  private build(options: ToolOptions): void {
    const hidden = sliderKeys(options);
    const descriptors = options.descriptors.filter((d) => !hidden.has(d.key));
    const ctx: ControlContext = { options, popovers: this.ctx.popovers, changed: () => this.ctx.changed() };
    for (const item of layoutOptions(descriptors, options.groups)) {
      if (item.kind === "separator") {
        this.body.appendChild(separator());
        continue;
      }
      const control = item.kind === "group" ? groupControl(item.group, item.descriptors, ctx) : stripControl(item.desc, ctx);
      this.controls.push(control);
      this.body.appendChild(control.element);
    }
  }

  // ── Lead / trail ────────────────────────────────────────────────────────

  private buildLead(mode: StripMode): void {
    this.lead.replaceChildren();
    if (mode === "region") {
      this.lead.append(stateLabel("region", "Regions"), hint("Drag to draw \u00b7 click a box to select"));
    } else if (mode === "align") {
      this.lead.append(stateLabel("alignDrawing", "Align drawing"));
    }
  }

  /**
   * Trailing part: the selection's own actions (To mask, Invert -- they act
   * on the selection itself, so they follow the tool's options), the empty
   * selection-tool hint, or the mode's Done button.
   */
  private buildTrail(mode: StripMode, selection: boolean, text: boolean, selectHint: string): void {
    this.toMask = null;
    this.trail.replaceChildren();
    if (mode === "region") {
      this.trail.append(lightButton("Done", "", () => this.ctx.leaveRegionMode()));
    } else if (mode === "align") {
      this.trail.append(lightButton("Done", "", () => this.ctx.toggleMoveDrawing()));
    } else if (selection) {
      const button = textButton("To mask", TO_MASK_TITLE, () => this.ctx.getSession()?.editor.selection.toMask());
      const swatch = document.createElement("span");
      swatch.className = "cps-strip-swatch";
      button.prepend(swatch);
      // The target can change without a selection event: refresh before the tooltip shows.
      button.addEventListener("pointerenter", () => {
        const editor = this.ctx.getSession()?.editor;
        if (editor) this.syncToMask(editor);
      });
      this.toMask = { button, swatch };
      // Invert changes the selection itself, so it has no "on" state.
      const invert = textButton("Invert", "Invert selection (Ctrl+Shift+I)", () => this.ctx.getSession()?.editor.selection.invert());
      if (this.body.childElementCount > 0) this.trail.append(separator());
      this.trail.append(button, invert);
    } else if (selectHint) {
      if (this.body.childElementCount > 0) this.trail.append(separator());
      this.trail.append(hint(selectHint));
    }
    if (text) {
      const done = lightButton("Done", TEXT_DONE_TITLE, () => this.ctx.getSession()?.editor.text.commit());
      const icon = document.createElement("span");
      icon.className = "cps-strip-icon";
      setIcon(icon, "check", 15);
      done.prepend(icon);
      this.trail.append(separator(), done);
    }
  }

  /** "To mask": the target cmask's colour swatch (`cmaskLayer`), or the selection-to-mask icon for a targeted lmask. */
  private syncToMask(editor: Editor): void {
    const parts = this.toMask;
    if (!parts) return;
    const lmask = editor.layerMask.targeted !== null;
    parts.button.title = lmask ? TO_LMASK_TITLE : TO_MASK_TITLE;
    parts.button.setAttribute("aria-label", parts.button.title);
    parts.swatch.classList.toggle("cps-strip-swatch-icon", lmask);
    if (lmask) {
      if (!parts.swatch.firstChild) setIcon(parts.swatch, "selectionToMask", 15);
      parts.swatch.style.backgroundColor = "";
      return;
    }
    parts.swatch.replaceChildren();
    const mask = editor.cmaskLayer;
    // No mask yet (old document): the colour the lazily added one will get.
    parts.swatch.style.backgroundColor = mask ? maskDisplayColor(mask) : readFirstMaskStyle().color;
  }
}

// ── Controls with a strip look ────────────────────────────────────────────────

/**
 * A descriptor's control, with the transform session's look: Commit as a
 * light button, Cancel as a text button, the proportion lock as a link icon.
 * @param desc - Descriptor.
 * @param ctx - Control context.
 * @returns The control.
 */
function stripControl(desc: OptionDescriptor, ctx: ControlContext): OptionControl {
  if (desc.kind === "button" && (desc.key === "commit" || desc.key === "cancel")) {
    const run = (): void => {
      ctx.options.set(desc.key, true);
      ctx.changed();
    };
    const commit = desc.key === "commit";
    const element = commit ? lightButton("Commit", desc.title ?? desc.label, run) : textButton("Cancel", desc.title ?? desc.label, run);
    if (commit) {
      const icon = document.createElement("span");
      icon.className = "cps-strip-icon";
      setIcon(icon, "check", 15);
      element.prepend(icon);
    } else {
      element.className = "cps-text-button cps-strip-cancel";
    }
    return { element, refresh: () => undefined };
  }
  if (desc.kind === "toggle" && desc.key === "lock") {
    const control = createControl({ ...desc, icon: "link" }, ctx);
    control.element.classList.add("cps-link-toggle");
    return control;
  }
  return createControl(desc, ctx);
}

// ── DOM helpers ───────────────────────────────────────────────────────────────

function part(className: string): HTMLDivElement {
  const el = document.createElement("div");
  el.className = `cps-strip-part ${className}`;
  return el;
}

function separator(): HTMLSpanElement {
  const sep = document.createElement("span");
  sep.className = "cps-bar-sep";
  return sep;
}

function hint(text: string): HTMLSpanElement {
  const el = document.createElement("span");
  el.className = "cps-strip-hint";
  el.textContent = text;
  return el;
}

function stateLabel(icon: string, text: string): HTMLSpanElement {
  const el = document.createElement("span");
  el.className = "cps-strip-state";
  const glyph = document.createElement("span");
  glyph.className = "cps-strip-icon";
  setIcon(glyph, icon, 16);
  el.append(glyph, text);
  return el;
}

function textButton(text: string, title: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "cps-toggle cps-command";
  button.textContent = text;
  if (title) {
    button.title = title;
    button.setAttribute("aria-label", title);
  }
  button.addEventListener("click", onClick);
  return button;
}

function lightButton(text: string, title: string, onClick: () => void): HTMLButtonElement {
  const button = textButton(text, title, onClick);
  button.className = "cps-light-button";
  return button;
}
