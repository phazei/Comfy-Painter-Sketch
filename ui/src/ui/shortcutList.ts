/**
 * The one shortcut list behind the help overlay (`helpOverlay.ts`; design
 * handoff section 9). A condensed copy of SPEC section 24 "Shortcuts": one
 * row per key or key pair, short action text, grouped into the overlay's
 * eight section cards. When a binding changes, update SPEC section 24 and
 * this list together (`shortcuts.ts` stays the implementation). Only the
 * editor's own keys: ComfyUI keys the editor merely lets through or wraps
 * (Ctrl+S save, Ctrl+Enter queue) are not listed. User-facing wording: an
 * lmask is "Layer Mask", a cmask is "Mask" (internal terms stay out).
 */

/** One row: the keys (or click / drag gesture) and what they do. */
export interface ShortcutRow {
  readonly keys: string;
  readonly action: string;
}

/** A titled group of rows (one card in the overlay). */
export interface ShortcutSection {
  readonly title: string;
  readonly rows: readonly ShortcutRow[];
}

/**
 * The "Essentials" band at the top of the overlay: a curated handful of the
 * keys used most, repeated from the sections below (keep both in sync).
 */
export const QUICK_ROWS: readonly ShortcutRow[] = [
  { keys: "Ctrl Z / Ctrl ⇧ Z", action: "Undo / redo" },
  { keys: "B / E", action: "Brush / eraser" },
  { keys: "[ / ]", action: "Brush size" },
  { keys: "1..9 / 0", action: "Opacity" },
  { keys: "X", action: "Swap colours" },
  { keys: "Alt (hold)", action: "Eyedropper" },
  { keys: "Ctrl (hold)", action: "Move layer" },
  { keys: "⇧ click", action: "Straight line" },
  { keys: "Space drag", action: "Pan" },
  { keys: "Ctrl 0", action: "Fit to view" },
  { keys: "Q", action: "Quick Mask" },
  { keys: "F", action: "Fullscreen" },
];

/** Shown at the right end of the Essentials title line. */
export const QUICK_ASIDE: ShortcutRow = { keys: "Tab", action: "Simple / Advanced" };

/** Every section of the help overlay, in display order. */
export const HELP_SECTIONS: readonly ShortcutSection[] = [
  {
    title: "General",
    rows: [
      { keys: "Ctrl Z", action: "Undo" },
      { keys: "Ctrl ⇧ Z / Ctrl Y", action: "Redo" },
      { keys: "Esc", action: "Close menu · commit text · cancel float · deselect · exit fullscreen" },
      { keys: "Q", action: "Quick Mask" },
      { keys: "F", action: "Fullscreen" },
      { keys: "O", action: "Outputs tab (regions)" },
      { keys: "Tab", action: "Simple / Advanced mode" },
      { keys: "?", action: "This help" },
      { keys: "Del / Backspace", action: "Clear the selection" },
      { keys: "Wheel", action: "Zoom about the cursor" },
      { keys: "Middle-drag / Space drag", action: "Pan" },
      { keys: "Ctrl 0", action: "Fit to view" },
      { keys: "Ctrl 1", action: "100 %" },
      { keys: "Ctrl = / Ctrl -", action: "Zoom in / out" },
    ],
  },
  {
    title: "Tools",
    rows: [
      { keys: "B / E", action: "Brush / Eraser" },
      { keys: "G / I", action: "Paint bucket / Eyedropper" },
      { keys: "T", action: "Text" },
      { keys: "V", action: "Move layer" },
      { keys: "L / W", action: "Lasso / Magic wand" },
      { keys: "U / ⇧ U", action: "Shapes / cycle shapes" },
      { keys: "M / ⇧ M", action: "Marquees / cycle marquees" },
      { keys: "Ctrl (hold)", action: "Temporary Move layer" },
      { keys: "Alt (hold)", action: "Temporary eyedropper" },
      { keys: "Hold / right-click", action: "Tool slot: fly-out" },
      { keys: "Esc / Ctrl Enter", action: "Commit text (Enter = new line)" },
      { keys: "Ctrl drag (Text)", action: "Move the text layer" },
    ],
  },
  {
    title: "Brush and options",
    rows: [
      { keys: "[ / ]", action: "Size (shapes: width) down / up" },
      { keys: "⇧ [ / ⇧ ]", action: "Hardness −/+ 25 %" },
      { keys: "1..9 / 0", action: "Opacity 10..90 % / 100 %" },
      { keys: "⇧ click", action: "Straight line from the last stroke" },
      { keys: "⇧ drag", action: "15° steps / square, circle" },
      { keys: "Alt drag", action: "Rectangle, ellipse from centre" },
      { keys: "X", action: "Swap colours (Layer Mask: swatches)" },
      { keys: "D", action: "Default colours" },
      { keys: "Alt click (Eyedropper)", action: "Pick into background" },
      { keys: "Drag a number label", action: "Scrub (⇧ ×10)" },
    ],
  },
  {
    title: "Selection",
    rows: [
      { keys: "⇧ / Alt / ⇧ Alt", action: "Held at press: add / subtract / intersect" },
      { keys: "Ctrl A / Ctrl D", action: "Select all / deselect" },
      { keys: "Ctrl ⇧ I / ⇧ F7", action: "Invert" },
      { keys: "Alt Backspace / Ctrl Backspace", action: "Fill with foreground / background" },
      { keys: "Del / Backspace", action: "Clear (Layer Mask: reveal)" },
      { keys: "Drag inside", action: "Move the outline" },
      { keys: "Ctrl drag / Ctrl Alt drag", action: "Inside: lift the pixels / a copy" },
      { keys: "Arrows / ⇧ arrows", action: "Nudge the outline 1 / 10 px" },
      { keys: "Alt (Lasso)", action: "Straight segments" },
      { keys: "Double-click / click start", action: "Close the polygon (Lasso)" },
    ],
  },
  {
    title: "Layers and masks",
    rows: [
      { keys: "Click a row", action: "Select (Mask row: Quick Mask on)" },
      { keys: "Ctrl click a row", action: "Selection from the layer (+⇧ / Alt)" },
      { keys: "Double-click a name", action: "Rename" },
      { keys: "Drag a row", action: "Reorder" },
      { keys: "Ctrl E", action: "Merge down" },
      { keys: "Click / Alt click", action: "Add Layer Mask button: reveal / hide all" },
      { keys: "Click Layer Mask", action: "Edit the Layer Mask" },
      { keys: "⇧ click Layer Mask", action: "Enable / disable" },
      { keys: "Alt click Layer Mask", action: "View the Layer Mask alone" },
      { keys: "Ctrl click Layer Mask", action: "Soft selection of the shown part" },
      { keys: "Click layer thumbnail", action: "Edit the pixels" },
    ],
  },
  {
    title: "Move and transform",
    rows: [
      { keys: "Arrows / ⇧ arrows", action: "Nudge 1 / 10 px" },
      { keys: "Alt drag in a selection", action: "Lift a copy (Move layer)" },
      { keys: "Ctrl Alt T", action: "Free Transform" },
      { keys: "Enter / Esc", action: "Commit / cancel" },
      { keys: "⇧ (handle)", action: "Toggle proportional" },
      { keys: "Alt (handle)", action: "Scale about the centre" },
      { keys: "⇧ (rotate)", action: "15° steps" },
      { keys: "Wheel while dragging", action: "Scale (Align drawing)" },
    ],
  },
  {
    title: "Clipboard",
    rows: [
      { keys: "Ctrl C / Ctrl ⇧ C", action: "Copy / copy merged" },
      { keys: "Ctrl X", action: "Cut" },
      { keys: "Ctrl V", action: "Paste as a new layer" },
      { keys: "Ctrl ⇧ V", action: "Paste in place" },
      { keys: "Hold / right-click", action: "Paste button: choose the source" },
    ],
  },
  {
    title: "Regions",
    rows: [
      { keys: "Drag empty canvas", action: "New region" },
      { keys: "⇧ drag", action: "New region inside another" },
      { keys: "Drag a region / handle", action: "Move / resize" },
      { keys: "Click empty canvas", action: "Select Main" },
      { keys: "Del / Backspace", action: "Remove the region" },
      { keys: "Double-click a title", action: "Rename" },
      { keys: "X Y W H fields", action: "Enter commits, Esc reverts" },
    ],
  },
];
