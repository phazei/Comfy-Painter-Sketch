/**
 * Pure focus decisions for the editor's keyboard scope (`keyboard.ts`).
 * Kept DOM-free (elements are described by plain {@link FocusTargetInfo}
 * records) so the rules are unit-testable without a browser.
 *
 * Rules (see `keyboard.ts` module doc for the full story):
 * - A pointerdown inside the editor root on a text-entry element lets the
 *   browser focus it (the user is about to type there).
 * - A pointerdown on a native `<input type=range>` keeps the browser default
 *   too: `preventDefault()` on pointerdown suppresses the compatibility
 *   `mousedown` that drives native slider dragging.
 * - Any other pointerdown inside the root is prevented (no focus move) and
 *   the hidden key sink takes focus -- stealing it from text fields in other
 *   nodes, since the user clearly addressed the editor.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

/** The parts of an element the focus rules look at. */
export interface FocusTargetInfo {
  /** Upper-case tag name (`Element.tagName`). */
  tagName: string;
  /** `type` of an `<input>` (lower-case). */
  type?: string;
  /** `isContentEditable` of an HTML element. */
  editable?: boolean;
}

/**
 * What a pointerdown inside the root does with focus:
 * - `"text"`: browser default (text entry gets focus);
 * - `"native"`: browser default, the control needs it (range slider);
 * - `"sink"`: `preventDefault()` and focus the key sink.
 */
export type PointerFocusAction = "text" | "native" | "sink";

/** Inputs whose `type` is not a text entry. */
const NON_TEXT_INPUTS = ["range", "checkbox", "radio", "button", "submit", "reset", "color", "file", "image"];

// ── Classification ────────────────────────────────────────────────────────────

/**
 * Whether an element is a text-entry field (typing goes to it). `<select>`
 * counts: it needs native focus to open and handles keys itself.
 * @param info - Element description.
 * @returns `true` for text inputs, textareas, selects and contenteditable.
 */
export function isTextEntry(info: FocusTargetInfo): boolean {
  if (info.tagName === "TEXTAREA" || info.tagName === "SELECT") return true;
  if (info.tagName === "INPUT") return !NON_TEXT_INPUTS.includes((info.type ?? "text").toLowerCase());
  return info.editable === true;
}

/**
 * Whether an element is a native range slider.
 * @param info - Element description.
 * @returns `true` for `<input type=range>`.
 */
export function isRangeInput(info: FocusTargetInfo): boolean {
  return info.tagName === "INPUT" && (info.type ?? "").toLowerCase() === "range";
}

/**
 * Focus handling for a pointerdown on an element inside the editor root.
 * @param info - Target element description.
 * @returns The action (see {@link PointerFocusAction}).
 */
export function pointerFocusAction(info: FocusTargetInfo): PointerFocusAction {
  if (isTextEntry(info)) return "text";
  if (isRangeInput(info)) return "native";
  return "sink";
}

/**
 * Whether an element inside the root may keep DOM focus (anything else is
 * redirected to the key sink so ChangeTracker keeps ignoring Ctrl+Z).
 * @param info - Focused element description.
 * @returns `true` for text entries and range sliders.
 */
export function mayKeepFocus(info: FocusTargetInfo): boolean {
  return pointerFocusAction(info) !== "sink";
}

// ── Scope state ───────────────────────────────────────────────────────────────

/** Inputs of {@link isScopeActive}. */
export interface ScopeState {
  /** Pointer is over the root. */
  hovered: boolean;
  /** A drag that started inside is in progress. */
  held: boolean;
  /** The user pressed inside the root and has not pressed/focused elsewhere since. */
  engaged: boolean;
  /** Fullscreen is open. */
  fullscreen: boolean;
}

/**
 * Whether the editor's key listeners should be installed.
 * @param state - Current scope state.
 * @returns `true` while any reason to capture keys holds.
 */
export function isScopeActive(state: ScopeState): boolean {
  return state.hovered || state.held || state.engaged || state.fullscreen;
}

/**
 * Whether hovering may move focus to the key sink. Hover never steals focus
 * from a text field (ours or another node's); a click does (see module doc).
 * @param focused - Currently focused element, or `null` for none/body.
 * @returns `true` if the sink may take focus.
 */
export function hoverMayTakeFocus(focused: FocusTargetInfo | null): boolean {
  return focused === null || !isTextEntry(focused);
}

/**
 * Describe a DOM element for the rules above.
 * @param element - Element.
 * @returns Its {@link FocusTargetInfo}.
 */
export function describeElement(element: Element): FocusTargetInfo {
  const info: FocusTargetInfo = { tagName: element.tagName.toUpperCase() };
  if (element instanceof HTMLInputElement) info.type = element.type;
  if (element instanceof HTMLElement && element.isContentEditable) info.editable = true;
  return info;
}
