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
};

/** Glyph for unknown icon names. */
const FALLBACK = "M5 5h14v14H5z";

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
