/**
 * Left tool rail. M0 renders disabled placeholder buttons only; M3 wires them
 * to the Tool interface.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

/** A placeholder rail entry. */
interface RailItem {
  id: string;
  title: string;
  /** SVG path data on a 24x24 grid. */
  path: string;
}

// ── Items ─────────────────────────────────────────────────────────────────────

const PLACEHOLDER_ITEMS: readonly RailItem[] = [
  { id: "brush", title: "Brush (B)", path: "M4 20c2 0 4-1 4-3a2 2 0 1 0-4 0M8 17 19 6a2 2 0 0 0-3-3L5 14" },
  { id: "eraser", title: "Eraser (E)", path: "M7 20h10M4 14l8-8 6 6-8 8H7z" },
  { id: "fill", title: "Paint bucket (G)", path: "M5 11l7-7 7 7-7 7zM19 15c1 2 2 3 2 4a2 2 0 0 1-4 0c0-1 1-2 2-4" },
  { id: "mask", title: "Quick Mask (Q)", path: "M4 4h16v16H4zM12 8a4 4 0 1 0 0 8a4 4 0 1 0 0-8" },
];

// ── Component ─────────────────────────────────────────────────────────────────

/**
 * Build the rail element.
 *
 * @returns The rail root element.
 */
export function createToolRail(): HTMLElement {
  const rail = document.createElement("div");
  rail.className = "cps-rail";
  for (const item of PLACEHOLDER_ITEMS) rail.appendChild(createRailButton(item));
  return rail;
}

/** One disabled icon button. */
function createRailButton(item: RailItem): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "cps-rail-button";
  button.dataset["tool"] = item.id;
  button.title = item.title;
  button.disabled = true;

  const svgNs = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNs, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(svgNs, "path");
  path.setAttribute("d", item.path);
  svg.appendChild(path);
  button.appendChild(svg);
  return button;
}
