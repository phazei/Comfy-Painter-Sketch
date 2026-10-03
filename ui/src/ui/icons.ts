/**
 * Inline SVG icons for the editor UI and the stage cursors. Each name maps to
 * the inner markup of a 24x24 outline glyph (stroke = currentColor, round
 * caps/joins): mostly Lucide icons (`lucideIcons.ts`, ISC), plus a few of our
 * own drawn on Lucide's grid and stroke (SPEC "Remaining work" item 2 holds
 * the approved mapping). Strings are constants from this module, so setting
 * them via `innerHTML` is safe. The rendered stroke width comes from CSS
 * (`--cps-icon-stroke` on `.cps-icon`).
 */

import { LUCIDE } from "./lucideIcons";

// ── Custom glyphs (Lucide grid, stroke 2) ────────────────────────────────────

/** Lucide `square-dashed` without its centre mark (base of our dashed-square glyphs). */
const SQUARE_DASHED =
  "<path d='M5 3a2 2 0 0 0-2 2'/><path d='M19 3a2 2 0 0 1 2 2'/><path d='M21 19a2 2 0 0 1-2 2'/><path d='M5 21a2 2 0 0 1-2-2'/>" +
  "<path d='M9 3h1'/><path d='M9 21h1'/><path d='M14 3h1'/><path d='M14 21h1'/><path d='M3 9v1'/><path d='M21 9v1'/><path d='M3 14v1'/><path d='M21 14v1'/>";

/** New-layer sheet with an open corner and a plus (the user's drawing). */
const NEW_SHEET = "<path d='M11.35 22H5a2 2 0 01-2-2V4a2 2 0 012-2h14a2 2 0 012 2v9.35'/><path d='M14 19h8'/><path d='M18 15v8'/>";

/** Our own glyphs (no Lucide equivalent). */
const CUSTOM: Readonly<Record<string, string>> = {
  // Align drawing: the bottom sheet of a layer pile with a large isometric
  // four-way arrow in the sheet's plane (the user's drawing).
  // The arrow is drawn 0.5 thinner than the icon stroke (follows `--cps-icon-stroke`).
  alignDrawing:
    "<path d='M4 11.5 1.5 13 12 19l10.5-6-2.5-1.5'/>" +
    "<path style='stroke-width:calc(var(--cps-icon-stroke, 2) - 0.5)' d='M7 6.2l10 6.4M7 12.6l10-6.4M10.5 6 7 6.2v2.1M13.5 6l3.5.2v2.1M10.5 12.8 7 12.6v-2.1M13.5 12.8l3.5-.2v-2.1'/>",
  // Photoshop's Quick Mask: a rectangle with a circle in it.
  quickMask: "<rect x='3' y='4' width='18' height='16' rx='2'/><circle cx='12' cy='12' r='4.5'/>",
  // Paste from the system clipboard: a clipboard with two scribbled lines (the user's drawing).
  paste:
    "<path d='m10 16 6 .5'/><path d='M16 4h2a2 2 0 012 2v14a2 2 0 01-2 2H6a2 2 0 01-2-2V6a2 2 0 012-2h2'/><path d='m8 11.5 7-1'/><rect x='8' y='2' width='8' height='4' rx='1'/>",
  // Paste from the ComfyUI clipspace: Lucide `clipboard` with a filled, slanted "C" (the user's drawing).
  pasteClipspace:
    `${LUCIDE["clipboard"]}` +
    "<path fill='currentColor' stroke='none' d='M9.47 19.44Q8.55 19.44 8.82 18.54L9.2 17.24H8.05Q7.14 17.24 7.4 16.34L8.47 12.65Q8.73 11.75 9.64 11.75H10.82L11.19 10.46Q11.45 9.56 12.36 9.56H15.95Q16.86 9.56 16.6 10.46L16.17 11.96Q15.91 12.85 15 12.85H11.76L10.8 16.14H14.03Q14.94 16.14 14.68 17.04L14.24 18.54Q13.98 19.44 13.07 19.44Z'/>",
  // Mask glyph (Photoshop's add-mask symbol).
  mask: "<rect x='3' y='3' width='18' height='18' rx='2'/><circle cx='12' cy='12' r='4' fill='currentColor'/>",
  // Inverted mask glyph (Alt on the add-mask button: hide all).
  maskInverted:
    "<path fill='currentColor' fill-rule='evenodd' d='M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM12 6a6 6 0 1 0 0 12 6 6 0 0 0 0-12z'/>",
  // New layer: a sheet with its bottom-right corner open for a plus (the user's drawing).
  layerAdd: NEW_SHEET,
  // New mask / add layer mask: the new-layer sheet with the mask's filled circle.
  maskAdd: `${NEW_SHEET}<circle cx='12' cy='12' r='3' fill='currentColor'/>`,
  // Magic wand (the user's drawing): sparkles, a stick ending in a star point.
  magicWand:
    "<path d='M13 1v2m1-1h-2m1 6 3 3m5 1v4m2-2h-4M6 4v4m2-2H4'/>" +
    "<path d='M20.68 2.68A3.9 3.9 0 0 1 16.6 4.4L2.36 18.64a1.21 1.21 0 0 0 0 1.72l1.28 1.28a1.2 1.2 0 0 0 1.72 0L19.6 7.4a3.9 3.9 0 0 1 1.72-4.08z'/>",
  // Pointer tip of the Photoshop-style cursors: Lucide `mouse-pointer-2`
  // rotated about its apex (3.59, 3.59) so the left edge is vertical.
  pointer: `<g transform='rotate(22.109 3.592 3.592)'>${LUCIDE["mouse-pointer-2"] ?? ""}</g>`,
  // Selection to mask: dashed square with the mask's filled circle.
  selectionToMask: `${SQUARE_DASHED}<circle cx='12' cy='12' r='3' fill='currentColor'/>`,
  // Selection subtract badge, pairing Lucide `square-dashed-plus` / `-x`.
  squareDashedMinus: `${SQUARE_DASHED}<path d='M8 12h8'/>`,
  // FG/BG swap (Photoshop's curved double arrow; kept from the old set).
  swap: "<path d='M6 6h7a5 5 0 0 1 5 5v7M9 3 6 6l3 3M15 15l3 3 3-3'/>",
  // Polygonal lasso: the lasso loop drawn as straight segments.
  polygonLasso: "<path d='M3.7 14.5 3 8l5-5 8 .5L21 8l-2 6-7 3.5-5-.6'/><path d='M7 22l-2-4'/><circle cx='5' cy='16' r='2'/>",
  // Precise cross (the user's): outer ticks and inward wedges, centre open.
  preciseCross:
    "<path d='M12 2v3M12 22v-3M2 12h3M22 12h-3'/>" +
    "<path fill='currentColor' stroke='none' d='M11 5H13L12 10.5ZM11 19H13L12 13.5ZM5 11V13L10.5 12ZM19 11V13L13.5 12Z'/>",
  // Ring tools' cursor dot (drawn filled, 8 px).
  dot: "<circle cx='12' cy='12' r='3'/>",
  // Eyedropper badge: the pick goes to the background slot (the user's drawing).
  bgSlot:
    "<path d='M14 20a2 2 0 002 2h4a2 2 0 002-2v-4a2 2 0 00-2-2v6z'/><path d='M14 20a6 6 0 006-6'/><rect x='8' y='8' width='8' height='8' rx='2'/>",
  // ── UI refresh glyphs (the maintainer's, from the design handoff icon module) ──
  // Sliders pill: brush size (two dots), hardness (soft ring + hard core), line width (three rules).
  brushSize: "<circle cx='7' cy='17' r='2.5'/><circle cx='15.5' cy='8.5' r='5.5'/>",
  hardness: "<circle cx='12' cy='12' r='9' stroke-dasharray='1.5 2.6'/><circle cx='12' cy='12' r='4.5' fill='currentColor'/>",
  lineWidth: "<path d='M4 5h16' style='stroke-width:1'/><path d='M4 11h16' style='stroke-width:2'/><path d='M4 18h16' style='stroke-width:3.5'/>",
  // Copy merged: the copy glyph with a three-line badge.
  copyMerged: `${LUCIDE["copy"]}<path d='M13.5 13.5h5M13.5 16.5h5M13.5 19.5h5' style='stroke-width:1.5'/>`,
  // Text angle.
  angle: "<path d='M4 20h16'/><path d='M4 20 15 6'/><path d='M10.5 20A6.5 6.5 0 0 0 8 14.9'/>",
  // Side panel shrink / expand (rotates 180° when shrunk).
  panelCollapse: "<path d='m17 11-5-5-5 5'/><path d='m17 18-5-5-5 5'/>",
  // Rasterize text (a pixel grid).
  rasterize: "<rect x='3' y='3' width='18' height='18' rx='2'/><path d='M3 9h18M3 15h18M9 3v18M15 3v18'/>",
  // Colour harmony (picker): a wheel cut in thirds with a filled hub.
  colorWheel:
    "<circle cx='12' cy='12' r='9'/><path d='M12 3v6M14.6 13.5l5.2 3M9.4 13.5l-5.2 3'/><circle cx='12' cy='12' r='3' fill='currentColor'/>",
  // Colour variations (picker): a light and a dark circle side by side.
  colorVariations: "<circle cx='8' cy='12' r='5'/><circle cx='16' cy='12' r='5' fill='currentColor'/>",
  // Default colours (D): a filled square over an outlined one.
  resetColors: "<rect x='3' y='3' width='11' height='11' rx='2' fill='currentColor'/><rect x='10' y='10' width='11' height='11' rx='2'/>",
};

/** Our icon names that are plain Lucide icons (name -> Lucide name). */
const ALIASES: Readonly<Record<string, string>> = {
  // Tools.
  brush: "brush",
  eraser: "eraser",
  bucket: "paint-bucket",
  eyedropper: "pipette",
  line: "slash",
  arrow: "move-up-right",
  rectangle: "rectangle-horizontal",
  ellipse: "ellipse",
  text: "type",
  move: "move",
  marqueeRect: "square-dashed",
  marqueeEllipse: "circle-dashed",
  lasso: "lasso",
  region: "vector-square",
  transform: "scaling",
  // Rail actions.
  copy: "copy",
  cut: "scissors",
  undo: "undo-2",
  redo: "redo-2",
  fit: "fullscreen",
  clear: "brush-cleaning",
  fullscreen: "maximize-2",
  exitFullscreen: "minimize-2",
  images: "images",
  // Options bar.
  panel: "panel-right",
  stylus: "pen",
  flipH: "triangles-centerline-dashed-vertical",
  flipV: "triangles-centerline-dashed-horizontal",
  check: "check",
  close: "x",
  trash: "trash",
  invert: "contrast",
  bold: "bold",
  italic: "italic",
  // Layers panel.
  plus: "plus",
  duplicate: "copy",
  mergeDown: "layers-arrow-down",
  eye: "eye",
  eyeOff: "eye-off",
  lock: "lock",
  unlock: "lock-open",
  solo: "circle-dot",
  maskView: "scan-eye",
  // UI refresh: bottom bar, menus, strip.
  help: "circle-help",
  warning: "triangle-alert",
  chevronDown: "chevron-down",
  back: "arrow-left",
  link: "link",
  alignLeft: "text-align-start",
  alignCenter: "text-align-center",
  alignRight: "text-align-end",
  // Cursor glyphs and badges.
  textCursor: "text-cursor",
  ban: "ban",
  copyPlus: "copy-plus",
  squareDashedPlus: "square-dashed-plus",
  squareDashedX: "square-dashed-x",
  resizeEW: "move-horizontal",
  resizeNS: "move-vertical",
  resizeNESW: "move-diagonal",
  resizeNWSE: "move-diagonal-2",
  rotate: "refresh-cw",
  hand: "hand",
  handGrab: "hand-grab",
  hourglass: "hourglass",
};

// Aliases sharing a glyph with another name.
const SHARED: Readonly<Record<string, string>> = { layerMaskAdd: "maskAdd" };

/** Glyph for unknown icon names. */
const FALLBACK = "<rect x='5' y='5' width='14' height='14'/>";

/**
 * Inner SVG markup (24x24 viewBox, attribute quotes `'`) for a named icon,
 * or a fallback square. Cursors compose these into their own SVG.
 * @param name - Icon name.
 * @returns The markup.
 */
export function iconMarkup(name: string): string {
  const key = SHARED[name] ?? name;
  const custom = CUSTOM[key];
  if (custom !== undefined) return custom;
  const lucide = ALIASES[key];
  return (lucide !== undefined ? LUCIDE[lucide] : undefined) ?? FALLBACK;
}

/**
 * Whether a name resolves to a real icon (not the fallback).
 * @param name - Icon name.
 * @returns `true` if known.
 */
export function hasIcon(name: string): boolean {
  const key = SHARED[name] ?? name;
  if (CUSTOM[key] !== undefined) return true;
  const lucide = ALIASES[key];
  return lucide !== undefined && LUCIDE[lucide] !== undefined;
}

/**
 * Full `<svg>` markup for an icon.
 * @param name - Icon name (unknown names get a square).
 * @param size - Rendered size in CSS px (default 20).
 * @returns SVG markup.
 */
export function iconSvg(name: string, size = 20): string {
  return (
    `<svg class="cps-icon" viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true" ` +
    `fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">` +
    `${iconMarkup(name)}</svg>`
  );
}

/**
 * Replace an element's content with an icon.
 * @param element - Target (usually a button).
 * @param name - Icon name.
 * @param size - Size in CSS px.
 */
export function setIcon(element: Element, name: string, size = 20): void {
  element.innerHTML = iconSvg(name, size);
}
