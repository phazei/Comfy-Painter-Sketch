/**
 * Parse, migrate and validate a stored document value. Every load path goes
 * through {@link parseDocument}; it never throws.
 *
 * Structure (frame, bounds, layers array) is validated strictly; optional or
 * cosmetic fields are normalized leniently (defaults filled, bad values
 * replaced) so a slightly odd manifest still loads.
 */

import { containsRect, frameRect } from "../geometry/rect";
import type { Rect, Size } from "../geometry/rect";
import { createId, createPaintLayer } from "./create";
import { log } from "../log";
import { readPlacement } from "./placement";
import { readTextData } from "./textData";
import { DOCUMENT_VERSION } from "./types";
import type { Layer, LayerKind, PainterDocument, Region } from "./types";

/** Largest accepted frame/bounds side in pixels. */
export const MAX_DOCUMENT_SIDE = 16384;

/** Outcome of {@link parseDocument}. */
export type ParseResult =
  | { status: "empty" }
  | { status: "ok"; document: PainterDocument; repaired: boolean }
  | { status: "invalid"; reason: string };

// ── Entry point ───────────────────────────────────────────────────────────────

/**
 * Parse a widget value (JSON string or already-parsed object).
 *
 * @param raw - Stored value.
 * @returns `empty` for `""`/nullish, `ok` with a valid document (possibly
 *   repaired), or `invalid` with a human-readable reason.
 */
export function parseDocument(raw: unknown): ParseResult {
  if (raw === null || raw === undefined) return { status: "empty" };
  let data: unknown = raw;
  if (typeof raw === "string") {
    if (!raw.trim()) return { status: "empty" };
    try {
      data = JSON.parse(raw);
    } catch {
      return { status: "invalid", reason: "document is not valid JSON" };
    }
  }
  if (!isRecord(data)) return { status: "invalid", reason: "document is not an object" };

  const migrated = migrate(data);
  if (typeof migrated === "string") return { status: "invalid", reason: migrated };
  return validate(migrated);
}

// ── Migration ─────────────────────────────────────────────────────────────────

/**
 * Bring an older manifest up to {@link DOCUMENT_VERSION}. v1 is the first
 * version, so this only rejects unknown versions for now.
 *
 * @returns The (possibly rewritten) record, or an error reason.
 */
function migrate(data: Record<string, unknown>): Record<string, unknown> | string {
  const version = data["version"];
  if (version === DOCUMENT_VERSION) return data;
  return `unsupported document version ${JSON.stringify(version)}`;
}

// ── Validation ────────────────────────────────────────────────────────────────

function validate(data: Record<string, unknown>): ParseResult {
  const frame = readSize(data["frame"]);
  if (!frame) return { status: "invalid", reason: "missing or invalid frame" };
  let repaired = false;

  let bounds = readRect(data["bounds"]);
  if (!bounds) {
    bounds = frameRect(frame);
    repaired = true;
  } else if (!containsRect(bounds, frameRect(frame))) {
    // Invariant: bounds always covers the frame. PNGs are sized to the stored
    // bounds, so a repaired bounds would misplace pixels: reject instead.
    return { status: "invalid", reason: "bounds does not contain the frame" };
  }
  if (bounds.width > MAX_DOCUMENT_SIDE || bounds.height > MAX_DOCUMENT_SIDE) {
    return { status: "invalid", reason: "bounds too large" };
  }

  const rawLayers = data["layers"];
  if (!Array.isArray(rawLayers)) return { status: "invalid", reason: "layers is not an array" };
  const layers: Layer[] = [];
  const seen = new Set<string>();
  for (const entry of rawLayers) {
    const layer = readLayer(entry);
    if (!layer) return { status: "invalid", reason: "invalid layer entry" };
    if (seen.has(layer.id)) return { status: "invalid", reason: `duplicate layer id ${layer.id}` };
    seen.add(layer.id);
    layers.push(layer);
  }
  if (!layers.some((l) => l.kind === "paint")) {
    layers.unshift(createPaintLayer("Layer 1"));
    repaired = true;
  }
  // Masks always sit above the paint stack (M8). Their order never affects
  // the output (union), so moving strays up keeps the result identical.
  const masks = layers.filter((l) => l.kind === "mask");
  const stacked = [...layers.filter((l) => l.kind !== "mask"), ...masks];
  if (stacked.some((l, i) => l !== layers[i])) {
    layers.splice(0, layers.length, ...stacked);
    repaired = true;
  }

  let activeLayerId = typeof data["activeLayerId"] === "string" ? data["activeLayerId"] : "";
  if (!seen.has(activeLayerId)) {
    activeLayerId = (layers.find((l) => l.kind === "paint") ?? layers[0])?.id ?? "";
    repaired = true;
  }

  let docId = data["docId"];
  if (typeof docId !== "string" || !/^[a-z0-9]{4,64}$/i.test(docId)) {
    docId = createId();
    repaired = true;
  }

  const regions = readRegions(data["regions"]);
  if (!regions) repaired = true;

  const placed = readPlacement(data["placement"]);
  if (placed.repaired) repaired = true;

  return {
    status: "ok",
    repaired,
    document: {
      version: DOCUMENT_VERSION,
      docId: docId as string,
      frame,
      bounds,
      regions: regions ?? [],
      ...(placed.placement ? { placement: placed.placement } : {}),
      activeLayerId,
      layers,
    },
  };
}

const LAYER_KINDS: ReadonlySet<string> = new Set<LayerKind>(["paint", "text", "mask"]);

function readLayer(value: unknown): Layer | null {
  if (!isRecord(value)) return null;
  const id = value["id"];
  const kind = value["kind"];
  if (typeof id !== "string" || !id) return null;
  if (typeof kind !== "string" || !LAYER_KINDS.has(kind)) return null;
  const file = value["file"];
  if (file !== null && file !== undefined && (typeof file !== "string" || !file.trim())) return null;

  const layer: Layer = {
    id,
    name: typeof value["name"] === "string" ? value["name"] : id,
    kind: kind as LayerKind,
    visible: typeof value["visible"] === "boolean" ? value["visible"] : true,
    locked: typeof value["locked"] === "boolean" ? value["locked"] : false,
    opacity: clamp01(value["opacity"], 1),
    blendMode: "normal",
    file: typeof file === "string" ? file : null,
  };
  if (typeof value["color"] === "string") layer.color = value["color"];
  if (typeof value["invert"] === "boolean") layer.invert = value["invert"];
  if (layer.kind === "text") {
    // Lenient: unusable text data keeps the layer (and its pixels) as paint.
    const textData = readTextData(value["textData"]);
    if (textData) {
      layer.textData = textData;
    } else {
      log.warn(`text layer ${id} has no usable textData; loading it as a paint layer`);
      layer.kind = "paint";
    }
  }
  return layer;
}

function readRegions(value: unknown): Region[] | null {
  if (value === undefined) return null;
  if (!Array.isArray(value)) return null;
  const regions: Region[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) return null;
    const rect = readRect(entry["rect"]);
    const id = entry["id"];
    const index = entry["index"];
    if (!rect || typeof id !== "string" || typeof index !== "number" || !Number.isInteger(index)) return null;
    regions.push({ id, index, rect });
  }
  return regions;
}

function readSize(value: unknown): Size | null {
  if (!isRecord(value)) return null;
  const width = value["width"];
  const height = value["height"];
  if (!isSide(width) || !isSide(height)) return null;
  return { width, height };
}

function readRect(value: unknown): Rect | null {
  if (!isRecord(value)) return null;
  const size = readSize(value);
  const x = value["x"];
  const y = value["y"];
  if (!size || !isInt(x) || !isInt(y)) return null;
  return { x, y, ...size };
}

// ── Guards ────────────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && Math.abs(value) <= MAX_DOCUMENT_SIDE * 4;
}

function isSide(value: unknown): value is number {
  return isInt(value) && value >= 1 && value <= MAX_DOCUMENT_SIDE;
}

function clamp01(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(1, Math.max(0, value));
}

