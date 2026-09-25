/**
 * Pure collapse logic of the right side panel: auto-collapsed while the
 * editor is narrow, open when wide; a user toggle wins until the editor
 * crosses into a different size class (then the automatic choice applies
 * again). Kept pure so it is unit-testable.
 */

/** Editor width classes. */
export type SizeClass = "narrow" | "wide";

/** Editor widths below this (CSS px) are "narrow". */
export const NARROW_EDITOR_WIDTH = 520;

/** Collapse state. */
export interface PanelState {
  /** Size class last seen (`null` before the first measurement). */
  sizeClass: SizeClass | null;
  /** User's explicit choice for this size class, or `null` = automatic. */
  userCollapsed: boolean | null;
}

/** Initial state (automatic, not yet measured). */
export const INITIAL_PANEL_STATE: Readonly<PanelState> = { sizeClass: null, userCollapsed: null };

/**
 * Size class of an editor width.
 * @param width - Editor root width, CSS px.
 * @returns `"narrow"` below {@link NARROW_EDITOR_WIDTH}, else `"wide"`.
 */
export function sizeClassOf(width: number): SizeClass {
  return width < NARROW_EDITOR_WIDTH ? "narrow" : "wide";
}

/**
 * Whether the panel is collapsed in a state.
 * @param state - Panel state.
 * @returns `true` when collapsed.
 */
export function isPanelCollapsed(state: Readonly<PanelState>): boolean {
  if (state.userCollapsed !== null) return state.userCollapsed;
  return state.sizeClass !== "wide";
}

/**
 * The editor was resized. Zero widths (hidden/unmounted) are ignored.
 * @param state - Current state.
 * @param width - New editor width, CSS px.
 * @returns Next state (same object if nothing changed).
 */
export function panelResized(state: Readonly<PanelState>, width: number): Readonly<PanelState> {
  if (!(width > 0)) return state;
  const sizeClass = sizeClassOf(width);
  if (sizeClass === state.sizeClass) return state;
  return { sizeClass, userCollapsed: null };
}

/**
 * The user (or an API caller) set the collapsed state explicitly.
 * @param state - Current state.
 * @param collapsed - Requested state.
 * @returns Next state.
 */
export function panelSetByUser(state: Readonly<PanelState>, collapsed: boolean): Readonly<PanelState> {
  return { sizeClass: state.sizeClass, userCollapsed: collapsed };
}
