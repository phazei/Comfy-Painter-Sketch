/**
 * Left tool rail: one button per registered tool, then Undo/Redo/Fit/Clear
 * (always visible, SPEC "Canvas / view"). Minimal M1 version; M3 replaces
 * the look.
 */

import type { Tool } from "../tools/types";

// ── Icons ─────────────────────────────────────────────────────────────────────

/** SVG path data (24x24) per tool id / action. */
const ICONS: Readonly<Record<string, string>> = {
  brush: "M4 20c2 0 4-1 4-3a2 2 0 1 0-4 0M8 17 19 6a2 2 0 0 0-3-3L5 14",
  eraser: "M7 20h10M4 14l8-8 6 6-8 8H7z",
  undo: "M9 14 4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3",
  redo: "M15 14l5-5-5-5M20 9H10a6 6 0 0 0 0 12h3",
  // Four corner brackets indicating "fit to view".
  fit:
    "M4 9V5h4M20 9V5h-4M4 15v4h4M20 15v4h-4",
  clear: "M4 7h16M10 11v6M14 11v6M5 7l1 13h12l1-13M9 7V4h6v3",
};

// ── Component ─────────────────────────────────────────────────────────────────

/** Callbacks from the rail. */
export interface ToolRailActions {
  selectTool(id: string): void;
  undo(): void;
  redo(): void;
  /** Fit image to stage (Ctrl+0). */
  fit(): void;
  /** Clear canvas (the handler confirms). */
  clear(): void;
}

/**
 * Tool rail element with update hooks.
 */
export class ToolRail {
  readonly element: HTMLDivElement;
  private readonly toolButtons = new Map<string, HTMLButtonElement>();
  private readonly toolBox: HTMLDivElement;
  private readonly undoButton: HTMLButtonElement;
  private readonly redoButton: HTMLButtonElement;

  /**
   * @param actions - Button handlers.
   */
  constructor(private readonly actions: ToolRailActions) {
    this.element = document.createElement("div");
    this.element.className = "cps-rail";
    this.toolBox = document.createElement("div");
    this.toolBox.className = "cps-rail-group";
    const spacer = document.createElement("div");
    spacer.className = "cps-rail-spacer";
    this.undoButton = railButton("undo", "Undo (Ctrl+Z)", () => this.actions.undo());
    this.redoButton = railButton("redo", "Redo (Ctrl+Shift+Z)", () => this.actions.redo());
    const fitButton = railButton("fit", "Fit to view (Ctrl+0)", () => this.actions.fit());
    const clearButton = railButton("clear", "Clear canvas", () => this.actions.clear());
    this.element.append(this.toolBox, spacer, this.undoButton, this.redoButton, fitButton, clearButton);
  }

  /**
   * Rebuild tool buttons.
   * @param tools - Tools in order.
   * @param activeId - Active tool id.
   */
  setTools(tools: readonly Tool[], activeId: string): void {
    this.toolBox.replaceChildren();
    this.toolButtons.clear();
    for (const tool of tools) {
      const button = railButton(tool.id, `${tool.label} (${tool.shortcut.toUpperCase()})`, () =>
        this.actions.selectTool(tool.id),
      );
      this.toolButtons.set(tool.id, button);
      this.toolBox.appendChild(button);
    }
    this.setActive(activeId);
  }

  /**
   * Highlight the active tool.
   * @param activeId - Tool id.
   */
  setActive(activeId: string): void {
    for (const [id, button] of this.toolButtons) {
      button.classList.toggle("cps-active", id === activeId);
      button.setAttribute("aria-pressed", String(id === activeId));
    }
  }

  /**
   * Enable/disable undo and redo.
   * @param canUndo - Undo available.
   * @param canRedo - Redo available.
   */
  setHistory(canUndo: boolean, canRedo: boolean): void {
    this.undoButton.disabled = !canUndo;
    this.redoButton.disabled = !canRedo;
  }
}

function railButton(icon: string, title: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "cps-rail-button";
  button.title = title;
  button.addEventListener("click", onClick);
  const svgNs = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNs, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(svgNs, "path");
  path.setAttribute("d", ICONS[icon] ?? "M4 4h16v16H4z");
  svg.appendChild(path);
  button.appendChild(svg);
  return button;
}