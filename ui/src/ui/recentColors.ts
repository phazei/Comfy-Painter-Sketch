/**
 * Recent colours for the colour picker (SPEC "Color"): up to
 * {@link MAX_RECENTS} committed colours, newest first, persisted in
 * localStorage under `PainterSketch.recentColors`. Storage failures (quota,
 * private mode, malformed data) degrade to an empty list.
 */

import { normalizeHex } from "../engine/colors";

// ── Constants ───────────────────────────────────────────────────────────────

const RECENT_KEY = "PainterSketch.recentColors";
const MAX_RECENTS = 10;

// ── Storage ─────────────────────────────────────────────────────────────────

/**
 * Read the persisted recent colours list.
 * @returns Array of up to {@link MAX_RECENTS} normalized hex strings.
 */
export function getRecentColors(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === "string" && normalizeHex(v) !== null);
  } catch {
    return [];
  }
}

/**
 * Put a colour at the front of the recent list (de-duplicated, capped).
 * @param hex - Colour; ignored if not a valid hex colour.
 */
export function saveRecentColor(hex: string): void {
  const normalized = normalizeHex(hex);
  if (!normalized) return;
  const existing = getRecentColors().filter((c) => c !== normalized);
  const updated = [normalized, ...existing].slice(0, MAX_RECENTS);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(updated));
  } catch {
    // Storage quota or private mode – silently ignore.
  }
}

// ── Row ─────────────────────────────────────────────────────────────────────

/**
 * Fill `container` with one swatch button per recent colour; hidden when the
 * list is empty.
 * @param container - Row element (emptied first).
 * @param onPick - Called with a swatch's colour when clicked.
 */
export function renderRecentColors(container: HTMLElement, onPick: (hex: string) => void): void {
  container.textContent = "";
  const recents = getRecentColors();
  for (const hex of recents) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "cps-picker-recent";
    btn.style.backgroundColor = hex;
    btn.title = hex.toUpperCase();
    btn.setAttribute("aria-label", `Use recent colour ${hex.toUpperCase()}`);
    btn.addEventListener("click", () => onPick(hex));
    container.appendChild(btn);
  }
  container.hidden = recents.length === 0;
}
