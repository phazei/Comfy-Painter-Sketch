/**
 * Inline SVG icons for the editor UI: one 24x24 path set per name, drawn as
 * 20 px outline glyphs (stroke = currentColor, round caps/joins) so every
 * icon shares one style. Strings are constants from this module, so setting
 * them via `innerHTML` is safe.
 */

/** Path data (24x24 viewBox) per icon name. */
const PATHS: Readonly<Record<string, string>> = {
  brush: "M4 20c2 0 4-1 4-3a2 2 0 1 0-4 0M8 17 19 6a2 2 0 0 0-3-3L5 14",
  eraser: "M7 20h11M4.5 14.5l8-8 6 6-7.5 7.5H9.5z",
  // Tipped paint can with a drip.
  bucket: "M11 3 3.5 10.5a1.5 1.5 0 0 0 0 2.1l5.9 5.9a1.5 1.5 0 0 0 2.1 0L19 11zM6 2l3 3M4 11h14M21 17c0 1.5-.8 2.5-1.8 2.5s-1.7-1-1.7-2.5c0-1 1.7-3 1.7-3s1.8 2 1.8 3",
  // Pipette, tip at bottom-left.
  eyedropper: "M3 21l2-.5L15 10.5M3 21l.5-2L13.5 9M12 7.5l4.5 4.5M14.5 10l4.2-4.2a2 2 0 0 0-2.8-2.8L11.7 7.2",
  // Photoshop's Quick Mask: a rectangle with a circle in it.
  quickMask: "M4 5h16v14H4zM12 8.5a3.5 3.5 0 1 0 0 7a3.5 3.5 0 1 0 0-7",
  undo: "M9 14 4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3",
  redo: "M15 14l5-5-5-5M20 9H10a6 6 0 0 0 0 12h3",
  // Frame corners around the image: "fit to view".
  fit: "M4 8V4h4M16 4h4v4M20 16v4h-4M8 20H4v-4M9 9h6v6H9z",
  clear: "M4 7h16M10 11v6M14 11v6M5 7l1 13h12l1-13M9 7V4h6v3",
  fullscreen: "M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7",
  // Arrows pointing inwards: "exit fullscreen".
  exitFullscreen: "M20 10h-6V4M4 14h6v6M14 10l7-7M10 14l-7 7",
  panel: "M4 5h16v14H4zM15 5v14",
  eye: "M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6",
  eyeOff: "M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6M4 4l16 16",
  // Curved double arrow (Photoshop's "switch colors").
  swap: "M6 6h7a5 5 0 0 1 5 5v7M9 3 6 6l3 3M15 15l3 3 3-3",
  // Layers panel.
  lock: "M6 11h12v9H6zM8.5 11V8a3.5 3.5 0 0 1 7 0v3",
  unlock: "M6 11h12v9H6zM8.5 11V8a3.5 3.5 0 0 1 6.8-1.2",
  plus: "M12 5v14M5 12h14",
  duplicate: "M9 9h11v11H9zM5 15H4V4h11v1",
  trash: "M4 7h16M10 11v6M14 11v6M5 7l1 13h12l1-13M9 7V4h6v3",
  // Half-filled circle outline: "invert".
  invert: "M12 4a8 8 0 1 0 0 16a8 8 0 1 0 0-16M12 4v16M12 8h4M12 12h6M12 16h4",
  // Tablet pen, nib at bottom-left, with a pressure stroke: "pen pressure".
  stylus: "M17 3l4 4L9 19l-5 1 1-5zM14 6l4 4M5 15l4 4M13 21c2-1.5 4-1.5 6 0",
  // Shape tools (U).
  line: "M5 19 19 5",
  arrow: "M5 19 19 5M11 5h8v8",
  rectangle: "M4 6h16v12H4z",
  ellipse: "M12 5c4.4 0 8 3.1 8 7s-3.6 7-8 7-8-3.1-8-7 3.6-7 8-7z",
  // Text tool (T): a serif "T" (also the text-layer badge in the layers panel).
  text: "M5 7.5V5h14v2.5M12 5v14M9 19h6",
  // Move tool (V): four-way arrow.
  move: "M12 3v18M3 12h18M9 6l3-3 3 3M9 18l3 3 3-3M6 9l-3 3 3 3M18 9l3 3-3 3",
  // Move drawing: back sheet (down-left, partially hidden) + front sheet (up-right),
  // small four-way arrow centred on the front sheet.
  // Isometric layer stack: top sheet (diamond) with a 4-way diagonal move
  // arrow, lower sheet shown as an open chevron underneath.
  moveDrawing:
    "M12 2.5 21.5 8.5 12 14.5 2.5 8.5z" +
    "M2.5 13.5V15L12 20.5 21.5 15v-1.5" +
    "M9.4 6.8l5.2 3.4M14.6 6.8l-5.2 3.4" +
    "M10.7 6.8H9.4v1.1M13.3 6.8h1.3v1.1M10.7 10.2H9.4V9.1M13.3 10.2h1.3V9.1",
  // Selection (M): dashed rectangle.
  marqueeRect: "M4 8V6h2M10 6h4M18 6h2v2M20 11v2M20 16v2h-2M14 18h-4M6 18H4v-2M4 13v-2",
  // Elliptical marquee (M): dashed ellipse (8 arcs of the rectangle's ellipse).
  marqueeEllipse:
    "M19.7 10.5A8 6 0 0 1 19.7 13.5M18.9 15A8 6 0 0 1 16 17.2M14.1 17.8A8 6 0 0 1 9.9 17.8M8 17.2A8 6 0 0 1 5.1 15" +
    "M4.3 13.5A8 6 0 0 1 4.3 10.5M5.1 9A8 6 0 0 1 8 6.8M9.9 6.2A8 6 0 0 1 14.1 6.2M16 6.8A8 6 0 0 1 18.9 9",
  // Lasso (L): rope loop with a knot and a dangling tail.
  lasso: "M8.5 14.6C5.8 13.8 4 12.1 4 10c0-3 3.6-5.5 8-5.5s8 2.5 8 5.5-3.6 5.5-8 5.5c-1.3 0-2.5-.2-3.5-.4M8.5 14.6c-1.4.6-1.4 2.2 0 2.6s1.2 2.3-.8 3.3",
  // Magic wand (W): diagonal stick with a sparkle at its tip.
  magicWand: "M4 20 14.5 9.5M13 8l3 3M17 3v4M15 5h4M20.5 9.5v2M19.5 10.5h2M10.5 3.5v2M9.5 4.5h2",
  // "Selection to mask": dashed square with the Quick Mask circle.
  selectionToMask: "M4 7V4h3M10 4h4M17 4h3v3M20 10v4M20 17v3h-3M14 20h-4M7 20H4v-3M4 14v-4M12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6",
};

/** Glyph for unknown icon names. */
const FALLBACK = "M5 5h14v14H5z";

/**
 * SVG path data string (24x24 viewBox) for a named icon, or a fallback square.
 * Used by {@link cursors} to reuse the exact toolbar path in cursor SVGs.
 * @param name - Icon name.
 * @returns The `d` attribute string.
 */
export function iconPath(name: string): string {
  return PATHS[name] ?? FALLBACK;
}

/**
 * Full `<svg>` markup for an icon.
 * @param name - Icon name (unknown names get a square).
 * @param size - Rendered size in CSS px (default 20).
 * @returns SVG markup.
 */
export function iconSvg(name: string, size = 20): string {
  const d = PATHS[name] ?? FALLBACK;
  return (
    `<svg class="cps-icon" viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true" ` +
    `fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">` +
    `<path d="${d}"/></svg>`
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