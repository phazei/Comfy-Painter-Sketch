/**
 * Output regions (SPEC "Outputs and regions (editor)"): validation, stable slots, names and geometry. Pure.
 *
 * Regions are stored in current-image pixels from the top-left and are never
 * rescaled (not on input image or width/height changes, not by Move drawing).
 * They may extend outside the image, up to one image size beyond each edge
 * (the region area, `regionArea`: the image plus its own width / height on
 * every side; not the paint area, which is the document bounds cap).
 * Edges round with `floor(v + 0.5)`, the same rule as Python (`nodes/document_regions.py`).
 */

import type { Rect, Size } from "../geometry/rect";
import { cloneOutputOptions, readOutputOptions } from "./outputOptions";
import type { Region } from "./types";

/** Maximum stable output pairs, excluding Main. */
export const MAX_REGIONS = 6;

/** Default region size as a fraction of the image side (centred). */
export const DEFAULT_REGION_FRACTION = 0.5;

// ── Slots and names ───────────────────────────────────────────────────────────

/**
 * Validate a positional region slot without coercion.
 * @param value - Candidate slot.
 * @returns Whether it is an integer in 1..6.
 */
export function isRegionSlot(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_REGIONS;
}

/**
 * Find the lowest empty slot; existing slots are never renumbered.
 * @param regions - Existing regions.
 * @returns Empty slot, or null when all six are filled.
 */
export function nextRegionSlot(regions: readonly Pick<Region, "slot">[]): number | null {
  const used = new Set(regions.map((region) => region.slot));
  for (let slot = 1; slot <= MAX_REGIONS; slot++) {
    if (!used.has(slot)) return slot;
  }
  return null;
}

/**
 * Default name of a slot.
 * @param slot - Slot 1..6.
 * @returns `Region N`.
 */
export function defaultRegionName(slot: number): string {
  return `Region ${slot}`;
}

/**
 * Name commit rule for the title editor: trimmed; empty means the default.
 * @param input - Raw text typed by the user.
 * @param slot - Slot of the region being renamed.
 * @returns Name to store.
 */
export function commitRegionName(input: string, slot: number): string {
  const name = input.trim();
  return name || defaultRegionName(slot);
}

/**
 * Effective name of a region (older documents may store an empty name).
 * @param region - Region name and slot.
 * @returns Trimmed name, or `Region N` when blank.
 */
export function regionName(region: Pick<Region, "name" | "slot">): string {
  return commitRegionName(region.name, region.slot);
}

/**
 * Card title of a region.
 * @param region - Region name and slot.
 * @returns `N · name`.
 */
export function regionSlotLabel(region: Pick<Region, "name" | "slot">): string {
  return `${region.slot} · ${regionName(region)}`;
}

// ── Geometry ──────────────────────────────────────────────────────────────────

/**
 * Round one edge coordinate (half up, same as Python).
 * @param value - Fractional coordinate.
 * @returns `floor(value + 0.5)`.
 */
export function roundRegionEdge(value: number): number {
  return Math.floor(value + 0.5);
}

/**
 * Area a region may occupy: one image size beyond each edge of the image.
 * @param image - Current image size.
 * @returns Rect from `(-w, -h)` of size `3w x 3h`.
 */
export function regionArea(image: Size): Rect {
  return { x: -image.width, y: -image.height, width: 3 * image.width, height: 3 * image.height };
}

/**
 * Round edges and clamp a rect to {@link regionArea}, keeping at least 1x1.
 * Each edge rounds independently, so the size may change by one pixel.
 * @param rect - Candidate rect in image px (fractions allowed).
 * @param image - Current image size (positive integers).
 * @returns Integer rect inside the allowed area.
 */
export function clampRegionRect(rect: Rect, image: Size): Rect {
  const area = regionArea(image);
  const [x, right] = clampEdges(rect.x, rect.x + rect.width, area.x, area.x + area.width);
  const [y, bottom] = clampEdges(rect.y, rect.y + rect.height, area.y, area.y + area.height);
  return { x, y, width: right - x, height: bottom - y };
}

/**
 * Rect for a region created from the `+ Region N` row: centred, each side
 * {@link DEFAULT_REGION_FRACTION} of the image (at least 1 px).
 * @param image - Current image size.
 * @returns Integer rect inside the image.
 */
export function defaultRegionRect(image: Size): Rect {
  const width = Math.max(1, roundRegionEdge(image.width * DEFAULT_REGION_FRACTION));
  const height = Math.max(1, roundRegionEdge(image.height * DEFAULT_REGION_FRACTION));
  const x = Math.floor((image.width - width) / 2);
  const y = Math.floor((image.height - height) / 2);
  return { x, y, width, height };
}

function clampEdges(start: number, end: number, min: number, max: number): [number, number] {
  const low = clamp(roundRegionEdge(start), min, max - 1);
  const high = clamp(roundRegionEdge(end), low + 1, max);
  return [low, high];
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

// ── Records ───────────────────────────────────────────────────────────────────

/**
 * Construct a region; the caller chooses an empty slot and a clamped rect.
 * @param id - Unique region identity.
 * @param slot - Empty slot (1..6).
 * @param rect - Rect in image px, copied.
 * @returns Visible region named `Region N` with default output options.
 */
export function createRegion(id: string, slot: number, rect: Rect): Region {
  return {
    id,
    slot,
    name: defaultRegionName(slot),
    rect: { ...rect },
    visible: true,
    output: cloneOutputOptions(),
  };
}

/**
 * Deep-copy region metadata with stable field order.
 * @param region - Validated region.
 * @returns Independent rect and options.
 */
export function cloneRegion(region: Region): Region {
  const { x, y, width, height } = region.rect;
  return {
    id: region.id,
    slot: region.slot,
    name: region.name,
    rect: { x, y, width, height },
    visible: region.visible,
    output: cloneOutputOptions(region.output),
  };
}

// ── Parsing ───────────────────────────────────────────────────────────────────

/**
 * Read saved region records; each bad record is skipped on its own. Legacy
 * `{id, index, rect}` maps to `slot = index + 1`. The first record wins a
 * duplicate id or slot.
 * @param value - Saved `regions` field (missing is fine).
 * @returns Valid regions and whether anything needed repair.
 */
export function readRegions(value: unknown): { regions: Region[]; repaired: boolean } {
  if (value === undefined) return { regions: [], repaired: false };
  if (!Array.isArray(value)) return { regions: [], repaired: true };
  const regions: Region[] = [];
  const ids = new Set<string>();
  const slots = new Set<number>();
  let repaired = false;
  for (const entry of value) {
    const region = isRecord(entry) ? readRegion(entry) : null;
    if (!region || ids.has(region.id) || slots.has(region.slot)) {
      repaired = true;
      continue;
    }
    if (entry["slot"] === undefined || !sameRect(entry["rect"], region.rect)) repaired = true;
    ids.add(region.id);
    slots.add(region.slot);
    regions.push(region);
  }
  return { regions, repaired };
}

/**
 * Read a saved rect: finite numbers, edges rounded with {@link roundRegionEdge},
 * at least 1x1 after rounding. Not clamped (the image size is unknown here).
 * @param value - Untrusted rect.
 * @returns Fresh integer rect, or null for malformed geometry.
 */
export function readRegionRect(value: unknown): Rect | null {
  if (!isRecord(value)) return null;
  const { x, y, width, height } = value;
  if (!finite(x) || !finite(y) || !finite(width) || !finite(height)) return null;
  const right = x + width;
  const bottom = y + height;
  if (!Number.isFinite(right) || !Number.isFinite(bottom)) return null;
  const left = roundRegionEdge(x);
  const top = roundRegionEdge(y);
  const w = roundRegionEdge(right) - left;
  const h = roundRegionEdge(bottom) - top;
  if (w < 1 || h < 1) return null;
  return { x: left, y: top, width: w, height: h };
}

function readRegion(entry: Record<string, unknown>): Region | null {
  const id = entry["id"];
  if (typeof id !== "string" || !id.trim()) return null;
  const slot = entry["slot"] === undefined ? legacySlot(entry["index"]) : entry["slot"];
  if (!isRegionSlot(slot)) return null;
  const rect = readRegionRect(entry["rect"]);
  if (!rect) return null;
  const name = entry["name"];
  const visible = entry["visible"];
  return {
    id,
    slot,
    name: typeof name === "string" ? name : "",
    rect,
    visible: typeof visible === "boolean" ? visible : true,
    output: readOutputOptions(entry["output"]),
  };
}

function legacySlot(index: unknown): number | null {
  if (typeof index !== "number" || !Number.isInteger(index)) return null;
  return index + 1;
}

function sameRect(raw: unknown, rect: Rect): boolean {
  if (!isRecord(raw)) return false;
  return raw["x"] === rect.x && raw["y"] === rect.y && raw["width"] === rect.width && raw["height"] === rect.height;
}

// ── Guards ────────────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
