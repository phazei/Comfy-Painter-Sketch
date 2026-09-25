import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
const PREFIX = "[PainterSketch]";
const log = {
  /**
   * Log a warning.
   * @param args - Values to log after the prefix.
   */
  warn: (...args) => console.warn(PREFIX, ...args),
  /**
   * Log an error.
   * @param args - Values to log after the prefix.
   */
  error: (...args) => console.error(PREFIX, ...args)
};
function notify(severity, detail) {
  const toast = app.extensionManager?.toast;
  if (toast && typeof toast.add === "function") {
    toast.add({ severity, summary: "PainterSketch", detail, life: severity === "error" ? 8e3 : 5e3 });
  }
  if (severity === "info") return;
  if (severity === "error") log.error(detail);
  else log.warn(detail);
}
const REFERENCE_SOURCE = String.raw`painter-sketch(?:[\\/]|%2f){1,8}(ps-[a-z0-9]+-[0-9a-f]+\.(?:png|webp))`;
function extractReferences(text, into = /* @__PURE__ */ new Set()) {
  for (const match of text.matchAll(new RegExp(REFERENCE_SOURCE, "gi"))) {
    const name = match[1];
    if (name) into.add(name.toLowerCase());
  }
  return into;
}
function isStatsResponse(value) {
  if (typeof value !== "object" || value === null) return false;
  const { all, old } = value;
  return isFileStat(all) && isFileStat(old);
}
function isCleanupResponse(value) {
  if (typeof value !== "object" || value === null) return false;
  const { count, bytes, errors, all, old } = value;
  return typeof count === "number" && typeof bytes === "number" && isFileStat(all) && isFileStat(old) && (errors === void 0 || Array.isArray(errors) && errors.every((e) => typeof e === "string"));
}
function isFileStat(value) {
  if (typeof value !== "object" || value === null) return false;
  const { count, bytes } = value;
  return typeof count === "number" && typeof bytes === "number";
}
function formatBytes(bytes) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return unit === 0 ? `${Math.round(value)} B` : `${value.toFixed(1)} ${units[unit]}`;
}
function fileCount(count) {
  return `${count} ${count === 1 ? "file" : "files"}`;
}
function confirmText(dry) {
  if (dry.count === 0) return null;
  let text = `${dry.count} of the ${fileCount(dry.old.count)} older than 24 h (${formatBytes(dry.bytes)}) are unused and will be deleted. This affects all workflows.`;
  const skipped = dry.errors?.length ?? 0;
  if (skipped) {
    text += `

Warning: ${fileCount(skipped)} in the workflows folders could not be scanned (too large or unreadable); layer files used only there would be deleted.`;
  }
  return text;
}
function isRecord$1(value) {
  return typeof value === "object" && value !== null;
}
function scanValue(value, into) {
  if (value === null || value === void 0) return;
  if (typeof value === "string") {
    extractReferences(value, into);
    return;
  }
  try {
    const text = JSON.stringify(value);
    if (text) extractReferences(text, into);
  } catch {
  }
}
function scanOpenWorkflows(into) {
  const manager = app.extensionManager;
  const store = isRecord$1(manager) ? manager["workflow"] : void 0;
  const open = isRecord$1(store) ? store["openWorkflows"] : void 0;
  if (!Array.isArray(open)) return;
  for (const workflow of open) {
    if (!isRecord$1(workflow)) continue;
    scanValue(workflow["content"], into);
    scanValue(workflow["originalContent"], into);
    const tracker = workflow["changeTracker"];
    if (!isRecord$1(tracker)) continue;
    for (const key of ["activeState", "initialState", "undoQueue", "redoQueue"]) scanValue(tracker[key], into);
  }
}
function scanCurrentGraph(into) {
  const root = app;
  const graph = isRecord$1(root) ? root["graph"] : void 0;
  if (!isRecord$1(graph) || typeof graph["serialize"] !== "function") return;
  try {
    scanValue(graph["serialize"].call(graph), into);
  } catch {
  }
}
function scanStorage(getStorage, into) {
  let storage;
  try {
    storage = getStorage();
  } catch {
    return;
  }
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (key !== null) scanValue(storage.getItem(key), into);
  }
}
function collectClientReferences() {
  const names = /* @__PURE__ */ new Set();
  scanOpenWorkflows(names);
  scanCurrentGraph(names);
  scanStorage(() => globalThis.localStorage, names);
  scanStorage(() => globalThis.sessionStorage, names);
  return [...names].sort();
}
const CLEANUP_SETTING_ID = "PainterSketch.Cleanup";
const CLEANUP_ROUTE = "/painter-sketch/cleanup";
const CLEANUP_SETTING = {
  id: CLEANUP_SETTING_ID,
  category: ["PainterSketch", "Storage", "Clean up files"],
  name: "Clean up files",
  tooltip: "Deletes layer files in input/painter-sketch/ that no saved workflow, open workflow tab or unsaved draft in this browser uses and that are older than 24 hours. Asks before deleting.",
  type: () => renderCleanupControl(),
  defaultValue: ""
};
function renderCleanupControl() {
  const root = document.createElement("div");
  root.style.cssText = "display:flex;flex-direction:column;gap:0.4rem;";
  const statsLine = document.createElement("span");
  statsLine.style.cssText = "font-size:0.8rem;opacity:0.7;";
  statsLine.textContent = "Loading file counts…";
  const row = document.createElement("div");
  row.style.cssText = "display:flex;align-items:center;gap:0.75rem;";
  const button2 = document.createElement("button");
  button2.type = "button";
  button2.className = "p-button p-component p-button-sm p-button-secondary";
  button2.textContent = "Clean up files";
  button2.addEventListener("click", () => {
    button2.disabled = true;
    button2.textContent = "Cleaning up…";
    void runCleanup(statsLine).finally(() => {
      button2.disabled = false;
      button2.textContent = "Clean up files";
    });
  });
  row.append(button2);
  root.append(statsLine, row);
  void fetchStats(statsLine);
  return root;
}
async function fetchStats(statsLine) {
  try {
    const response = await api.fetchApi(CLEANUP_ROUTE, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "stats" })
    });
    const data = await response.json().catch(() => null);
    if (response.ok && isStatsResponse(data)) {
      statsLine.textContent = statsText(data);
    } else {
      statsLine.textContent = "Could not load file counts.";
    }
  } catch {
    statsLine.textContent = "Could not load file counts.";
  }
}
function statsText(stats) {
  const all = `${stats.all.count} (${formatBytes(stats.all.bytes)})`;
  const old = `${stats.old.count} (${formatBytes(stats.old.bytes)})`;
  return `Files: ${all} · Older than 24 h: ${old}`;
}
async function postCleanup(dryRun, referenced) {
  const response = await api.fetchApi(CLEANUP_ROUTE, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dryRun, referenced })
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const message = typeof data === "object" && data !== null ? data.error : void 0;
    throw new Error(typeof message === "string" ? message : `server returned ${response.status}`);
  }
  if (!isCleanupResponse(data)) throw new Error("unexpected server response");
  return data;
}
async function runCleanup(statsLine) {
  try {
    const referenced = collectClientReferences();
    const dry = await postCleanup(true, referenced);
    if (dry.old.count === 0) {
      notify("info", "Nothing to clean up (no files older than 24 h)");
      void fetchStats(statsLine);
      return;
    }
    if (dry.count === 0) {
      notify("info", `Nothing to clean up (the ${fileCount(dry.old.count)} files older than 24 h are all in use)`);
      void fetchStats(statsLine);
      return;
    }
    const text = confirmText(dry);
    if (text === null || !window.confirm(text)) return;
    const result = await postCleanup(false, collectClientReferences());
    const summary = `Deleted ${fileCount(result.count)} (${formatBytes(result.bytes)}).`;
    const errors = result.errors ?? [];
    if (errors.length) notify("warn", `${summary} ${errors.length} problem(s), see server log. First: ${errors[0]}`);
    else notify("info", summary);
  } catch (error) {
    notify("error", `File cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    void fetchStats(statsLine);
  }
}
const PAINT_QUALITY_ID = "PainterSketch.PaintQuality";
const PAINT_QUALITY_DEFAULT = 99;
const MIN = 50;
const MAX = 100;
const PAINT_QUALITY_SETTING = {
  id: PAINT_QUALITY_ID,
  category: ["PainterSketch", "Storage", "Paint layer quality"],
  name: "Paint layer quality",
  tooltip: "Paint layer quality. Below 100 saves lossy WebP (much smaller); 100 saves lossless PNG. Masks are always PNG.",
  type: "slider",
  attrs: { min: MIN, max: MAX, step: 1 },
  defaultValue: PAINT_QUALITY_DEFAULT
};
function normalizePaintQuality(raw) {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return PAINT_QUALITY_DEFAULT;
  return Math.min(MAX, Math.max(MIN, Math.round(raw)));
}
const SETTINGS = [
  PAINT_QUALITY_SETTING,
  CLEANUP_SETTING
];
const EXTENSION_NAME = "phazei.PainterSketch";
const NODE_NAME = "PainterSketch";
const WIDGET_SPEC_TYPE = "PAINTERSKETCH";
const DOM_WIDGET_TYPE = "paintersketch";
const INPUT_NAMES = {
  image: "image",
  width: "width",
  height: "height",
  background: "background"
};
const LINK_INPUT = 1;
const WIDGET_MIN_HEIGHT = 256;
const WIDGET_MARGIN = 6;
const DEFAULT_NODE_SIZE = [512, 640];
const SOURCE_POLL_MS = 500;
function isEmptyRect(r) {
  return !(r.width > 0 && r.height > 0);
}
function unionRect(a, b) {
  if (isEmptyRect(a)) return { ...b };
  if (isEmptyRect(b)) return { ...a };
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y
  };
}
function intersectRect(a, b) {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) };
}
function containsRect(outer, inner) {
  return inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;
}
function roundOutRect(r) {
  const x = Math.floor(r.x);
  const y = Math.floor(r.y);
  return { x, y, width: Math.ceil(r.x + r.width) - x, height: Math.ceil(r.y + r.height) - y };
}
function rectEquals(a, b) {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}
function frameRect(frame) {
  return { x: 0, y: 0, width: frame.width, height: frame.height };
}
const DOCUMENT_VERSION = 1;
const DOCUMENT_SUBFOLDER = "painter-sketch";
function createId(length = 12) {
  const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz";
  const bytes = new Uint8Array(length);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else for (let i = 0; i < length; i++) bytes[i] = Math.floor(Math.random() * 256);
  let out = "";
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}
function createPaintLayer(name) {
  return {
    id: createId(8),
    name,
    kind: "paint",
    visible: true,
    locked: false,
    opacity: 1,
    blendMode: "normal",
    file: null
  };
}
const DEFAULT_MASK_COLOR = "#ff0000";
const DEFAULT_MASK_OPACITY = 0.5;
function createMaskLayer(name = "Mask") {
  return {
    id: createId(8),
    name,
    kind: "mask",
    visible: true,
    locked: false,
    opacity: DEFAULT_MASK_OPACITY,
    blendMode: "normal",
    file: null,
    color: DEFAULT_MASK_COLOR,
    invert: false
  };
}
function createEmptyDocument(frame, docId = createId()) {
  const layer = createPaintLayer("Layer 1");
  const size = { width: Math.round(frame.width), height: Math.round(frame.height) };
  return {
    version: DOCUMENT_VERSION,
    docId,
    frame: size,
    bounds: frameRect(size),
    regions: [],
    activeLayerId: layer.id,
    layers: [layer, createMaskLayer()]
  };
}
const PLACEMENT_MIN_SCALE = 0.05;
const PLACEMENT_MAX_SCALE = 20;
const IDENTITY_PLACEMENT = Object.freeze({ x: 0, y: 0, scale: 1 });
function clampPlacementScale(scale) {
  if (!Number.isFinite(scale)) return 1;
  return Math.min(PLACEMENT_MAX_SCALE, Math.max(PLACEMENT_MIN_SCALE, scale));
}
function isIdentityPlacement(p) {
  return !p || p.x === 0 && p.y === 0 && p.scale === 1;
}
function normalizePlacement(p) {
  return {
    x: Number.isFinite(p.x) ? p.x : 0,
    y: Number.isFinite(p.y) ? p.y : 0,
    scale: clampPlacementScale(p.scale)
  };
}
function readPlacement(value) {
  if (value === void 0) return { placement: void 0, repaired: false };
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { placement: void 0, repaired: true };
  const raw = value;
  const num = (v, fallback) => typeof v === "number" && Number.isFinite(v) ? v : fallback;
  const placement = normalizePlacement({ x: num(raw["x"], 0), y: num(raw["y"], 0), scale: num(raw["scale"], 1) });
  const repaired = placement.x !== raw["x"] || placement.y !== raw["y"] || placement.scale !== raw["scale"];
  return { placement: isIdentityPlacement(placement) ? void 0 : placement, repaired };
}
const MAX_DOCUMENT_SIDE = 16384;
function parseDocument(raw) {
  if (raw === null || raw === void 0) return { status: "empty" };
  let data = raw;
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
function migrate(data) {
  const version = data["version"];
  if (version === DOCUMENT_VERSION) return data;
  return `unsupported document version ${JSON.stringify(version)}`;
}
function validate(data) {
  const frame = readSize(data["frame"]);
  if (!frame) return { status: "invalid", reason: "missing or invalid frame" };
  let repaired = false;
  let bounds = readRect(data["bounds"]);
  if (!bounds) {
    bounds = frameRect(frame);
    repaired = true;
  } else if (!containsRect(bounds, frameRect(frame))) {
    return { status: "invalid", reason: "bounds does not contain the frame" };
  }
  if (bounds.width > MAX_DOCUMENT_SIDE || bounds.height > MAX_DOCUMENT_SIDE) {
    return { status: "invalid", reason: "bounds too large" };
  }
  const rawLayers = data["layers"];
  if (!Array.isArray(rawLayers)) return { status: "invalid", reason: "layers is not an array" };
  const layers = [];
  const seen = /* @__PURE__ */ new Set();
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
      docId,
      frame,
      bounds,
      regions: regions ?? [],
      ...placed.placement ? { placement: placed.placement } : {},
      activeLayerId,
      layers
    }
  };
}
const LAYER_KINDS = /* @__PURE__ */ new Set(["paint", "text", "mask"]);
function readLayer(value) {
  if (!isRecord(value)) return null;
  const id = value["id"];
  const kind = value["kind"];
  if (typeof id !== "string" || !id) return null;
  if (typeof kind !== "string" || !LAYER_KINDS.has(kind)) return null;
  const file = value["file"];
  if (file !== null && file !== void 0 && (typeof file !== "string" || !file.trim())) return null;
  const layer = {
    id,
    name: typeof value["name"] === "string" ? value["name"] : id,
    kind,
    visible: typeof value["visible"] === "boolean" ? value["visible"] : true,
    locked: typeof value["locked"] === "boolean" ? value["locked"] : false,
    opacity: clamp01$1(value["opacity"], 1),
    blendMode: "normal",
    file: typeof file === "string" ? file : null
  };
  if (typeof value["color"] === "string") layer.color = value["color"];
  if (typeof value["invert"] === "boolean") layer.invert = value["invert"];
  if (isRecord(value["textData"])) layer.textData = value["textData"];
  return layer;
}
function readRegions(value) {
  if (value === void 0) return null;
  if (!Array.isArray(value)) return null;
  const regions = [];
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
function readSize(value) {
  if (!isRecord(value)) return null;
  const width = value["width"];
  const height = value["height"];
  if (!isSide(width) || !isSide(height)) return null;
  return { width, height };
}
function readRect(value) {
  if (!isRecord(value)) return null;
  const size = readSize(value);
  const x = value["x"];
  const y = value["y"];
  if (!size || !isInt(x) || !isInt(y)) return null;
  return { x, y, ...size };
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isInt(value) {
  return typeof value === "number" && Number.isInteger(value) && Math.abs(value) <= MAX_DOCUMENT_SIDE * 4;
}
function isSide(value) {
  return isInt(value) && value >= 1 && value <= MAX_DOCUMENT_SIDE;
}
function clamp01$1(value, fallback) {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(1, Math.max(0, value));
}
function stringifyDocument(doc) {
  const p = doc.placement;
  return JSON.stringify({
    version: doc.version,
    docId: doc.docId,
    frame: { width: doc.frame.width, height: doc.frame.height },
    bounds: { x: doc.bounds.x, y: doc.bounds.y, width: doc.bounds.width, height: doc.bounds.height },
    regions: doc.regions.map((r) => ({
      id: r.id,
      index: r.index,
      rect: { x: r.rect.x, y: r.rect.y, width: r.rect.width, height: r.rect.height }
    })),
    // Only when moved: identity manifests stay byte-identical to pre-M5 ones.
    ...p && !isIdentityPlacement(p) ? { placement: { x: p.x, y: p.y, scale: p.scale } } : {},
    activeLayerId: doc.activeLayerId,
    layers: doc.layers.map(serializeLayer)
  });
}
function serializeLayer(layer) {
  const out = {
    id: layer.id,
    name: layer.name,
    kind: layer.kind,
    visible: layer.visible,
    locked: layer.locked,
    opacity: layer.opacity,
    blendMode: layer.blendMode,
    file: layer.file
  };
  if (layer.color !== void 0) out["color"] = layer.color;
  if (layer.invert !== void 0) out["invert"] = layer.invert;
  if (layer.textData !== void 0) out["textData"] = layer.textData;
  return out;
}
function cloneDocument(doc) {
  return {
    ...doc,
    frame: { ...doc.frame },
    bounds: { ...doc.bounds },
    regions: doc.regions.map((r) => ({ ...r, rect: { ...r.rect } })),
    ...doc.placement ? { placement: { ...doc.placement } } : {},
    layers: doc.layers.map((l) => ({ ...l, ...l.textData ? { textData: { ...l.textData } } : {} }))
  };
}
class Emitter {
  listeners = /* @__PURE__ */ new Map();
  /**
   * Subscribe.
   * @param event - Event name.
   * @param listener - Callback.
   * @returns Unsubscribe function.
   */
  on(event, listener) {
    let set = this.listeners.get(event);
    if (!set) {
      set = /* @__PURE__ */ new Set();
      this.listeners.set(event, set);
    }
    set.add(listener);
    return () => set.delete(listener);
  }
  /**
   * Notify listeners.
   * @param event - Event name.
   * @param payload - Payload.
   */
  emit(event, payload) {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const listener of [...set]) listener(payload);
  }
  /** Remove all listeners. */
  clear() {
    this.listeners.clear();
  }
}
const DEFAULT_COLORS = { fg: "#000000", bg: "#ffffff" };
function normalizeHex(value) {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim());
  const hex = m?.[1];
  if (!hex) return null;
  const full = hex.length === 3 ? [...hex].map((c) => c + c).join("") : hex;
  return `#${full.toLowerCase()}`;
}
class ColorState {
  events = new Emitter();
  pair;
  /**
   * @param initial - Starting colours (defaults to black/white).
   */
  constructor(initial = DEFAULT_COLORS) {
    this.pair = { fg: normalizeHex(initial.fg) ?? DEFAULT_COLORS.fg, bg: normalizeHex(initial.bg) ?? DEFAULT_COLORS.bg };
  }
  /** Foreground colour (`#rrggbb`). */
  get fg() {
    return this.pair.fg;
  }
  /** Background colour (`#rrggbb`). */
  get bg() {
    return this.pair.bg;
  }
  /** Both colours (copy). */
  get current() {
    return { ...this.pair };
  }
  /**
   * Set one colour; invalid values are ignored.
   * @param slot - Foreground or background.
   * @param value - Hex colour.
   */
  set(slot, value) {
    const hex = normalizeHex(value);
    if (!hex || hex === this.pair[slot]) return;
    this.pair = { ...this.pair, [slot]: hex };
    this.emit();
  }
  /** Swap foreground and background (`X`). */
  swap() {
    if (this.pair.fg === this.pair.bg) return;
    this.pair = { fg: this.pair.bg, bg: this.pair.fg };
    this.emit();
  }
  /** Reset to black foreground, white background (`D`). */
  reset() {
    if (this.pair.fg === DEFAULT_COLORS.fg && this.pair.bg === DEFAULT_COLORS.bg) return;
    this.pair = { ...DEFAULT_COLORS };
    this.emit();
  }
  emit() {
    this.events.emit("change", { ...this.pair });
  }
}
class DocIO {
  /**
   * @param s - Shared editor state.
   * @param applyBackgroundSize - Re-run a background size change deferred while loading.
   */
  constructor(s, applyBackgroundSize) {
    this.s = s;
    this.applyBackgroundSize = applyBackgroundSize;
  }
  s;
  applyBackgroundSize;
  /** Mark the start of an async layer restore (disables painting). */
  beginLoading() {
    this.s.loadingCount++;
  }
  /** Mark the end of an async layer restore; applies a deferred frame change. */
  endLoading() {
    const s = this.s;
    s.loadingCount = Math.max(0, s.loadingCount - 1);
    s.events.emit("render", void 0);
    if (!s.loading && s.pendingBackgroundSize) {
      const size = s.pendingBackgroundSize;
      s.pendingBackgroundSize = null;
      this.applyBackgroundSize(size);
    }
  }
  /**
   * Draw a restored layer image (WebP or PNG) into a layer (not an undo
   * step, not dirty).
   * @param layerId - Layer id.
   * @param image - Decoded image (sized to `bounds`).
   */
  restoreLayerPixels(layerId, image) {
    const surface = this.s.store.ensure(layerId);
    surface.ctx.clearRect(0, 0, surface.canvas.width, surface.canvas.height);
    surface.ctx.drawImage(image, 0, 0);
    this.s.runtime.bump(layerId);
    this.s.events.emit("render", void 0);
  }
  /**
   * Record a finished upload.
   * @param layerId - Layer id.
   * @param version - Layer version that was uploaded.
   * @param file - Stored file reference (`null` for an empty layer).
   */
  markUploaded(layerId, version, file) {
    const layer = this.s.doc.layers.find((l) => l.id === layerId);
    const rt = this.s.runtime.get(layerId);
    if (!layer || !rt) return;
    layer.file = file;
    if (rt.version === version) rt.dirty = false;
    this.s.events.emit("change", void 0);
  }
}
function findMaskLayer(doc) {
  const active = doc.layers.find((l) => l.id === doc.activeLayerId);
  if (active?.kind === "mask") return active;
  return doc.layers.find((l) => l.kind === "mask");
}
function findPaintLayer(doc) {
  const active = doc.layers.find((l) => l.id === doc.activeLayerId);
  if (active?.kind === "paint") return active;
  for (let i = doc.layers.length - 1; i >= 0; i--) {
    const layer = doc.layers[i];
    if (layer?.kind === "paint") return layer;
  }
  return void 0;
}
function targetLayer(doc, target) {
  return target === "mask" ? findMaskLayer(doc) : findPaintLayer(doc);
}
function ensureMaskLayer(doc) {
  const existing = findMaskLayer(doc);
  if (existing) return { layer: existing, created: false };
  const layer = createMaskLayer();
  doc.layers.push(layer);
  return { layer, created: true };
}
function maskDisplayColor(layer) {
  const color = layer.color;
  return typeof color === "string" && /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(color) ? color : DEFAULT_MASK_COLOR;
}
const DEFAULT_GROWTH = { chunk: 256, capFactor: 3, maxSide: 16384 };
function boundsCap(frame, limits = DEFAULT_GROWTH) {
  const width = Math.max(frame.width, Math.min(Math.round(frame.width * limits.capFactor), limits.maxSide));
  const height = Math.max(frame.height, Math.min(Math.round(frame.height * limits.capFactor), limits.maxSide));
  return {
    x: -Math.floor((width - frame.width) / 2),
    y: -Math.floor((height - frame.height) / 2),
    width,
    height
  };
}
function growBounds(bounds, need, frame, limits = DEFAULT_GROWTH) {
  const cap = boundsCap(frame, limits);
  const target = intersectRect(roundOutRect(need), cap);
  if (target.width <= 0 || target.height <= 0 || containsRect(bounds, target)) return { ...bounds };
  const chunk = Math.max(1, limits.chunk);
  const grow = (distance) => distance > 0 ? Math.ceil(distance / chunk) * chunk : 0;
  const left = grow(bounds.x - target.x);
  const top = grow(bounds.y - target.y);
  const right = grow(target.x + target.width - (bounds.x + bounds.width));
  const bottom = grow(target.y + target.height - (bounds.y + bounds.height));
  const grown = {
    x: bounds.x - left,
    y: bounds.y - top,
    width: bounds.width + left + right,
    height: bounds.height + top + bottom
  };
  return unionRect(intersectRect(grown, cap), bounds);
}
const DEFAULT_HISTORY_BYTES = 256 * 1024 * 1024;
class HistoryStack {
  /**
   * @param maxBytes - Memory budget across both stacks.
   */
  constructor(maxBytes = DEFAULT_HISTORY_BYTES) {
    this.maxBytes = maxBytes;
  }
  maxBytes;
  undoStack = [];
  redoStack = [];
  total = 0;
  /** Whether there is something to undo. */
  get canUndo() {
    return this.undoStack.length > 0;
  }
  /** Whether there is something to redo. */
  get canRedo() {
    return this.redoStack.length > 0;
  }
  /** Estimated bytes held. */
  get totalBytes() {
    return this.total;
  }
  /** Number of undo entries. */
  get undoDepth() {
    return this.undoStack.length;
  }
  /** Number of redo entries. */
  get redoDepth() {
    return this.redoStack.length;
  }
  /**
   * The newest undo entry, only while nothing is redoable (the entry a
   * continuing gesture may merge into).
   * @returns The entry, or `undefined`.
   */
  mergeTarget() {
    return this.redoStack.length ? void 0 : this.undoStack[this.undoStack.length - 1];
  }
  /**
   * Record a new operation. Clears the redo stack, then enforces the cap.
   *
   * @param entry - The applied operation.
   * @returns Entries evicted to stay within budget (oldest first).
   */
  push(entry) {
    for (const dropped of this.redoStack) this.total -= dropped.bytes;
    this.redoStack.length = 0;
    this.undoStack.push(entry);
    this.total += entry.bytes;
    return this.enforceCap();
  }
  /**
   * Move the newest entry to the redo stack.
   *
   * @returns The entry to revert, or `null` when there is nothing to undo.
   */
  undo() {
    const entry = this.undoStack.pop();
    if (!entry) return null;
    this.redoStack.push(entry);
    return entry;
  }
  /**
   * Move the newest redo entry back to the undo stack.
   *
   * @returns The entry to re-apply, or `null` when there is nothing to redo.
   */
  redo() {
    const entry = this.redoStack.pop();
    if (!entry) return null;
    this.undoStack.push(entry);
    return entry;
  }
  /**
   * Whether any entry (undo or redo side) matches.
   * @param predicate - Test.
   * @returns `true` if one matches.
   */
  some(predicate) {
    return this.undoStack.some(predicate) || this.redoStack.some(predicate);
  }
  /** Drop everything. */
  clear() {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.total = 0;
  }
  enforceCap() {
    const evicted = [];
    while (this.total > this.maxBytes && this.undoStack.length > 1) {
      const oldest = this.undoStack.shift();
      if (!oldest) break;
      this.total -= oldest.bytes;
      evicted.push(oldest);
    }
    return evicted;
  }
}
class LayerRuntimeTable {
  entries = /* @__PURE__ */ new Map();
  revisions = /* @__PURE__ */ new Map();
  /** Last version of removed layers (see {@link LayerRuntimeTable.reinstate}). */
  removedVersions = /* @__PURE__ */ new Map();
  revisionCounter = 0;
  /**
   * (Re)initialise a layer's bookkeeping: clean, version 0.
   * @param layerId - Layer id.
   * @param hasContent - Whether the layer holds (saved) paint.
   */
  reset(layerId, hasContent) {
    this.entries.set(layerId, { dirty: false, version: 0, hasContent });
  }
  /**
   * Forget a deleted layer (so it no longer counts as dirty/painted). Its
   * revision is kept so a re-inserted layer never reuses a stale cache key.
   * @param layerId - Layer id.
   */
  remove(layerId) {
    const rt = this.entries.get(layerId);
    if (rt) this.removedVersions.set(layerId, rt.version);
    this.entries.delete(layerId);
  }
  /**
   * (Re)install a layer that is (again) part of the document (new layer,
   * undo of a delete). The version continues past any earlier life of the
   * id, so an upload started before the delete can never mark the restored
   * pixels clean.
   * @param layerId - Layer id.
   * @param hasPixels - The layer holds pixels (dirty until uploaded).
   */
  reinstate(layerId, hasPixels) {
    const version = (this.removedVersions.get(layerId) ?? 0) + 1;
    this.entries.set(layerId, { dirty: hasPixels, version, hasContent: hasPixels });
    this.bump(layerId);
  }
  /**
   * Bookkeeping of a layer.
   * @param layerId - Layer id.
   * @returns The entry or `undefined`.
   */
  get(layerId) {
    return this.entries.get(layerId);
  }
  /**
   * Pixels of a layer were edited: new revision, dirty, next version.
   * @param layerId - Layer id.
   */
  touch(layerId) {
    this.bump(layerId);
    const rt = this.entries.get(layerId);
    if (!rt) return;
    rt.dirty = true;
    rt.version++;
    rt.hasContent = true;
  }
  /**
   * Committed pixels of a layer changed without an edit (restore, cancel):
   * only invalidates caches keyed by the revision.
   * @param layerId - Layer id.
   */
  bump(layerId) {
    this.revisions.set(layerId, ++this.revisionCounter);
  }
  /**
   * Current pixel revision of a layer.
   * @param layerId - Layer id.
   * @returns Revision (0 = never bumped).
   */
  revision(layerId) {
    return this.revisions.get(layerId) ?? 0;
  }
  /** Whether any layer has ever held paint. */
  get hasPaint() {
    for (const r of this.entries.values()) if (r.hasContent) return true;
    return false;
  }
  /** Whether any layer needs uploading. */
  get dirty() {
    for (const r of this.entries.values()) if (r.dirty) return true;
    return false;
  }
  /**
   * Copy every entry of `other` (fork); revisions are not copied.
   * @param other - Source table.
   */
  copyFrom(other) {
    for (const [id, rt] of other.entries) this.entries.set(id, { ...rt });
  }
}
function createSurface(width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error(`Could not create a ${canvas.width}x${canvas.height} canvas`);
  return { canvas, ctx };
}
function releaseSurface(surface) {
  surface.canvas.width = 0;
  surface.canvas.height = 0;
}
function rebaseSurface(source, from, to) {
  const next = createSurface(to.width, to.height);
  next.ctx.drawImage(source.canvas, from.x - to.x, from.y - to.y);
  return next;
}
class LayerStore {
  surfaces = /* @__PURE__ */ new Map();
  currentBounds;
  /**
   * @param bounds - Initial paint area (document coords, integers).
   */
  constructor(bounds) {
    this.currentBounds = { ...bounds };
  }
  /** Current paint area. */
  get bounds() {
    return { ...this.currentBounds };
  }
  /**
   * Surface for a layer, created (transparent) on first use.
   * @param layerId - Layer id.
   * @returns Its surface.
   */
  ensure(layerId) {
    let surface = this.surfaces.get(layerId);
    if (!surface) {
      surface = createSurface(this.currentBounds.width, this.currentBounds.height);
      this.surfaces.set(layerId, surface);
    }
    return surface;
  }
  /**
   * Existing surface for a layer.
   * @param layerId - Layer id.
   * @returns Surface or `undefined`.
   */
  get(layerId) {
    return this.surfaces.get(layerId);
  }
  /**
   * Drop layers not in `keep`.
   * @param keep - Layer ids to keep.
   */
  retain(keep) {
    for (const [id, surface] of this.surfaces) {
      if (keep.has(id)) continue;
      releaseSurface(surface);
      this.surfaces.delete(id);
    }
  }
  /**
   * Change the paint area, keeping every pixel at its document position
   * (pixels outside the new bounds are dropped).
   * @param bounds - New bounds.
   */
  rebase(bounds) {
    if (rectEquals(bounds, this.currentBounds)) return;
    for (const [id, surface] of this.surfaces) {
      this.surfaces.set(id, rebaseSurface(surface, this.currentBounds, bounds));
      releaseSurface(surface);
    }
    this.currentBounds = { ...bounds };
  }
  /**
   * Replace bounds and clear every layer (no pixel preservation).
   * @param bounds - New bounds.
   */
  reset(bounds) {
    for (const surface of this.surfaces.values()) releaseSurface(surface);
    this.surfaces.clear();
    this.currentBounds = { ...bounds };
  }
  /**
   * Read pixels of a document rect (clipped to bounds).
   * @param layerId - Layer id.
   * @param rect - Integer document rect.
   * @returns Pixels and the clipped rect, or `null` if nothing overlaps.
   */
  read(layerId, rect) {
    const clipped = intersectRect(rect, this.currentBounds);
    if (isEmptyRect(clipped)) return null;
    const { ctx } = this.ensure(layerId);
    const data = ctx.getImageData(
      clipped.x - this.currentBounds.x,
      clipped.y - this.currentBounds.y,
      clipped.width,
      clipped.height
    );
    return { rect: clipped, data };
  }
  /**
   * Write pixels at a document position (replaces, no blending).
   * @param layerId - Layer id.
   * @param x - Document x of the data's top-left.
   * @param y - Document y of the data's top-left.
   * @param data - Pixels.
   */
  write(layerId, x, y, data) {
    const { ctx } = this.ensure(layerId);
    ctx.putImageData(data, x - this.currentBounds.x, y - this.currentBounds.y);
  }
  /**
   * Whole-layer snapshot.
   * @param layerId - Layer id.
   * @returns Pixels covering `bounds`.
   */
  snapshot(layerId) {
    const { ctx, canvas } = this.ensure(layerId);
    return ctx.getImageData(0, 0, canvas.width, canvas.height);
  }
  /**
   * Deep copy (pixels duplicated).
   * @returns Independent store.
   */
  clone() {
    const copy = new LayerStore(this.currentBounds);
    for (const [id, surface] of this.surfaces) {
      copy.ensure(id).ctx.drawImage(surface.canvas, 0, 0);
    }
    return copy;
  }
  /** Estimated bytes held by layer canvases. */
  get bytes() {
    return this.surfaces.size * this.currentBounds.width * this.currentBounds.height * 4;
  }
  /** Release every canvas. */
  dispose() {
    for (const surface of this.surfaces.values()) releaseSurface(surface);
    this.surfaces.clear();
  }
}
const EMPTY$1 = { x: 0, y: 0, width: 0, height: 0 };
function selectionMode(shift, alt) {
  if (shift && alt) return "intersect";
  if (shift) return "add";
  if (alt) return "subtract";
  return "replace";
}
function snapRect(box) {
  const x0 = Math.round(box.x);
  const y0 = Math.round(box.y);
  const x1 = Math.round(box.x + box.width);
  const y1 = Math.round(box.y + box.height);
  return { x: Math.min(x0, x1), y: Math.min(y0, y1), width: Math.abs(x1 - x0), height: Math.abs(y1 - y0) };
}
function rectSelection(box) {
  const rect = snapRect(box);
  if (isEmptyRect(rect)) return null;
  return { rect, data: new Uint8Array(rect.width * rect.height).fill(255), outside: 0 };
}
function selectionFromCoverage(coverage, area, bbox) {
  if (coverage.length < area.width * area.height) return null;
  const inner = bbox ? intersectRect(bbox, { x: 0, y: 0, width: area.width, height: area.height }) : null;
  if (inner && isEmptyRect(inner)) return null;
  const crop = inner ?? { x: 0, y: 0, width: area.width, height: area.height };
  const data = copyRegion(coverage, area.width, crop);
  return trimSelection({ rect: { x: area.x + crop.x, y: area.y + crop.y, width: crop.width, height: crop.height }, data, outside: 0 });
}
function coverageFor(sel, area) {
  const out = new Uint8Array(Math.max(0, area.width * area.height));
  if (sel.outside) out.fill(sel.outside);
  const overlap = intersectRect(sel.rect, area);
  if (isEmptyRect(overlap)) return out;
  const sw = sel.rect.width;
  for (let y = overlap.y; y < overlap.y + overlap.height; y++) {
    const src = (y - sel.rect.y) * sw + (overlap.x - sel.rect.x);
    out.set(sel.data.subarray(src, src + overlap.width), (y - area.y) * area.width + (overlap.x - area.x));
  }
  return out;
}
function selectionExtent(sel, area) {
  return intersectRect(sel.outside ? area : sel.rect, area);
}
function selectionsEqual(a, b) {
  if (a === b) return true;
  if (!a || !b || a.outside !== b.outside) return false;
  const r = a.rect;
  const q = b.rect;
  if (r.x !== q.x || r.y !== q.y || r.width !== q.width || r.height !== q.height) return false;
  for (let i = 0; i < a.data.length; i++) if (a.data[i] !== b.data[i]) return false;
  return true;
}
function selectionBytes(sel) {
  return (sel?.data.byteLength ?? 0) + 64;
}
const OPS = {
  add: (a, b) => a > b ? a : b,
  subtract: (a, b) => Math.min(a, 255 - b),
  intersect: (a, b) => a < b ? a : b
};
function combineSelection(current, next, mode) {
  if (mode === "replace") return next ? trimSelection(next) : null;
  if (!current) return mode === "add" && next ? trimSelection(next) : null;
  if (!next) return mode === "intersect" ? null : current;
  const op = OPS[mode];
  const outside = op(current.outside, next.outside) >= 128 ? 255 : 0;
  const rect = unionRect(current.rect, next.rect);
  const a = coverageFor(current, rect);
  const b = coverageFor(next, rect);
  const data = new Uint8Array(a.length);
  for (let i = 0; i < data.length; i++) data[i] = op(a[i], b[i]);
  return trimSelection({ rect, data, outside });
}
function invertSelection(sel) {
  if (!sel) return null;
  const data = new Uint8Array(sel.data.length);
  for (let i = 0; i < data.length; i++) data[i] = 255 - sel.data[i];
  return trimSelection({ rect: { ...sel.rect }, data, outside: sel.outside ? 0 : 255 });
}
function clipSelection(sel, limit) {
  if (!sel) return null;
  const rect = sel.outside ? { ...limit } : intersectRect(sel.rect, limit);
  if (isEmptyRect(rect)) return null;
  return trimSelection({ rect, data: coverageFor(sel, rect), outside: 0 });
}
function trimSelection(sel) {
  const { rect, data, outside } = sel;
  let minX = rect.width;
  let minY = rect.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < rect.height; y++) {
    const row = y * rect.width;
    for (let x = 0; x < rect.width; x++) {
      if (data[row + x] === outside) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return outside ? { rect: { ...EMPTY$1, x: rect.x, y: rect.y }, data: new Uint8Array(0), outside } : null;
  if (minX === 0 && minY === 0 && maxX === rect.width - 1 && maxY === rect.height - 1) return sel;
  const crop = { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
  return {
    rect: { x: rect.x + crop.x, y: rect.y + crop.y, width: crop.width, height: crop.height },
    data: copyRegion(data, rect.width, crop),
    outside
  };
}
function eraseCoverage(dst, rect, coverage, coverageWidth) {
  for (let y = 0; y < rect.height; y++) {
    const row = (rect.y + y) * coverageWidth + rect.x;
    for (let x = 0; x < rect.width; x++) {
      const c = coverage[row + x];
      if (c === 0) continue;
      const p = (y * rect.width + x) * 4 + 3;
      dst[p] = dst[p] * (255 - c) / 255;
    }
  }
}
function copyRegion(src, stride, crop) {
  const out = new Uint8Array(crop.width * crop.height);
  for (let y = 0; y < crop.height; y++) {
    const from = (crop.y + y) * stride + crop.x;
    out.set(src.subarray(from, from + crop.width), y * crop.width);
  }
  return out;
}
const OUTLINE_THRESHOLD = 128;
const E = 1;
const S = 2;
const W = 4;
const N = 8;
function outlineContours(sel, area) {
  const { rect, data } = sel;
  const outsideIn = sel.outside >= OUTLINE_THRESHOLD;
  const bounded = outsideIn && area !== void 0 && !isEmptyRect(area);
  const dom = bounded ? unionRect(rect, area) : rect;
  const beyond = outsideIn && !bounded;
  const w = dom.width;
  const h = dom.height;
  if (w <= 0 || h <= 0) return [];
  if (!bounded && isUniform(data)) {
    if (data[0] >= OUTLINE_THRESHOLD === beyond) return [];
    return [rectContour(dom)];
  }
  const gw = w + 2;
  const grid = new Uint8Array(gw * (h + 2));
  if (beyond) grid.fill(1);
  const ox = rect.x - dom.x;
  const oy = rect.y - dom.y;
  if (bounded) {
    for (let y = 0; y < h; y++) grid.fill(1, (y + 1) * gw + 1, (y + 1) * gw + 1 + w);
  }
  for (let y = 0; y < rect.height; y++) {
    const src = y * rect.width;
    const dst = (y + oy + 1) * gw + ox + 1;
    for (let x = 0; x < rect.width; x++) grid[dst + x] = data[src + x] >= OUTLINE_THRESHOLD ? 1 : 0;
  }
  const vw = w + 1;
  const out = new Uint8Array(vw * (h + 1));
  for (let vy = 0; vy <= h; vy++) {
    const above = vy * gw + 1;
    const below = above + gw;
    const v = vy * vw;
    for (let px = 0; px < w; px++) {
      const a = grid[above + px];
      const b = grid[below + px];
      if (a === b) continue;
      if (b) addBit(out, v + px, E);
      else addBit(out, v + px + 1, W);
    }
  }
  for (let py = 0; py < h; py++) {
    const row = (py + 1) * gw;
    for (let vx = 0; vx <= w; vx++) {
      const l = grid[row + vx];
      const r = grid[row + vx + 1];
      if (l === r) continue;
      if (r) addBit(out, (py + 1) * vw + vx, N);
      else addBit(out, py * vw + vx, S);
    }
  }
  const contours = [];
  const pts = [];
  for (let start = 0; start < out.length; start++) {
    if (out[start] === 0) continue;
    pts.length = 0;
    let v = start;
    let dir = 0;
    for (; ; ) {
      const bits = out[v];
      if (bits === 0) break;
      const next = dir === 0 ? lowestBit(bits) : pick(bits, dir);
      out[v] = bits & ~next;
      if (next !== dir) pts.push(dom.x + v % vw, dom.y + (v / vw | 0));
      dir = next;
      v += dir === E ? 1 : dir === W ? -1 : dir === S ? vw : -vw;
    }
    if (pts.length >= 8) contours.push(Float64Array.from(pts));
  }
  return contours;
}
function pick(bits, dir) {
  const right = dir === N ? E : dir << 1;
  if (bits & right) return right;
  if (bits & dir) return dir;
  const left = dir === E ? N : dir >> 1;
  if (bits & left) return left;
  return lowestBit(bits);
}
function addBit(out, i, bit) {
  out[i] = out[i] | bit;
}
function lowestBit(bits) {
  return bits & -bits;
}
function rectContour(r) {
  const x1 = r.x + r.width;
  const y1 = r.y + r.height;
  return Float64Array.from([r.x, r.y, x1, r.y, x1, y1, r.x, y1]);
}
function isUniform(data) {
  const first = data[0];
  for (let i = 1; i < data.length; i++) if (data[i] !== first) return false;
  return true;
}
class SelectionState {
  /**
   * @param onChange - Called after every change (emits the editor `selection` event).
   */
  constructor(onChange) {
    this.onChange = onChange;
  }
  onChange;
  sel = null;
  rev = 0;
  outlineCache = null;
  clip = null;
  /** Current selection (`null` = none: everything editable). */
  get current() {
    return this.sel;
  }
  /** Bumped on every change (cache key for the UI). */
  get revision() {
    return this.rev;
  }
  /**
   * Replace the selection (no history; `selectionOps.ts` records it).
   * @param sel - New selection or `null`.
   */
  set(sel) {
    if (sel === this.sel) return;
    this.sel = sel;
    this.rev++;
    this.onChange();
  }
  /**
   * Cached outline contours of the current selection.
   * @param frame - Image frame rect (bounds an inverted selection's outline).
   * @returns Closed contours in document coords, or `null` without a selection.
   */
  outline(frame) {
    if (!this.sel) return null;
    const cached = this.outlineCache;
    if (cached && cached.rev === this.rev && rectEquals(cached.frame, frame)) return cached.contours;
    const contours = outlineContours(this.sel, frame);
    this.outlineCache = { rev: this.rev, frame: { ...frame }, contours };
    return contours;
  }
  /**
   * Clip mask for strokes: a canvas sized to `bounds` whose alpha is the
   * selection coverage (used with `destination-in`).
   * @param bounds - Current paint bounds.
   * @returns The canvas, or `null` without a selection.
   */
  clipCanvas(bounds) {
    const sel = this.sel;
    if (!sel) return null;
    const cached = this.clip;
    if (cached && cached.rev === this.rev && rectEquals(cached.bounds, bounds)) return cached.surface.canvas;
    this.releaseClip();
    const surface = createSurface(bounds.width, bounds.height);
    const coverage = coverageFor(sel, bounds);
    const image = surface.ctx.createImageData(surface.canvas.width, surface.canvas.height);
    const px = image.data;
    for (let i = 0; i < coverage.length; i++) px[i * 4 + 3] = coverage[i];
    surface.ctx.putImageData(image, 0, 0);
    this.clip = { rev: this.rev, bounds: { ...bounds }, surface };
    return surface.canvas;
  }
  /**
   * Selection coverage over `area` for the bucket fill's `clip` seam.
   * @param area - Integer document rect (the bounds).
   * @returns Coverage bytes, or `undefined` without a selection.
   */
  coverage(area) {
    return this.sel ? coverageFor(this.sel, area) : void 0;
  }
  /** Estimated bytes held (selection + clip canvas). */
  get bytes() {
    const clip = this.clip?.surface.canvas;
    return (this.sel?.data.byteLength ?? 0) + (clip ? clip.width * clip.height * 4 : 0);
  }
  /** Release caches (keeps the selection). */
  dispose() {
    this.releaseClip();
    this.outlineCache = null;
  }
  releaseClip() {
    if (this.clip) releaseSurface(this.clip.surface);
    this.clip = null;
  }
}
const MIN_STEP = 0.5;
const MIN_SIZE = 0.5;
function normalizePressure(pointerType, pressure) {
  if (pointerType !== "pen") return 1;
  if (!Number.isFinite(pressure)) return 1;
  return Math.min(1, Math.max(0, pressure));
}
function curvePressure(pressure, gamma) {
  const g = gamma > 0 && Number.isFinite(gamma) ? gamma : 1;
  return Math.pow(Math.min(1, Math.max(0, pressure)), g);
}
function pressureSizeFactor(pressure, minSizeRatio, gamma) {
  const min = Number.isFinite(minSizeRatio) ? Math.min(1, Math.max(0, minSizeRatio)) : 0;
  return min + (1 - min) * curvePressure(pressure, gamma);
}
function dabSize(pressure, dyn) {
  if (!dyn.pressureSize) return Math.max(MIN_SIZE, dyn.size);
  return Math.max(MIN_SIZE, dyn.size * pressureSizeFactor(pressure, dyn.minSizeRatio, dyn.gamma));
}
function dabAlpha(pressure, dyn) {
  const flow = Math.min(1, Math.max(0, dyn.flow));
  return dyn.pressureOpacity ? flow * curvePressure(pressure, dyn.gamma) : flow;
}
function createSpacer() {
  return { last: null, residual: 0 };
}
function placeDabs(state, next, dyn) {
  const prev = state.last;
  state.last = next;
  if (!prev) {
    state.residual = 0;
    return [makeDab(next.x, next.y, next.pressure, dyn)];
  }
  const dx = next.x - prev.x;
  const dy = next.y - prev.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) return [];
  const dabs = [];
  const spacing = Math.max(0.01, dyn.spacing);
  let travelled = 0;
  for (; ; ) {
    const t = travelled / length;
    const pressure = prev.pressure + (next.pressure - prev.pressure) * t;
    const step = Math.max(MIN_STEP, spacing * dabSize(pressure, dyn));
    const needed = step - state.residual;
    if (travelled + needed > length) {
      state.residual += length - travelled;
      break;
    }
    travelled += needed;
    state.residual = 0;
    const u = travelled / length;
    dabs.push(
      makeDab(prev.x + dx * u, prev.y + dy * u, prev.pressure + (next.pressure - prev.pressure) * u, dyn)
    );
  }
  return dabs;
}
function makeDab(x, y, pressure, dyn) {
  return { x, y, size: dabSize(pressure, dyn), alpha: dabAlpha(pressure, dyn) };
}
function dabBounds(dab) {
  const r = dab.size / 2 + 1;
  return { x: dab.x - r, y: dab.y - r, width: r * 2, height: r * 2 };
}
function stampStops(hardness, radiusPx) {
  const h = Math.min(1, Math.max(0, hardness));
  const aaEdge = radiusPx > 1 ? 1 - 1 / radiusPx : 0;
  const inner = Math.min(h, aaEdge);
  if (inner <= 0) return [[0, 1], [1, 0]];
  return [[0, 1], [inner, 1], [1, 0]];
}
const EMPTY = { x: 0, y: 0, width: 0, height: 0 };
class StrokeBuffer {
  buffer = null;
  preview = null;
  bounds = EMPTY;
  style = null;
  strokeRect = EMPTY;
  pendingPreview = EMPTY;
  refreshed = EMPTY;
  /** Selection clip (alpha = coverage, sized to the bounds) or `null` = unclipped. */
  clipSource = () => null;
  /** Buffer x clip, composited instead of the buffer while a selection exists. */
  clipped = null;
  /**
   * Clip every composite (live preview and commit) to a selection: the
   * buffer is multiplied by the clip's alpha right before compositing, so
   * soft coverage never compounds over overlapping dabs.
   * @param source - Returns the clip canvas for the current bounds, or `null`.
   */
  setClip(source) {
    this.clipSource = source;
  }
  /** Document rect refreshed by the last {@link updatePreview} call (may be empty). */
  get lastRefreshed() {
    return { ...this.refreshed };
  }
  /** Whether a stroke is in progress. */
  get active() {
    return this.style !== null;
  }
  /** Document rect touched by the current stroke (integer). */
  get touched() {
    return intersectRect(roundOutRect(this.strokeRect), this.bounds);
  }
  /**
   * Start a stroke over `layer`.
   * @param layer - Target layer surface (sized to `bounds`).
   * @param bounds - Current document bounds.
   * @param style - Stroke appearance.
   */
  begin(layer, bounds, style) {
    this.ensureSize(bounds);
    this.style = style;
    this.strokeRect = EMPTY;
    this.pendingPreview = EMPTY;
    this.refreshed = EMPTY;
    const preview = this.surfaces().preview;
    preview.ctx.clearRect(0, 0, preview.canvas.width, preview.canvas.height);
    preview.ctx.drawImage(layer.canvas, 0, 0);
  }
  /**
   * Follow a bounds change mid-stroke (pixels keep document positions).
   * @param bounds - New bounds.
   */
  rebase(bounds) {
    if (!this.buffer || !this.preview) {
      this.bounds = { ...bounds };
      return;
    }
    const nextBuffer = rebaseSurface(this.buffer, this.bounds, bounds);
    const nextPreview = rebaseSurface(this.preview, this.bounds, bounds);
    releaseSurface(this.buffer);
    releaseSurface(this.preview);
    this.releaseClipped();
    this.buffer = nextBuffer;
    this.preview = nextPreview;
    this.bounds = { ...bounds };
  }
  /**
   * Draw dabs into the buffer.
   * @param dabs - Dabs in document coords.
   * @param stamps - Stamp cache.
   * @param maxDiameter - Largest diameter in this stroke (stamp resolution).
   */
  addDabs(dabs, stamps, maxDiameter) {
    if (!this.style || dabs.length === 0) return;
    const { ctx } = this.surfaces().buffer;
    const color = this.style.mode === "erase" ? "#000000" : this.style.color;
    const stamp = stamps.get(maxDiameter, this.style.hardness, color);
    for (const dab of dabs) {
      ctx.globalAlpha = dab.alpha;
      const r = dab.size / 2;
      ctx.drawImage(stamp.canvas, dab.x - r - this.bounds.x, dab.y - r - this.bounds.y, dab.size, dab.size);
      const rect = dabBounds(dab);
      this.strokeRect = unionRect(this.strokeRect, rect);
      this.pendingPreview = unionRect(this.pendingPreview, rect);
    }
    ctx.globalAlpha = 1;
  }
  /**
   * Replace the buffer content with one shape (shape tools redraw the whole
   * shape on every move): clears what the previous shape drew, draws the
   * new one, and marks both areas for the preview. {@link touched} becomes
   * the new shape's rect.
   * @param rect - Document rect the new shape can touch (empty = nothing).
   * @param draw - Draws into the buffer context; `origin` is the document point at its (0, 0).
   */
  replaceContent(rect, draw) {
    if (!this.style) return;
    const { ctx } = this.surfaces().buffer;
    const old = this.touched;
    if (!isEmptyRect(old)) ctx.clearRect(old.x - this.bounds.x, old.y - this.bounds.y, old.width, old.height);
    this.pendingPreview = unionRect(unionRect(this.pendingPreview, old), rect);
    this.strokeRect = isEmptyRect(rect) ? EMPTY : { ...rect };
    if (!isEmptyRect(rect)) draw(ctx, { x: this.bounds.x, y: this.bounds.y });
  }
  /**
   * Refresh the preview inside the region dirtied since the last call.
   * The refreshed document rect is available as {@link lastRefreshed}.
   * @param layer - Target layer surface.
   * @returns Preview surface to draw instead of the layer.
   */
  updatePreview(layer) {
    const { buffer, preview } = this.surfaces();
    const r = intersectRect(roundOutRect(this.pendingPreview), this.bounds);
    this.pendingPreview = EMPTY;
    this.refreshed = r;
    if (this.style && !isEmptyRect(r)) {
      const x = r.x - this.bounds.x;
      const y = r.y - this.bounds.y;
      const { ctx } = preview;
      ctx.clearRect(x, y, r.width, r.height);
      ctx.drawImage(layer.canvas, x, y, r.width, r.height, x, y, r.width, r.height);
      this.compositeBuffer(ctx, buffer, x, y, r.width, r.height);
    }
    return preview;
  }
  /**
   * Composite the buffer onto the layer inside the touched rect and end the
   * stroke. The caller snapshots `touched` before/after for history.
   * @param layer - Target layer surface.
   */
  commit(layer) {
    const r = this.touched;
    if (this.style && !isEmptyRect(r)) {
      const x = r.x - this.bounds.x;
      const y = r.y - this.bounds.y;
      this.compositeBuffer(layer.ctx, this.surfaces().buffer, x, y, r.width, r.height);
    }
    this.end();
  }
  /** Abort the stroke without touching the layer. */
  cancel() {
    this.end();
  }
  /** Release buffers. */
  dispose() {
    if (this.buffer) releaseSurface(this.buffer);
    if (this.preview) releaseSurface(this.preview);
    this.releaseClipped();
    this.buffer = null;
    this.preview = null;
    this.style = null;
  }
  // ── Internals ───────────────────────────────────────────────────────────
  compositeBuffer(ctx, buffer, x, y, width, height) {
    if (!this.style) return;
    const source = this.clipBuffer(buffer, x, y, width, height);
    ctx.save();
    ctx.globalAlpha = this.style.opacity;
    ctx.globalCompositeOperation = this.style.mode === "erase" ? "destination-out" : "source-over";
    ctx.drawImage(source, x, y, width, height, x, y, width, height);
    ctx.restore();
  }
  /** The buffer region multiplied by the selection clip (or the buffer itself without one). */
  clipBuffer(buffer, x, y, width, height) {
    const clip = this.clipSource();
    if (!clip) return buffer.canvas;
    this.clipped ??= createSurface(buffer.canvas.width, buffer.canvas.height);
    const { ctx } = this.clipped;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, width, height);
    ctx.clip();
    ctx.clearRect(x, y, width, height);
    ctx.drawImage(buffer.canvas, x, y, width, height, x, y, width, height);
    ctx.globalCompositeOperation = "destination-in";
    ctx.drawImage(clip, x, y, width, height, x, y, width, height);
    ctx.restore();
    return this.clipped.canvas;
  }
  releaseClipped() {
    if (this.clipped) releaseSurface(this.clipped);
    this.clipped = null;
  }
  end() {
    const r = this.touched;
    if (this.buffer && !isEmptyRect(r)) {
      this.buffer.ctx.clearRect(r.x - this.bounds.x, r.y - this.bounds.y, r.width, r.height);
    }
    this.style = null;
    this.strokeRect = EMPTY;
    this.pendingPreview = EMPTY;
    this.refreshed = EMPTY;
  }
  ensureSize(bounds) {
    const same = this.buffer && this.bounds.width === bounds.width && this.bounds.height === bounds.height && this.bounds.x === bounds.x && this.bounds.y === bounds.y;
    if (same) return;
    this.dispose();
    this.buffer = createSurface(bounds.width, bounds.height);
    this.preview = createSurface(bounds.width, bounds.height);
    this.bounds = { ...bounds };
  }
  surfaces() {
    if (!this.buffer || !this.preview) throw new Error("StrokeBuffer used before begin()");
    return { buffer: this.buffer, preview: this.preview };
  }
}
const MIN_ZOOM = 0.02;
const MAX_ZOOM = 64;
function fitContain(content, viewport, padding = 0) {
  const vw = finitePositive(viewport.width);
  const vh = finitePositive(viewport.height);
  const pad = Math.max(0, Math.min(finitePositive(padding), vw / 2, vh / 2));
  const availW = vw - pad * 2;
  const availH = vh - pad * 2;
  const cw = finitePositive(content.width);
  const ch = finitePositive(content.height);
  if (cw === 0 || ch === 0 || availW === 0 || availH === 0) {
    return { x: vw / 2, y: vh / 2, width: 0, height: 0, scale: 0 };
  }
  const scale = Math.min(availW / cw, availH / ch);
  const width = cw * scale;
  const height = ch * scale;
  return { x: (vw - width) / 2, y: (vh - height) / 2, width, height, scale };
}
function fitView(frame, stage, padding = 8) {
  const fit = fitContain(frame, stage, padding);
  if (fit.scale <= 0) return { scale: 1, offsetX: 0, offsetY: 0 };
  const scale = clampZoom(fit.scale);
  return {
    scale,
    offsetX: (stage.width - frame.width * scale) / 2,
    offsetY: (stage.height - frame.height * scale) / 2
  };
}
function clampZoom(scale) {
  if (!Number.isFinite(scale) || scale <= 0) return 1;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, scale));
}
function zoomAt(view, newScale, anchor) {
  const scale = clampZoom(newScale);
  const ratio = scale / view.scale;
  return {
    scale,
    offsetX: anchor.x - (anchor.x - view.offsetX) * ratio,
    offsetY: anchor.y - (anchor.y - view.offsetY) * ratio
  };
}
function wheelZoomFactor(deltaPx) {
  const clamped = Math.max(-300, Math.min(300, deltaPx));
  return Math.exp(-clamped * 15e-4);
}
function panBy(view, dx, dy) {
  return { scale: view.scale, offsetX: view.offsetX + dx, offsetY: view.offsetY + dy };
}
function clampOffset(view, frame, stage) {
  const sw = finitePositive(stage.width);
  const sh = finitePositive(stage.height);
  const fw = finitePositive(frame.width) * view.scale;
  const fh = finitePositive(frame.height) * view.scale;
  if (sw === 0 || sh === 0 || fw === 0 || fh === 0) return view;
  const gripX = Math.min(64, fw);
  const gripY = Math.min(64, fh);
  const minOffsetX = gripX - fw;
  const maxOffsetX = sw - gripX;
  const minOffsetY = gripY - fh;
  const maxOffsetY = sh - gripY;
  return {
    scale: view.scale,
    offsetX: Math.min(maxOffsetX, Math.max(minOffsetX, view.offsetX)),
    offsetY: Math.min(maxOffsetY, Math.max(minOffsetY, view.offsetY))
  };
}
function stageToDoc(view, p) {
  return { x: (p.x - view.offsetX) / view.scale, y: (p.y - view.offsetY) / view.scale };
}
function docRectToStage(view, r) {
  return {
    x: r.x * view.scale + view.offsetX,
    y: r.y * view.scale + view.offsetY,
    width: r.width * view.scale,
    height: r.height * view.scale
  };
}
function backingStoreSize(cssSize, devicePixelRatio, displayScale = 1, maxSide = 4096) {
  const cw = finitePositive(cssSize.width);
  const ch = finitePositive(cssSize.height);
  const dpr = finitePositive(devicePixelRatio) || 1;
  const zoom = finitePositive(displayScale) || 1;
  let ratio = dpr * zoom;
  const largest = Math.max(cw, ch) * ratio;
  if (largest > maxSide) ratio *= maxSide / largest;
  return {
    width: Math.max(1, Math.round(cw * ratio)),
    height: Math.max(1, Math.round(ch * ratio)),
    ratio
  };
}
function finitePositive(value) {
  return Number.isFinite(value) && value > 0 ? value : 0;
}
class ViewState {
  transform = { scale: 1, offsetX: 0, offsetY: 0 };
  fitting = true;
  stage = { width: 0, height: 0 };
  frame = { width: 1, height: 1 };
  /** On-screen px per stage CSS px (graph zoom). */
  displayScale = 1;
  /** Current transform. */
  get current() {
    return this.transform;
  }
  /** Whether the view follows "fit to stage". */
  get isFitting() {
    return this.fitting;
  }
  /**
   * Update stage size / graph zoom. In fit mode the view re-fits. In non-fit
   * mode the image point that was at the previous stage centre stays at the
   * new stage centre (resize keeps the canvas centred), then the offset is
   * clamped so the image stays on-screen.
   *
   * @param stage - Stage CSS size.
   * @param displayScale - Ancestor scale (graph zoom).
   * @returns `true` if the transform changed.
   */
  setStage(stage, displayScale) {
    const prev = this.stage;
    this.stage = { ...stage };
    this.displayScale = displayScale > 0 ? displayScale : 1;
    if (this.fitting) return this.refit();
    if (prev.width > 0 && prev.height > 0 && stage.width > 0 && stage.height > 0) {
      const dx = (stage.width - prev.width) / 2;
      const dy = (stage.height - prev.height) / 2;
      this.transform = clampOffset(panBy(this.transform, dx, dy), this.frame, this.stage);
      return true;
    }
    return false;
  }
  /**
   * Update the frame size. In fit mode the view re-fits; in non-fit mode the
   * offset is clamped so the image stays on-screen.
   *
   * @param frame - Document frame size.
   * @returns `true` if the transform changed.
   */
  setFrame(frame) {
    this.frame = { ...frame };
    if (this.fitting) return this.refit();
    const clamped = clampOffset(this.transform, this.frame, this.stage);
    const changed = clamped.offsetX !== this.transform.offsetX || clamped.offsetY !== this.transform.offsetY;
    this.transform = clamped;
    return changed;
  }
  /** Enter fit mode and re-fit (Ctrl+0 / Fit button). */
  fit() {
    this.fitting = true;
    this.refit();
  }
  /**
   * 100% (Ctrl+1): one document pixel per on-screen pixel, centred on the
   * stage centre's document point.
   */
  actualPixels() {
    const centre = { x: this.stage.width / 2, y: this.stage.height / 2 };
    this.setTransform(zoomAt(this.transform, 1 / this.displayScale, centre));
  }
  /**
   * Zoom by a wheel delta around a stage point.
   * @param deltaPx - Wheel delta in px (positive = out).
   * @param anchor - Stage point under the cursor.
   */
  wheelZoom(deltaPx, anchor) {
    this.setTransform(zoomAt(this.transform, this.transform.scale * wheelZoomFactor(deltaPx), anchor));
  }
  /**
   * Zoom by a factor around the stage centre (Ctrl +/-).
   * @param factor - Multiplier.
   */
  zoomBy(factor) {
    const centre = { x: this.stage.width / 2, y: this.stage.height / 2 };
    this.setTransform(zoomAt(this.transform, clampZoom(this.transform.scale * factor), centre));
  }
  /**
   * Pan by stage px.
   * @param dx - Stage px.
   * @param dy - Stage px.
   */
  pan(dx, dy) {
    this.setTransform(panBy(this.transform, dx, dy));
  }
  setTransform(next) {
    this.fitting = false;
    this.transform = clampOffset(next, this.frame, this.stage);
  }
  refit() {
    if (this.stage.width <= 0 || this.stage.height <= 0) return false;
    const next = fitView(this.frame, this.stage);
    const changed = next.scale !== this.transform.scale || next.offsetX !== this.transform.offsetX || next.offsetY !== this.transform.offsetY;
    this.transform = next;
    return changed;
  }
}
class EditorState {
  events = new Emitter();
  view = new ViewState();
  history = new HistoryStack();
  stroke = new StrokeBuffer();
  runtime = new LayerRuntimeTable();
  store;
  /** Current selection (session state, not saved); strokes are clipped to it. */
  selection = new SelectionState(() => this.events.emit("selection", void 0));
  doc;
  frameSource;
  background = { kind: "fill", color: "#ffffff" };
  /**
   * Size of the current image: the background image's natural size, or the
   * `width` x `height` widgets under a fill. `null` = unknown (use `doc.frame`).
   */
  backgroundSize = null;
  loadingCount = 0;
  /** Background size that arrived while loading (applied afterwards). */
  pendingBackgroundSize = null;
  /** Quick Mask paint target (UI state, not saved). */
  target = "paint";
  /** Layer the current stroke paints into. */
  strokeLayerId = null;
  /** Largest dab diameter of the current stroke, document px. */
  strokeDiameter = 1;
  /** Where the previous stroke ended, document coords. */
  lastStrokeEnd = null;
  /**
   * @param doc - Document (copied).
   * @param source - Origin of its frame size.
   * @param store - Existing pixels (for clones); a blank store is created otherwise.
   */
  constructor(doc, source, store) {
    this.doc = cloneDocument(doc);
    this.frameSource = source;
    this.store = store ?? new LayerStore(doc.bounds);
    for (const layer of doc.layers) {
      this.store.ensure(layer.id);
      this.runtime.reset(layer.id, layer.file !== null);
    }
    this.stroke.setClip(() => this.selection.clipCanvas(this.store.bounds));
    this.syncViewFrame();
  }
  /** Layer files are being restored. */
  get loading() {
    return this.loadingCount > 0;
  }
  /** Size the view shows: the current image (image or widget-sized fill), else `doc.frame`. */
  get imageSize() {
    const size = this.backgroundSize;
    return size ? { ...size } : { ...this.doc.frame };
  }
  /** No paint ever and nothing in history that depends on the frame (selection steps don't count). */
  get isEmpty() {
    return !this.runtime.hasPaint && !this.history.some((entry) => entry.kind !== "selection");
  }
  /** The view fits the image, not the document frame. */
  syncViewFrame() {
    this.view.setFrame(this.imageSize);
  }
  /**
   * Grow bounds to cover `need`. Chunked + capped for strokes; exact and
   * uncapped when re-applying history.
   * @param need - Document rect that must be covered.
   * @param chunked - Stroke growth (256 px chunks, capped).
   */
  ensureBounds(need, chunked) {
    const current = this.store.bounds;
    if (containsRect(current, need)) return;
    const next = chunked ? growBounds(current, need, this.doc.frame) : unionRect(current, need);
    if (containsRect(next, current) && (next.width !== current.width || next.height !== current.height)) {
      this.store.rebase(next);
      this.stroke.rebase(next);
      this.doc.bounds = { ...next };
    }
  }
  /**
   * The mask layer, adding a default one (not dirty, no history) when the
   * document has none -- documents saved before M2 get one lazily.
   * @returns The mask layer.
   */
  ensureMask() {
    const { layer, created } = ensureMaskLayer(this.doc);
    if (created) {
      this.store.ensure(layer.id);
      this.runtime.reset(layer.id, false);
      this.events.emit("change", void 0);
      this.events.emit("mask", void 0);
    }
    return layer;
  }
  /** Abort the current stroke (its preview may be cached in a mask tint). */
  cancelStroke() {
    this.stroke.cancel();
    if (this.strokeLayerId) this.runtime.bump(this.strokeLayerId);
    this.strokeLayerId = null;
    this.events.emit("history", void 0);
    this.events.emit("render", void 0);
  }
  /** Notify history, content and render listeners after an edit. */
  afterEdit() {
    this.events.emit("history", void 0);
    this.events.emit("change", void 0);
    this.events.emit("render", void 0);
  }
}
const IDENTITY_MAP = { scale: 1, offsetX: 0, offsetY: 0 };
function frameMap(frame, image, placement) {
  const { width: fw, height: fh } = frame;
  const { width: W2, height: H } = image;
  if (!(fw > 0 && fh > 0 && W2 > 0 && H > 0) || ![fw, fh, W2, H].every(Number.isFinite)) return { ...IDENTITY_MAP };
  const s = Math.min(W2 / fw, H / fh);
  const offsetX = (W2 - fw * s) / 2;
  const offsetY = (H - fh * s) / 2;
  if (!placement || isIdentityPlacement(placement)) return { scale: s, offsetX, offsetY };
  const k = placement.scale;
  return {
    scale: s * k,
    offsetX: offsetX + s * (fw / 2 * (1 - k) + placement.x),
    offsetY: offsetY + s * (fh / 2 * (1 - k) + placement.y)
  };
}
function documentMap(doc, image) {
  return frameMap(doc.frame, image, doc.placement);
}
function docToImage(map, p) {
  return { x: map.offsetX + p.x * map.scale, y: map.offsetY + p.y * map.scale };
}
function imageToDoc(map, p) {
  return { x: (p.x - map.offsetX) / map.scale, y: (p.y - map.offsetY) / map.scale };
}
function docRectToImage(map, r) {
  return {
    x: map.offsetX + r.x * map.scale,
    y: map.offsetY + r.y * map.scale,
    width: r.width * map.scale,
    height: r.height * map.scale
  };
}
function imageRectToDoc(map, r) {
  return {
    x: (r.x - map.offsetX) / map.scale,
    y: (r.y - map.offsetY) / map.scale,
    width: r.width / map.scale,
    height: r.height / map.scale
  };
}
function imageLengthToDoc(map, imageLength) {
  return imageLength / map.scale;
}
function roundHalfEven(value) {
  const floor = Math.floor(value);
  const diff = value - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}
function layerPlacement(map, bounds) {
  return {
    x: roundHalfEven(map.offsetX + bounds.x * map.scale),
    y: roundHalfEven(map.offsetY + bounds.y * map.scale),
    width: Math.max(1, roundHalfEven(bounds.width * map.scale)),
    height: Math.max(1, roundHalfEven(bounds.height * map.scale))
  };
}
class FrameOps {
  /**
   * @param s - Shared editor state.
   */
  constructor(s) {
    this.s = s;
  }
  s;
  /**
   * Set what is drawn under the paint; the view re-fits (in fit mode).
   * @param background - Image or fill.
   * @param imageSize - Size of the current image: the natural size of an
   *   image background, or the `width` x `height` widgets for a fill (no
   *   image connected). `null` = show `doc.frame`.
   */
  setBackground(background, imageSize) {
    this.s.background = background;
    this.s.backgroundSize = imageSize ? { ...imageSize } : null;
    this.s.syncViewFrame();
    this.s.events.emit("render", void 0);
  }
  /**
   * A new current-image size arrived (upstream image, or the widgets while
   * disconnected; call after {@link setBackground}): an empty document
   * adopts it, otherwise it is only a display mapping (decision 4).
   * Deferred while layer files are loading.
   * @param size - Current image size.
   */
  handleBackgroundSize(size) {
    const s = this.s;
    if (s.loading) {
      s.pendingBackgroundSize = { ...size };
      return;
    }
    const source = s.background.kind === "image" ? "image" : "widgets";
    const frame = s.doc.frame;
    if (size.width === frame.width && size.height === frame.height) {
      s.frameSource = source;
      return;
    }
    if (s.isEmpty) this.adoptFrame(size, source);
  }
  /**
   * Replace the frame of an empty document (no history).
   * @param size - New frame.
   * @param source - Origin of the size.
   */
  adoptFrame(size, source) {
    const s = this.s;
    if (s.stroke.active) s.cancelStroke();
    const frame = { width: Math.round(size.width), height: Math.round(size.height) };
    s.doc.frame = frame;
    s.doc.bounds = frameRect(frame);
    delete s.doc.placement;
    s.frameSource = source;
    s.store.reset(s.doc.bounds);
    for (const layer of s.doc.layers) {
      s.store.ensure(layer.id);
      layer.file = null;
      s.runtime.reset(layer.id, false);
      s.runtime.bump(layer.id);
    }
    s.history.clear();
    s.selection.set(null);
    s.lastStrokeEnd = null;
    s.syncViewFrame();
    s.events.emit("placement", void 0);
    s.afterEdit();
  }
  /**
   * Clear all paint and reset the frame to the current image size and the
   * placement to identity, as one undoable step.
   */
  clear() {
    const s = this.s;
    if (s.loading) return;
    if (s.stroke.active) s.cancelStroke();
    const size = s.imageSize;
    const frame = { width: Math.max(1, Math.round(size.width)), height: Math.max(1, Math.round(size.height)) };
    const source = !s.backgroundSize ? s.frameSource : s.background.kind === "image" ? "image" : "widgets";
    const before = this.captureSnapshot();
    const after = { frame, bounds: frameRect(frame), source, pixels: null };
    this.applySnapshot(after);
    s.history.push({ kind: "clear", before, after, bytes: snapshotBytes(before) });
    s.lastStrokeEnd = null;
    s.afterEdit();
  }
  /**
   * Restore a full document snapshot (Clear undo/redo).
   * @param state - Snapshot to apply.
   */
  applySnapshot(state) {
    const s = this.s;
    s.doc.frame = { ...state.frame };
    s.doc.bounds = { ...state.bounds };
    if (state.placement) s.doc.placement = { ...state.placement };
    else delete s.doc.placement;
    s.frameSource = state.source;
    s.store.reset(state.bounds);
    for (const layer of s.doc.layers) {
      const data = state.pixels?.get(layer.id);
      if (data) s.store.write(layer.id, state.bounds.x, state.bounds.y, data);
      else s.store.ensure(layer.id);
      s.runtime.touch(layer.id);
    }
    s.syncViewFrame();
    s.events.emit("placement", void 0);
  }
  captureSnapshot() {
    const s = this.s;
    const pixels = /* @__PURE__ */ new Map();
    for (const layer of s.doc.layers) pixels.set(layer.id, s.store.snapshot(layer.id));
    const placement = s.doc.placement ? { ...s.doc.placement } : void 0;
    return { frame: { ...s.doc.frame }, bounds: s.store.bounds, source: s.frameSource, ...placement ? { placement } : {}, pixels };
  }
}
function snapshotBytes(state) {
  let bytes = 0;
  if (state.pixels) for (const data of state.pixels.values()) bytes += data.data.byteLength;
  return bytes;
}
class MaskTint {
  surface = null;
  key = null;
  /**
   * Bring the tint up to date and return it.
   * @param source - Coverage canvas (layer or stroke preview), sized to `key.bounds`.
   * @param key - Current inputs.
   * @param dirty - Document rect changed in `source` since the last call while
   *   the key is unchanged (live stroke preview); `null` = nothing extra.
   * @returns Tinted canvas sized to `key.bounds`.
   */
  update(source, key, dirty) {
    const surface = this.ensureSurface(key.bounds);
    if (!this.key || !sameKey(this.key, key)) {
      paint(surface.ctx, source, { x: 0, y: 0, width: key.bounds.width, height: key.bounds.height }, key);
    } else if (dirty) {
      const local = intersectRect(
        { x: dirty.x - key.bounds.x, y: dirty.y - key.bounds.y, width: dirty.width, height: dirty.height },
        { x: 0, y: 0, width: key.bounds.width, height: key.bounds.height }
      );
      if (!isEmptyRect(local)) paint(surface.ctx, source, local, key);
    }
    this.key = { ...key, bounds: { ...key.bounds } };
    return surface.canvas;
  }
  /** Release the cached canvas. */
  dispose() {
    if (this.surface) releaseSurface(this.surface);
    this.surface = null;
    this.key = null;
  }
  ensureSurface(bounds) {
    const s = this.surface;
    if (s && s.canvas.width === bounds.width && s.canvas.height === bounds.height) return s;
    if (s) releaseSurface(s);
    this.key = null;
    this.surface = createSurface(bounds.width, bounds.height);
    return this.surface;
  }
}
function sameKey(a, b) {
  return a.revision === b.revision && a.color === b.color && a.invert === b.invert && rectEquals(a.bounds, b.bounds);
}
function paint(ctx, source, r, key) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(r.x, r.y, r.width, r.height);
  ctx.clip();
  ctx.globalAlpha = 1;
  ctx.clearRect(r.x, r.y, r.width, r.height);
  ctx.fillStyle = key.color;
  if (key.invert) {
    ctx.globalCompositeOperation = "source-over";
    ctx.fillRect(r.x, r.y, r.width, r.height);
    ctx.globalCompositeOperation = "destination-out";
    ctx.drawImage(source, r.x, r.y, r.width, r.height, r.x, r.y, r.width, r.height);
  } else {
    ctx.globalCompositeOperation = "source-over";
    ctx.drawImage(source, r.x, r.y, r.width, r.height, r.x, r.y, r.width, r.height);
    ctx.globalCompositeOperation = "source-in";
    ctx.fillRect(r.x, r.y, r.width, r.height);
  }
  ctx.restore();
}
class LayerDisplay {
  /**
   * @param s - Shared editor state.
   */
  constructor(s) {
    this.s = s;
  }
  s;
  tints = /* @__PURE__ */ new Map();
  /**
   * Visible paint layers to composite.
   * @returns Bottom -> top layers.
   */
  compositeLayers() {
    const s = this.s;
    const out = [];
    for (const layer of s.doc.layers) {
      if (!layer.visible || layer.kind === "mask") continue;
      const surface = s.store.ensure(layer.id);
      const source = s.strokeLayerId === layer.id && s.stroke.active ? s.stroke.updatePreview(surface).canvas : surface.canvas;
      out.push({ source, opacity: layer.opacity });
    }
    return out;
  }
  /**
   * Visible mask layers as tinted overlays (drawn above all paint).
   * @returns Bottom -> top overlays.
   */
  maskOverlays() {
    const s = this.s;
    const out = [];
    const bounds = s.store.bounds;
    for (const layer of s.doc.layers) {
      if (!layer.visible || layer.kind !== "mask") continue;
      const surface = s.store.ensure(layer.id);
      const stroking = s.strokeLayerId === layer.id && s.stroke.active;
      const source = stroking ? s.stroke.updatePreview(surface).canvas : surface.canvas;
      let tint = this.tints.get(layer.id);
      if (!tint) {
        tint = new MaskTint();
        this.tints.set(layer.id, tint);
      }
      const color = maskDisplayColor(layer);
      const invert = layer.invert === true;
      const key = { bounds, color, invert, revision: s.runtime.revision(layer.id) };
      const canvas = tint.update(source, key, stroking ? s.stroke.lastRefreshed : null);
      out.push({ tint: canvas, color, opacity: layer.opacity, invert });
    }
    return out;
  }
  /** Release the tint caches. */
  dispose() {
    for (const tint of this.tints.values()) tint.dispose();
    this.tints.clear();
  }
}
const PROP_KEYS = ["name", "opacity", "color", "invert"];
function isPaintLike(layer) {
  return layer.kind !== "mask";
}
function paintLayerCount(layers) {
  let n = 0;
  for (const layer of layers) if (isPaintLike(layer)) n++;
  return n;
}
function nextLayerName(layers) {
  let max = 0;
  for (const layer of layers) {
    const match = /^Layer (\d+)$/.exec(layer.name.trim());
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `Layer ${max + 1}`;
}
function paintInsertIndex(doc) {
  const layers = doc.layers;
  const active = layers.findIndex((l) => l.id === doc.activeLayerId);
  if (active >= 0 && isPaintLike(layers[active])) return active + 1;
  for (let i = layers.length - 1; i >= 0; i--) if (isPaintLike(layers[i])) return i + 1;
  const firstMask = layers.findIndex((l) => l.kind === "mask");
  return firstMask >= 0 ? firstMask : layers.length;
}
function canDeleteLayer(layers, id) {
  const layer = layers.find((l) => l.id === id);
  return !!layer && isPaintLike(layer) && paintLayerCount(layers) > 1;
}
function canDuplicateLayer(layers, id) {
  const layer = layers.find((l) => l.id === id);
  return !!layer && isPaintLike(layer);
}
function activeAfterRemoval(layers, removed) {
  for (let i = Math.min(removed - 1, layers.length - 1); i >= 0; i--) {
    const layer = layers[i];
    if (layer && isPaintLike(layer)) return layer.id;
  }
  for (let i = Math.max(0, removed); i < layers.length; i++) {
    const layer = layers[i];
    if (layer && isPaintLike(layer)) return layer.id;
  }
  return void 0;
}
function resolveMove(layers, id, targetId, above) {
  const from = layers.findIndex((l) => l.id === id);
  const target = layers.findIndex((l) => l.id === targetId);
  const src = layers[from];
  const dst = layers[target];
  if (!src || !dst || !isPaintLike(src) || !isPaintLike(dst)) return null;
  if (from === target) return null;
  const targetAfterRemoval = target > from ? target - 1 : target;
  const to = above ? targetAfterRemoval + 1 : targetAfterRemoval;
  return to === from ? null : { from, to };
}
function readProps(layer, props) {
  const out = {};
  for (const key of PROP_KEYS) if (key in props) Object.assign(out, { [key]: layer[key] });
  return out;
}
function propsDiffer(layer, props) {
  return PROP_KEYS.some((key) => key in props && props[key] !== layer[key]);
}
function writeProps(layer, props) {
  for (const key of PROP_KEYS) {
    if (!(key in props)) continue;
    const value = props[key];
    if (value === void 0) {
      if (key === "color" || key === "invert") delete layer[key];
    } else {
      Object.assign(layer, { [key]: value });
    }
  }
}
function applyLayerChange(layers, change, forward) {
  switch (change.op) {
    case "insert":
    case "remove": {
      const inserting = change.op === "insert" === forward;
      if (inserting) {
        if (layers.some((l) => l.id === change.layer.id)) return false;
        layers.splice(Math.min(change.index, layers.length), 0, { ...change.layer });
        return true;
      }
      const index = layers.findIndex((l) => l.id === change.layer.id);
      const live = layers[index];
      if (!live) return false;
      change.layer = { ...live };
      layers.splice(index, 1);
      return true;
    }
    case "move": {
      const from = forward ? change.from : change.to;
      const to = forward ? change.to : change.from;
      if (layers[from]?.id !== change.id) return false;
      const [moved] = layers.splice(from, 1);
      if (!moved) return false;
      layers.splice(Math.min(to, layers.length), 0, moved);
      return true;
    }
    case "props": {
      const layer = layers.find((l) => l.id === change.id);
      if (!layer) return false;
      writeProps(layer, forward ? change.after : change.before);
      return true;
    }
  }
}
const LAYERS_ENTRY_BASE_BYTES = 256;
function changesBytes(changes) {
  let bytes = LAYERS_ENTRY_BASE_BYTES;
  for (const change of changes) {
    if ((change.op === "insert" || change.op === "remove") && change.pixels) bytes += change.pixels.data.data.byteLength;
  }
  return bytes;
}
function captureLayerPixels(s, layerId) {
  if (!s.runtime.get(layerId)?.hasContent) return null;
  const bounds = s.store.bounds;
  return { x: bounds.x, y: bounds.y, data: s.store.snapshot(layerId) };
}
function installLayerPixels(s, layerId, pixels) {
  const surface = s.store.ensure(layerId);
  surface.ctx.clearRect(0, 0, surface.canvas.width, surface.canvas.height);
  if (pixels) {
    s.ensureBounds({ x: pixels.x, y: pixels.y, width: pixels.data.width, height: pixels.data.height }, false);
    s.store.write(layerId, pixels.x, pixels.y, pixels.data);
  }
  s.runtime.reinstate(layerId, pixels !== null);
}
function releaseRemovedLayers(s) {
  const keep = new Set(s.doc.layers.map((l) => l.id));
  s.store.retain(keep);
}
function applyLayersEntry(s, entry, forward) {
  if (s.stroke.active) s.cancelStroke();
  const changes = forward ? entry.changes : [...entry.changes].reverse();
  for (const change of changes) {
    if (!applyLayerChange(s.doc.layers, change, forward)) continue;
    if (change.op !== "insert" && change.op !== "remove") continue;
    const appeared = change.op === "insert" === forward;
    if (appeared) installLayerPixels(s, change.layer.id, change.pixels);
    else s.runtime.remove(change.layer.id);
  }
  const active = forward ? entry.activeAfter : entry.activeBefore;
  if (s.doc.layers.some((l) => l.id === active && isPaintLike(l))) s.doc.activeLayerId = active;
  releaseRemovedLayers(s);
  emitLayerEvents(s);
}
function emitLayerEvents(s) {
  s.events.emit("layers", void 0);
  s.events.emit("mask", void 0);
}
class LayerOps {
  /**
   * @param s - Shared editor state.
   */
  constructor(s) {
    this.s = s;
  }
  s;
  // ── Queries ─────────────────────────────────────────────────────────────
  /**
   * Pixel revision of a layer: changes whenever its committed pixels change
   * (thumbnail cache key; not bumped during a stroke preview).
   * @param layerId - Layer id.
   * @returns Revision number.
   */
  revision(layerId) {
    return this.s.runtime.revision(layerId);
  }
  /**
   * Whether the layer can be deleted (paint-like, not the last one).
   * @param layerId - Layer id.
   * @returns `true` if deletable.
   */
  canDelete(layerId) {
    return canDeleteLayer(this.s.doc.layers, layerId);
  }
  /**
   * Whether the layer can be duplicated (paint-like).
   * @param layerId - Layer id.
   * @returns `true` if duplicable.
   */
  canDuplicate(layerId) {
    return canDuplicateLayer(this.s.doc.layers, layerId);
  }
  // ── Not undoable ────────────────────────────────────────────────────────
  /**
   * Make a paint layer the active one (the layer strokes go to outside
   * Quick Mask). Mask layers are selected via the paint target instead.
   * @param layerId - Paint layer id.
   * @returns `true` if the active layer changed.
   */
  setActiveLayer(layerId) {
    const s = this.s;
    const layer = this.find(layerId);
    if (!layer || !isPaintLike(layer) || s.doc.activeLayerId === layerId) return false;
    if (s.stroke.active) s.cancelStroke();
    s.doc.activeLayerId = layerId;
    s.events.emit("layers", void 0);
    s.events.emit("change", void 0);
    return true;
  }
  /**
   * Show or hide a layer (hidden layers are skipped in `IMAGE`/`MASK`).
   * @param layerId - Layer id.
   * @param visible - Visibility.
   */
  setVisible(layerId, visible) {
    const s = this.s;
    const layer = this.find(layerId);
    if (!layer || layer.visible === visible) return;
    if (s.stroke.active && s.strokeLayerId === layerId) s.cancelStroke();
    layer.visible = visible;
    this.afterMeta();
  }
  /**
   * Lock or unlock a layer (painting on a locked layer is refused).
   * @param layerId - Layer id.
   * @param locked - Lock state.
   */
  setLocked(layerId, locked) {
    const s = this.s;
    const layer = this.find(layerId);
    if (!layer || layer.locked === locked) return;
    if (s.stroke.active && s.strokeLayerId === layerId) s.cancelStroke();
    layer.locked = locked;
    this.afterMeta();
  }
  // ── Structural (undoable) ───────────────────────────────────────────────
  /**
   * Add an empty "Layer N" above the active paint layer and make it active.
   * @returns New layer id, or `null` while loading.
   */
  add() {
    const s = this.s;
    if (!this.ready()) return null;
    const layer = createPaintLayer(nextLayerName(s.doc.layers));
    const index = paintInsertIndex(s.doc);
    this.insert(layer, index, null);
    return layer.id;
  }
  /**
   * Duplicate a paint layer (pixels included) directly above it; the copy
   * becomes active.
   * @param layerId - Source layer (default: the active layer).
   * @returns New layer id, or `null` if not possible.
   */
  duplicate(layerId = this.s.doc.activeLayerId) {
    const s = this.s;
    if (!this.ready() || !this.canDuplicate(layerId)) return null;
    const index = s.doc.layers.findIndex((l) => l.id === layerId);
    const source = s.doc.layers[index];
    if (!source) return null;
    const layer = { ...source, id: createId(8), name: `${source.name} copy` };
    this.insert(layer, index + 1, captureLayerPixels(s, source.id));
    return layer.id;
  }
  /**
   * Delete a paint layer (not the last one; masks are not deletable). The
   * pixels stay in the undo entry.
   * @param layerId - Layer (default: the active layer).
   * @returns `true` if deleted.
   */
  remove(layerId = this.s.doc.activeLayerId) {
    const s = this.s;
    if (!this.ready() || !this.canDelete(layerId)) return false;
    const index = s.doc.layers.findIndex((l) => l.id === layerId);
    const layer = s.doc.layers[index];
    if (!layer) return false;
    const activeBefore = s.doc.activeLayerId;
    const pixels = captureLayerPixels(s, layerId);
    s.doc.layers.splice(index, 1);
    s.runtime.remove(layerId);
    releaseRemovedLayers(s);
    if (activeBefore === layerId) s.doc.activeLayerId = activeAfterRemoval(s.doc.layers, index) ?? activeBefore;
    this.record([{ op: "remove", index, layer: { ...layer }, pixels }], activeBefore);
    return true;
  }
  /**
   * Reorder a paint layer next to another paint layer.
   * @param layerId - Dragged layer.
   * @param targetId - Layer it is dropped next to.
   * @param above - Above (true) or below the target in the stack.
   * @returns `true` if the order changed.
   */
  move(layerId, targetId, above) {
    const s = this.s;
    if (!this.ready()) return false;
    const move = resolveMove(s.doc.layers, layerId, targetId, above);
    if (!move) return false;
    const [layer] = s.doc.layers.splice(move.from, 1);
    if (!layer) return false;
    s.doc.layers.splice(move.to, 0, layer);
    this.record([{ op: "move", id: layerId, ...move }], s.doc.activeLayerId);
    return true;
  }
  /**
   * Rename a layer (trimmed; empty names are ignored).
   * @param layerId - Layer id.
   * @param name - New name.
   * @returns `true` if renamed.
   */
  rename(layerId, name) {
    const trimmed = name.trim().slice(0, 100);
    if (!trimmed) return false;
    return this.setProps(layerId, { name: trimmed });
  }
  /**
   * Layer opacity (paint: composite opacity; mask: overlay display only).
   * @param layerId - Layer id.
   * @param opacity - 0..1 (clamped).
   * @param gesture - Edits with the same key merge into one undo entry (a scrub/slider drag).
   * @returns `true` if changed.
   */
  setOpacity(layerId, opacity, gesture) {
    if (!Number.isFinite(opacity)) return false;
    return this.setProps(layerId, { opacity: Math.min(1, Math.max(0, opacity)) }, gesture);
  }
  /**
   * Mask display colour.
   * @param layerId - Mask layer id.
   * @param color - `#rrggbb`.
   * @param gesture - Edits with the same key merge into one undo entry (picker drag).
   * @returns `true` if changed.
   */
  setMaskColor(layerId, color, gesture) {
    if (this.find(layerId)?.kind !== "mask" || !/^#[0-9a-f]{6}$/i.test(color)) return false;
    return this.setProps(layerId, { color: color.toLowerCase() }, gesture);
  }
  /**
   * Per-mask invert (applied before the union, decision 5).
   * @param layerId - Mask layer id.
   * @param invert - Invert state.
   * @returns `true` if changed.
   */
  setMaskInvert(layerId, invert) {
    if (this.find(layerId)?.kind !== "mask") return false;
    return this.setProps(layerId, { invert });
  }
  // ── Internals ───────────────────────────────────────────────────────────
  find(layerId) {
    return this.s.doc.layers.find((l) => l.id === layerId);
  }
  /** Structural edits wait for restores and cancel a running stroke. */
  ready() {
    const s = this.s;
    if (s.loading) return false;
    if (s.stroke.active) s.cancelStroke();
    return true;
  }
  insert(layer, index, pixels) {
    const s = this.s;
    const activeBefore = s.doc.activeLayerId;
    s.doc.layers.splice(index, 0, layer);
    installLayerPixels(s, layer.id, pixels);
    s.doc.activeLayerId = layer.id;
    this.record([{ op: "insert", index, layer: { ...layer }, pixels }], activeBefore);
  }
  setProps(layerId, props, gesture) {
    const s = this.s;
    const layer = this.find(layerId);
    if (!layer || s.loading || !propsDiffer(layer, props)) return false;
    const merge = gesture ? s.history.mergeTarget() : void 0;
    const change = merge?.kind === "layers" && merge.gesture === gesture ? merge.changes[0] : void 0;
    if (change?.op === "props" && change.id === layerId && sameKeys(change.after, props)) {
      Object.assign(change.after, props);
      writeProps(layer, props);
      this.afterMeta(true);
      return true;
    }
    const before = readProps(layer, props);
    writeProps(layer, props);
    this.record([{ op: "props", id: layerId, before, after: { ...props } }], s.doc.activeLayerId, gesture);
    return true;
  }
  record(changes, activeBefore, gesture) {
    const s = this.s;
    s.history.push({
      kind: "layers",
      changes,
      activeBefore,
      activeAfter: s.doc.activeLayerId,
      bytes: changesBytes(changes),
      ...gesture ? { gesture } : {}
    });
    this.afterMeta(true);
  }
  /** Events after a metadata change (`history` too when it was recorded). */
  afterMeta(history = false) {
    const s = this.s;
    if (history) s.events.emit("history", void 0);
    emitLayerEvents(s);
    s.events.emit("change", void 0);
    s.events.emit("render", void 0);
  }
}
function sameKeys(a, b) {
  const ka = Object.keys(a).sort().join();
  return ka === Object.keys(b).sort().join();
}
class EditorMaskOps {
  /**
   * @param s - Shared editor state.
   * @param paint - Paint operations (owns `setPaintTarget` / `setMaskVisible`).
   */
  constructor(s, paint2) {
    this.s = s;
    this.paint = paint2;
  }
  s;
  paint;
  /** What brush/eraser strokes paint into (UI state, not saved). */
  get paintTarget() {
    return this.s.target;
  }
  /** The mask layer Quick Mask edits, if the document has one. */
  get maskLayer() {
    return findMaskLayer(this.s.doc);
  }
  /**
   * Switch the paint target (Quick Mask, `Q`); adds a mask layer if missing.
   * @param target - New target.
   */
  setPaintTarget(target) {
    this.paint.setPaintTarget(target);
  }
  /** Toggle between the paint layer and the mask. */
  togglePaintTarget() {
    this.paint.setPaintTarget(this.s.target === "mask" ? "paint" : "mask");
  }
  /**
   * Show or hide the mask layer (adds one if missing). Hidden mask layers are
   * also excluded from the `MASK` output (saved-file contract).
   * @param visible - Visibility.
   */
  setMaskVisible(visible) {
    this.paint.setMaskVisible(visible);
  }
}
const AA_PAD = 1;
const HEAD_HALF_WIDTH = 0.4;
const HEAD_MAX_SHARE = 0.9;
function snapAngle(from, to, stepDeg = 15) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) return { ...to };
  const step = stepDeg * Math.PI / 180;
  const angle = Math.round(Math.atan2(dy, dx) / step) * step;
  return { x: from.x + clean(Math.cos(angle)) * length, y: from.y + clean(Math.sin(angle)) * length };
}
function boxFromDrag(start, current, square, fromCenter) {
  let dx = current.x - start.x;
  let dy = current.y - start.y;
  if (square) {
    const side = Math.max(Math.abs(dx), Math.abs(dy));
    dx = (dx < 0 ? -1 : 1) * side;
    dy = (dy < 0 ? -1 : 1) * side;
  }
  if (fromCenter) {
    const w = Math.abs(dx);
    const h = Math.abs(dy);
    return { x: start.x - w, y: start.y - h, width: w * 2, height: h * 2 };
  }
  return { x: Math.min(start.x, start.x + dx), y: Math.min(start.y, start.y + dy), width: Math.abs(dx), height: Math.abs(dy) };
}
function crispRect(rect, strokeWidth) {
  const x = Math.round(rect.x);
  const y = Math.round(rect.y);
  const r = { x, y, width: Math.round(rect.x + rect.width) - x, height: Math.round(rect.y + rect.height) - y };
  const odd = strokeWidth > 0 && Math.round(strokeWidth) % 2 === 1;
  return odd ? { ...r, x: r.x + 0.5, y: r.y + 0.5 } : r;
}
function headLength(width, ratio, lineLength, count) {
  if (count <= 0) return 0;
  const wanted = Math.max(0, width * ratio);
  return Math.min(wanted, lineLength * HEAD_MAX_SHARE / count);
}
function arrowHeadPolygon(tip, from, length) {
  const dx = tip.x - from.x;
  const dy = tip.y - from.y;
  const d = Math.hypot(dx, dy);
  if (d === 0 || length <= 0) return [];
  const ux = dx / d;
  const uy = dy / d;
  const bx = tip.x - ux * length;
  const by = tip.y - uy * length;
  const half = length * HEAD_HALF_WIDTH;
  return [
    { ...tip },
    { x: bx - uy * half, y: by + ux * half },
    { x: bx + uy * half, y: by - ux * half }
  ];
}
function lineGeometry(line) {
  const { from, to } = line;
  const length = Math.hypot(to.x - from.x, to.y - from.y);
  if (length === 0 || line.width <= 0) return null;
  const count = line.heads === "both" ? 2 : line.heads === "end" ? 1 : 0;
  const head = headLength(line.width, line.headRatio, length, count);
  const ux = (to.x - from.x) / length;
  const uy = (to.y - from.y) / length;
  const heads = [];
  let a = from;
  let b = to;
  if (count > 0 && head > 0) {
    heads.push(arrowHeadPolygon(to, from, head));
    b = { x: to.x - ux * head, y: to.y - uy * head };
    if (count === 2) {
      heads.push(arrowHeadPolygon(from, to, head));
      a = { x: from.x + ux * head, y: from.y + uy * head };
    }
  }
  const shaftLength = Math.hypot(b.x - a.x, b.y - a.y);
  return { shaft: shaftLength > 0 ? [a, b] : null, heads };
}
function isDrawableShape(shape) {
  if (shape.kind === "line") return lineGeometry(shape) !== null;
  const hasPaint = shape.paint !== "stroke" || shape.strokeWidth > 0;
  return hasPaint && shape.rect.width > 0 && shape.rect.height > 0;
}
function shapeBounds(shape) {
  const empty = { x: 0, y: 0, width: 0, height: 0 };
  if (!isDrawableShape(shape)) return empty;
  if (shape.kind === "line") {
    const geo = lineGeometry(shape);
    if (!geo) return empty;
    let r = empty;
    if (geo.shaft) r = unionRect(r, padRect(pointsRect(geo.shaft), shape.width / 2));
    for (const head of geo.heads) r = unionRect(r, pointsRect(head));
    return padRect(r, AA_PAD);
  }
  const stroke = shape.paint === "fill" ? 0 : shape.strokeWidth;
  const path = shape.kind === "rect" ? crispRect(shape.rect, stroke) : shape.rect;
  return padRect(path, stroke / 2 + AA_PAD);
}
function pointsRect(points) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  if (minX > maxX) return { x: 0, y: 0, width: 0, height: 0 };
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}
function padRect(r, pad) {
  return { x: r.x - pad, y: r.y - pad, width: r.width + pad * 2, height: r.height + pad * 2 };
}
function clean(v) {
  return Math.abs(v) < 1e-12 ? 0 : v;
}
function renderShape(ctx, shape, origin, colorOverride) {
  if (!isDrawableShape(shape)) return;
  ctx.save();
  ctx.translate(-origin.x, -origin.y);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  if (shape.kind === "line") drawLine(ctx, shape, colorOverride);
  else drawBox(ctx, shape, colorOverride);
  ctx.restore();
}
function drawLine(ctx, line, colorOverride) {
  const geo = lineGeometry(line);
  if (!geo) return;
  const color = colorOverride ?? line.color;
  if (geo.shaft) {
    const [a, b] = geo.shaft;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.lineWidth = line.width;
    ctx.lineCap = "round";
    ctx.strokeStyle = color;
    ctx.stroke();
  }
  ctx.fillStyle = color;
  for (const head of geo.heads) {
    const [first, ...rest] = head;
    if (!first) continue;
    ctx.beginPath();
    ctx.moveTo(first.x, first.y);
    for (const p of rest) ctx.lineTo(p.x, p.y);
    ctx.closePath();
    ctx.fill();
  }
}
function drawBox(ctx, box, colorOverride) {
  const stroke = box.paint !== "fill" && box.strokeWidth > 0;
  const fill = box.paint !== "stroke";
  const path = (strokeWidth) => {
    ctx.beginPath();
    if (box.kind === "rect") {
      const r = crispRect(box.rect, strokeWidth);
      ctx.rect(r.x, r.y, r.width, r.height);
    } else {
      const { x, y, width, height } = box.rect;
      ctx.ellipse(x + width / 2, y + height / 2, width / 2, height / 2, 0, 0, Math.PI * 2);
    }
  };
  if (fill) {
    path(stroke ? box.strokeWidth : 0);
    ctx.fillStyle = colorOverride ?? box.fillColor;
    ctx.fill();
  }
  if (stroke) {
    path(box.strokeWidth);
    ctx.lineWidth = box.strokeWidth;
    ctx.lineJoin = "miter";
    ctx.strokeStyle = colorOverride ?? box.strokeColor;
    ctx.stroke();
  }
}
const LOCKED_LAYER_NOTE = "Layer is locked.";
const MASK_STROKE_COLOR = "#ffffff";
const HIDDEN_MASK_NOTE = "The mask is hidden; show it to output it.";
class PaintOps {
  /**
   * @param s - Shared editor state.
   * @param frames - Frame operations (Clear snapshots for undo).
   * @param stamps - Dab stamp cache.
   */
  constructor(s, frames, stamps) {
    this.s = s;
    this.frames = frames;
    this.stamps = stamps;
  }
  s;
  frames;
  stamps;
  // ── Quick Mask / paint target ───────────────────────────────────────────
  /**
   * Switch the paint target. Targeting the mask adds a default mask layer to
   * documents that have none.
   * @param target - New target.
   */
  setPaintTarget(target) {
    const s = this.s;
    if (target === s.target) return;
    if (s.stroke.active) s.cancelStroke();
    if (target === "mask") s.ensureMask();
    s.target = target;
    s.events.emit("mask", void 0);
  }
  /**
   * Show or hide the mask layer (adds one if missing).
   * @param visible - Visibility.
   */
  setMaskVisible(visible) {
    const s = this.s;
    const layer = s.ensureMask();
    if (layer.visible === visible) return;
    if (s.stroke.active && s.strokeLayerId === layer.id) s.cancelStroke();
    layer.visible = visible;
    s.events.emit("mask", void 0);
    s.events.emit("change", void 0);
    s.events.emit("render", void 0);
  }
  // ── Strokes ─────────────────────────────────────────────────────────────
  /**
   * Start a stroke on the paint target (mask strokes paint white coverage).
   * @param style - Stroke appearance.
   * @param maxDiameter - Largest dab diameter this stroke can produce, document px.
   * @returns `false` if painting is not possible (loading, locked, hidden).
   */
  beginStroke(style, maxDiameter) {
    const s = this.s;
    if (s.loading || s.stroke.active) return false;
    const layer = s.target === "mask" ? s.ensureMask() : targetLayer(s.doc, "paint");
    if (!layer) return false;
    if (layer.locked) {
      s.events.emit("note", LOCKED_LAYER_NOTE);
      return false;
    }
    if (!layer.visible) {
      s.events.emit("note", layer.kind === "mask" ? HIDDEN_MASK_NOTE : "The layer is hidden.");
      return false;
    }
    const strokeStyle = layer.kind === "mask" ? { ...style, color: MASK_STROKE_COLOR } : style;
    s.strokeLayerId = layer.id;
    s.strokeDiameter = Math.max(1, maxDiameter);
    s.stroke.begin(s.store.ensure(layer.id), s.store.bounds, strokeStyle);
    s.events.emit("history", void 0);
    return true;
  }
  /**
   * Add dabs to the current stroke, growing bounds when they go off-frame.
   * @param dabs - Dabs in document coords.
   */
  addDabs(dabs) {
    const s = this.s;
    if (!s.stroke.active || dabs.length === 0) return;
    let need = { x: 0, y: 0, width: 0, height: 0 };
    for (const dab of dabs) {
      const r = dab.size / 2 + 1;
      need = unionRect(need, { x: dab.x - r, y: dab.y - r, width: r * 2, height: r * 2 });
    }
    s.ensureBounds(need, true);
    s.stroke.addDabs(dabs, this.stamps, s.strokeDiameter);
    s.events.emit("render", void 0);
  }
  /**
   * Replace the current stroke's content with one shape (live preview;
   * shape tools call this on every move). Grows bounds like dabs do; on a
   * mask target every part paints white coverage.
   * @param shape - Shape in document coords.
   */
  drawShape(shape) {
    const s = this.s;
    const layerId = s.strokeLayerId;
    if (!s.stroke.active || !layerId) return;
    const need = shapeBounds(shape);
    if (!isEmptyRect(need)) s.ensureBounds(need, true);
    const isMask = s.doc.layers.find((l) => l.id === layerId)?.kind === "mask";
    const rect = intersectRect(roundOutRect(need), s.store.bounds);
    s.stroke.replaceContent(rect, (ctx, origin) => renderShape(ctx, shape, origin, isMask ? MASK_STROKE_COLOR : null));
    s.events.emit("render", void 0);
  }
  /**
   * Commit the stroke to its layer as one undo step.
   * @param end - Where the stroke ended, document coords.
   */
  endStroke(end) {
    const s = this.s;
    const layerId = s.strokeLayerId;
    if (!s.stroke.active || !layerId) return;
    const rect = s.stroke.touched;
    const surface = s.store.ensure(layerId);
    if (isEmptyRect(rect)) {
      s.stroke.cancel();
    } else {
      const before = s.store.read(layerId, rect);
      s.stroke.commit(surface);
      const after = s.store.read(layerId, rect);
      if (before && after) {
        const bytes = before.data.data.byteLength + after.data.data.byteLength;
        s.history.push({ kind: "patch", layerId, x: before.rect.x, y: before.rect.y, before: before.data, after: after.data, bytes });
        s.runtime.touch(layerId);
      }
    }
    s.strokeLayerId = null;
    if (end) s.lastStrokeEnd = { ...end };
    s.afterEdit();
  }
  // ── Undo / redo ─────────────────────────────────────────────────────────
  /** Undo the last operation (no-op while stroking). */
  undo() {
    const s = this.s;
    if (!s.history.canUndo || s.stroke.active) return;
    const entry = s.history.undo();
    if (entry) this.applyEntry(entry, "before");
    s.afterEdit();
  }
  /** Redo the last undone operation (no-op while stroking). */
  redo() {
    const s = this.s;
    if (!s.history.canRedo || s.stroke.active) return;
    const entry = s.history.redo();
    if (entry) this.applyEntry(entry, "after");
    s.afterEdit();
  }
  applyEntry(entry, side) {
    const s = this.s;
    if (entry.kind === "clear") {
      this.frames.applySnapshot(side === "before" ? entry.before : entry.after);
      s.lastStrokeEnd = null;
      return;
    }
    if (entry.kind === "layers") {
      applyLayersEntry(s, entry, side === "after");
      return;
    }
    if (entry.kind === "selection") {
      s.selection.set(side === "before" ? entry.before : entry.after);
      return;
    }
    if (!s.doc.layers.some((l) => l.id === entry.layerId)) return;
    const data = side === "before" ? entry.before : entry.after;
    s.ensureBounds({ x: entry.x, y: entry.y, width: data.width, height: data.height }, false);
    s.store.write(entry.layerId, entry.x, entry.y, data);
    s.runtime.touch(entry.layerId);
  }
}
function drawDocRegion(ctx, input, rect) {
  const { map, imageSize, bounds } = input;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  ctx.clearRect(0, 0, rect.width, rect.height);
  const bx = -map.offsetX / map.scale - rect.x;
  const by = -map.offsetY / map.scale - rect.y;
  const bw = imageSize.width / map.scale;
  const bh = imageSize.height / map.scale;
  if (input.background.kind === "image") {
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(input.background.image, bx, by, bw, bh);
  } else {
    ctx.fillStyle = input.background.color;
    ctx.fillRect(bx, by, bw, bh);
  }
  for (const layer of input.layers) {
    if (layer.opacity <= 0) continue;
    ctx.globalAlpha = layer.opacity;
    ctx.drawImage(layer.source, bounds.x - rect.x, bounds.y - rect.y);
  }
  ctx.globalAlpha = 1;
}
function readDocRegion(input, rect, scratch) {
  const canvas = scratch ?? document.createElement("canvas");
  if (canvas.width !== rect.width) canvas.width = rect.width;
  if (canvas.height !== rect.height) canvas.height = rect.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  drawDocRegion(ctx, input, rect);
  const data = ctx.getImageData(0, 0, rect.width, rect.height);
  if (!scratch) canvas.width = canvas.height = 0;
  return data;
}
const EMPTY_RECT = { x: 0, y: 0, width: 0, height: 0 };
const MATCH = 1;
const FILLED = 255;
function floodFill(data, width, height, options) {
  const coverage = new Uint8Array(width * height);
  const sx = Math.floor(options.x);
  const sy = Math.floor(options.y);
  if (!(sx >= 0 && sy >= 0 && sx < width && sy < height) || data.length < width * height * 4) {
    return { coverage, bbox: { ...EMPTY_RECT } };
  }
  const seed = sy * width + sx;
  const clip = options.clip && options.clip.length === coverage.length ? options.clip : void 0;
  markMatches(data, coverage, seed, clampTolerance(options.tolerance), clip);
  if (coverage[seed] !== MATCH) return { coverage: new Uint8Array(width * height), bbox: { ...EMPTY_RECT } };
  let bbox = options.contiguous ? fillContiguous(coverage, width, height, seed) : keepAllMatches(coverage, width, height);
  if (options.antiAlias) bbox = addFringe(coverage, width, height, bbox, clip);
  if (clip) applyClip(coverage, width, bbox, clip);
  return { coverage, bbox };
}
function clampTolerance(tolerance) {
  return Number.isFinite(tolerance) ? Math.min(255, Math.max(0, Math.round(tolerance))) : 0;
}
function markMatches(data, coverage, seed, tol, clip) {
  const p0 = seed * 4;
  const r = data[p0] ?? 0;
  const g = data[p0 + 1] ?? 0;
  const b = data[p0 + 2] ?? 0;
  const a = data[p0 + 3] ?? 0;
  const n = coverage.length;
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    if (clip && clip[i] === 0) continue;
    const pa = data[p + 3];
    if (pa === 0 && a === 0) {
      coverage[i] = MATCH;
      continue;
    }
    const dr = data[p] - r;
    const dg = data[p + 1] - g;
    const db = data[p + 2] - b;
    const da = pa - a;
    if (dr <= tol && dr >= -tol && dg <= tol && dg >= -tol && db <= tol && db >= -tol && da <= tol && da >= -tol) {
      coverage[i] = MATCH;
    }
  }
}
function fillContiguous(coverage, width, height, seed) {
  let stack = new Int32Array(1024);
  let sp = 0;
  const push = (i) => {
    if (sp === stack.length) {
      const grown = new Int32Array(stack.length * 2);
      grown.set(stack);
      stack = grown;
    }
    stack[sp++] = i;
  };
  const scanRow = (from, to) => {
    let inRun = false;
    for (let i = from; i <= to; i++) {
      if (coverage[i] === MATCH) {
        if (!inRun) push(i);
        inRun = true;
      } else {
        inRun = false;
      }
    }
  };
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  push(seed);
  while (sp > 0) {
    const idx = stack[--sp];
    if (coverage[idx] !== MATCH) continue;
    const y = idx / width | 0;
    const rowStart = y * width;
    const rowEnd = rowStart + width - 1;
    let l = idx;
    let r = idx;
    while (l > rowStart && coverage[l - 1] === MATCH) l--;
    while (r < rowEnd && coverage[r + 1] === MATCH) r++;
    coverage.fill(FILLED, l, r + 1);
    const xl = l - rowStart;
    const xr = r - rowStart;
    if (xl < minX) minX = xl;
    if (xr > maxX) maxX = xr;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (y > 0) scanRow(l - width, r - width);
    if (y < height - 1) scanRow(l + width, r + width);
  }
  for (let i = 0; i < coverage.length; i++) if (coverage[i] === MATCH) coverage[i] = 0;
  return maxX < 0 ? { ...EMPTY_RECT } : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}
function keepAllMatches(coverage, width, height) {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    let rowMin = -1;
    let rowMax = -1;
    for (let x = 0; x < width; x++) {
      if (coverage[row + x] !== MATCH) continue;
      coverage[row + x] = FILLED;
      if (rowMin < 0) rowMin = x;
      rowMax = x;
    }
    if (rowMin < 0) continue;
    if (rowMin < minX) minX = rowMin;
    if (rowMax > maxX) maxX = rowMax;
    if (y < minY) minY = y;
    maxY = y;
  }
  return maxX < 0 ? { ...EMPTY_RECT } : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}
function addFringe(coverage, width, height, bbox, clip) {
  if (bbox.width <= 0) return bbox;
  const x0 = Math.max(0, bbox.x - 1);
  const y0 = Math.max(0, bbox.y - 1);
  const x1 = Math.min(width - 1, bbox.x + bbox.width);
  const y1 = Math.min(height - 1, bbox.y + bbox.height);
  let minX = bbox.x;
  let minY = bbox.y;
  let maxX = bbox.x + bbox.width - 1;
  let maxY = bbox.y + bbox.height - 1;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const i = y * width + x;
      if (coverage[i] !== 0 || clip && clip[i] === 0) continue;
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx >= 0 && xx < width && coverage[yy * width + xx] === FILLED) n++;
        }
      }
      if (n === 0) continue;
      coverage[i] = Math.round(n * 255 / 9);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}
function applyClip(coverage, width, bbox, clip) {
  for (let y = bbox.y; y < bbox.y + bbox.height; y++) {
    for (let x = bbox.x; x < bbox.x + bbox.width; x++) {
      const i = y * width + x;
      const c = clip[i];
      if (c < 255) coverage[i] = Math.round(coverage[i] * c / 255);
    }
  }
}
function hexToRgb$1(hex) {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  const body = m?.[1];
  if (!body) return { r: 0, g: 0, b: 0 };
  const full = body.length === 3 ? [...body].map((c) => c + c).join("") : body;
  const n = parseInt(full, 16);
  return { r: n >> 16 & 255, g: n >> 8 & 255, b: n & 255 };
}
function rgbToHex$1(rgb) {
  const part = (v) => Math.min(255, Math.max(0, Math.round(v))).toString(16).padStart(2, "0");
  return `#${part(rgb.r)}${part(rgb.g)}${part(rgb.b)}`;
}
function averageColor(data) {
  let r = 0;
  let g = 0;
  let b = 0;
  let a = 0;
  for (let p = 0; p + 3 < data.length; p += 4) {
    const w = data[p + 3];
    if (w === 0) continue;
    r += data[p] * w;
    g += data[p + 1] * w;
    b += data[p + 2] * w;
    a += w;
  }
  if (a === 0) return null;
  return { r: Math.round(r / a), g: Math.round(g / a), b: Math.round(b / a) };
}
function blendCoverage(dst, rect, coverage, coverageWidth, color, opacity) {
  const k = Math.min(1, Math.max(0, opacity)) / 255;
  if (k <= 0) return;
  for (let y = 0; y < rect.height; y++) {
    const row = (rect.y + y) * coverageWidth + rect.x;
    for (let x = 0; x < rect.width; x++) {
      const c = coverage[row + x];
      if (c === 0) continue;
      const p = (y * rect.width + x) * 4;
      const sa = c * k;
      const da = dst[p + 3] / 255;
      const keep = da * (1 - sa);
      const oa = sa + keep;
      if (oa <= 0) continue;
      dst[p] = (color.r * sa + dst[p] * keep) / oa;
      dst[p + 1] = (color.g * sa + dst[p + 1] * keep) / oa;
      dst[p + 2] = (color.b * sa + dst[p + 2] * keep) / oa;
      dst[p + 3] = oa * 255;
    }
  }
}
function wandSelection(pixels, area, point, options) {
  const { coverage, bbox } = floodFill(pixels, area.width, area.height, {
    x: Math.floor(point.x) - area.x,
    y: Math.floor(point.y) - area.y,
    tolerance: options.tolerance,
    contiguous: options.contiguous,
    antiAlias: options.antiAlias
  });
  return selectionFromCoverage(coverage, area, bbox);
}
class PixelOps {
  /**
   * @param s - Shared editor state.
   */
  constructor(s) {
    this.s = s;
  }
  s;
  /** Small reusable canvas for eyedropper reads. */
  scratch = null;
  // ── Fill ────────────────────────────────────────────────────────────────
  /**
   * Flood fill the paint target from a point, as one undo step.
   * @param req - Fill parameters.
   * @returns `true` if pixels changed.
   */
  fill(req) {
    const s = this.s;
    if (s.loading || s.stroke.active) return false;
    const layer = s.target === "mask" ? s.ensureMask() : targetLayer(s.doc, "paint");
    if (!layer || !this.canEdit(layer)) return false;
    const px = Math.floor(req.point.x);
    const py = Math.floor(req.point.y);
    const image = this.imageRectInDoc();
    if (!inside(image, px, py) && !inside(s.store.bounds, px, py)) return false;
    s.ensureBounds(image, true);
    const bounds = s.store.bounds;
    if (!inside(bounds, px, py)) return false;
    const source = this.sampleArea(bounds, req.sample, layer);
    if (!source) return false;
    const { coverage, bbox } = floodFill(source, bounds.width, bounds.height, {
      x: px - bounds.x,
      y: py - bounds.y,
      tolerance: req.tolerance,
      contiguous: req.contiguous,
      antiAlias: req.antiAlias,
      // M5: confined to (and scaled by) the selection.
      clip: s.selection.coverage(bounds)
    });
    if (isEmptyRect(bbox)) return false;
    const docRect = { x: bounds.x + bbox.x, y: bounds.y + bbox.y, width: bbox.width, height: bbox.height };
    const before = s.store.read(layer.id, docRect);
    if (!before) return false;
    const next = new ImageData(new Uint8ClampedArray(before.data.data), before.data.width, before.data.height);
    const color = hexToRgb$1(layer.kind === "mask" ? MASK_STROKE_COLOR : req.color);
    blendCoverage(next.data, bbox, coverage, bounds.width, color, req.opacity);
    s.store.write(layer.id, docRect.x, docRect.y, next);
    const after = s.store.read(layer.id, docRect);
    if (after) {
      const bytes = before.data.data.byteLength + after.data.data.byteLength;
      s.history.push({ kind: "patch", layerId: layer.id, x: docRect.x, y: docRect.y, before: before.data, after: after.data, bytes });
    }
    s.runtime.touch(layer.id);
    s.afterEdit();
    return true;
  }
  // ── Magic wand ──────────────────────────────────────────────────────────
  /**
   * Magic-wand coverage at a point (not applied: the tool combines it with
   * the current selection via `Editor.selection.apply`). Samples like the
   * bucket, over the paint bounds united with the image rect, without growing
   * the bounds (the wand edits no pixels). "Current layer" is the active paint
   * layer (colours, also in Quick Mask; like the eyedropper).
   * @param req - Click position, matching options and sample source.
   * @returns Selection in document coords, or `null` (nothing matched / loading / outside).
   */
  wandSelection(req) {
    const s = this.s;
    if (s.loading || s.stroke.active) return null;
    const area = unionRect(this.imageRectInDoc(), s.store.bounds);
    if (!inside(area, Math.floor(req.point.x), Math.floor(req.point.y))) return null;
    const layer = targetLayer(s.doc, "paint");
    const source = req.sample === "all" || !layer ? this.sampleArea(area, "all", null) : this.sampleArea(area, "layer", layer);
    return source ? wandSelection(source, area, req.point, req) : null;
  }
  // ── Sampling ────────────────────────────────────────────────────────────
  /**
   * Colour under a point (eyedropper).
   * @param point - Document coords.
   * @param source - Active paint layer or the visible composite.
   * @param size - Sample window side: 1 (point), 3 or 5 (average).
   * @returns `#rrggbb`, or `null` if the window is fully transparent / off the layer.
   */
  sampleColor(point, source, size) {
    const s = this.s;
    const r = Math.max(0, Math.floor((size - 1) / 2));
    const rect = { x: Math.floor(point.x) - r, y: Math.floor(point.y) - r, width: r * 2 + 1, height: r * 2 + 1 };
    let data;
    if (source === "layer") {
      const layer = targetLayer(s.doc, "paint");
      data = layer ? s.store.read(layer.id, rect)?.data : null;
    } else {
      this.scratch ??= document.createElement("canvas");
      data = readDocRegion(this.compositeInput(), rect, this.scratch);
    }
    const rgb = data ? averageColor(data.data) : null;
    return rgb ? rgbToHex$1(rgb) : null;
  }
  /** Release the scratch canvas. */
  dispose() {
    if (this.scratch) this.scratch.width = this.scratch.height = 0;
    this.scratch = null;
  }
  // ── Internals ───────────────────────────────────────────────────────────
  /**
   * RGBA of a document area as the bucket / wand see it: the visible
   * composite, or one layer (transparent outside the bounds).
   */
  sampleArea(area, sample, layer) {
    if (sample === "all" || !layer) return readDocRegion(this.compositeInput(), area)?.data ?? null;
    const read = this.s.store.read(layer.id, area);
    if (read && rectEquals(read.rect, area)) return read.data.data;
    const out = new Uint8ClampedArray(area.width * area.height * 4);
    if (!read) return out;
    const { rect, data } = read;
    for (let y = 0; y < rect.height; y++) {
      const src = y * rect.width * 4;
      out.set(data.data.subarray(src, src + rect.width * 4), ((rect.y - area.y + y) * area.width + (rect.x - area.x)) * 4);
    }
    return out;
  }
  /** Same lock/visibility rules (and notes) as strokes. */
  canEdit(layer) {
    if (layer.locked) {
      this.s.events.emit("note", LOCKED_LAYER_NOTE);
      return false;
    }
    if (!layer.visible) {
      this.s.events.emit("note", layer.kind === "mask" ? HIDDEN_MASK_NOTE : "The layer is hidden.");
      return false;
    }
    return true;
  }
  /** The current image's rect in document coords (rounded out). */
  imageRectInDoc() {
    const s = this.s;
    const map = documentMap(s.doc, s.imageSize);
    const size = s.imageSize;
    return roundOutRect({
      x: -map.offsetX / map.scale,
      y: -map.offsetY / map.scale,
      width: size.width / map.scale,
      height: size.height / map.scale
    });
  }
  compositeInput() {
    const s = this.s;
    const layers = [];
    for (const layer of s.doc.layers) {
      if (!layer.visible || layer.kind === "mask") continue;
      layers.push({ source: s.store.ensure(layer.id).canvas, opacity: layer.opacity });
    }
    return {
      background: s.background,
      imageSize: s.imageSize,
      map: documentMap(s.doc, s.imageSize),
      bounds: s.store.bounds,
      layers
    };
  }
}
function inside(r, x, y) {
  return x >= r.x && y >= r.y && x < r.x + r.width && y < r.y + r.height;
}
const WHEEL_SCALE_STEP = 1.05;
const MAX_WHEEL_DELTA = 300;
function fitScale(frame, image) {
  return frameMap(frame, image).scale;
}
function translatePlacement(p, frame, image, dx, dy) {
  const s = fitScale(frame, image);
  return { x: p.x + dx / s, y: p.y + dy / s, scale: p.scale };
}
function scalePlacementAt(p, frame, image, factor, anchor) {
  const base = frameMap(frame, image);
  const now = frameMap(frame, image, p);
  const k = clampPlacementScale(p.scale * factor);
  const docX = (anchor.x - now.offsetX) / now.scale;
  const docY = (anchor.y - now.offsetY) / now.scale;
  const s = base.scale;
  return {
    x: (anchor.x - base.offsetX) / s - frame.width / 2 * (1 - k) - k * docX,
    y: (anchor.y - base.offsetY) / s - frame.height / 2 * (1 - k) - k * docY,
    scale: k
  };
}
function wheelScaleFactor(deltaPx) {
  if (!Number.isFinite(deltaPx)) return 1;
  const d = Math.max(-MAX_WHEEL_DELTA, Math.min(MAX_WHEEL_DELTA, deltaPx));
  return Math.pow(WHEEL_SCALE_STEP, -d / 100);
}
function placementImageOffset(p, frame, image) {
  const s = fitScale(frame, image);
  return { x: p.x * s, y: p.y * s };
}
function imageOffsetToPlacement(imagePx, frame, image) {
  return imagePx / fitScale(frame, image);
}
class PlacementOps {
  /**
   * @param s - Shared editor state.
   */
  constructor(s) {
    this.s = s;
  }
  s;
  /** Current placement (a copy; identity when unset). */
  get current() {
    return { ...this.s.doc.placement ?? IDENTITY_PLACEMENT };
  }
  /** Whether the drawing is moved or scaled. */
  get isMoved() {
    return !isIdentityPlacement(this.s.doc.placement);
  }
  /** Current offset in image px (options bar X / Y). */
  get imageOffset() {
    const s = this.s;
    return placementImageOffset(this.current, s.doc.frame, s.imageSize);
  }
  /**
   * Replace the placement (normalized: finite, scale clamped).
   * @param next - New placement.
   * @param commit - `true` (default): also update the widget value
   *   (`change`); `false` for live drag frames (redraw only).
   */
  set(next, commit = true) {
    const s = this.s;
    const p = normalizePlacement(next);
    const before = s.doc.placement;
    const same = before ? before.x === p.x && before.y === p.y && before.scale === p.scale : isIdentityPlacement(p);
    if (!same) {
      if (isIdentityPlacement(p)) delete s.doc.placement;
      else s.doc.placement = p;
      s.events.emit("placement", void 0);
      s.events.emit("render", void 0);
    }
    if (commit) this.commit();
  }
  /** Publish the current placement to the widget value (end of a drag). */
  commit() {
    this.s.events.emit("change", void 0);
  }
  /**
   * Move by an image-px delta (arrow nudges).
   * @param dx - Image px.
   * @param dy - Image px.
   * @param commit - See {@link set}.
   */
  translateImage(dx, dy, commit = true) {
    const s = this.s;
    this.set(translatePlacement(this.current, s.doc.frame, s.imageSize, dx, dy), commit);
  }
  /**
   * Multiply the scale around an image point (kept fixed).
   * @param factor - Scale multiplier.
   * @param anchor - Image point.
   * @param commit - See {@link set}.
   */
  scaleAt(factor, anchor, commit = true) {
    const s = this.s;
    this.set(scalePlacementAt(this.current, s.doc.frame, s.imageSize, factor, anchor), commit);
  }
  /** Back to identity ("Reset position"). */
  reset() {
    this.set(IDENTITY_PLACEMENT);
  }
}
const NO_SELECTION_NOTE = "Nothing is selected.";
class SelectionOps {
  /**
   * @param s - Shared editor state.
   */
  constructor(s) {
    this.s = s;
  }
  s;
  // ── Read access ─────────────────────────────────────────────────────────
  /** Current selection (`null` = none: painting is not clipped). */
  get current() {
    return this.s.selection.current;
  }
  /** Whether a selection exists. */
  get active() {
    return this.s.selection.current !== null;
  }
  /** Bumped on every selection change (UI cache key). */
  get revision() {
    return this.s.selection.revision;
  }
  /**
   * Cached marching-ants outline: closed contours (flat corner lists), in
   * document coords. An inverted selection also outlines the current image
   * area in document coords (Photoshop's ants along the canvas edge), so the
   * ants follow the image boundary rather than `doc.frame` when the image
   * has a different aspect ratio or a Move-tool placement.
   * @returns Contours, or `null` without a selection.
   */
  outline() {
    return this.s.selection.outline(this.imageRectInDoc());
  }
  /**
   * Largest document area a selection may cover (the bounds growth cap plus
   * the current bounds); tools need not clip, {@link apply} does.
   */
  get limit() {
    return unionRect(boundsCap(this.s.doc.frame), this.s.store.bounds);
  }
  // ── Selection changes (one history entry each) ──────────────────────────
  /**
   * Combine new coverage with the current selection, as one undo step.
   * @param next - Tool coverage in document coords (`null` = selects nothing).
   * @param mode - Photoshop mode from the modifiers at drag start.
   * @returns `true` if the selection changed.
   */
  apply(next, mode) {
    return this.change(combineSelection(this.current, clipSelection(next, this.limit), mode));
  }
  /**
   * Ctrl+A: select the current image area (the background as shown -- the
   * upstream image rect, or the `width x height` fill when no image is
   * connected). The image rect `{0,0,W,H}` is converted to document coords
   * via {@link imageRectToDoc} so the result is correct regardless of the
   * frame size, Move-tool placement, or upstream image changes. Bounds are
   * grown to cover the image rect first (like the bucket fill) so the whole
   * image area is paintable after selecting it.
   * @returns `true` if the selection changed.
   */
  selectAll() {
    const imageRect = this.imageRectInDoc();
    this.s.ensureBounds(imageRect, true);
    const sel = rectSelection(intersectRect(imageRect, this.limit));
    return this.change(sel);
  }
  /**
   * Ctrl+D: drop the selection.
   * @returns `true` if there was one.
   */
  deselect() {
    return this.change(null);
  }
  /**
   * Shift+F7 / options-bar "Invert": invert (no-op without a selection).
   * @returns `true` if the selection changed.
   */
  invert() {
    return this.change(invertSelection(this.current));
  }
  // ── Pixel commands (one undo patch each) ────────────────────────────────
  /**
   * Delete/Backspace: clear the selected pixels of the paint target (on the
   * mask target this removes mask coverage).
   * @returns `true` if pixels changed.
   */
  clearSelected() {
    const layer = this.editableTarget();
    return layer ? this.editPixels(layer, (px, rect, cov, stride) => eraseCoverage(px, rect, cov, stride)) : false;
  }
  /**
   * Alt+Backspace (FG) / Ctrl+Backspace (BG): fill the selection on the paint
   * target (on the mask target: add coverage, colour ignored).
   * @param color - CSS hex colour.
   * @returns `true` if pixels changed.
   */
  fillSelected(color) {
    const layer = this.editableTarget();
    if (!layer) return false;
    const rgb = hexToRgb$1(layer.kind === "mask" ? MASK_STROKE_COLOR : color);
    return this.editPixels(layer, (px, rect, cov, stride) => blendCoverage(px, rect, cov, stride, rgb, 1));
  }
  /**
   * "Selection to mask": add the selection coverage to the mask layer
   * (whatever the paint target is; a mask layer is added if missing).
   * @returns `true` if pixels changed.
   */
  toMask() {
    const s = this.s;
    if (!this.ready()) return false;
    const layer = s.ensureMask();
    if (!this.canEdit(layer)) return false;
    const white = hexToRgb$1(MASK_STROKE_COLOR);
    return this.editPixels(layer, (px, rect, cov, stride) => blendCoverage(px, rect, cov, stride, white, 1));
  }
  // ── Internals ───────────────────────────────────────────────────────────
  change(next) {
    const s = this.s;
    if (s.loading || s.stroke.active) return false;
    const before = s.selection.current;
    if (selectionsEqual(before, next)) return false;
    s.history.push({ kind: "selection", before, after: next, bytes: selectionBytes(before) + selectionBytes(next) });
    s.selection.set(next);
    s.events.emit("history", void 0);
    return true;
  }
  /** Not loading/stroking and a selection exists (notes otherwise). */
  ready() {
    const s = this.s;
    if (s.loading || s.stroke.active) return false;
    if (!s.selection.current) {
      s.events.emit("note", NO_SELECTION_NOTE);
      return false;
    }
    return true;
  }
  editableTarget() {
    const s = this.s;
    if (!this.ready()) return null;
    const layer = s.target === "mask" ? s.ensureMask() : targetLayer(s.doc, "paint");
    return layer && this.canEdit(layer) ? layer : null;
  }
  /** Same lock/visibility rules (and notes) as strokes and the bucket. */
  canEdit(layer) {
    if (layer.locked) {
      this.s.events.emit("note", LOCKED_LAYER_NOTE);
      return false;
    }
    if (!layer.visible) {
      this.s.events.emit("note", layer.kind === "mask" ? HIDDEN_MASK_NOTE : "The layer is hidden.");
      return false;
    }
    return true;
  }
  /**
   * Run a coverage pixel op over the selection extent of a layer and record
   * one patch. Bounds first grow (chunked, capped) to cover a normal
   * selection; an inverted one covers the whole bounds.
   */
  editPixels(layer, op) {
    const s = this.s;
    const sel = s.selection.current;
    if (!sel) return false;
    if (!sel.outside) s.ensureBounds(sel.rect, true);
    const area = selectionExtent(sel, s.store.bounds);
    if (isEmptyRect(area)) return false;
    const before = s.store.read(layer.id, area);
    if (!before) return false;
    const rect = intersectRect(before.rect, area);
    const coverage = coverageFor(sel, rect);
    const next = new ImageData(new Uint8ClampedArray(before.data.data), before.data.width, before.data.height);
    op(next.data, { x: 0, y: 0, width: rect.width, height: rect.height }, coverage, rect.width);
    s.store.write(layer.id, rect.x, rect.y, next);
    const after = s.store.read(layer.id, rect);
    if (after) {
      const bytes = before.data.data.byteLength + after.data.data.byteLength;
      s.history.push({ kind: "patch", layerId: layer.id, x: rect.x, y: rect.y, before: before.data, after: after.data, bytes });
    }
    s.runtime.touch(layer.id);
    s.afterEdit();
    return true;
  }
  /**
   * The current image rect `{0,0,W,H}` converted to document coords (rounded
   * out to integer pixels). Mirrors `pixelOps.imageRectInDoc` -- the single
   * authoritative way to find "where the image is" in doc coords. Uses
   * {@link documentMap} so it includes the Move-tool placement.
   */
  imageRectInDoc() {
    const s = this.s;
    const map = documentMap(s.doc, s.imageSize);
    const size = s.imageSize;
    return roundOutRect(imageRectToDoc(map, frameRect(size)));
  }
}
const MAX_STAMPS = 32;
class StampCache {
  stamps = /* @__PURE__ */ new Map();
  /**
   * Get (or render) a stamp.
   *
   * @param diameter - Largest diameter it will be drawn at, px.
   * @param hardness - 0..1.
   * @param color - CSS colour.
   * @returns Square surface with the disc centred.
   */
  get(diameter, hardness, color) {
    const size = Math.max(2, Math.ceil(diameter));
    const key = `${size}|${hardness.toFixed(2)}|${color}`;
    const hit = this.stamps.get(key);
    if (hit) {
      this.stamps.delete(key);
      this.stamps.set(key, hit);
      return hit;
    }
    const stamp = renderStamp(size, hardness, color);
    this.stamps.set(key, stamp);
    if (this.stamps.size > MAX_STAMPS) {
      const oldest = this.stamps.keys().next().value;
      if (oldest !== void 0) this.stamps.delete(oldest);
    }
    return stamp;
  }
  /** Drop all stamps. */
  clear() {
    this.stamps.clear();
  }
}
function renderStamp(size, hardness, color) {
  const surface = createSurface(size, size);
  const { ctx } = surface;
  const r = size / 2;
  const gradient = ctx.createRadialGradient(r, r, 0, r, r, r);
  const rgb = colorToRgb(ctx, color);
  for (const [offset, alpha] of stampStops(hardness, r)) {
    gradient.addColorStop(offset, `rgba(${rgb}, ${alpha})`);
  }
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(r, r, r, 0, Math.PI * 2);
  ctx.fill();
  return surface;
}
function colorToRgb(ctx, color) {
  ctx.fillStyle = "#000000";
  ctx.fillStyle = color;
  const parsed = String(ctx.fillStyle);
  const hex = /^#([0-9a-f]{6})$/i.exec(parsed)?.[1];
  if (hex) {
    const n = parseInt(hex, 16);
    return `${n >> 16 & 255}, ${n >> 8 & 255}, ${n & 255}`;
  }
  const rgba = /^rgba?\(([^)]+)\)$/i.exec(parsed)?.[1];
  if (rgba) return rgba.split(",").slice(0, 3).join(",");
  return "0, 0, 0";
}
class Editor {
  events;
  view;
  stamps = new StampCache();
  /** FG/BG colours (session-scoped, not saved). */
  colors;
  /** Layer list commands (add/delete/duplicate/reorder/rename/visibility/lock/opacity/active). */
  layerOps;
  /** Paint-bucket fill and eyedropper sampling. */
  pixelOps;
  /** Move-tool placement of the whole drawing (not undoable). */
  placement;
  /** Selection (session state, undoable) and its pixel commands. */
  selection;
  s;
  frames;
  paint;
  io;
  display;
  maskOps;
  /**
   * @param doc - Document (copied).
   * @param source - Origin of its frame size.
   * @param store - Existing pixels (for clones); a blank store is created otherwise.
   * @param colors - Colour state to start from (forks copy their source's).
   */
  constructor(doc, source, store, colors) {
    this.s = new EditorState(doc, source, store);
    this.events = this.s.events;
    this.view = this.s.view;
    this.colors = new ColorState(colors?.current);
    this.frames = new FrameOps(this.s);
    this.paint = new PaintOps(this.s, this.frames, this.stamps);
    this.io = new DocIO(this.s, (size) => this.frames.handleBackgroundSize(size));
    this.display = new LayerDisplay(this.s);
    this.layerOps = new LayerOps(this.s);
    this.pixelOps = new PixelOps(this.s);
    this.placement = new PlacementOps(this.s);
    this.selection = new SelectionOps(this.s);
    this.maskOps = new EditorMaskOps(this.s, this.paint);
  }
  // ── Read access ─────────────────────────────────────────────────────────
  /** Current document (treat as read-only). */
  get doc() {
    return this.s.doc;
  }
  /** Where the frame size came from. */
  get frameSource() {
    return this.s.frameSource;
  }
  /** Undo available. */
  get canUndo() {
    return this.s.history.canUndo && !this.s.stroke.active;
  }
  /** Redo available. */
  get canRedo() {
    return this.s.history.canRedo && !this.s.stroke.active;
  }
  /** Layer files are being restored; painting is disabled. */
  get loading() {
    return this.s.loading;
  }
  /** Whether any layer has ever held paint. */
  get hasPaint() {
    return this.s.runtime.hasPaint;
  }
  /** Whether any layer needs uploading. */
  get dirty() {
    return this.s.runtime.dirty;
  }
  /**
   * Whether any mask layer is hidden AND has ever held paint (queue-time
   * warning: it will not be in the MASK output).
   * @returns `true` if a hidden-but-painted mask exists.
   */
  hiddenMaskHasContent() {
    for (const layer of this.s.doc.layers) {
      if (layer.kind !== "mask" || layer.visible) continue;
      if (this.s.runtime.get(layer.id)?.hasContent) return true;
    }
    return false;
  }
  /** Background drawn under the paint. */
  get background() {
    return this.s.background;
  }
  /** Size of what the view shows: the current image (or widget-sized fill), else `doc.frame`. */
  get imageSize() {
    return this.s.imageSize;
  }
  /**
   * Document -> image transform: frame fit + Move-tool placement, same as
   * Python's `_layout` (see `frameMap.ts` {@link documentMap}).
   */
  get frameMap() {
    return documentMap(this.s.doc, this.s.imageSize);
  }
  /**
   * Runtime state of a layer.
   * @param layerId - Layer id.
   * @returns Bookkeeping or `undefined`.
   */
  layerRuntime(layerId) {
    return this.s.runtime.get(layerId);
  }
  /**
   * Canvas of a layer (for export/upload).
   * @param layerId - Layer id.
   * @returns The canvas.
   */
  layerCanvas(layerId) {
    return this.s.store.ensure(layerId).canvas;
  }
  /** Current paint bounds (document coords). */
  get bounds() {
    return this.s.store.bounds;
  }
  /** Where the previous stroke ended, document coords (Shift+click line start). */
  get lastStrokeEnd() {
    return this.s.lastStrokeEnd;
  }
  set lastStrokeEnd(point) {
    this.s.lastStrokeEnd = point ? { ...point } : null;
  }
  /**
   * Visible layers to composite (live stroke preview for the painted layer).
   * @returns Bottom -> top layers.
   */
  compositeLayers() {
    return this.display.compositeLayers();
  }
  /**
   * Visible mask layers as tinted overlays (drawn above all paint).
   * @returns Bottom -> top overlays.
   */
  maskOverlays() {
    return this.display.maskOverlays();
  }
  // ── Quick Mask / paint target ───────────────────────────────────────────
  /** What brush/eraser strokes paint into (UI state, not saved). */
  get paintTarget() {
    return this.maskOps.paintTarget;
  }
  /** The mask layer Quick Mask edits, if the document has one. */
  get maskLayer() {
    return this.maskOps.maskLayer;
  }
  /**
   * Switch the paint target (Quick Mask, `Q`); adds a mask layer if missing.
   * @param target - New target.
   */
  setPaintTarget(target) {
    this.maskOps.setPaintTarget(target);
  }
  /** Toggle between the paint layer and the mask. */
  togglePaintTarget() {
    this.maskOps.togglePaintTarget();
  }
  /**
   * Show or hide the mask layer (adds one if missing). Hidden mask layers are
   * also excluded from the `MASK` output (saved-file contract).
   * @param visible - Visibility.
   */
  setMaskVisible(visible) {
    this.maskOps.setMaskVisible(visible);
  }
  // ── Background / frame ──────────────────────────────────────────────────
  /**
   * Set what is drawn under the paint; layer pixels are untouched.
   * @param background - Image or fill.
   * @param imageSize - Current image size: the image's natural size, or the
   *   `width` x `height` widgets for a fill; `null` = show `doc.frame`.
   */
  setBackground(background, imageSize) {
    this.frames.setBackground(background, imageSize);
  }
  /**
   * A new current-image size arrived (an empty document adopts it; a painted
   * one is only displayed through the frame map). Call after `setBackground`.
   * @param size - Current image size.
   */
  handleBackgroundSize(size) {
    this.frames.handleBackgroundSize(size);
  }
  /**
   * Replace the frame of an empty document (no history).
   * @param size - New frame.
   * @param source - Origin of the size.
   */
  adoptFrame(size, source) {
    this.frames.adoptFrame(size, source);
  }
  /** Clear all paint (masks included) and reset the frame; one undo step. */
  clear() {
    this.frames.clear();
  }
  // ── Restore bookkeeping (persistence) ───────────────────────────────────
  /** Mark the start of an async layer restore (disables painting). */
  beginLoading() {
    this.io.beginLoading();
  }
  /** Mark the end of an async layer restore; applies a deferred frame change. */
  endLoading() {
    this.io.endLoading();
  }
  /**
   * Draw a restored PNG into a layer (not an undo step, not dirty).
   * @param layerId - Layer id.
   * @param image - Decoded PNG (sized to `bounds`).
   */
  restoreLayerPixels(layerId, image) {
    this.io.restoreLayerPixels(layerId, image);
  }
  /**
   * Record a finished upload.
   * @param layerId - Layer id.
   * @param version - Layer version that was uploaded.
   * @param file - Stored file reference (`null` for an empty layer).
   */
  markUploaded(layerId, version, file) {
    this.io.markUploaded(layerId, version, file);
  }
  // ── Strokes ─────────────────────────────────────────────────────────────
  /**
   * Start a stroke on the paint target.
   * @param style - Stroke appearance.
   * @param maxDiameter - Largest dab diameter this stroke can produce, document px.
   * @returns `false` if painting is not possible (loading, locked, hidden).
   */
  beginStroke(style, maxDiameter) {
    return this.paint.beginStroke(style, maxDiameter);
  }
  /**
   * Add dabs to the current stroke.
   * @param dabs - Dabs in document coords.
   */
  addDabs(dabs) {
    this.paint.addDabs(dabs);
  }
  /**
   * Replace the current stroke's content with one shape (shape tools: live
   * preview on every move, rasterized into the layer by {@link endStroke}).
   * @param shape - Shape in document coords.
   */
  drawShape(shape) {
    this.paint.drawShape(shape);
  }
  /**
   * Commit the stroke to its layer as one undo step.
   * @param end - Where the stroke ended, document coords (for Shift+click lines).
   */
  endStroke(end) {
    this.paint.endStroke(end);
  }
  /** Abort the current stroke. */
  cancelStroke() {
    this.s.cancelStroke();
  }
  // ── Undo / redo ─────────────────────────────────────────────────────────
  /** Undo the last operation. */
  undo() {
    this.paint.undo();
  }
  /** Redo the last undone operation. */
  redo() {
    this.paint.redo();
  }
  // ── Cloning / teardown ──────────────────────────────────────────────────
  /**
   * Independent copy with a new document id (node duplicated while its source
   * is still live). History is not copied.
   * @param docId - New id.
   * @returns New editor.
   */
  fork(docId) {
    const doc = cloneDocument(this.s.doc);
    doc.docId = docId;
    const copy = new Editor(doc, this.s.frameSource, this.s.store.clone(), this.colors);
    copy.s.runtime.copyFrom(this.s.runtime);
    copy.setBackground(this.s.background, this.s.backgroundSize);
    return copy;
  }
  /** Estimated memory held (pixels + history; mask tint caches excluded). */
  get bytes() {
    return this.s.store.bytes + this.s.history.totalBytes + this.s.selection.bytes;
  }
  /** Release everything. */
  dispose() {
    this.s.stroke.dispose();
    this.s.store.dispose();
    this.display.dispose();
    this.pixelOps.dispose();
    this.s.selection.dispose();
    this.s.history.clear();
    this.stamps.clear();
    this.events.clear();
    this.colors.events.clear();
  }
}
function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  const digits = m?.[1];
  if (!digits) return null;
  const full = digits.length === 3 ? [...digits].map((c) => c + c).join("") : digits;
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16)
  };
}
function rgbToHex(rgb) {
  const r = clampByte(rgb.r);
  const g = clampByte(rgb.g);
  const b = clampByte(rgb.b);
  return `#${byteHex(r)}${byteHex(g)}${byteHex(b)}`;
}
function rgbToHsv(rgb) {
  const r = clampByte(rgb.r) / 255;
  const g = clampByte(rgb.g) / 255;
  const b = clampByte(rgb.b) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  const v = max;
  const s = max === 0 ? 0 : delta / max;
  let h = 0;
  if (delta !== 0) {
    if (max === r) h = (g - b) / delta % 6;
    else if (max === g) h = (b - r) / delta + 2;
    else h = (r - g) / delta + 4;
    h = h * 60;
    if (h < 0) h += 360;
  }
  return { h, s, v };
}
function hsvToRgb(hsv) {
  const h = (hsv.h % 360 + 360) % 360;
  const s = clamp01(hsv.s);
  const v = clamp01(hsv.v);
  const c = v * s;
  const x = c * (1 - Math.abs(h / 60 % 2 - 1));
  const m = v - c;
  let r1 = 0;
  let g1 = 0;
  let b1 = 0;
  if (h < 60) {
    r1 = c;
    g1 = x;
  } else if (h < 120) {
    r1 = x;
    g1 = c;
  } else if (h < 180) {
    g1 = c;
    b1 = x;
  } else if (h < 240) {
    g1 = x;
    b1 = c;
  } else if (h < 300) {
    r1 = x;
    b1 = c;
  } else {
    r1 = c;
    b1 = x;
  }
  return {
    r: Math.round((r1 + m) * 255),
    g: Math.round((g1 + m) * 255),
    b: Math.round((b1 + m) * 255)
  };
}
function hexToHsv(hex) {
  const rgb = hexToRgb(hex);
  return rgb ? rgbToHsv(rgb) : null;
}
function hsvToHex(hsv) {
  return rgbToHex(hsvToRgb(hsv));
}
function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}
function clampByte(v) {
  return Math.max(0, Math.min(255, Math.round(v)));
}
function byteHex(byte) {
  return byte.toString(16).padStart(2, "0");
}
const RECENT_KEY = "PainterSketch.recentColors";
const MAX_RECENTS = 10;
function openColorPicker(host, anchor, opts) {
  const initial = normalizeHex(opts.initial) ?? "#000000";
  let hsv = hexToHsv(initial) ?? { h: 0, s: 0, v: 0 };
  let current = initial;
  let committed = false;
  let escaped = false;
  const root = document.createElement("div");
  root.className = "cps-picker";
  if (opts.title) {
    const title = document.createElement("div");
    title.className = "cps-picker-title";
    title.textContent = opts.title;
    root.appendChild(title);
  }
  const svWrap = document.createElement("div");
  svWrap.className = "cps-picker-sv";
  const svCanvas = document.createElement("canvas");
  svCanvas.className = "cps-picker-sv-canvas";
  const svThumb = document.createElement("div");
  svThumb.className = "cps-picker-sv-thumb";
  svWrap.append(svCanvas, svThumb);
  const hueWrap = document.createElement("div");
  hueWrap.className = "cps-picker-hue";
  const hueThumb = document.createElement("div");
  hueThumb.className = "cps-picker-hue-thumb";
  hueWrap.appendChild(hueThumb);
  const hexRow = document.createElement("div");
  hexRow.className = "cps-picker-hex-row";
  const hexLabel = document.createElement("span");
  hexLabel.className = "cps-picker-hex-label";
  hexLabel.textContent = "Hex";
  const hexInput = document.createElement("input");
  hexInput.type = "text";
  hexInput.className = "cps-picker-hex-input";
  hexInput.maxLength = 7;
  hexInput.spellcheck = false;
  hexInput.autocomplete = "off";
  hexRow.append(hexLabel, hexInput);
  const preview = document.createElement("div");
  preview.className = "cps-picker-preview";
  preview.title = "Click left half to revert to original colour";
  const previewOld = document.createElement("div");
  previewOld.className = "cps-picker-preview-old";
  const previewNew = document.createElement("div");
  previewNew.className = "cps-picker-preview-new";
  preview.append(previewOld, previewNew);
  const recentsEl = document.createElement("div");
  recentsEl.className = "cps-picker-recents";
  root.append(svWrap, hueWrap, hexRow, preview, recentsEl);
  const applyHsv = (newHsv, skipHexField = false) => {
    hsv = newHsv;
    current = hsvToHex(hsv);
    drawSv();
    positionSvThumb();
    positionHueThumb();
    if (!skipHexField) syncHexField();
    previewNew.style.backgroundColor = current;
    opts.onInput(current);
  };
  const applyHex = (hex) => {
    const normalized = normalizeHex(hex);
    if (!normalized) return;
    const newHsv = hexToHsv(normalized);
    if (!newHsv) return;
    applyHsv(newHsv);
  };
  const drawSv = () => {
    const ctx = svCanvas.getContext("2d");
    if (!ctx) return;
    const w = svCanvas.width;
    const h = svCanvas.height;
    const satGrad = ctx.createLinearGradient(0, 0, w, 0);
    satGrad.addColorStop(0, "#ffffff");
    satGrad.addColorStop(1, hsvToHex({ h: hsv.h, s: 1, v: 1 }));
    ctx.fillStyle = satGrad;
    ctx.fillRect(0, 0, w, h);
    const valGrad = ctx.createLinearGradient(0, 0, 0, h);
    valGrad.addColorStop(0, "rgba(0,0,0,0)");
    valGrad.addColorStop(1, "#000000");
    ctx.fillStyle = valGrad;
    ctx.fillRect(0, 0, w, h);
  };
  const positionSvThumb = () => {
    svThumb.style.left = `${clamp01(hsv.s) * 100}%`;
    svThumb.style.top = `${(1 - clamp01(hsv.v)) * 100}%`;
  };
  const svPointerDown = (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    svWrap.setPointerCapture(event.pointerId);
    updateSvFromEvent(event);
  };
  const svPointerMove = (event) => {
    if (!svWrap.hasPointerCapture(event.pointerId)) return;
    updateSvFromEvent(event);
  };
  const updateSvFromEvent = (event) => {
    const rect = svCanvas.getBoundingClientRect();
    const s = clamp01((event.clientX - rect.left) / rect.width);
    const v = clamp01(1 - (event.clientY - rect.top) / rect.height);
    applyHsv({ h: hsv.h, s, v });
  };
  svWrap.addEventListener("pointerdown", svPointerDown);
  svWrap.addEventListener("pointermove", svPointerMove);
  svWrap.addEventListener("wheel", (e) => e.stopPropagation());
  const positionHueThumb = () => {
    hueThumb.style.left = `${hsv.h / 360 * 100}%`;
  };
  const huePointerDown = (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    hueWrap.setPointerCapture(event.pointerId);
    updateHueFromEvent(event);
  };
  const huePointerMove = (event) => {
    if (!hueWrap.hasPointerCapture(event.pointerId)) return;
    updateHueFromEvent(event);
  };
  const updateHueFromEvent = (event) => {
    const rect = hueWrap.getBoundingClientRect();
    const h = clamp01((event.clientX - rect.left) / rect.width) * 360;
    applyHsv({ h, s: hsv.s, v: hsv.v });
  };
  hueWrap.addEventListener("pointerdown", huePointerDown);
  hueWrap.addEventListener("pointermove", huePointerMove);
  hueWrap.addEventListener("wheel", (e) => e.stopPropagation());
  const syncHexField = () => {
    hexInput.value = current.slice(1).toUpperCase();
    hexInput.classList.remove("cps-invalid");
  };
  const applyHexField = () => {
    const raw = hexInput.value.trim();
    const normalized = normalizeHex(raw);
    if (normalized) {
      hexInput.classList.remove("cps-invalid");
      applyHex(normalized);
    } else {
      hexInput.classList.add("cps-invalid");
      syncHexField();
    }
  };
  hexInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      applyHexField();
      hexInput.blur();
    }
  });
  hexInput.addEventListener("blur", () => {
    applyHexField();
  });
  hexInput.addEventListener("input", () => {
    const raw = hexInput.value.trim();
    const normalized = normalizeHex(raw);
    if (normalized) {
      hexInput.classList.remove("cps-invalid");
      applyHex(normalized);
    } else {
      hexInput.classList.add("cps-invalid");
    }
  });
  previewOld.style.backgroundColor = initial;
  previewOld.title = "Click to revert to original colour";
  previewOld.addEventListener("click", () => {
    applyHex(initial);
  });
  const loadRecents = () => {
    try {
      const raw = localStorage.getItem(RECENT_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((v) => typeof v === "string" && normalizeHex(v) !== null);
    } catch {
      return [];
    }
  };
  const saveRecent = (hex) => {
    const normalized = normalizeHex(hex);
    if (!normalized) return;
    const existing = loadRecents().filter((c) => c !== normalized);
    const updated = [normalized, ...existing].slice(0, MAX_RECENTS);
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify(updated));
    } catch {
    }
  };
  const renderRecents = () => {
    recentsEl.textContent = "";
    const recents = loadRecents();
    for (const hex of recents) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "cps-picker-recent";
      btn.style.backgroundColor = hex;
      btn.title = hex.toUpperCase();
      btn.setAttribute("aria-label", `Use recent colour ${hex.toUpperCase()}`);
      btn.addEventListener("click", () => applyHex(hex));
      recentsEl.appendChild(btn);
    }
    recentsEl.hidden = recents.length === 0;
  };
  const resizeSvCanvas = () => {
    const rect = svCanvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));
    if (svCanvas.width !== w || svCanvas.height !== h) {
      svCanvas.width = w;
      svCanvas.height = h;
    }
  };
  requestAnimationFrame(() => {
    resizeSvCanvas();
    drawSv();
    positionSvThumb();
    positionHueThumb();
    syncHexField();
    previewOld.style.backgroundColor = initial;
    previewNew.style.backgroundColor = current;
    renderRecents();
  });
  const handle = host.open(root, {
    anchor,
    placement: "below",
    onClose: () => {
      if (!escaped && !committed) {
        committed = true;
        if (current !== initial) {
          saveRecent(current);
          opts.onCommit?.(current);
        }
      } else if (escaped) {
        opts.onInput(initial);
      }
    }
  });
  handle.element.addEventListener(
    "keydown",
    (event) => {
      if (event.key === "Escape") {
        escaped = true;
      }
    },
    true
  );
  return handle;
}
const PATHS = {
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
  // Move tool (V): four-way arrow.
  move: "M12 3v18M3 12h18M9 6l3-3 3 3M9 18l3 3 3-3M6 9l-3 3 3 3M18 9l3 3-3 3",
  // Move drawing: back sheet (down-left, partially hidden) + front sheet (up-right),
  // small four-way arrow centred on the front sheet.
  // Isometric layer stack: top sheet (diamond) with a 4-way diagonal move
  // arrow, lower sheet shown as an open chevron underneath.
  moveDrawing: "M12 2.5 21.5 8.5 12 14.5 2.5 8.5zM2.5 13.5V15L12 20.5 21.5 15v-1.5M9.4 6.8l5.2 3.4M14.6 6.8l-5.2 3.4M10.7 6.8H9.4v1.1M13.3 6.8h1.3v1.1M10.7 10.2H9.4V9.1M13.3 10.2h1.3V9.1",
  // Selection (M): dashed rectangle.
  marqueeRect: "M4 8V6h2M10 6h4M18 6h2v2M20 11v2M20 16v2h-2M14 18h-4M6 18H4v-2M4 13v-2",
  // Elliptical marquee (M): dashed ellipse (8 arcs of the rectangle's ellipse).
  marqueeEllipse: "M19.7 10.5A8 6 0 0 1 19.7 13.5M18.9 15A8 6 0 0 1 16 17.2M14.1 17.8A8 6 0 0 1 9.9 17.8M8 17.2A8 6 0 0 1 5.1 15M4.3 13.5A8 6 0 0 1 4.3 10.5M5.1 9A8 6 0 0 1 8 6.8M9.9 6.2A8 6 0 0 1 14.1 6.2M16 6.8A8 6 0 0 1 18.9 9",
  // Lasso (L): rope loop with a knot and a dangling tail.
  lasso: "M8.5 14.6C5.8 13.8 4 12.1 4 10c0-3 3.6-5.5 8-5.5s8 2.5 8 5.5-3.6 5.5-8 5.5c-1.3 0-2.5-.2-3.5-.4M8.5 14.6c-1.4.6-1.4 2.2 0 2.6s1.2 2.3-.8 3.3",
  // Magic wand (W): diagonal stick with a sparkle at its tip.
  magicWand: "M4 20 14.5 9.5M13 8l3 3M17 3v4M15 5h4M20.5 9.5v2M19.5 10.5h2M10.5 3.5v2M9.5 4.5h2",
  // "Selection to mask": dashed square with the Quick Mask circle.
  selectionToMask: "M4 7V4h3M10 4h4M17 4h3v3M20 10v4M20 17v3h-3M14 20h-4M7 20H4v-3M4 14v-4M12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6"
};
const FALLBACK = "M5 5h14v14H5z";
function iconPath(name) {
  return PATHS[name] ?? FALLBACK;
}
function iconSvg(name, size = 20) {
  const d = PATHS[name] ?? FALLBACK;
  return `<svg class="cps-icon" viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="${d}"/></svg>`;
}
function setIcon(element, name, size = 20) {
  element.innerHTML = iconSvg(name, size);
}
const WATCH_MS = 250;
const PLACEHOLDER_TEXT = "Editing in fullscreen — press Esc or click to return";
const OVERLAY_STOPPED = [
  "pointerdown",
  "pointerup",
  "pointercancel",
  "mousedown",
  "mouseup",
  "click",
  "dblclick",
  "contextmenu"
];
let openMount = null;
class FullscreenMount {
  /**
   * @param root - Editor root (appended to the container now).
   * @param options - Callbacks.
   */
  constructor(root, options) {
    this.root = root;
    this.options = options;
    this.container = document.createElement("div");
    this.container.className = "cps-widget";
    this.container.appendChild(root);
    this.placeholder = document.createElement("button");
    this.placeholder.type = "button";
    this.placeholder.className = "cps-fullscreen-placeholder";
    this.placeholder.textContent = PLACEHOLDER_TEXT;
    this.placeholder.addEventListener("click", () => this.exit());
  }
  root;
  options;
  /** Stable DOM widget element; holds the root (or the placeholder). */
  container;
  placeholder;
  overlay = null;
  watchTimer = null;
  disposed = false;
  /** Whether the editor is fullscreen. */
  get isOpen() {
    return this.overlay !== null;
  }
  /** The overlay element while fullscreen, else `null`. */
  get overlayElement() {
    return this.overlay;
  }
  /** Enter or leave fullscreen. */
  toggle() {
    if (this.overlay) this.exit();
    else this.enter();
  }
  /** Move the root into a new overlay. No-op if open, disposed or unmounted. */
  enter() {
    if (this.overlay || this.disposed || !this.container.isConnected) return;
    openMount?.exit();
    this.options.beforeChange?.();
    const overlay = buildOverlay(() => this.exit());
    this.overlay = overlay;
    openMount = this;
    overlay.prepend(this.root);
    this.container.appendChild(this.placeholder);
    document.body.appendChild(overlay);
    this.watchTimer = setInterval(() => this.watch(), WATCH_MS);
    this.options.onChange(true);
  }
  /** Move the root back into the container and remove the overlay. */
  exit() {
    const overlay = this.overlay;
    if (!overlay) return;
    this.options.beforeChange?.();
    this.overlay = null;
    if (openMount === this) openMount = null;
    if (this.watchTimer !== null) clearInterval(this.watchTimer);
    this.watchTimer = null;
    this.placeholder.remove();
    this.container.appendChild(this.root);
    overlay.remove();
    this.options.onChange(false);
  }
  /** Exit (if open) and stop accepting `enter`. Idempotent. */
  dispose() {
    this.exit();
    this.disposed = true;
  }
  watch() {
    if (!this.container.isConnected || this.options.isDetached?.()) this.exit();
  }
}
function buildOverlay(exit) {
  const overlay = document.createElement("div");
  overlay.className = "cps-fullscreen";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-label", "PainterSketch fullscreen editor");
  const button2 = document.createElement("button");
  button2.type = "button";
  button2.className = "cps-fullscreen-exit";
  button2.title = "Exit fullscreen (Esc)";
  setIcon(button2, "exitFullscreen", 16);
  const label = document.createElement("span");
  label.textContent = "Exit fullscreen";
  button2.appendChild(label);
  button2.addEventListener("click", exit);
  overlay.appendChild(button2);
  const stop = (event) => event.stopPropagation();
  for (const type of OVERLAY_STOPPED) overlay.addEventListener(type, stop);
  overlay.addEventListener(
    "wheel",
    (event) => {
      event.stopPropagation();
      if (event.target === overlay || event.ctrlKey) event.preventDefault();
    },
    { passive: false }
  );
  const noDrop = (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "none";
  };
  overlay.addEventListener("dragover", noDrop);
  overlay.addEventListener("drop", noDrop);
  return overlay;
}
const NON_TEXT_INPUTS = ["range", "checkbox", "radio", "button", "submit", "reset", "color", "file", "image"];
function isTextEntry(info) {
  if (info.tagName === "TEXTAREA" || info.tagName === "SELECT") return true;
  if (info.tagName === "INPUT") return !NON_TEXT_INPUTS.includes((info.type ?? "text").toLowerCase());
  return info.editable === true;
}
function isRangeInput(info) {
  return info.tagName === "INPUT" && (info.type ?? "").toLowerCase() === "range";
}
function pointerFocusAction(info) {
  if (isTextEntry(info)) return "text";
  if (isRangeInput(info)) return "native";
  return "sink";
}
function mayKeepFocus(info) {
  return pointerFocusAction(info) !== "sink";
}
function isScopeActive(state) {
  return state.hovered || state.held || state.engaged || state.fullscreen;
}
function hoverMayTakeFocus(focused) {
  return focused === null || !isTextEntry(focused);
}
function describeElement(element) {
  const info = { tagName: element.tagName.toUpperCase() };
  if (element instanceof HTMLInputElement) info.type = element.type;
  if (element instanceof HTMLElement && element.isContentEditable) info.editable = true;
  return info;
}
const BROWSER_MOD_KEYS = /* @__PURE__ */ new Set(["r", "w", "t", "n", "l", "tab", "pageup", "pagedown"]);
const BROWSER_MOD_SHIFT_KEYS = /* @__PURE__ */ new Set(["i", "j", "c"]);
const COMFY_MOD_KEYS = /* @__PURE__ */ new Set(["s", "enter"]);
function fullscreenKeyPolicy(event) {
  const key = event.key.toLowerCase();
  if (/^f([1-9]|1[0-9]|2[0-4])$/.test(key)) return "pass";
  const mod = event.ctrlKey || event.metaKey;
  if (event.altKey && !mod && (key === "arrowleft" || key === "arrowright")) return "pass";
  if (mod && !event.altKey) {
    if (BROWSER_MOD_KEYS.has(key) || COMFY_MOD_KEYS.has(key)) return "pass";
    if (event.shiftKey && BROWSER_MOD_SHIFT_KEYS.has(key)) return "pass";
  }
  return "swallow";
}
class ModifierScope {
  /**
   * @param handlers - Callbacks invoked when Space or Alt changes.
   */
  constructor(handlers) {
    this.handlers = handlers;
  }
  handlers;
  spaceDown = false;
  altDown = false;
  shiftDown = false;
  listening = false;
  onKeyDown = (event) => {
    if (event.key === "Alt") {
      event.preventDefault();
      this.setAlt(true);
    } else if (event.key === " " || event.code === "Space") {
      this.setSpace(true);
    }
    this.setShift(event.shiftKey);
  };
  onKeyUp = (event) => {
    if (event.key === "Alt") this.setAlt(false);
    else if (event.key === " " || event.code === "Space") this.setSpace(false);
    this.setShift(event.shiftKey);
  };
  onBlur = () => {
    this.setSpace(false);
    this.setAlt(false);
    this.setShift(false);
  };
  /** Whether Space is currently held. */
  get isSpaceDown() {
    return this.spaceDown;
  }
  /** Whether Alt is currently held. */
  get isAltDown() {
    return this.altDown;
  }
  /**
   * Register window listeners. Idempotent.
   */
  activate() {
    if (this.listening) return;
    this.listening = true;
    window.addEventListener("keydown", this.onKeyDown, true);
    window.addEventListener("keyup", this.onKeyUp, true);
    window.addEventListener("blur", this.onBlur);
  }
  /**
   * Remove window listeners and clear both modifiers. Idempotent.
   */
  deactivate() {
    if (!this.listening) return;
    this.listening = false;
    window.removeEventListener("keydown", this.onKeyDown, true);
    window.removeEventListener("keyup", this.onKeyUp, true);
    window.removeEventListener("blur", this.onBlur);
    this.setSpace(false);
    this.setAlt(false);
    this.setShift(false);
  }
  // ── Internals ─────────────────────────────────────────────────────────────
  setSpace(down) {
    if (this.spaceDown === down) return;
    this.spaceDown = down;
    this.handlers.onSpaceChange(down);
  }
  setAlt(down) {
    if (this.altDown === down) return;
    this.altDown = down;
    this.handlers.onAltChange?.(down);
  }
  setShift(down) {
    if (this.shiftDown === down) return;
    this.shiftDown = down;
    this.handlers.onShiftChange?.(down);
  }
}
function isSaveChord(event) {
  return event.key.toLowerCase() === "s" && (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey;
}
const HAS_KEYS_CLASS = "cps-has-keys";
class KeyboardScope {
  /**
   * @param root - Editor root (hover target, hosts the focus sink).
   * @param handlers - Key callbacks.
   */
  constructor(root, handlers) {
    this.root = root;
    this.handlers = handlers;
    this.sink = document.createElement("input");
    this.sink.className = "cps-focus-sink";
    this.sink.readOnly = true;
    this.sink.tabIndex = -1;
    this.sink.setAttribute("aria-hidden", "true");
    root.appendChild(this.sink);
    this.modifiers = new ModifierScope({
      onSpaceChange: (down) => handlers.onSpaceChange(down),
      onAltChange: (down) => handlers.onAltChange?.(down),
      onShiftChange: (down) => handlers.onShiftChange?.(down)
    });
    root.addEventListener("pointerenter", this.enter);
    root.addEventListener("pointerleave", this.leave);
    root.addEventListener("keydown", this.rootKeydown);
    root.addEventListener("pointerdown", this.rootPointerDown, true);
    root.addEventListener("focusin", this.rootFocusIn);
    root.addEventListener("focusout", this.rootFocusOut);
  }
  root;
  handlers;
  active = false;
  hovered = false;
  held = false;
  engaged = false;
  previousFocus = null;
  /** Fullscreen overlay (contains the root) while fullscreen, else `null`. */
  captureScope = null;
  sink;
  /** Alt/Space modifier tracking (window keydown/keyup/blur). */
  modifiers;
  keydown = (event) => this.handleKeyDown(event);
  keyup = (event) => this.handleKeyUp(event);
  /** Fullscreen: stop keys from our own text fields after they handled them. */
  rootKeydown = (event) => {
    if (this.captureScope && fullscreenKeyPolicy(event) === "swallow") event.stopPropagation();
  };
  /**
   * Any press inside the root engages the editor (see module doc). Capture
   * phase, so it runs before the stage/row/scrub handlers; those may still
   * `setPointerCapture` -- `preventDefault()` here only stops the focus move
   * and the compatibility mouse events, not `click`/`dblclick`.
   */
  rootPointerDown = (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    this.setEngaged(true);
    if (pointerFocusAction(describeElement(target)) !== "sink") return;
    event.preventDefault();
    this.focusSink();
  };
  /**
   * Safety net: a non-text element inside the root that still receives
   * focus while active is redirected to the sink so ChangeTracker keeps
   * ignoring Ctrl+Z. Text entries and range sliders keep focus.
   */
  rootFocusIn = (event) => {
    const target = event.target;
    if (this.active && target instanceof Element && target !== this.sink && !mayKeepFocus(describeElement(target))) {
      this.focusSink();
    }
    this.syncIndicator();
  };
  /** One of our text fields blurred to nothing: give focus back to the sink. */
  rootFocusOut = (event) => {
    if (event.relatedTarget === null && event.target !== this.sink) queueMicrotask(() => this.reclaimFocus());
    queueMicrotask(() => this.syncIndicator());
  };
  /** Engaged: a press outside the root (and fullscreen overlay) ends it. */
  outsidePointerDown = (event) => {
    if (!this.isInside(event.target)) this.setEngaged(false);
  };
  /** Engaged: focus moving outside the root (and overlay) ends it. */
  outsideFocusIn = (event) => {
    if (!this.isInside(event.target)) this.setEngaged(false);
  };
  /**
   * Fullscreen: buttons and other non-input elements outside the root (the
   * overlay exit button, the backdrop) don't keep focus.
   */
  scopeFocusIn = (event) => {
    const target = event.target;
    if (target instanceof Element && !(target instanceof HTMLInputElement) && !isTextEntry(describeElement(target))) {
      this.focusSink();
    }
  };
  /** Fullscreen: a click on the backdrop leaves focus on `body`; reclaim it. */
  scopePointerUp = () => {
    queueMicrotask(() => this.reclaimFocus());
  };
  /** Whether Space is held (pan). */
  get isSpaceDown() {
    return this.modifiers.isSpaceDown;
  }
  /**
   * Keep the scope active while a drag that started inside is in progress,
   * even if the pointer leaves.
   * @param held - Drag in progress.
   */
  setHeld(held) {
    this.held = held;
    this.sync();
  }
  /**
   * Fullscreen on/off. While set, the scope is active regardless of hover
   * and filters unhandled keys (see module doc).
   * @param scope - Overlay element containing the root, or `null` to leave.
   */
  setCaptureScope(scope) {
    if (scope === this.captureScope) return;
    const previous = this.captureScope;
    if (previous) {
      previous.removeEventListener("focusin", this.scopeFocusIn);
      previous.removeEventListener("pointerup", this.scopePointerUp, true);
    }
    this.captureScope = scope;
    if (scope) {
      scope.addEventListener("focusin", this.scopeFocusIn);
      scope.addEventListener("pointerup", this.scopePointerUp, true);
    }
    this.sync();
    this.reclaimFocus();
    this.syncIndicator();
  }
  /**
   * While active, move focus back to the sink if nothing else holds it
   * (e.g. after a popover with a focused text field closed), so ComfyUI's
   * graph undo keeps ignoring Ctrl+Z.
   */
  reclaimFocus() {
    const current = document.activeElement;
    if (this.active && (!current || current === document.body)) this.focusSink();
    this.syncIndicator();
  }
  /** Remove listeners and the focus sink. */
  dispose() {
    this.hovered = false;
    this.held = false;
    this.setEngaged(false);
    this.setCaptureScope(null);
    this.sync();
    this.root.removeEventListener("pointerenter", this.enter);
    this.root.removeEventListener("pointerleave", this.leave);
    this.root.removeEventListener("keydown", this.rootKeydown);
    this.root.removeEventListener("pointerdown", this.rootPointerDown, true);
    this.root.removeEventListener("focusin", this.rootFocusIn);
    this.root.removeEventListener("focusout", this.rootFocusOut);
    this.root.classList.remove(HAS_KEYS_CLASS);
    this.sink.remove();
  }
  // ── Internals ───────────────────────────────────────────────────────────
  enter = () => {
    this.hovered = true;
    this.sync();
  };
  leave = () => {
    this.hovered = false;
    this.sync();
  };
  setEngaged(engaged) {
    if (engaged === this.engaged) return;
    this.engaged = engaged;
    if (engaged) {
      this.previousFocus = null;
      window.addEventListener("pointerdown", this.outsidePointerDown, true);
      document.addEventListener("focusin", this.outsideFocusIn, true);
    } else {
      window.removeEventListener("pointerdown", this.outsidePointerDown, true);
      document.removeEventListener("focusin", this.outsideFocusIn, true);
    }
    this.sync();
  }
  sync() {
    const shouldBeActive = isScopeActive({
      hovered: this.hovered,
      held: this.held,
      engaged: this.engaged,
      fullscreen: this.captureScope !== null
    });
    if (shouldBeActive === this.active) return;
    this.active = shouldBeActive;
    if (shouldBeActive) {
      window.addEventListener("keydown", this.keydown, true);
      window.addEventListener("keyup", this.keyup, true);
      this.modifiers.activate();
      this.takeFocus();
    } else {
      window.removeEventListener("keydown", this.keydown, true);
      window.removeEventListener("keyup", this.keyup, true);
      this.modifiers.deactivate();
      this.returnFocus();
      this.handlers.onDeactivate?.();
    }
    this.syncIndicator();
  }
  /** Hover/fullscreen activation: take focus unless a text field has it. */
  takeFocus() {
    const current = document.activeElement;
    const focused = current && current !== document.body ? current : null;
    if (focused === this.sink) return;
    if (focused && !hoverMayTakeFocus(describeElement(focused))) return;
    this.previousFocus = focused && !this.root.contains(focused) ? focused : null;
    this.focusSink();
  }
  returnFocus() {
    if (document.activeElement !== this.sink) return;
    this.sink.blur();
    const previous = this.previousFocus;
    this.previousFocus = null;
    if (previous instanceof HTMLElement && previous.isConnected && !isTextEntry(describeElement(previous))) {
      previous.focus({ preventScroll: true });
    }
  }
  focusSink() {
    if (document.activeElement !== this.sink) this.sink.focus({ preventScroll: true });
  }
  /** Focus indicator from the real focus state. */
  syncIndicator() {
    const current = document.activeElement;
    const owns = current !== null && current !== document.body && this.root.contains(current);
    this.root.classList.toggle(HAS_KEYS_CLASS, owns);
  }
  /** Inside the root, or inside the fullscreen overlay holding it. */
  isInside(target) {
    if (!(target instanceof Node)) return false;
    return this.root.contains(target) || (this.captureScope?.contains(target) ?? false);
  }
  handleKeyDown(event) {
    if (this.captureScope && this.isOutsideScope(event.target)) return;
    if (isSaveChord(event) && this.ownsKeyTarget(event.target)) {
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) this.handlers.onSave?.();
      return;
    }
    if (this.isForeignTextTarget(event.target)) return;
    if (event.key === "Alt") {
      event.preventDefault();
      return;
    }
    if (event.key === " " || event.code === "Space") {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (this.handlers.onKeyDown(event) || this.captureScope && fullscreenKeyPolicy(event) === "swallow") {
      event.preventDefault();
      event.stopPropagation();
    }
  }
  handleKeyUp(event) {
    if (event.key === "Alt") {
      if (!this.isForeignTextTarget(event.target)) event.preventDefault();
      return;
    }
    if (event.key === " " || event.code === "Space") {
      if (this.isForeignTextTarget(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
    }
  }
  /** Fullscreen: focus is in UI above/outside the overlay (e.g. a dialog). */
  isOutsideScope(target) {
    if (!(target instanceof Node) || target === document.body || target === document.documentElement) return false;
    return !(this.captureScope?.contains(target) ?? false);
  }
  /**
   * The editor owns this key: it targets the sink or another element inside
   * the root / fullscreen overlay. While fullscreen, `body` also counts (a
   * backdrop click can leave focus there before it is reclaimed).
   */
  ownsKeyTarget(target) {
    if (target === this.sink || this.isInside(target)) return true;
    return this.captureScope !== null && (target === document.body || target === document.documentElement);
  }
  /** Text fields other than our sink keep their keys (hex field, text tool...). */
  isForeignTextTarget(target) {
    return target instanceof Element && target !== this.sink && isTextEntry(describeElement(target));
  }
}
const THUMB_BOX = 36;
const THUMB_MIN_INTERVAL_MS = 150;
function thumbSize(size, box = THUMB_BOX) {
  const w = Math.max(1, size.width);
  const h = Math.max(1, size.height);
  const s = box / Math.max(w, h);
  return { width: Math.max(4, Math.round(w * s)), height: Math.max(4, Math.round(h * s)) };
}
class Thumbnail {
  canvas;
  key = "";
  constructor() {
    this.canvas = document.createElement("canvas");
    this.canvas.className = "cps-layer-thumb";
    this.canvas.width = THUMB_BOX;
    this.canvas.height = THUMB_BOX;
    this.canvas.style.width = `${THUMB_BOX}px`;
    this.canvas.style.height = `${THUMB_BOX}px`;
  }
  /**
   * Redraw if `key` changed.
   * @param key - Cache key (revision + geometry + display state).
   * @param size - Content size (for the aspect ratio).
   * @param source - What to draw.
   */
  update(key, size, source) {
    if (key === this.key) return;
    this.key = key;
    const css = thumbSize(size);
    const dpr = Math.min(2, Math.max(1, globalThis.devicePixelRatio || 1));
    const w = Math.round(css.width * dpr);
    const h = Math.round(css.height * dpr);
    const canvas = this.canvas;
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    canvas.style.width = `${css.width}px`;
    canvas.style.height = `${css.height}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.save();
    ctx.clearRect(0, 0, w, h);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "medium";
    if (source.kind === "background") drawBackground(ctx, source.background, w, h);
    else drawLayer(ctx, source, w, h);
    ctx.restore();
  }
  /** Force the next {@link update} to redraw. */
  invalidate() {
    this.key = "";
  }
}
function drawBackground(ctx, background, w, h) {
  if (background.kind === "fill") {
    ctx.fillStyle = background.color;
    ctx.fillRect(0, 0, w, h);
    return;
  }
  try {
    ctx.drawImage(background.image, 0, 0, w, h);
  } catch {
  }
}
function drawLayer(ctx, source, w, h) {
  const { canvas, region } = source;
  if (source.mask) {
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, w, h);
  }
  if (region.width > 0 && region.height > 0 && canvas.width > 0 && canvas.height > 0) {
    ctx.drawImage(canvas, region.x, region.y, region.width, region.height, 0, 0, w, h);
  }
  if (source.mask && source.invert) {
    ctx.globalCompositeOperation = "difference";
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, w, h);
  }
}
class RefreshThrottle {
  /**
   * @param refresh - Work to run.
   */
  constructor(refresh) {
    this.refresh = refresh;
  }
  refresh;
  frame = null;
  timer = null;
  last = 0;
  /** Request a refresh (cheap; call on every editor event). */
  request() {
    if (this.frame !== null || this.timer !== null) return;
    const wait = this.last + THUMB_MIN_INTERVAL_MS - performance.now();
    if (wait > 0) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.request();
      }, wait);
      return;
    }
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      this.last = performance.now();
      this.refresh();
    });
  }
  /** Cancel pending work. */
  dispose() {
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    if (this.timer !== null) clearTimeout(this.timer);
    this.frame = null;
    this.timer = null;
  }
}
class LayerRow {
  /**
   * @param kind - Row kind.
   * @param id - Layer id (`"background"` for the background row).
   * @param actions - Callbacks.
   * @param maskOpacity - Overlay opacity control (mask rows).
   */
  constructor(kind, id, actions, maskOpacity) {
    this.kind = kind;
    this.id = id;
    this.actions = actions;
    this.element = document.createElement("div");
    this.element.className = `cps-layer-row cps-layer-${kind}`;
    this.element.dataset["layerId"] = id;
    const main = document.createElement("div");
    main.className = "cps-layer-main";
    const thumbBox = document.createElement("span");
    thumbBox.className = "cps-layer-thumb-box";
    thumbBox.appendChild(this.thumb.canvas);
    this.nameEl = document.createElement("span");
    this.nameEl.className = "cps-layer-name";
    main.append(thumbBox, this.nameEl);
    if (kind !== "background") {
      this.eye = button("cps-layer-eye", () => actions.toggleVisible(id));
      main.appendChild(this.eye);
    }
    this.lock = button("cps-layer-lock", () => actions.toggleLocked(id));
    main.appendChild(this.lock);
    this.element.appendChild(main);
    if (kind === "background") {
      this.lock.disabled = true;
      this.lock.title = "The background (input image) is locked";
      setIcon(this.lock, "lock", 14);
    } else {
      this.element.addEventListener("click", (event) => {
        if (!isControl(event.target)) actions.select(id);
      });
      this.nameEl.addEventListener("dblclick", (event) => {
        event.stopPropagation();
        this.startRename();
      });
    }
    if (kind === "mask") {
      const extra = document.createElement("div");
      extra.className = "cps-layer-extra";
      const swatch2 = button("cps-layer-swatch", () => actions.pickColor(id, swatch2));
      swatch2.title = "Mask colour (display only)";
      const invert = button("cps-layer-invert", () => actions.toggleInvert(id));
      setIcon(invert, "invert", 14);
      extra.append(swatch2, invert);
      if (maskOpacity) extra.appendChild(maskOpacity.element);
      this.element.appendChild(extra);
      this.swatch = swatch2;
      this.invertButton = invert;
    }
  }
  kind;
  id;
  actions;
  element;
  thumb = new Thumbnail();
  nameEl;
  eye = null;
  lock;
  swatch = null;
  invertButton = null;
  model = null;
  editor = null;
  icons = { eye: "", lock: "" };
  /** Whether the name is being edited. */
  get isRenaming() {
    return this.editor !== null;
  }
  /**
   * Apply display state.
   * @param model - New state.
   */
  update(model) {
    this.model = model;
    const el2 = this.element;
    el2.classList.toggle("cps-selected", model.selected);
    el2.classList.toggle("cps-standby", model.standby);
    el2.classList.toggle("cps-hidden-layer", !model.visible);
    if (!this.editor) this.nameEl.textContent = model.name;
    this.nameEl.title = this.kind === "background" ? "Input image" : `${model.name} (double-click to rename)`;
    if (this.eye) {
      const icon = model.visible ? "eye" : "eyeOff";
      if (icon !== this.icons.eye) setIcon(this.eye, icon, 14);
      this.icons.eye = icon;
      this.eye.classList.toggle("cps-off", !model.visible);
      this.eye.setAttribute("aria-pressed", String(model.visible));
      this.eye.title = this.kind === "mask" ? model.visible ? "Hide mask (also excludes it from the MASK output)" : "Show mask (hidden masks are excluded from the MASK output)" : model.visible ? "Hide layer" : "Show layer";
    }
    if (this.kind !== "background") {
      const icon = model.locked ? "lock" : "unlock";
      if (icon !== this.icons.lock) setIcon(this.lock, icon, 14);
      this.icons.lock = icon;
      this.lock.classList.toggle("cps-on", model.locked);
      this.lock.setAttribute("aria-pressed", String(model.locked));
      this.lock.title = model.locked ? "Unlock layer" : "Lock layer (refuses painting)";
    }
    if (this.swatch && model.color) this.swatch.style.backgroundColor = model.color;
    if (this.invertButton) {
      const on = model.invert === true;
      this.invertButton.classList.toggle("cps-active", on);
      this.invertButton.setAttribute("aria-pressed", String(on));
      this.invertButton.title = on ? "Mask inverted (click to un-invert)" : "Invert mask";
    }
  }
  /** Begin inline renaming. */
  startRename() {
    if (this.editor || this.kind === "background") return;
    const input = document.createElement("input");
    input.type = "text";
    input.className = "cps-layer-rename";
    input.value = this.model?.name ?? "";
    input.spellcheck = false;
    input.maxLength = 100;
    this.editor = input;
    this.nameEl.replaceChildren(input);
    this.actions.renaming(true);
    let done = false;
    const finish = (commit) => {
      if (done) return;
      done = true;
      const value = input.value;
      this.editor = null;
      this.nameEl.textContent = this.model?.name ?? "";
      if (commit) this.actions.rename(this.id, value);
      this.actions.renaming(false);
    };
    input.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Enter") {
        event.preventDefault();
        finish(true);
      } else if (event.key === "Escape") {
        event.preventDefault();
        finish(false);
      }
    });
    input.addEventListener("blur", () => finish(true));
    input.addEventListener("pointerdown", (event) => event.stopPropagation());
    input.addEventListener("click", (event) => event.stopPropagation());
    input.focus({ preventScroll: true });
    input.select();
  }
}
function button(className, onClick) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = `cps-icon-button cps-layer-button ${className}`;
  b.addEventListener("click", (event) => {
    event.stopPropagation();
    onClick();
  });
  return b;
}
function isControl(target) {
  return target instanceof Element && target.closest("button, input, select, .cps-num") !== null;
}
const DRAG_THRESHOLD_PX = 4;
const EDGE_PX = 18;
const SCROLL_STEP_PX = 8;
class LayerDrag {
  /**
   * @param list - Scrolling list holding `.cps-layer-row` elements.
   * @param onDrop - Called with the dragged id and the drop target.
   */
  constructor(list, onDrop) {
    this.list = list;
    this.onDrop = onDrop;
    const { signal } = this.controller;
    list.addEventListener("pointerdown", (e) => this.down(e), { signal });
    list.addEventListener("pointermove", (e) => this.move(e), { signal });
    list.addEventListener("pointerup", (e) => this.up(e, true), { signal });
    list.addEventListener("pointercancel", (e) => this.up(e, false), { signal });
    list.addEventListener("lostpointercapture", (e) => this.up(e, false), { signal });
  }
  list;
  onDrop;
  press = null;
  dragging = false;
  drop = null;
  marked = null;
  controller = new AbortController();
  /** Whether a drag is in progress. */
  get active() {
    return this.dragging;
  }
  /** Remove listeners. */
  dispose() {
    this.reset();
    this.controller.abort();
  }
  down(event) {
    if (event.button !== 0 || isControl(event.target) || !(event.target instanceof Element)) return;
    const row = event.target.closest(".cps-layer-paint");
    const id = row?.dataset["layerId"];
    if (!row || !id) return;
    this.press = { id, pointerId: event.pointerId, startY: event.clientY, row };
  }
  move(event) {
    const press = this.press;
    if (!press || event.pointerId !== press.pointerId) return;
    if (!this.dragging) {
      if (Math.abs(event.clientY - press.startY) < DRAG_THRESHOLD_PX) return;
      try {
        this.list.setPointerCapture(event.pointerId);
      } catch {
        this.press = null;
        return;
      }
      this.dragging = true;
      press.row.classList.add("cps-dragging");
    }
    event.preventDefault();
    this.autoScroll(event.clientY);
    this.drop = this.findDrop(event.clientY);
    this.mark(this.drop);
  }
  up(event, commit) {
    const press = this.press;
    if (!press || event.pointerId !== press.pointerId) return;
    const drop = this.drop;
    const wasDragging = this.dragging;
    this.reset();
    if (this.list.hasPointerCapture(event.pointerId)) this.list.releasePointerCapture(event.pointerId);
    if (commit && wasDragging && drop && drop.targetId !== press.id) this.onDrop(press.id, drop);
  }
  reset() {
    this.press?.row.classList.remove("cps-dragging");
    this.press = null;
    this.dragging = false;
    this.drop = null;
    this.mark(null);
  }
  /** Paint row under (or nearest to) the pointer, above/below its middle. */
  findDrop(clientY) {
    const rows = [...this.list.querySelectorAll(".cps-layer-paint")];
    let best = null;
    for (const row of rows) {
      const id = row.dataset["layerId"];
      if (!id) continue;
      const r = row.getBoundingClientRect();
      if (clientY < r.top) return best ?? { targetId: id, above: true };
      best = { targetId: id, above: clientY < r.top + r.height / 2 };
      if (clientY <= r.bottom) return best;
      best = { targetId: id, above: false };
    }
    return best;
  }
  mark(drop) {
    const marked = this.marked;
    marked?.classList.remove("cps-drop-above", "cps-drop-below");
    this.marked = null;
    if (!drop) return;
    const row = [...this.list.querySelectorAll(".cps-layer-row")].find(
      (r) => r.dataset["layerId"] === drop.targetId
    );
    if (!row) return;
    row.classList.add(drop.above ? "cps-drop-above" : "cps-drop-below");
    this.marked = row;
  }
  autoScroll(clientY) {
    const r = this.list.getBoundingClientRect();
    if (clientY < r.top + EDGE_PX) this.list.scrollTop -= SCROLL_STEP_PX;
    else if (clientY > r.bottom - EDGE_PX) this.list.scrollTop += SCROLL_STEP_PX;
  }
}
const POW_CURVE = 2;
function stepDecimals(step) {
  if (!Number.isFinite(step) || step <= 0) return 0;
  for (let d = 0; d <= 6; d++) if (Math.abs(Math.round(step * 10 ** d) - step * 10 ** d) < 1e-9) return d;
  return 6;
}
function clampDisplay(desc, display) {
  if (!Number.isFinite(display)) return desc.min;
  const step = desc.step > 0 ? desc.step : 1;
  const snapped = desc.min + Math.round((display - desc.min) / step) * step;
  const clamped = Math.min(desc.max, Math.max(desc.min, snapped));
  return Number(clamped.toFixed(stepDecimals(step)));
}
function toDisplay(desc, value) {
  return clampDisplay(desc, value * (desc.scale ?? 1));
}
function fromDisplay(desc, display) {
  return clampDisplay(desc, display) / (desc.scale ?? 1);
}
function formatDisplay(desc, display) {
  return clampDisplay(desc, display).toFixed(stepDecimals(desc.step));
}
function sliderToDisplay(desc, t) {
  const u = Math.min(1, Math.max(0, t));
  const k = desc.curve === "pow" ? Math.pow(u, POW_CURVE) : u;
  return clampDisplay(desc, desc.min + k * (desc.max - desc.min));
}
function displayToSlider(desc, display) {
  const range = desc.max - desc.min;
  if (range <= 0) return 0;
  const k = (clampDisplay(desc, display) - desc.min) / range;
  return desc.curve === "pow" ? Math.pow(k, 1 / POW_CURVE) : k;
}
function coerceOption(desc, value) {
  switch (desc.kind) {
    case "number":
      return typeof value === "number" ? fromDisplay(desc, value * (desc.scale ?? 1)) : void 0;
    case "toggle":
    case "button":
      return typeof value === "boolean" ? value : void 0;
    case "select":
      return typeof value === "string" && desc.choices.some((c) => c.value === value) ? value : void 0;
  }
}
function isOptionEnabled(desc, get) {
  if (!desc.dependsOn?.length) return true;
  return desc.dependsOn.some((key) => get(key) === true);
}
function layoutOptions(descriptors, groups = []) {
  const collapsed = new Map(groups.map((g) => [g.id, g]));
  const items = [];
  const emitted = /* @__PURE__ */ new Map();
  let lastGroup;
  for (const desc of descriptors) {
    const group2 = desc.group !== void 0 ? collapsed.get(desc.group) : void 0;
    if (group2) {
      const members = emitted.get(group2.id);
      if (members) {
        members.push(desc);
        continue;
      }
    }
    if (items.length > 0 && desc.group !== lastGroup) items.push({ kind: "separator" });
    lastGroup = desc.group;
    if (group2) {
      const members = [desc];
      emitted.set(group2.id, members);
      items.push({ kind: "group", group: group2, descriptors: members });
    } else {
      items.push({ kind: "control", desc });
    }
  }
  return items;
}
function isGroupActive(group2, get) {
  return (group2.activeWhen ?? []).some((key) => get(key) === true);
}
class OptionSet {
  /**
   * @param descriptors - Descriptors in display order.
   * @param values - Values object; only descriptor keys are ever written.
   * @param groups - Groups collapsed behind a button in the bar.
   */
  constructor(descriptors, values, groups = []) {
    this.descriptors = descriptors;
    this.values = values;
    this.groups = groups;
    for (const desc of descriptors) this.byKey.set(desc.key, desc);
  }
  descriptors;
  values;
  groups;
  byKey = /* @__PURE__ */ new Map();
  /** @inheritdoc */
  get(key) {
    return this.byKey.has(key) ? this.values[key] : void 0;
  }
  /** @inheritdoc */
  set(key, value) {
    const desc = this.byKey.get(key);
    if (!desc) return false;
    const next = coerceOption(desc, value);
    if (next === void 0 || next === this.values[key]) return false;
    this.values[key] = next;
    return true;
  }
}
const MAX_PX_PER_STEP = 8;
const MIN_PX_PER_STEP = 1;
const RANGE_PX = 240;
const SCRUB_FAST_FACTOR = 10;
function scrubPixelsPerStep(desc) {
  const steps = desc.step > 0 ? Math.round((desc.max - desc.min) / desc.step) : 0;
  if (!(steps > 0)) return MAX_PX_PER_STEP;
  return Math.min(MAX_PX_PER_STEP, Math.max(MIN_PX_PER_STEP, RANGE_PX / steps));
}
function scrubValue(desc, startDisplay, dx, fast) {
  const steps = Math.trunc(dx / scrubPixelsPerStep(desc)) * (fast ? SCRUB_FAST_FACTOR : 1);
  return clampDisplay(desc, startDisplay + steps * desc.step);
}
const SLIDER_STEPS = 1e3;
function createControl(desc, ctx) {
  switch (desc.kind) {
    case "number":
      return numberControl(desc, ctx);
    case "toggle":
      return toggleControl(desc, ctx);
    case "select":
      return selectControl(desc, ctx);
    case "button":
      return buttonControl(desc, ctx);
  }
}
function numberControl(desc, ctx) {
  const element = document.createElement("div");
  element.className = "cps-num";
  if (desc.title) element.title = desc.title;
  const label = document.createElement("span");
  label.className = "cps-num-label";
  label.textContent = desc.label;
  const value = document.createElement("button");
  value.type = "button";
  value.className = "cps-num-value";
  element.append(label, value);
  const display = () => {
    const v = ctx.options.get(desc.key);
    return typeof v === "number" ? toDisplay(desc, v) : desc.min;
  };
  const commit = (next) => {
    if (ctx.options.set(desc.key, fromDisplay(desc, next))) ctx.changed();
  };
  let popover = null;
  const refresh = () => {
    value.textContent = `${formatDisplay(desc, display())}${desc.unit ?? ""}`;
    element.classList.toggle("cps-dim", !isOptionEnabled(desc, (k) => ctx.options.get(k)));
    popover?.sync();
  };
  label.addEventListener("pointerdown", (event) => startScrub(event, label, desc, display, commit));
  value.addEventListener("click", () => {
    if (popover) {
      popover.handle.close();
      return;
    }
    popover = openSlider(desc, ctx, value, display, commit, () => popover = null);
  });
  refresh();
  return { element, refresh };
}
function startScrub(event, label, desc, display, commit) {
  if (event.button !== 0) return;
  event.preventDefault();
  const id = event.pointerId;
  let startX = event.clientX;
  let start = display();
  let fast = event.shiftKey;
  try {
    label.setPointerCapture(id);
  } catch {
    return;
  }
  label.classList.add("cps-scrubbing");
  const controller = new AbortController();
  const move = (e) => {
    if (e.pointerId !== id) return;
    if (e.shiftKey !== fast) {
      start = display();
      startX = e.clientX;
      fast = e.shiftKey;
    }
    commit(scrubValue(desc, start, e.clientX - startX, fast));
  };
  const end = (e) => {
    if (e.pointerId !== id) return;
    controller.abort();
    label.classList.remove("cps-scrubbing");
    if (label.hasPointerCapture(id)) label.releasePointerCapture(id);
  };
  const { signal } = controller;
  label.addEventListener("pointermove", move, { signal });
  label.addEventListener("pointerup", end, { signal });
  label.addEventListener("pointercancel", end, { signal });
  label.addEventListener("lostpointercapture", end, { signal });
}
function openSlider(desc, ctx, anchor, display, commit, onClose) {
  const content = document.createElement("div");
  content.className = "cps-slider-pop";
  const range = document.createElement("input");
  range.type = "range";
  range.min = "0";
  range.max = String(SLIDER_STEPS);
  range.step = "1";
  range.className = "cps-slider";
  const field = document.createElement("input");
  field.type = "text";
  field.inputMode = "decimal";
  field.className = "cps-num-input";
  field.spellcheck = false;
  const unit = document.createElement("span");
  unit.className = "cps-num-unit";
  unit.textContent = desc.unit ?? "";
  content.append(range, field, unit);
  const sync = () => {
    const d = display();
    range.value = String(Math.round(displayToSlider(desc, d) * SLIDER_STEPS));
    if (document.activeElement !== field) field.value = formatDisplay(desc, d);
  };
  const commitField = () => {
    const parsed = Number.parseFloat(field.value.replace(",", "."));
    if (Number.isFinite(parsed)) commit(parsed);
    field.value = formatDisplay(desc, display());
  };
  range.addEventListener("input", () => commit(sliderToDisplay(desc, Number(range.value) / SLIDER_STEPS)));
  field.addEventListener("change", commitField);
  field.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    commitField();
    handle.close();
  });
  const handle = ctx.popovers.open(content, { anchor, placement: "below", className: "cps-pop-slider", onClose });
  sync();
  field.focus({ preventScroll: true });
  field.select();
  return { handle, sync };
}
function toggleControl(desc, ctx) {
  const element = document.createElement("button");
  element.type = "button";
  element.className = "cps-toggle";
  element.textContent = desc.label;
  if (desc.title) element.title = desc.title;
  element.addEventListener("click", () => {
    if (ctx.options.set(desc.key, ctx.options.get(desc.key) !== true)) ctx.changed();
  });
  const refresh = () => {
    const on = ctx.options.get(desc.key) === true;
    element.classList.toggle("cps-active", on);
    element.setAttribute("aria-pressed", String(on));
    element.classList.toggle("cps-dim", !isOptionEnabled(desc, (k) => ctx.options.get(k)));
  };
  refresh();
  return { element, refresh };
}
function buttonControl(desc, ctx) {
  const element = document.createElement("button");
  element.type = "button";
  element.className = "cps-toggle cps-command";
  element.textContent = desc.label;
  if (desc.title) element.title = desc.title;
  element.addEventListener("click", () => {
    ctx.options.set(desc.key, true);
    ctx.changed();
  });
  const refresh = () => {
    element.classList.toggle("cps-dim", ctx.options.get(desc.key) === false);
  };
  refresh();
  return { element, refresh };
}
function selectControl(desc, ctx) {
  const element = document.createElement("label");
  element.className = "cps-select";
  if (desc.title) element.title = desc.title;
  const name = document.createElement("span");
  name.className = "cps-num-label";
  name.textContent = desc.label;
  const select = document.createElement("select");
  for (const choice of desc.choices) {
    const option = document.createElement("option");
    option.value = choice.value;
    option.textContent = choice.label;
    select.appendChild(option);
  }
  select.addEventListener("change", () => {
    if (ctx.options.set(desc.key, select.value)) ctx.changed();
  });
  element.append(name, select);
  const refresh = () => {
    const v = ctx.options.get(desc.key);
    if (typeof v === "string") select.value = v;
    element.classList.toggle("cps-dim", !isOptionEnabled(desc, (k) => ctx.options.get(k)));
  };
  refresh();
  return { element, refresh };
}
let gestureCounter = 0;
function newGesture(prefix) {
  return `${prefix}:${++gestureCounter}`;
}
class LayerOpacityOptions {
  constructor(desc, target) {
    this.target = target;
    this.descriptors = [desc];
  }
  target;
  descriptors;
  gesture = newGesture("opacity");
  get(key) {
    const t = this.target();
    if (key !== "opacity" || !t) return void 0;
    return t.editor.doc.layers.find((l) => l.id === t.layerId)?.opacity;
  }
  set(key, value) {
    const t = this.target();
    if (key !== "opacity" || !t || typeof value !== "number") return false;
    return t.editor.layerOps.setOpacity(t.layerId, value, this.gesture);
  }
}
function layerOpacityControl(label, title, target, popovers) {
  const desc = { kind: "number", key: "opacity", label, title, min: 0, max: 100, step: 1, unit: "%", scale: 100 };
  const options = new LayerOpacityOptions(desc, target);
  const control = createControl(desc, { options, popovers, changed: () => control.refresh() });
  control.element.classList.add("cps-layer-opacity");
  control.element.addEventListener("pointerdown", () => options.gesture = newGesture("opacity"), { capture: true });
  return control;
}
class MaskColorPicker {
  /**
   * @param pick - Colour UI to open.
   */
  constructor(pick2) {
    this.pick = pick2;
  }
  pick;
  /**
   * Open the picker for a mask layer.
   * @param anchor - Swatch element.
   * @param target - Mask layer.
   * @param initial - Current colour.
   */
  open(anchor, target, initial) {
    const gesture = newGesture("mask-color");
    const apply = (hex) => {
      target.editor.layerOps.setMaskColor(target.layerId, hex, gesture);
    };
    this.pick(anchor, { initial, title: "Mask colour", onInput: apply, onCommit: apply });
  }
}
const BACKGROUND_ID = "\0background";
class LayersPanel {
  /**
   * @param ctx - Host services.
   */
  constructor(ctx) {
    this.ctx = ctx;
    this.element = el("div", "cps-layers");
    const header = el("div", "cps-layers-header");
    const title = el("span", "cps-layers-title");
    title.textContent = "Layers";
    this.opacity = layerOpacityControl("Opacity", "Opacity of the selected layer (drag the label to scrub)", () => this.selectedTarget(), ctx.popovers);
    header.append(title, this.opacity.element);
    this.list = el("div", "cps-layers-list");
    const footer = el("div", "cps-layers-footer");
    this.addButton = footerButton("plus", "New layer (above the active layer)", () => this.addLayer());
    this.duplicateButton = footerButton("duplicate", "Duplicate layer", () => this.withEditor((e) => e.layerOps.duplicate()));
    this.deleteButton = footerButton("trash", "Delete layer", () => this.withEditor((e) => e.layerOps.remove()));
    this.moveDrawingButton = moveDrawingBtn(() => this.ctx.toggleMoveDrawing());
    const footerDivider = document.createElement("div");
    footerDivider.className = "cps-layers-footer-divider";
    footer.append(this.moveDrawingButton, footerDivider, this.addButton, this.duplicateButton, this.deleteButton);
    this.element.append(header, this.list, footer);
    this.maskColor = new MaskColorPicker(ctx.pickColor);
    this.actions = this.rowActions();
    this.drag = new LayerDrag(
      this.list,
      (id, drop) => this.withEditor((e) => e.layerOps.move(id, drop.targetId, drop.above))
    );
    this.unbind.push(ctx.sidePanel.events.on("collapse", (collapsed) => !collapsed && this.thumbs.request()));
  }
  ctx;
  element;
  list;
  opacity;
  addButton;
  duplicateButton;
  deleteButton;
  moveDrawingButton;
  rows = /* @__PURE__ */ new Map();
  maskControls = /* @__PURE__ */ new Map();
  drag;
  thumbs = new RefreshThrottle(() => this.refreshThumbs());
  maskColor;
  actions;
  editor = null;
  unbind = [];
  editorUnbind = [];
  renaming = false;
  backgroundKeys = /* @__PURE__ */ new WeakMap();
  backgroundCounter = 0;
  /**
   * Show an editor's layers (or nothing).
   * @param editor - Editor to bind.
   */
  setEditor(editor) {
    if (editor === this.editor) {
      this.sync();
      return;
    }
    this.unbindEditor();
    this.editor = editor;
    this.renaming = false;
    for (const row of this.rows.values()) row.element.remove();
    this.rows.clear();
    this.maskControls.clear();
    if (editor) {
      this.editorUnbind = [
        editor.events.on("layers", () => this.sync()),
        editor.events.on("mask", () => this.sync()),
        editor.events.on("render", () => this.thumbs.request()),
        editor.events.on("change", () => this.thumbs.request())
      ];
    }
    this.sync();
  }
  /**
   * Sync the "Move drawing" toggle button highlight to the current mode.
   * @param active - The Move drawing tool is currently active.
   */
  setMoveDrawing(active) {
    this.moveDrawingButton.classList.toggle("cps-active", active);
    this.moveDrawingButton.setAttribute("aria-pressed", String(active));
  }
  /** Remove listeners and DOM. */
  dispose() {
    this.setEditor(null);
    for (const off of this.unbind) off();
    this.unbind = [];
    this.thumbs.dispose();
    this.drag.dispose();
    this.element.remove();
  }
  // ── Rendering ───────────────────────────────────────────────────────────
  unbindEditor() {
    for (const off of this.editorUnbind) off();
    this.editorUnbind = [];
  }
  /** Rebuild row state from the editor (rows are reused by id). */
  sync() {
    if (this.renaming) return;
    const editor = this.editor;
    const wanted = [];
    if (editor) {
      const doc = editor.doc;
      const targeting = editor.paintTarget === "mask";
      const maskId = editor.maskLayer?.id;
      for (let i = doc.layers.length - 1; i >= 0; i--) {
        const layer = doc.layers[i];
        if (!layer) continue;
        const kind = isPaintLike(layer) ? "paint" : "mask";
        const row = this.rowFor(kind, layer.id);
        const active = layer.id === doc.activeLayerId;
        const selected = kind === "mask" ? targeting && layer.id === maskId : !targeting && active;
        row.update(rowModel(layer, selected, targeting && active));
        wanted.push(row);
      }
      const bg = this.rowFor("background", BACKGROUND_ID);
      bg.update({ id: BACKGROUND_ID, name: "Background", visible: true, locked: true, selected: false, standby: false });
      wanted.push(bg);
    }
    const keep = new Set(wanted.map((r) => r.id));
    for (const [id, row] of this.rows) {
      if (keep.has(id)) continue;
      row.element.remove();
      this.rows.delete(id);
      this.maskControls.delete(id);
    }
    const current = [...this.list.children];
    if (current.length !== wanted.length || wanted.some((r, i) => current[i] !== r.element)) {
      this.list.replaceChildren(...wanted.map((r) => r.element));
    }
    for (const control of this.maskControls.values()) control.refresh();
    this.syncFooter();
    this.thumbs.request();
  }
  syncFooter() {
    const editor = this.editor;
    const target = this.selectedTarget();
    const paintId = editor && target && editor.paintTarget !== "mask" ? target.layerId : null;
    this.addButton.disabled = !editor;
    this.duplicateButton.disabled = !(editor && paintId && editor.layerOps.canDuplicate(paintId));
    this.deleteButton.disabled = !(editor && paintId && editor.layerOps.canDelete(paintId));
    this.opacity.refresh();
    this.opacity.element.classList.toggle("cps-dim", !target);
    const label = this.opacity.element.querySelector(".cps-num-label");
    if (label) label.textContent = editor?.paintTarget === "mask" ? "Overlay" : "Opacity";
  }
  rowFor(kind, id) {
    const existing = this.rows.get(id);
    if (existing && existing.kind === kind) return existing;
    existing?.element.remove();
    let maskOpacity;
    if (kind === "mask") {
      maskOpacity = layerOpacityControl("Overlay", "Mask overlay opacity (display only)", () => this.targetFor(id), this.ctx.popovers);
      this.maskControls.set(id, maskOpacity);
    }
    const row = new LayerRow(kind, id, this.actions, maskOpacity);
    this.rows.set(id, row);
    return row;
  }
  /** Redraw thumbnails whose pixels/geometry changed (throttled caller). */
  refreshThumbs() {
    const editor = this.editor;
    if (!editor || this.ctx.sidePanel.collapsed || !this.element.isConnected) return;
    const doc = editor.doc;
    const bounds = editor.bounds;
    const frame = doc.frame;
    const geometry = `${bounds.x},${bounds.y},${bounds.width},${bounds.height}|${frame.width}x${frame.height}`;
    const region = { x: -bounds.x, y: -bounds.y, width: frame.width, height: frame.height };
    for (const layer of doc.layers) {
      const row = this.rows.get(layer.id);
      if (!row) continue;
      const mask = layer.kind === "mask";
      const invert = mask && layer.invert === true;
      const key = `${editor.layerOps.revision(layer.id)}|${geometry}|${invert}`;
      row.thumb.update(key, frame, { kind: "layer", canvas: editor.layerCanvas(layer.id), region, mask, invert });
    }
    const bg = this.rows.get(BACKGROUND_ID);
    if (bg) {
      const background = editor.background;
      const size = editor.imageSize;
      const id = background.kind === "fill" ? background.color : this.backgroundId(background.image);
      bg.thumb.update(`${id}|${size.width}x${size.height}`, size, { kind: "background", background, size });
    }
  }
  backgroundId(image) {
    let id = this.backgroundKeys.get(image);
    if (id === void 0) {
      id = ++this.backgroundCounter;
      this.backgroundKeys.set(image, id);
    }
    return `img${id}`;
  }
  // ── Actions ─────────────────────────────────────────────────────────────
  rowActions() {
    return {
      select: (id) => this.withEditor((e) => {
        if (e.maskLayer?.id === id) {
          e.setPaintTarget("mask");
          return;
        }
        e.layerOps.setActiveLayer(id);
        e.setPaintTarget("paint");
      }),
      toggleVisible: (id) => this.withEditor((e) => e.layerOps.setVisible(id, !findLayer(e, id)?.visible)),
      toggleLocked: (id) => this.withEditor((e) => e.layerOps.setLocked(id, !findLayer(e, id)?.locked)),
      rename: (id, name) => this.withEditor((e) => e.layerOps.rename(id, name)),
      toggleInvert: (id) => this.withEditor((e) => e.layerOps.setMaskInvert(id, findLayer(e, id)?.invert !== true)),
      pickColor: (id, anchor) => {
        const editor = this.editor;
        const layer = editor && findLayer(editor, id);
        if (editor && layer) this.maskColor.open(anchor, { editor, layerId: id }, maskDisplayColor(layer));
      },
      renaming: (active) => {
        this.renaming = active;
        if (active) return;
        this.ctx.releaseFocus();
        this.sync();
      }
    };
  }
  addLayer() {
    this.withEditor((e) => {
      if (e.layerOps.add()) e.setPaintTarget("paint");
    });
  }
  withEditor(fn) {
    const editor = this.editor;
    if (!editor) return;
    this.ctx.beforeEdit();
    fn(editor);
  }
  /** Layer the header opacity edits: the mask in Quick Mask, else the active paint layer. */
  selectedTarget() {
    const editor = this.editor;
    if (!editor) return null;
    const id = editor.paintTarget === "mask" ? editor.maskLayer?.id : editor.doc.activeLayerId;
    return id ? this.targetFor(id) : null;
  }
  targetFor(id) {
    const editor = this.editor;
    return editor && findLayer(editor, id) ? { editor, layerId: id } : null;
  }
}
function rowModel(layer, selected, standby) {
  const model = { id: layer.id, name: layer.name, visible: layer.visible, locked: layer.locked, selected, standby };
  if (layer.kind === "mask") {
    model.color = maskDisplayColor(layer);
    model.invert = layer.invert === true;
  }
  return model;
}
function findLayer(editor, id) {
  return editor.doc.layers.find((l) => l.id === id);
}
function el(tag, className) {
  const element = document.createElement(tag);
  element.className = className;
  return element;
}
function footerButton(icon, title, onClick) {
  const button2 = el("button", "cps-icon-button cps-layers-action");
  button2.type = "button";
  button2.title = title;
  setIcon(button2, icon, 16);
  button2.addEventListener("click", onClick);
  return button2;
}
function moveDrawingBtn(onClick) {
  const button2 = el("button", "cps-icon-button cps-layers-action cps-layers-move-drawing");
  button2.type = "button";
  button2.title = "Move drawing — reposition/scale all layers against the image";
  button2.setAttribute("aria-label", "Move drawing — reposition/scale all layers against the image");
  button2.setAttribute("aria-pressed", "false");
  setIcon(button2, "moveDrawing", 16);
  button2.addEventListener("click", onClick);
  return button2;
}
function groupControl(group2, descriptors, ctx) {
  const button2 = document.createElement("button");
  button2.type = "button";
  button2.className = "cps-icon-button cps-option-group";
  button2.title = group2.title;
  button2.setAttribute("aria-haspopup", "dialog");
  button2.setAttribute("aria-expanded", "false");
  setIcon(button2, group2.icon, 18);
  let open = null;
  const refresh = () => {
    const on = isGroupActive(group2, (key) => ctx.options.get(key));
    button2.classList.toggle("cps-on", on);
    button2.title = on ? `${group2.title} (on)` : group2.title;
    for (const control of open?.controls ?? []) control.refresh();
  };
  const setOpen = (value) => {
    button2.classList.toggle("cps-active", value);
    button2.setAttribute("aria-expanded", String(value));
  };
  button2.addEventListener("click", () => {
    if (open) {
      open.handle.close();
      return;
    }
    const content = document.createElement("div");
    content.className = "cps-group-pop";
    const title = document.createElement("div");
    title.className = "cps-group-title";
    title.textContent = group2.title;
    const controls = descriptors.map((desc) => createControl(desc, ctx));
    content.append(title, ...controls.map((c) => c.element));
    const handle = ctx.popovers.open(content, {
      anchor: button2,
      placement: "below",
      className: "cps-pop-group",
      onClose: () => {
        open = null;
        setOpen(false);
      }
    });
    open = { handle, controls };
    setOpen(true);
    refresh();
  });
  refresh();
  return { element: button2, refresh };
}
class OptionsBar {
  /**
   * @param regions - Shell bar regions to render into.
   * @param popovers - Popover host (number slider popovers).
   * @param onChange - Called after the user edits an option.
   */
  constructor(regions, popovers, onChange) {
    this.regions = regions;
    this.popovers = popovers;
    this.onChange = onChange;
    this.maskBadge = document.createElement("span");
    this.maskBadge.className = "cps-mask-badge";
    this.maskBadge.textContent = "Mask";
    this.maskBadge.title = "Quick Mask: strokes paint the mask (Q to exit)";
    this.maskBadge.hidden = true;
    regions.leading.append(this.maskBadge);
  }
  regions;
  popovers;
  onChange;
  options = null;
  controls = [];
  maskBadge;
  /**
   * Show a tool's options (rebuilds controls only when the options object
   * changes, so an in-progress scrub survives refreshes).
   * @param options - Options to edit, or `null` for none.
   */
  bind(options) {
    if (options === this.options) {
      this.refresh();
      return;
    }
    this.closeOwnPopover();
    this.options = options;
    this.controls = [];
    const scroller = this.regions.scroller;
    scroller.replaceChildren();
    scroller.scrollLeft = 0;
    if (!options) return;
    const ctx = { options, popovers: this.popovers, changed: () => this.onChange() };
    for (const item of layoutOptions(options.descriptors, options.groups)) {
      if (item.kind === "separator") {
        scroller.appendChild(separator());
        continue;
      }
      const control = item.kind === "group" ? groupControl(item.group, item.descriptors, ctx) : createControl(item.desc, ctx);
      this.controls.push(control);
      scroller.appendChild(control.element);
    }
  }
  /** Re-read values from the bound options (after shortcuts changed them). */
  refresh() {
    for (const control of this.controls) control.refresh();
  }
  /**
   * Update the mask badge.
   * @param state - Current mask state.
   */
  setMask(state) {
    this.maskBadge.hidden = !state.targeting;
    this.maskBadge.style.backgroundColor = state.color;
  }
  /** Close a slider popover anchored in the bar (its control is going away). */
  closeOwnPopover() {
    this.popovers.closeAnchoredIn(this.regions.element);
  }
}
function separator() {
  const sep = document.createElement("span");
  sep.className = "cps-bar-sep";
  return sep;
}
class SelectionActions {
  /** Root element (append to the bar's leading region). */
  element;
  editor = null;
  constructor() {
    this.element = document.createElement("div");
    this.element.className = "cps-selection-actions";
    this.element.hidden = true;
    const toMask = document.createElement("button");
    toMask.type = "button";
    toMask.className = "cps-toggle";
    toMask.title = "Selection to mask: add the selection to the mask";
    setIcon(toMask, "selectionToMask", 14);
    toMask.append("To mask");
    toMask.addEventListener("click", () => this.editor?.selection.toMask());
    const invert = document.createElement("button");
    invert.type = "button";
    invert.className = "cps-toggle";
    invert.title = "Invert selection (Ctrl+Shift+I)";
    setIcon(invert, "invert", 14);
    invert.append("Invert");
    invert.addEventListener("click", () => this.editor?.selection.invert());
    this.element.append(toMask, invert);
  }
  /**
   * Follow an editor (or none) and refresh.
   * @param editor - Session editor.
   */
  setEditor(editor) {
    this.editor = editor;
    this.sync();
  }
  /** Show/hide for the current selection state. */
  sync() {
    this.element.hidden = !this.editor?.selection.active;
  }
}
const GAP = 4;
class PopoverHost {
  /**
   * @param root - Editor root (the host is appended to it).
   */
  constructor(root) {
    this.root = root;
    this.element = document.createElement("div");
    this.element.className = "cps-popover-host";
    root.appendChild(this.element);
  }
  root;
  /** Overlay element (append-only child of the editor root). */
  element;
  /** `close` fires after any popover closed. */
  events = new Emitter();
  /** Open popovers, bottom (outermost) first. */
  stack = [];
  outside = (event) => {
    const target = event.target;
    if (!(target instanceof Node)) return;
    for (let top = this.stack.at(-1); top; top = this.stack.at(-1)) {
      if (top.element.contains(target) || top.anchor.contains(target)) return;
      top.close();
    }
  };
  /** Whether a popover is open. */
  get isOpen() {
    return this.stack.length > 0;
  }
  /** The topmost open popover, if any. */
  get active() {
    return this.stack.at(-1) ?? null;
  }
  /**
   * Open `content` next to an anchor. Open popovers that do not contain the
   * anchor close first; one that does stays open underneath (nesting).
   * @param content - Popover content.
   * @param options - Anchor, placement, close callback.
   * @returns Handle of the new popover.
   */
  open(content, options) {
    for (let top = this.stack.at(-1); top && !top.element.contains(options.anchor); top = this.stack.at(-1)) {
      top.close();
    }
    const element = document.createElement("div");
    element.className = `cps-popover${options.className ? ` ${options.className}` : ""}`;
    element.appendChild(content);
    element.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      handle.close();
    });
    this.element.appendChild(element);
    let closed = false;
    const handle = {
      element,
      anchor: options.anchor,
      close: () => {
        if (closed) return;
        closed = true;
        const index = this.stack.indexOf(handle);
        while (index >= 0 && this.stack.length > index + 1) this.stack.at(-1)?.close();
        if (index >= 0) this.stack.splice(index, 1);
        element.remove();
        if (this.stack.length === 0) window.removeEventListener("pointerdown", this.outside, true);
        options.onClose?.();
        this.events.emit("close", void 0);
      },
      reposition: () => {
        if (options.anchor.isConnected) this.position(element, options.anchor, options.placement ?? "below");
        else handle.close();
      }
    };
    this.stack.push(handle);
    window.addEventListener("pointerdown", this.outside, true);
    handle.reposition();
    return handle;
  }
  /** Close every open popover. @returns `true` if one was open. */
  close() {
    const bottom = this.stack[0];
    if (!bottom) return false;
    bottom.close();
    return true;
  }
  /**
   * Close the open popovers anchored inside `container` (and their children).
   * @param container - E.g. the options bar whose controls are being rebuilt.
   */
  closeAnchoredIn(container) {
    const handle = this.stack.find((h) => container.contains(h.anchor));
    handle?.close();
  }
  /** Close and remove the layer. */
  dispose() {
    this.close();
    this.events.clear();
    this.element.remove();
  }
  // ── Positioning ─────────────────────────────────────────────────────────
  position(element, anchor, placement) {
    const rootRect = this.root.getBoundingClientRect();
    const scale = this.root.offsetWidth > 0 && rootRect.width > 0 ? rootRect.width / this.root.offsetWidth : 1;
    const a = anchor.getBoundingClientRect();
    const ox = rootRect.left + this.root.clientLeft * scale;
    const oy = rootRect.top + this.root.clientTop * scale;
    const box = {
      left: (a.left - ox) / scale,
      top: (a.top - oy) / scale,
      right: (a.right - ox) / scale,
      bottom: (a.bottom - oy) / scale
    };
    const w = element.offsetWidth;
    const h = element.offsetHeight;
    const rootW = this.root.clientWidth;
    const rootH = this.root.clientHeight;
    let left;
    let top;
    if (placement === "right") {
      left = box.right + GAP;
      top = box.top;
      if (left + w > rootW) left = box.left - GAP - w;
    } else {
      left = box.left;
      top = placement === "above" ? box.top - GAP - h : box.bottom + GAP;
      if (placement === "below" && top + h > rootH) top = box.top - GAP - h;
      if (placement === "above" && top < 0) top = box.bottom + GAP;
    }
    element.style.left = `${Math.round(clamp(left, 0, rootW - w))}px`;
    element.style.top = `${Math.round(clamp(top, 0, rootH - h))}px`;
  }
}
function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(Math.max(lo, hi), v));
}
const NARROW_EDITOR_WIDTH = 520;
const INITIAL_PANEL_STATE = { sizeClass: null, userCollapsed: null };
function sizeClassOf(width) {
  return width < NARROW_EDITOR_WIDTH ? "narrow" : "wide";
}
function isPanelCollapsed(state) {
  if (state.userCollapsed !== null) return state.userCollapsed;
  return state.sizeClass !== "wide";
}
function panelResized(state, width) {
  if (!(width > 0)) return state;
  const sizeClass = sizeClassOf(width);
  if (sizeClass === state.sizeClass) return state;
  return { sizeClass, userCollapsed: null };
}
function panelSetByUser(state, collapsed) {
  return { sizeClass: state.sizeClass, userCollapsed: collapsed };
}
class SidePanel {
  /** Panel element (a region of the shell body). */
  element;
  /** Mount point for panel content (placeholder "Layers" until M3.3). */
  content;
  events = new Emitter();
  state = INITIAL_PANEL_STATE;
  shown;
  constructor() {
    this.element = document.createElement("div");
    this.element.className = "cps-side";
    this.content = document.createElement("div");
    this.content.className = "cps-side-content";
    const placeholder = document.createElement("div");
    placeholder.className = "cps-side-placeholder";
    placeholder.textContent = "Layers";
    this.content.appendChild(placeholder);
    this.element.appendChild(this.content);
    this.shown = !isPanelCollapsed(this.state);
    this.apply();
  }
  /** Whether the panel is collapsed. */
  get collapsed() {
    return !this.shown;
  }
  /**
   * Collapse or expand (counts as an explicit choice until the editor
   * changes size class).
   * @param collapsed - New state.
   */
  setCollapsed(collapsed) {
    this.update(panelSetByUser(this.state, collapsed));
  }
  /**
   * Current collapse state, for {@link SidePanel.restore} (fullscreen saves
   * it on enter and restores it on exit).
   * @returns Immutable state snapshot.
   */
  snapshot() {
    return this.state;
  }
  /**
   * Restore a {@link SidePanel.snapshot}. Its size class is the one the
   * editor returns to, so the following resize keeps it.
   * @param state - Snapshot.
   */
  restore(state) {
    this.update(state);
  }
  /** Flip the collapsed state (the bar's panel button). */
  toggle() {
    this.setCollapsed(!this.collapsed);
  }
  /**
   * Editor root width changed (from the shell's ResizeObserver).
   * @param width - Root width, CSS px.
   */
  handleWidth(width) {
    this.update(panelResized(this.state, width));
  }
  update(next) {
    this.state = next;
    const shown = !isPanelCollapsed(next);
    if (shown === this.shown) return;
    this.shown = shown;
    this.apply();
    this.events.emit("collapse", !shown);
  }
  apply() {
    this.element.hidden = !this.shown;
  }
}
class EditorShell {
  /** Editor root (child of the DOM widget element; re-parented for fullscreen). */
  root;
  rail;
  bar;
  /** Canvas stage. */
  stage;
  sidePanel;
  popoverHost;
  events = new Emitter();
  panelButton;
  resizeObserver;
  nativeInput = null;
  nativeApply = null;
  constructor() {
    this.root = div("cps-root");
    this.rail = { element: div("cps-rail"), tools: div("cps-rail-tools"), swatchSlot: div("cps-rail-swatches") };
    this.rail.element.append(this.rail.tools, this.rail.swatchSlot);
    this.bar = {
      element: div("cps-bar"),
      leading: div("cps-bar-leading"),
      scroller: div("cps-bar-scroller"),
      trailing: div("cps-bar-trailing")
    };
    this.panelButton = document.createElement("button");
    this.panelButton.type = "button";
    this.panelButton.className = "cps-icon-button";
    setIcon(this.panelButton, "panel", 18);
    this.panelButton.addEventListener("click", () => this.sidePanel.toggle());
    this.bar.trailing.appendChild(this.panelButton);
    this.bar.element.append(this.bar.leading, this.bar.scroller, this.bar.trailing);
    this.stage = div("cps-stage");
    this.stage.tabIndex = -1;
    this.sidePanel = new SidePanel();
    const body = div("cps-body");
    body.append(this.stage, this.sidePanel.element);
    const main = div("cps-main");
    main.append(this.bar.element, body);
    this.root.append(this.rail.element, main);
    this.popoverHost = new PopoverHost(this.root);
    this.sidePanel.events.on("collapse", () => this.syncPanelButton());
    this.syncPanelButton();
    this.resizeObserver = new ResizeObserver(() => this.sidePanel.handleWidth(this.root.clientWidth));
    this.resizeObserver.observe(this.root);
  }
  /**
   * Ask for a colour picker for a swatch: emits `pick-color`; if no listener
   * handles it, falls back to the native colour input.
   * @param slot - Foreground or background.
   * @param anchor - Swatch element.
   * @param current - Current colour (`#rrggbb`).
   * @param apply - Called with each picked colour.
   */
  requestColorPick(slot, anchor, current, apply) {
    const request = { slot, anchor, handled: false };
    this.events.emit("pick-color", request);
    if (!request.handled) this.nativeColorPick(current, apply);
  }
  /**
   * Horizontal scroll for wheel over the options bar (vertical wheels scroll
   * it sideways). Called by the event isolation guard for non-stage wheels.
   * @param event - Wheel event (propagation already stopped).
   */
  handleChromeWheel(event) {
    const target = event.target;
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      return;
    }
    if (!(target instanceof Node) || !this.bar.element.contains(target)) return;
    event.preventDefault();
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? this.bar.scroller.clientWidth : 1;
    const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
    this.bar.scroller.scrollLeft += delta * unit;
  }
  /** Disconnect observers and close popovers. */
  dispose() {
    this.resizeObserver.disconnect();
    this.popoverHost.dispose();
    this.events.clear();
    this.sidePanel.events.clear();
  }
  // ── Internals ───────────────────────────────────────────────────────────
  syncPanelButton() {
    const open = !this.sidePanel.collapsed;
    this.panelButton.classList.toggle("cps-active", open);
    this.panelButton.setAttribute("aria-pressed", String(open));
    this.panelButton.title = open ? "Hide layers panel" : "Show layers panel";
  }
  /** Fallback picker until M3.2: a hidden native `<input type=color>`. */
  nativeColorPick(current, apply) {
    let input = this.nativeInput;
    if (!input) {
      const created = document.createElement("input");
      created.type = "color";
      created.className = "cps-native-color";
      created.tabIndex = -1;
      created.addEventListener("input", () => this.nativeApply?.(created.value));
      created.addEventListener("change", () => this.nativeApply?.(created.value));
      this.popoverHost.element.appendChild(created);
      this.nativeInput = input = created;
    }
    this.nativeApply = apply;
    input.value = current;
    if (typeof input.showPicker === "function") {
      try {
        input.showPicker();
        return;
      } catch {
      }
    }
    input.click();
  }
}
function div(className) {
  const element = document.createElement("div");
  element.className = className;
  return element;
}
function handleSelectionShortcut(event, editor, cancelDrag) {
  const ctrl = event.ctrlKey || event.metaKey;
  const alt = event.altKey;
  const shift = event.shiftKey;
  const key = event.key.toLowerCase();
  const sel = editor.selection;
  if (key === "backspace" || key === "delete") {
    if (event.repeat) return true;
    if (key === "backspace" && alt && !ctrl) return run$1(cancelDrag, () => sel.fillSelected(editor.colors.fg));
    if (key === "backspace" && ctrl && !alt) return run$1(cancelDrag, () => sel.fillSelected(editor.colors.bg));
    if (!ctrl && !alt && sel.active) return run$1(cancelDrag, () => sel.clearSelected());
    return !ctrl && !alt;
  }
  if (ctrl && !alt) {
    if (key === "a" && !shift) return run$1(cancelDrag, () => sel.selectAll());
    if (key === "d" && !shift) return run$1(cancelDrag, () => sel.deselect());
    if (key === "i" && shift) return run$1(cancelDrag, () => sel.invert());
    return false;
  }
  if (key === "f7" && shift && !alt) return run$1(cancelDrag, () => sel.invert());
  return false;
}
function run$1(cancelDrag, action) {
  cancelDrag();
  action();
  return true;
}
function handleShortcut(event, session, effects) {
  const { editor, tools } = session;
  const ctrl = event.ctrlKey || event.metaKey;
  const key = event.key.toLowerCase();
  if (key === "escape" && !ctrl && !event.altKey) {
    return (effects.cancelToolDrag?.() ?? false) || effects.closePopover() || effects.exitFullscreen();
  }
  if (handleSelectionShortcut(event, editor, () => effects.cancelDrag())) return true;
  if (ctrl && !event.altKey) {
    if (key === "z" && !event.shiftKey) return run(() => editor.undo());
    if (key === "z" && event.shiftKey || key === "y" && !event.shiftKey) return run(() => editor.redo());
    if (key === "0" || event.code === "Digit0") return run(() => (editor.view.fit(), effects.viewChanged()));
    if (key === "1" || event.code === "Digit1") return run(() => (editor.view.actualPixels(), effects.viewChanged()));
    if (key === "=" || key === "+") return run(() => (editor.view.zoomBy(1.25), effects.viewChanged()));
    if (key === "-" || key === "_") return run(() => (editor.view.zoomBy(0.8), effects.viewChanged()));
    return false;
  }
  if (event.altKey || ctrl) return false;
  if (tools.active.onKey?.(editor, event)) return true;
  const options = tools.active.options;
  if (event.code === "BracketLeft" || event.code === "BracketRight" || key === "[" || key === "]") {
    const up = event.code === "BracketRight" || key === "]" || key === "}";
    const changed = event.shiftKey ? stepOption(options, "hardness", (v) => stepHardness(v, up)) : stepOption(options, "size", (v) => stepSize(v, up));
    if (changed === null) return false;
    if (changed) effects.optionsChanged();
    return true;
  }
  const digit = /^Digit([0-9])$/.exec(event.code)?.[1] ?? (/^[0-9]$/.test(key) ? key : null);
  if (digit !== null && !event.shiftKey) {
    const changed = stepOption(options, "opacity", () => digit === "0" ? 1 : Number(digit) / 10);
    if (changed === null) return false;
    if (changed) effects.optionsChanged();
    return true;
  }
  if (event.shiftKey && key.length === 1) {
    const next = tools.cycleShortcut(key);
    if (!next) return false;
    effects.cancelDrag();
    tools.setActive(next.id);
    return true;
  }
  if (key.length !== 1) return false;
  switch (key) {
    case "q":
      effects.cancelDrag();
      editor.togglePaintTarget();
      return true;
    case "x":
      editor.colors.swap();
      return true;
    case "d":
      editor.colors.reset();
      return true;
    case "f":
      effects.fullscreen();
      return true;
  }
  const tool = tools.byShortcut(key);
  if (!tool) return false;
  if (tool.id !== tools.active.id) {
    effects.cancelDrag();
    tools.setActive(tool.id);
  }
  return true;
}
function run(action) {
  action();
  return true;
}
function stepOption(options, key, next) {
  const value = options?.get(key);
  if (!options || typeof value !== "number") return null;
  return options.set(key, next(value));
}
function stepSize(size, up) {
  const step = size < 10 ? 1 : size < 50 ? 5 : size < 100 ? 10 : size < 300 ? 25 : 50;
  const next = up ? size + step : size - (size <= 10 ? 1 : size <= 50 ? 5 : size <= 100 ? 10 : size <= 300 ? 25 : 50);
  return Math.min(1e3, Math.max(1, Math.round(next)));
}
function stepHardness(hardness, up) {
  const next = Math.round((hardness + (up ? 0.25 : -0.25)) * 4) / 4;
  return Math.min(1, Math.max(0, next));
}
const MODIFIER_KEYS = /* @__PURE__ */ new Set(["Shift", "Alt", "Control", "Meta"]);
class DragModifierWatch {
  /**
   * @param onChange - Called with the new state after a modifier key goes down or up.
   */
  constructor(onChange) {
    this.onChange = onChange;
  }
  onChange;
  listening = false;
  handle = (event) => {
    if (!MODIFIER_KEYS.has(event.key) || event.repeat) return;
    if (event.key === "Alt") event.preventDefault();
    this.onChange({ shiftKey: event.shiftKey, altKey: event.altKey, ctrlKey: event.ctrlKey, metaKey: event.metaKey });
  };
  /** Start listening (idempotent). */
  start() {
    if (this.listening) return;
    this.listening = true;
    window.addEventListener("keydown", this.handle, true);
    window.addEventListener("keyup", this.handle, true);
  }
  /** Stop listening (idempotent). */
  stop() {
    if (!this.listening) return;
    this.listening = false;
    window.removeEventListener("keydown", this.handle, true);
    window.removeEventListener("keyup", this.handle, true);
  }
}
class StageInput {
  /**
   * @param stage - Stage element.
   * @param host - Host callbacks.
   */
  constructor(stage, host) {
    this.stage = stage;
    this.host = host;
    const { signal } = this.controller;
    stage.addEventListener("pointerdown", (e) => this.handlePointer(e), { signal });
    stage.addEventListener("pointermove", (e) => this.handlePointer(e), { signal });
    stage.addEventListener("pointerup", (e) => this.handlePointer(e), { signal });
    stage.addEventListener("pointercancel", (e) => this.handlePointer(e), { signal });
    stage.addEventListener("lostpointercapture", (e) => this.handleLostCapture(e), { signal });
    stage.addEventListener("pointerleave", () => this.setHover(null), { signal });
  }
  stage;
  host;
  drag = null;
  controller = new AbortController();
  /** Last pointer event of the tool drag (re-sent when modifiers change). */
  lastToolEvent = null;
  /** Last hover position in stage CSS px (overlay redraws without pointer movement). */
  lastHover = null;
  modifierWatch = new DragModifierWatch((mods) => this.modifiersChanged(mods));
  /**
   * The tool locked at pointer-down for the current drag, or `null` when no
   * tool drag is in progress. Used by the stage overlay to show the correct
   * cursor/ring during modifier changes (e.g. Alt held mid-drag must not
   * switch the overlay to the eyedropper).
   * @returns The locked tool, or `null`.
   */
  get activeTool() {
    return this.drag?.kind === "tool" ? this.drag.tool : null;
  }
  /**
   * Wheel over the stage (already stopped by the isolation guard): zoom
   * around the cursor -- or, during a drag of a tool with `onWheel` (Move:
   * scale), hand it to the tool instead.
   * @param event - Wheel event.
   */
  handleWheel(event) {
    const session = this.host.session();
    if (!session) return;
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? this.stage.clientHeight : 1;
    const delta = (Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX) * unit;
    const drag = this.drag;
    if (drag?.kind === "tool" && drag.tool.onWheel) {
      drag.tool.onWheel(session.editor, delta, this.wheelSample(event, session));
      return;
    }
    session.editor.view.wheelZoom(delta, this.toStage(event));
    this.host.viewChanged();
  }
  /**
   * Any pointer event for the stage (also called by the isolation guard for
   * middle-button events).
   * @param event - Pointer event.
   */
  handlePointer(event) {
    switch (event.type) {
      case "pointerdown":
        this.down(event);
        break;
      case "pointermove":
        this.move(event);
        break;
      case "pointerup":
        this.up(event, false);
        break;
      case "pointercancel":
        this.up(event, true);
        break;
    }
  }
  /** Abort any drag in progress and a pending multi-press tool interaction (tool switch, detach). */
  cancel() {
    const drag = this.drag;
    this.drag = null;
    this.endToolDrag();
    const session = this.host.session();
    if (session) {
      if (drag?.kind === "tool") drag.tool.onCancel(session.editor);
      const active = session.tools.active;
      if (active !== (drag?.kind === "tool" ? drag.tool : null) && active.pending?.()) active.onCancel(session.editor);
    }
    this.host.setDragging(false);
  }
  /**
   * Esc: abort a tool drag in progress (e.g. a shape) or a pending
   * polygonal lasso; pans are unaffected.
   * @returns `true` if something was cancelled.
   */
  cancelToolDrag() {
    if (this.drag?.kind !== "tool" && !this.pendingTool()) return false;
    this.cancel();
    this.host.setHover(this.lastHover);
    return true;
  }
  /** Remove listeners. */
  dispose() {
    this.cancel();
    this.controller.abort();
  }
  // ── Internals ───────────────────────────────────────────────────────────
  down(event) {
    const session = this.host.session();
    if (!session || this.drag) return;
    const pan = event.button === 1 || event.button === 0 && this.host.isSpaceDown();
    if (!pan && event.button !== 0) return;
    event.preventDefault();
    this.capture(event.pointerId);
    this.host.setDragging(true);
    if (pan) {
      this.drag = { kind: "pan", pointerId: event.pointerId, last: this.toStage(event) };
      this.stage.classList.add("cps-panning");
      return;
    }
    this.host.setShift?.(event.shiftKey);
    this.host.setAlt?.(event.altKey);
    const tool = session.tools.resolve(event.altKey);
    this.drag = { kind: "tool", pointerId: event.pointerId, tool };
    this.lastToolEvent = event;
    this.modifierWatch.start();
    tool.onPointerDown(session.editor, this.samples(event, session));
    this.setHover(this.toStage(event));
  }
  move(event) {
    const point = this.toStage(event);
    this.host.setShift?.(event.shiftKey);
    this.host.setAlt?.(event.altKey);
    const drag = this.drag;
    const session = this.host.session();
    const pending = !drag && session ? this.pendingTool() : null;
    if (pending && session) {
      this.lastToolEvent = event;
      pending.onHover?.(session.editor, this.sample(event, session));
      this.settleWatch();
    }
    this.setHover(point);
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.stopPropagation();
    if (!session) return;
    if (drag.kind === "pan") {
      session.editor.view.pan(point.x - drag.last.x, point.y - drag.last.y);
      drag.last = point;
      this.host.viewChanged();
      return;
    }
    this.lastToolEvent = event;
    drag.tool.onPointerMove(session.editor, this.samples(event, session));
  }
  /** Shift/Alt/Ctrl changed mid-drag: re-send the last position with the new modifiers. */
  modifiersChanged(mods) {
    const drag = this.drag;
    const last = this.lastToolEvent;
    const session = this.host.session();
    if (!last || !session) return;
    if (drag?.kind === "tool") {
      drag.tool.onPointerMove(session.editor, [this.sample(last, session, mods)]);
    } else {
      const pending = drag ? null : this.pendingTool();
      pending?.onHover?.(session.editor, this.sample(last, session, mods));
      this.settleWatch();
    }
    this.setHover(this.toStage(last));
  }
  endToolDrag() {
    this.modifierWatch.stop();
    this.lastToolEvent = null;
  }
  /** The active tool when it waits for another press ({@link Tool.pending}), else `null`. */
  pendingTool() {
    const tool = this.host.session()?.tools.active;
    return tool?.pending?.() ? tool : null;
  }
  /** Between presses: keep watching modifiers only while a tool interaction is pending. */
  settleWatch() {
    if (this.drag) return;
    if (this.pendingTool()) this.modifierWatch.start();
    else this.endToolDrag();
  }
  setHover(point) {
    this.lastHover = point;
    this.host.setHover(point);
  }
  up(event, cancelled) {
    const drag = this.drag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    this.drag = null;
    this.stage.classList.remove("cps-panning");
    this.release(event.pointerId);
    this.host.setDragging(false);
    const session = this.host.session();
    if (drag.kind === "tool" && session) {
      const tool = drag.tool;
      if (cancelled) tool.onCancel(session.editor);
      else tool.onPointerUp(session.editor, this.samples(event, session)[0] ?? this.sample(event, session));
    }
    this.settleWatch();
    if (drag.kind !== "tool") return;
    if (event.type !== "lostpointercapture") this.setHover(this.toStage(event));
  }
  handleLostCapture(event) {
    if (this.drag?.pointerId === event.pointerId) this.up(event, false);
  }
  samples(event, session) {
    const coalesced = typeof event.getCoalescedEvents === "function" ? event.getCoalescedEvents() : [];
    const list = coalesced.length ? coalesced : [event];
    return list.map((e) => this.sample(e, session, event));
  }
  sample(e, session, modifiers = e) {
    const { editor } = session;
    const doc = imageToDoc(editor.frameMap, stageToDoc(editor.view.current, this.toStage(e)));
    return {
      x: doc.x,
      y: doc.y,
      pressure: normalizePressure(e.pointerType, e.pressure),
      pointerType: e.pointerType,
      shiftKey: modifiers.shiftKey,
      altKey: modifiers.altKey,
      ctrlKey: modifiers.ctrlKey || modifiers.metaKey
    };
  }
  /** A wheel event as a tool sample (document coords, full pressure). */
  wheelSample(e, session) {
    const { editor } = session;
    const doc = imageToDoc(editor.frameMap, stageToDoc(editor.view.current, this.toStage(e)));
    const ctrlKey = e.ctrlKey || e.metaKey;
    return { x: doc.x, y: doc.y, pressure: 1, pointerType: "mouse", shiftKey: e.shiftKey, altKey: e.altKey, ctrlKey };
  }
  toStage(e) {
    const rect = this.stage.getBoundingClientRect();
    const sx = rect.width > 0 ? this.stage.clientWidth / rect.width : 1;
    const sy = rect.height > 0 ? this.stage.clientHeight / rect.height : 1;
    return { x: (e.clientX - rect.left) * sx, y: (e.clientY - rect.top) * sy };
  }
  capture(pointerId) {
    try {
      this.stage.setPointerCapture(pointerId);
    } catch {
    }
  }
  release(pointerId) {
    if (this.stage.hasPointerCapture(pointerId)) this.stage.releasePointerCapture(pointerId);
  }
}
const STAGE_STYLE = {
  surround: "#1e1e1e",
  checkerLight: "#cfcfcf",
  checkerDark: "#a8a8a8",
  checkerCell: 8,
  offFrameVeil: "rgba(30, 30, 30, 0.55)",
  frameOutline: "rgba(255, 255, 255, 0.55)",
  frameShadow: "rgba(0, 0, 0, 0.6)"
};
const checkerPatterns = /* @__PURE__ */ new WeakMap();
function composite(input) {
  const { ctx, pixelRatio: pr, view, imageSize, map, bounds } = input;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  ctx.fillStyle = STAGE_STYLE.surround;
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  const imageRect = frameRect(imageSize);
  const paintRect = docRectToImage(map, bounds);
  const frameScreen = scaleRect(docRectToStage(view, imageRect), pr);
  const boundsScreen = scaleRect(docRectToStage(view, paintRect), pr);
  const pattern = checkerPattern(ctx);
  if (pattern) {
    ctx.fillStyle = pattern;
    ctx.fillRect(frameScreen.x, frameScreen.y, frameScreen.width, frameScreen.height);
  }
  const k = view.scale * pr;
  ctx.setTransform(k, 0, 0, k, view.offsetX * pr, view.offsetY * pr);
  ctx.imageSmoothingEnabled = k < 2;
  ctx.imageSmoothingQuality = "high";
  if (input.background.kind === "image") {
    ctx.drawImage(input.background.image, 0, 0, imageSize.width, imageSize.height);
  } else {
    ctx.fillStyle = input.background.color;
    ctx.fillRect(0, 0, imageSize.width, imageSize.height);
  }
  const placed = layerPlacement(map, bounds);
  const resampled = placed.width !== bounds.width || placed.height !== bounds.height;
  if (resampled) ctx.imageSmoothingEnabled = true;
  for (const layer of input.layers) {
    if (layer.opacity <= 0) continue;
    ctx.globalAlpha = layer.opacity;
    ctx.drawImage(layer.source, placed.x, placed.y, placed.width, placed.height);
  }
  for (const mask of input.masks) {
    if (mask.opacity <= 0) continue;
    ctx.globalAlpha = mask.opacity;
    ctx.drawImage(mask.tint, placed.x, placed.y, placed.width, placed.height);
    if (mask.invert) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, imageSize.width, imageSize.height);
      ctx.clip();
      ctx.fillStyle = mask.color;
      ctx.beginPath();
      ctx.rect(0, 0, imageSize.width, imageSize.height);
      ctx.rect(placed.x, placed.y, placed.width, placed.height);
      ctx.fill("evenodd");
      ctx.restore();
    }
  }
  ctx.globalAlpha = 1;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const extends_ = !containsRect(inflateRect(imageRect, EPSILON), paintRect);
  if (extends_) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(boundsScreen.x, boundsScreen.y, boundsScreen.width, boundsScreen.height);
    ctx.clip();
    ctx.fillStyle = STAGE_STYLE.offFrameVeil;
    ctx.beginPath();
    ctx.rect(0, 0, ctx.canvas.width, ctx.canvas.height);
    ctx.rect(frameScreen.x, frameScreen.y, frameScreen.width, frameScreen.height);
    ctx.fill("evenodd");
    ctx.restore();
  }
  const lw = Math.max(1, Math.round(pr));
  ctx.lineWidth = lw;
  ctx.strokeStyle = extends_ ? STAGE_STYLE.frameOutline : STAGE_STYLE.frameShadow;
  ctx.strokeRect(frameScreen.x - lw / 2, frameScreen.y - lw / 2, frameScreen.width + lw, frameScreen.height + lw);
}
const EPSILON = 1e-6;
function inflateRect(r, d) {
  return { x: r.x - d, y: r.y - d, width: r.width + d * 2, height: r.height + d * 2 };
}
function scaleRect(r, k) {
  return { x: r.x * k, y: r.y * k, width: r.width * k, height: r.height * k };
}
function checkerPattern(ctx) {
  const cached = checkerPatterns.get(ctx);
  if (cached) return cached;
  const cell = STAGE_STYLE.checkerCell;
  const tile = document.createElement("canvas");
  tile.width = tile.height = cell * 2;
  const t = tile.getContext("2d");
  if (!t) return null;
  t.fillStyle = STAGE_STYLE.checkerLight;
  t.fillRect(0, 0, cell * 2, cell * 2);
  t.fillStyle = STAGE_STYLE.checkerDark;
  t.fillRect(cell, 0, cell, cell);
  t.fillRect(0, cell, cell, cell);
  const pattern = ctx.createPattern(tile, "repeat");
  if (pattern) checkerPatterns.set(ctx, pattern);
  return pattern;
}
const ICON_SIZE = 24;
const OUTLINE_WIDTH = 4;
const ICON_WIDTH = 1.75;
const OUTLINE_COLOR = "#111";
const ICON_COLOR = "#fff";
const HOTSPOTS = {
  eyedropper: [3, 21],
  bucket: [19, 20]
};
const cache = /* @__PURE__ */ new Map();
function iconCursor(icon) {
  if (icon === "crosshair") return "crosshair";
  if (icon === "move") return "move";
  const cached = cache.get(icon);
  if (cached) return cached;
  const d = iconPath(icon);
  const [x, y] = HOTSPOTS[icon];
  const pathAttrs = `fill='none' stroke-linecap='round' stroke-linejoin='round'`;
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='${ICON_SIZE}' height='${ICON_SIZE}' viewBox='0 0 ${ICON_SIZE} ${ICON_SIZE}'><path ${pathAttrs} stroke='${OUTLINE_COLOR}' stroke-width='${OUTLINE_WIDTH}' d='${d}'/><path ${pathAttrs} stroke='${ICON_COLOR}' stroke-width='${ICON_WIDTH}' d='${d}'/></svg>`;
  const value = `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${x} ${y}, crosshair`;
  cache.set(icon, value);
  return value;
}
function cssCursor(cursor, badge = null) {
  if (badge && cursor.kind === "icon" && cursor.icon === "crosshair") return badgeCursor(badge);
  return cursor.kind === "ring" ? "crosshair" : iconCursor(cursor.icon);
}
function cursorBadge(state) {
  if (!state.combinesSelection || !state.hasSelection) return null;
  const mode = selectionMode(state.shift, state.alt);
  return mode === "replace" ? null : mode;
}
const BADGE_CURSOR_SIZE = 32;
const BADGE_HOTSPOT = 11;
const BADGE_GLYPHS = {
  add: "M20 24h8M24 20v8",
  subtract: "M20 24h8",
  intersect: "M21 21l6 6M27 21l-6 6"
};
const badgeCache = /* @__PURE__ */ new Map();
function badgeCursor(badge) {
  const cached = badgeCache.get(badge);
  if (cached) return cached;
  const s = BADGE_CURSOR_SIZE;
  const c = BADGE_HOTSPOT + 0.5;
  const cross = `M${c} 1v21M1 ${c}h21`;
  const glyph = BADGE_GLYPHS[badge];
  const attrs = `fill='none' stroke-linecap='square'`;
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='${s}' height='${s}' viewBox='0 0 ${s} ${s}'><path ${attrs} stroke='${OUTLINE_COLOR}' stroke-width='3' d='${cross}'/><path ${attrs} stroke='${ICON_COLOR}' stroke-width='1' d='${cross}'/><path ${attrs} stroke='${OUTLINE_COLOR}' stroke-width='4' d='${glyph}'/><path ${attrs} stroke='${ICON_COLOR}' stroke-width='2' d='${glyph}'/></svg>`;
  const value = `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${BADGE_HOTSPOT} ${BADGE_HOTSPOT}, crosshair`;
  badgeCache.set(badge, value);
  return value;
}
const OUTER = 34;
const INNER = 22;
function drawLoupe(ctx, x, y, pr, overlay) {
  const outer = OUTER * pr;
  const inner = INNER * pr;
  const half = (from, to, color) => {
    ctx.beginPath();
    ctx.arc(x, y, outer, from, to);
    ctx.arc(x, y, inner, to, from, true);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
  };
  ctx.save();
  half(Math.PI, Math.PI * 2, overlay.color);
  half(0, Math.PI, overlay.previous);
  ctx.lineWidth = Math.max(1, pr);
  ctx.strokeStyle = "rgba(128, 128, 128, 0.9)";
  for (const r of [outer, inner]) {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}
const STEP_MS = 125;
const DASH = 4;
class MarchingAnts {
  /**
   * @param requestDraw - Ask for an overlay redraw (should do nothing while the stage is hidden).
   */
  constructor(requestDraw) {
    this.requestDraw = requestDraw;
  }
  requestDraw;
  phase = 0;
  timer = null;
  docPath = null;
  stagePath = null;
  /**
   * Draw the selection outline and an optional in-progress shape.
   * @param ctx - Overlay context (backing px, identity transform).
   * @param editor - Editor.
   * @param view - Image -> stage transform.
   * @param pr - Backing px per CSS px.
   * @param preview - In-progress tool outline (document coords), or `null`.
   */
  draw(ctx, editor, view, pr, preview) {
    const matrix = docToBacking(editor, view, pr);
    const current = this.selectionPath(editor);
    if (current) this.stroke(ctx, this.toStage(current, matrix), pr);
    if (preview) this.stroke(ctx, transformed(shapePath(preview), matrix), pr);
    if (current || preview) this.schedule();
  }
  /** Stop the animation. */
  dispose() {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.docPath = null;
    this.stagePath = null;
  }
  // ── Internals ───────────────────────────────────────────────────────────
  schedule() {
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.phase = (this.phase + 1) % (DASH * 2);
      this.requestDraw();
    }, STEP_MS);
  }
  stroke(ctx, path, pr) {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.lineWidth = Math.max(1, pr);
    ctx.strokeStyle = "#ffffff";
    ctx.setLineDash([]);
    ctx.stroke(path);
    ctx.strokeStyle = "#000000";
    ctx.setLineDash([DASH * pr, DASH * pr]);
    ctx.lineDashOffset = -this.phase * pr;
    ctx.stroke(path);
    ctx.restore();
  }
  /** Document-space path of the current selection (rebuilt per selection change). */
  selectionPath(editor) {
    const contours = editor.selection.outline();
    if (!contours || contours.length === 0) {
      this.docPath = null;
      return null;
    }
    const cached = this.docPath;
    if (cached && cached.contours === contours) return cached.path;
    const path = new Path2D();
    for (const c of contours) {
      path.moveTo(c[0], c[1]);
      for (let i = 2; i + 1 < c.length; i += 2) path.lineTo(c[i], c[i + 1]);
      path.closePath();
    }
    this.docPath = { contours, path };
    return path;
  }
  /** Stage-space copy of the selection path (rebuilt when the transform changes). */
  toStage(source, matrix) {
    const key = `${matrix.a},${matrix.d},${matrix.e},${matrix.f}`;
    const cached = this.stagePath;
    if (cached && cached.source === source && cached.key === key) return cached.path;
    const path = transformed(source, matrix);
    this.stagePath = { key, source, path };
    return path;
  }
}
function docToBacking(editor, view, pr) {
  const map = editor.frameMap;
  const o = docToImage(map, { x: 0, y: 0 });
  const u = docToImage(map, { x: 1, y: 1 });
  const k = view.scale * pr;
  return new DOMMatrix([k * (u.x - o.x), 0, 0, k * (u.y - o.y), (view.offsetX + view.scale * o.x) * pr, (view.offsetY + view.scale * o.y) * pr]);
}
function transformed(source, matrix) {
  const path = new Path2D();
  path.addPath(source, matrix);
  return path;
}
function shapePath(shape) {
  const path = new Path2D();
  if (shape.kind === "rect") {
    path.rect(shape.rect.x, shape.rect.y, shape.rect.width, shape.rect.height);
  } else if (shape.kind === "ellipse") {
    const { x, y, width, height } = shape.rect;
    path.ellipse(x + width / 2, y + height / 2, width / 2, height / 2, 0, 0, Math.PI * 2);
  } else {
    shape.points.forEach((p, i) => i === 0 ? path.moveTo(p.x, p.y) : path.lineTo(p.x, p.y));
    if (shape.closed) path.closePath();
  }
  return path;
}
const NOTE_MS = 5e3;
class StageView {
  /**
   * @param stage - Stage element (canvases are appended to it).
   * @param session - Current session lookup.
   * @param getDragTool - Returns the tool locked at pointer-down during an
   *   active drag, or `null` when no drag is in progress. Used by the overlay
   *   so that Alt held mid-drag does not switch the ring/loupe to the
   *   eyedropper -- the tool is fixed for the duration of the drag.
   */
  constructor(stage, session, getDragTool = () => null) {
    this.stage = stage;
    this.session = session;
    this.getDragTool = getDragTool;
    this.canvas = document.createElement("canvas");
    this.canvas.className = "cps-canvas";
    this.ctx = this.canvas.getContext("2d");
    this.overlay = document.createElement("canvas");
    this.overlay.className = "cps-canvas cps-overlay";
    this.overlayCtx = this.overlay.getContext("2d");
    this.note = document.createElement("div");
    this.note.className = "cps-note";
    this.note.hidden = true;
    stage.append(this.canvas, this.overlay, this.note);
  }
  stage;
  session;
  getDragTool;
  canvas;
  ctx;
  overlay;
  overlayCtx;
  note;
  frameRequest = 0;
  overlayRequest = 0;
  pixelRatio = 1;
  noteTimer = null;
  disposed = false;
  /** Last value written to `--cps-tool-cursor`. */
  cursorValue = "";
  /** Selection outline animation (redraws only while the stage is visible). */
  ants = new MarchingAnts(() => {
    if (this.isVisible()) this.requestOverlay();
  });
  /** Pointer hover position, stage CSS px (`null` = outside). */
  hover = null;
  /** Alt held: the cursor is that of `tools.resolve(true)` (temporary eyedropper). */
  altDown = false;
  /** Shift held (selection-mode cursor badge). */
  shiftDown = false;
  /** Selection-mode badge on the cursor (kept fixed during a drag). */
  badge = null;
  /** Whether the stage is attached and has a non-zero layout size. */
  isVisible() {
    return this.stage.isConnected && this.stage.clientWidth > 0 && this.stage.clientHeight > 0;
  }
  /** Schedule a redraw on the next animation frame (coalesced). */
  requestRender() {
    if (this.disposed || this.frameRequest) return;
    this.frameRequest = requestAnimationFrame(() => {
      this.frameRequest = 0;
      this.render();
    });
  }
  /** Redraw synchronously, replacing any scheduled frame. */
  renderNow() {
    if (this.disposed) return;
    if (this.frameRequest) cancelAnimationFrame(this.frameRequest);
    this.frameRequest = 0;
    this.render();
  }
  /** Schedule an overlay-only redraw (cheap). */
  requestOverlay() {
    if (this.disposed || this.overlayRequest) return;
    this.overlayRequest = requestAnimationFrame(() => {
      this.overlayRequest = 0;
      this.drawOverlay();
    });
  }
  /**
   * Show a transient note at the bottom of the stage.
   * @param text - Note text.
   */
  showNote(text) {
    this.note.textContent = text;
    this.note.hidden = false;
    if (this.noteTimer !== null) clearTimeout(this.noteTimer);
    this.noteTimer = setTimeout(() => {
      this.note.hidden = true;
      this.noteTimer = null;
    }, NOTE_MS);
  }
  /** Push stage size + graph zoom into the view (re-fits in fit mode). */
  syncView() {
    const session = this.session();
    if (!session || !this.isVisible()) return;
    session.editor.view.setStage(this.stageSize(), this.displayScale());
  }
  /** @returns `true` if the backing store size changed. */
  syncBackingStore() {
    const css = this.stageSize();
    if (css.width <= 0 || css.height <= 0) return false;
    const size = backingStoreSize(css, window.devicePixelRatio, this.displayScale());
    this.pixelRatio = size.ratio;
    this.syncView();
    if (this.canvas.width === size.width && this.canvas.height === size.height) return false;
    this.canvas.width = this.overlay.width = size.width;
    this.canvas.height = this.overlay.height = size.height;
    this.requestOverlay();
    return true;
  }
  /**
   * Apply the CSS cursor of the tool in effect now: the tool locked at
   * pointer-down during a drag (Alt mid-drag changes nothing), else
   * `tools.resolve(altDown)` (Alt = temporary eyedropper). Synchronous, so
   * Alt down/up updates the cursor without pointer movement. Selection tools
   * with a selection add the Shift/Alt mode badge (`cursors.ts`). Written to the
   * `--cps-tool-cursor` property so the pan/loading class cursors still win.
   * @returns The tool in effect, or `null` without a session.
   */
  syncCursor() {
    const session = this.session();
    const dragTool = this.getDragTool();
    const tool = session ? dragTool ?? session.tools.resolve(this.altDown) : null;
    const locked = dragTool !== null || (tool?.pending?.() ?? false);
    if (!locked) {
      this.badge = cursorBadge({
        combinesSelection: tool?.combinesSelection ?? false,
        hasSelection: session?.editor.selection.active ?? false,
        shift: this.shiftDown,
        alt: this.altDown
      });
    }
    const value = tool ? cssCursor(tool.cursor(), this.badge) : "crosshair";
    if (value !== this.cursorValue) {
      this.cursorValue = value;
      this.stage.style.setProperty("--cps-tool-cursor", value);
    }
    return tool;
  }
  /** Cancel frames and release canvases. Idempotent. */
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.frameRequest) cancelAnimationFrame(this.frameRequest);
    if (this.overlayRequest) cancelAnimationFrame(this.overlayRequest);
    if (this.noteTimer !== null) clearTimeout(this.noteTimer);
    this.ants.dispose();
    this.canvas.width = this.canvas.height = 0;
    this.overlay.width = this.overlay.height = 0;
  }
  // ── Internals ───────────────────────────────────────────────────────────
  stageSize() {
    return { width: this.stage.clientWidth, height: this.stage.clientHeight };
  }
  displayScale() {
    const rect = this.stage.getBoundingClientRect();
    return this.stage.clientWidth > 0 && rect.width > 0 ? rect.width / this.stage.clientWidth : 1;
  }
  render() {
    const session = this.session();
    if (!this.ctx || !session || !this.isVisible()) return;
    this.syncBackingStore();
    const { editor } = session;
    composite({
      ctx: this.ctx,
      cssSize: this.stageSize(),
      pixelRatio: this.pixelRatio,
      view: editor.view.current,
      imageSize: editor.imageSize,
      map: editor.frameMap,
      bounds: editor.bounds,
      background: editor.background,
      layers: editor.compositeLayers(),
      masks: editor.maskOverlays()
    });
    this.stage.classList.toggle("cps-loading", editor.loading);
    this.drawOverlay();
  }
  /**
   * Tool overlay (loupe) or brush-size ring at the hover position (separate
   * canvas). During an active drag the tool is the one locked at pointer-down
   * (getDragTool), so Alt held mid-drag does not flip the overlay to the
   * eyedropper.
   */
  drawOverlay() {
    const ctx = this.overlayCtx;
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.overlay.width, this.overlay.height);
    const session = this.session();
    const tool = this.syncCursor();
    const hover = this.hover;
    const pr = this.pixelRatio;
    const overlay = tool?.overlay?.() ?? null;
    if (session) this.ants.draw(ctx, session.editor, session.editor.view.current, pr, overlay?.kind === "selection" ? overlay.shape : null);
    const panning = this.stage.classList.contains("cps-panning") || this.stage.classList.contains("cps-pan-ready");
    if (!session || !tool || !hover || panning) return;
    if (overlay?.kind === "loupe") {
      drawLoupe(ctx, hover.x * pr, hover.y * pr, pr, overlay);
      return;
    }
    const cursor = tool.cursor();
    if (cursor.kind !== "ring") return;
    const radius = Math.max(1, cursor.diameter * session.editor.view.current.scale * pr / 2);
    ctx.lineWidth = Math.max(1, pr);
    ctx.beginPath();
    ctx.arc(hover.x * pr, hover.y * pr, radius, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(0, 0, 0, 0.8)";
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(hover.x * pr, hover.y * pr, radius + ctx.lineWidth, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(255, 255, 255, 0.8)";
    ctx.stroke();
  }
}
class SwatchWidget {
  element;
  fg;
  bg;
  /**
   * @param actions - Click handlers.
   */
  constructor(actions) {
    this.element = document.createElement("div");
    this.element.className = "cps-swatches";
    this.bg = swatch("cps-swatch cps-swatch-bg", "Background color (X swaps)", () => actions.pick("bg", this.bg));
    this.fg = swatch("cps-swatch cps-swatch-fg", "Foreground color (X swaps)", () => actions.pick("fg", this.fg));
    const swap = swatch("cps-swatch-swap", "Swap colors (X)", () => actions.swap());
    setIcon(swap, "swap", 11);
    const reset = swatch("cps-swatch-reset", "Default colors (D)", () => actions.reset());
    reset.innerHTML = '<span class="cps-reset-bg"></span><span class="cps-reset-fg"></span>';
    this.element.append(this.bg, this.fg, swap, reset);
  }
  /**
   * Show colours.
   * @param colors - Current FG/BG.
   */
  setColors(colors) {
    this.fg.style.backgroundColor = colors.fg;
    this.bg.style.backgroundColor = colors.bg;
    this.fg.dataset["color"] = colors.fg;
    this.bg.dataset["color"] = colors.bg;
  }
  /**
   * Anchor element of a swatch (for pickers opened programmatically).
   * @param slot - Which swatch.
   * @returns The square's element.
   */
  anchor(slot) {
    return slot === "fg" ? this.fg : this.bg;
  }
}
function swatch(className, title, onClick) {
  const button2 = document.createElement("button");
  button2.type = "button";
  button2.className = className;
  button2.title = title;
  button2.setAttribute("aria-label", title);
  button2.addEventListener("click", onClick);
  return button2;
}
const LONG_PRESS_MS = 400;
class ToolGroupSlot {
  /**
   * @param options - Group, members, popover host, select callback.
   */
  constructor(options) {
    this.options = options;
    this.currentId = options.tools[0]?.id ?? "";
    const button2 = document.createElement("button");
    button2.type = "button";
    button2.className = "cps-rail-button cps-rail-grouped";
    button2.dataset["group"] = options.group.id;
    const key = options.tools[0]?.shortcut.toUpperCase() ?? "";
    const title = key ? `${options.group.label} (${key}, Shift+${key} cycles)` : options.group.label;
    button2.title = title;
    button2.setAttribute("aria-label", title);
    button2.setAttribute("aria-haspopup", "menu");
    button2.addEventListener("click", () => this.handleClick());
    button2.addEventListener("pointerdown", (e) => this.startPress(e));
    button2.addEventListener("pointerup", () => this.endPress());
    button2.addEventListener("pointerleave", () => this.endPress());
    button2.addEventListener("pointercancel", () => this.endPress());
    button2.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      this.endPress();
      this.openFlyout();
    });
    this.element = button2;
    this.render();
  }
  options;
  element;
  currentId;
  activeId = "";
  pressTimer = null;
  suppressClick = false;
  flyout = null;
  /** Group id. */
  get groupId() {
    return this.options.group.id;
  }
  /**
   * Show a member as the group's current tool (the slot icon).
   * @param toolId - Member id (others are ignored).
   */
  setCurrent(toolId) {
    if (!this.options.tools.some((t) => t.id === toolId) || toolId === this.currentId) return;
    this.currentId = toolId;
    this.render();
  }
  /**
   * Highlight when the active tool is a member (it also becomes current).
   * @param activeId - Active tool id.
   */
  setActive(activeId) {
    this.activeId = activeId;
    this.setCurrent(activeId);
    const on = this.options.tools.some((t) => t.id === activeId);
    this.element.classList.toggle("cps-active", on);
    this.element.setAttribute("aria-pressed", String(on));
  }
  /** Close the flyout and stop timers. */
  dispose() {
    this.endPress();
    this.flyout?.close();
  }
  // ── Internals ───────────────────────────────────────────────────────────
  render() {
    const tool = this.options.tools.find((t) => t.id === this.currentId);
    setIcon(this.element, tool?.icon ?? "");
    const corner = document.createElement("span");
    corner.className = "cps-rail-corner";
    this.element.appendChild(corner);
  }
  handleClick() {
    if (this.suppressClick) {
      this.suppressClick = false;
      return;
    }
    this.flyout?.close();
    this.options.select(this.currentId);
  }
  startPress(event) {
    this.suppressClick = false;
    if (event.button !== 0) return;
    this.endPress();
    this.pressTimer = setTimeout(() => {
      this.pressTimer = null;
      this.suppressClick = true;
      this.openFlyout();
    }, LONG_PRESS_MS);
  }
  endPress() {
    if (this.pressTimer !== null) clearTimeout(this.pressTimer);
    this.pressTimer = null;
  }
  openFlyout() {
    if (this.flyout) return;
    const menu = document.createElement("div");
    menu.className = "cps-tool-flyout";
    menu.setAttribute("role", "menu");
    for (const tool of this.options.tools) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "cps-tool-flyout-item";
      item.setAttribute("role", "menuitem");
      item.classList.toggle("cps-active", tool.id === this.activeId);
      setIcon(item, tool.icon, 18);
      const label = document.createElement("span");
      label.textContent = tool.label;
      const key = document.createElement("span");
      key.className = "cps-tool-flyout-key";
      key.textContent = tool.shortcut.toUpperCase();
      item.append(label, key);
      item.addEventListener("click", () => {
        this.flyout?.close();
        this.options.select(tool.id);
      });
      menu.appendChild(item);
    }
    this.flyout = this.options.popovers.open(menu, {
      anchor: this.element,
      placement: "right",
      onClose: () => {
        this.flyout = null;
      }
    });
  }
}
class ToolRail {
  /**
   * @param container - Shell region to render into.
   * @param actions - Button handlers.
   * @param popovers - Popover host (tool group flyouts).
   */
  constructor(container, actions, popovers) {
    this.actions = actions;
    this.popovers = popovers;
    this.toolBox = group();
    this.quickMaskButton = railButton("quickMask", "Quick Mask (Q)", () => this.actions.toggleQuickMask());
    this.quickMaskButton.classList.add("cps-rail-quickmask");
    this.quickMaskButton.setAttribute("aria-pressed", "false");
    const maskGroup = group();
    maskGroup.appendChild(this.quickMaskButton);
    const spacer = document.createElement("div");
    spacer.className = "cps-rail-spacer";
    this.undoButton = railButton("undo", "Undo (Ctrl+Z)", () => this.actions.undo());
    this.redoButton = railButton("redo", "Redo (Ctrl+Shift+Z)", () => this.actions.redo());
    this.fullscreenButton = railButton("fullscreen", "Fullscreen (F)", () => this.actions.fullscreen());
    this.fullscreenButton.setAttribute("aria-pressed", "false");
    const actionGroup = group();
    actionGroup.append(
      this.undoButton,
      this.redoButton,
      railButton("fit", "Fit to view (Ctrl+0)", () => this.actions.fit()),
      railButton("clear", "Clear canvas", () => this.actions.clear()),
      this.fullscreenButton
    );
    container.append(this.toolBox, maskGroup, spacer, actionGroup);
  }
  actions;
  popovers;
  toolButtons = /* @__PURE__ */ new Map();
  toolBox;
  undoButton;
  redoButton;
  quickMaskButton;
  fullscreenButton;
  toolIds = "";
  groupSlots = [];
  /**
   * Show the Quick Mask state (highlighted while strokes go to the mask).
   * @param on - Mask is the paint target.
   * @param color - Mask display colour (tints the highlighted icon).
   */
  setQuickMask(on, color) {
    this.quickMaskButton.classList.toggle("cps-active", on);
    this.quickMaskButton.setAttribute("aria-pressed", String(on));
    this.quickMaskButton.style.color = on ? color : "";
  }
  /**
   * Rebuild tool buttons from registry metadata (skipped when unchanged).
   * Tools in a group get one shared {@link ToolGroupSlot}.
   * @param tools - Tools in order.
   * @param activeId - Active tool id.
   * @param groups - Tool groups (last-used member per group).
   */
  setTools(tools, activeId, groups) {
    const ids = tools.map((t) => t.id).join(",");
    if (ids !== this.toolIds) {
      this.toolIds = ids;
      this.toolBox.replaceChildren();
      this.toolButtons.clear();
      for (const slot of this.groupSlots) slot.dispose();
      this.groupSlots = [];
      for (const tool of tools) {
        const spec = groups?.groupOf(tool.id);
        if (spec) {
          if (this.groupSlots.some((s) => s.groupId === spec.id)) continue;
          const members = spec.toolIds.flatMap((id) => tools.filter((t) => t.id === id));
          const slot = new ToolGroupSlot({ group: spec, tools: members, popovers: this.popovers, select: (id) => this.actions.selectTool(id) });
          this.groupSlots.push(slot);
          this.toolBox.appendChild(slot.element);
          continue;
        }
        const title = tool.shortcut ? `${tool.label} (${tool.shortcut.toUpperCase()})` : tool.label;
        const button2 = railButton(tool.icon, title, () => this.actions.selectTool(tool.id));
        button2.dataset["tool"] = tool.id;
        this.toolButtons.set(tool.id, button2);
        this.toolBox.appendChild(button2);
      }
    }
    for (const slot of this.groupSlots) {
      const current = groups?.currentOf(slot.groupId);
      if (current) slot.setCurrent(current);
    }
    this.setActive(activeId);
  }
  /**
   * Highlight the active tool (a group slot also switches to it).
   * @param activeId - Tool id.
   */
  setActive(activeId) {
    for (const [id, button2] of this.toolButtons) {
      button2.classList.toggle("cps-active", id === activeId);
      button2.setAttribute("aria-pressed", String(id === activeId));
    }
    for (const slot of this.groupSlots) slot.setActive(activeId);
  }
  /**
   * Enable/disable undo and redo.
   * @param canUndo - Undo available.
   * @param canRedo - Redo available.
   */
  setHistory(canUndo, canRedo) {
    this.undoButton.disabled = !canUndo;
    this.redoButton.disabled = !canRedo;
  }
  /**
   * Show the fullscreen state (the same button exits).
   * @param on - Editor is fullscreen.
   */
  setFullscreen(on) {
    const title = on ? "Exit fullscreen (F / Esc)" : "Fullscreen (F)";
    this.fullscreenButton.classList.toggle("cps-active", on);
    this.fullscreenButton.setAttribute("aria-pressed", String(on));
    this.fullscreenButton.title = title;
    this.fullscreenButton.setAttribute("aria-label", title);
    setIcon(this.fullscreenButton, on ? "exitFullscreen" : "fullscreen");
  }
}
function group() {
  const element = document.createElement("div");
  element.className = "cps-rail-group";
  return element;
}
function railButton(icon, title, onClick) {
  const button2 = document.createElement("button");
  button2.type = "button";
  button2.className = "cps-rail-button";
  button2.title = title;
  button2.setAttribute("aria-label", title);
  button2.addEventListener("click", onClick);
  setIcon(button2, icon);
  return button2;
}
class EditorHost {
  /**
   * @param events - Owner callbacks.
   */
  constructor(events = {}) {
    this.events = events;
    this.shell = new EditorShell();
    this.root = this.shell.root;
    this.stage = this.shell.stage;
    this.fullscreen = new FullscreenMount(this.root, {
      beforeChange: () => {
        this.input.cancel();
        this.shell.popoverHost.close();
      },
      onChange: (open) => this.fullscreenChanged(open),
      isDetached: () => this.events.isDetached?.() ?? false
    });
    this.element = this.fullscreen.container;
    this.view = new StageView(this.stage, () => this.session, () => this.input?.activeTool ?? null);
    this.rail = new ToolRail(this.shell.rail.tools, {
      selectTool: (id) => {
        this.input.cancel();
        this.session?.tools.setActive(id);
      },
      toggleQuickMask: () => {
        this.input.cancel();
        this.session?.editor.togglePaintTarget();
      },
      undo: () => this.session?.editor.undo(),
      redo: () => this.session?.editor.redo(),
      fit: () => {
        this.session?.editor.view.fit();
        this.view.requestRender();
      },
      clear: () => this.confirmClear(),
      fullscreen: () => this.shell.events.emit("fullscreen", void 0)
    }, this.shell.popoverHost);
    this.swatches = new SwatchWidget({
      pick: (slot, anchor) => {
        const colors = this.session?.editor.colors;
        if (colors) this.shell.requestColorPick(slot, anchor, colors[slot], (hex) => colors.set(slot, hex));
      },
      swap: () => this.session?.editor.colors.swap(),
      reset: () => this.session?.editor.colors.reset()
    });
    this.shell.rail.swatchSlot.appendChild(this.swatches.element);
    this.optionsBar = new OptionsBar(this.shell.bar, this.shell.popoverHost, () => this.optionsChanged());
    this.shell.bar.leading.append(this.selectionActions.element);
    this.layers = new LayersPanel({
      sidePanel: this.shell.sidePanel,
      popovers: this.shell.popoverHost,
      pickColor: (anchor, options) => openColorPicker(this.shell.popoverHost, anchor, options),
      beforeEdit: () => this.input.cancel(),
      releaseFocus: () => this.keyboard.reclaimFocus(),
      toggleMoveDrawing: () => this.toggleMoveDrawing()
    });
    this.shell.sidePanel.content.replaceChildren(this.layers.element);
    this.shell.events.on("pick-color", (request) => {
      const colors = this.session?.editor.colors;
      if (!colors) return;
      const slot = request.slot;
      request.handled = true;
      openColorPicker(this.shell.popoverHost, request.anchor, {
        initial: colors[slot],
        title: slot === "fg" ? "Foreground" : "Background",
        onInput: (hex) => colors.set(slot, hex),
        onCommit: (hex) => colors.set(slot, hex)
      });
    });
    this.input = new StageInput(this.stage, {
      session: () => this.session,
      isSpaceDown: () => this.keyboard.isSpaceDown,
      setDragging: (dragging) => this.keyboard.setHeld(dragging),
      setHover: (point) => {
        this.view.hover = point;
        this.view.requestOverlay();
      },
      setAlt: (down) => this.setAlt(down),
      setShift: (down) => this.setShift(down),
      viewChanged: () => this.view.requestRender()
    });
    this.keyboard = new KeyboardScope(this.root, {
      onKeyDown: (event) => this.session ? handleShortcut(event, this.session, {
        optionsChanged: () => this.optionsChanged(),
        viewChanged: () => this.view.requestRender(),
        cancelDrag: () => this.input.cancel(),
        cancelToolDrag: () => this.input.cancelToolDrag(),
        fullscreen: () => this.shell.events.emit("fullscreen", void 0),
        closePopover: () => this.shell.popoverHost.close(),
        exitFullscreen: () => {
          if (!this.fullscreen.isOpen) return false;
          this.fullscreen.exit();
          return true;
        }
      }) : false,
      onSpaceChange: (down) => this.stage.classList.toggle("cps-pan-ready", down),
      onAltChange: (down) => this.setAlt(down),
      onShiftChange: (down) => this.setShift(down),
      onSave: () => this.events.onSave?.(),
      onDeactivate: () => this.events.onDisengage?.()
    });
    this.shell.popoverHost.events.on("close", () => this.keyboard.reclaimFocus());
    this.shell.events.on("fullscreen", () => this.fullscreen.toggle());
    this.resizeObserver = new ResizeObserver(() => this.handleResize());
    this.resizeObserver.observe(this.stage);
  }
  events;
  /** Layout regions + extension seams (side panel, popovers, events). */
  shell;
  /** Element handed to `addDOMWidget`; never moves (holds `root`). */
  element;
  /** Editor root (= `shell.root`); moves into the fullscreen overlay. */
  root;
  /** Canvas area. */
  stage;
  /** Pointer/wheel router (the isolation guard forwards to it). */
  input;
  view;
  rail;
  optionsBar;
  swatches;
  layers;
  /** "Selection to mask" (options bar, while a selection exists). */
  selectionActions = new SelectionActions();
  keyboard;
  resizeObserver;
  fullscreen;
  restoreState = null;
  session = null;
  unbind = [];
  wasVisible = false;
  disposed = false;
  /** Last rail-tool id before switching to Move drawing (restored on toggle-off). */
  prevRailToolId = null;
  // ── Public API ──────────────────────────────────────────────────────────
  /** Session currently shown (M3.2/M3.3 read its editor and tools). */
  get current() {
    return this.session;
  }
  /**
   * Show a session (or nothing).
   * @param session - Session to bind.
   */
  setSession(session) {
    if (session === this.session) return;
    this.input.cancel();
    this.shell.popoverHost.close();
    for (const off of this.unbind) off();
    this.unbind = [];
    this.session = session;
    this.layers.setEditor(session?.editor ?? null);
    this.selectionActions.setEditor(session?.editor ?? null);
    if (session) {
      const { editor, tools } = session;
      this.unbind.push(
        editor.events.on("render", () => this.view.requestRender()),
        editor.events.on("history", () => this.syncHistory()),
        editor.events.on("note", (text) => this.view.showNote(text)),
        editor.events.on("mask", () => this.syncMask()),
        editor.events.on("change", () => this.syncMask()),
        // Move tool: live X / Y / Scale fields.
        editor.events.on("placement", () => this.optionsBar.refresh()),
        // Selection: marching ants + "To mask" button.
        editor.events.on("selection", () => (this.selectionActions.sync(), this.view.requestOverlay())),
        editor.colors.events.on("change", (colors) => this.swatches.setColors(colors)),
        tools.events.on("change", () => this.syncTools())
      );
      this.swatches.setColors(editor.colors.current);
      this.syncTools();
      this.syncMask();
      this.syncHistory();
      this.view.syncView();
    }
    this.view.requestRender();
  }
  /**
   * Re-check the on-screen scale (graph zoom changes don't trigger
   * ResizeObserver) and redraw if the backing store would change.
   */
  refreshScale() {
    if (this.view.syncBackingStore()) this.view.requestRender();
  }
  /** Whether the stage is attached and has a non-zero layout size. */
  isVisible() {
    return this.view.isVisible();
  }
  /** Schedule a redraw on the next animation frame (coalesced). */
  requestRender() {
    this.view.requestRender();
  }
  /**
   * Wheel over the editor outside the stage (rail, bar, side panel,
   * popovers); propagation is already stopped by the isolation guard.
   * @param event - Wheel event.
   */
  handleChromeWheel(event) {
    this.shell.handleChromeWheel(event);
  }
  /** Whether the editor is fullscreen. */
  get isFullscreen() {
    return this.fullscreen.isOpen;
  }
  /** Leave fullscreen if open (the root returns to {@link EditorHost.element}). */
  exitFullscreen() {
    this.fullscreen.exit();
  }
  /**
   * Tear down listeners and canvases (exits fullscreen first) and empty
   * {@link EditorHost.element}. The element itself stays where it is: the
   * owner removes it or hands its slot to a successor. Idempotent.
   */
  dispose() {
    if (this.disposed) return;
    this.fullscreen.dispose();
    this.setSession(null);
    this.disposed = true;
    this.resizeObserver.disconnect();
    this.input.dispose();
    this.keyboard.dispose();
    this.layers.dispose();
    this.view.dispose();
    this.shell.dispose();
    this.root.remove();
  }
  // ── Sync ────────────────────────────────────────────────────────────────
  syncTools() {
    const session = this.session;
    if (!session) return;
    if (session.tools.active.rail !== false && session.tools.active.id !== "move") {
      this.prevRailToolId = null;
    }
    this.rail.setTools(session.tools.railTools(), session.tools.active.id, session.tools.groups);
    this.optionsBar.bind(session.tools.active.options);
    this.syncMoveMode();
    this.view.syncCursor();
    this.view.requestOverlay();
  }
  /** Sync the "Move drawing" button to the current active tool. */
  syncMoveMode() {
    const active = this.session?.tools.active;
    this.layers.setMoveDrawing(active?.id === "move");
  }
  /**
   * Toggle "Move drawing" mode: activate the Move tool (saving the previous
   * rail tool) or deactivate it (returning to the previous rail tool).
   */
  toggleMoveDrawing() {
    const session = this.session;
    if (!session) return;
    const { tools } = session;
    this.input.cancel();
    if (tools.active.id === "move") {
      const prev = (this.prevRailToolId && tools.get(this.prevRailToolId)) ?? tools.railTools()[0];
      if (prev) {
        this.prevRailToolId = null;
        tools.setActive(prev.id);
      }
    } else {
      if (tools.active.rail !== false) this.prevRailToolId = tools.active.id;
      tools.setActive("move");
    }
  }
  /** Quick Mask button and "Mask" badge (the eye lives in the layers panel). */
  syncMask() {
    const editor = this.session?.editor;
    if (!editor) return;
    const mask = editor.maskLayer;
    const color = mask ? maskDisplayColor(mask) : DEFAULT_MASK_COLOR;
    const targeting = editor.paintTarget === "mask";
    this.rail.setQuickMask(targeting, color);
    this.root.classList.toggle("cps-quickmask", targeting);
    this.optionsBar.setMask({ targeting, color });
  }
  syncHistory() {
    const editor = this.session?.editor;
    this.rail.setHistory(editor?.canUndo ?? false, editor?.canRedo ?? false);
  }
  /** Alt held (keyboard or pointer modifier): the cursor follows `ToolRegistry.resolve`. */
  setAlt(down) {
    if (this.view.altDown === down) return;
    this.view.altDown = down;
    this.view.syncCursor();
    this.view.requestOverlay();
  }
  /** Shift held (keyboard or pointer modifier): selection-mode cursor badge. */
  setShift(down) {
    if (this.view.shiftDown === down) return;
    this.view.shiftDown = down;
    this.view.syncCursor();
  }
  optionsChanged() {
    this.optionsBar.refresh();
    this.session?.tools.notifyOptions();
    this.view.requestOverlay();
  }
  /** Clear button: confirm, then one undoable Clear (SPEC Behavior Notes). */
  confirmClear() {
    const editor = this.session?.editor;
    if (!editor || editor.loading) return;
    if (!window.confirm("Clear all paint? This can be undone.")) return;
    this.input.cancel();
    editor.clear();
  }
  // ── Fullscreen ──────────────────────────────────────────────────────────
  /** Root just moved into (`open`) or out of the overlay. */
  fullscreenChanged(open) {
    const panel = this.shell.sidePanel;
    const view = this.session?.editor.view;
    this.rail.setFullscreen(open);
    this.root.classList.toggle("cps-is-fullscreen", open);
    this.keyboard.setCaptureScope(open ? this.fullscreen.overlayElement : null);
    if (open) {
      this.restoreState = { panel: panel.snapshot(), fitting: view?.isFitting ?? true };
      panel.setCollapsed(false);
      view?.fit();
    } else {
      const saved = this.restoreState;
      this.restoreState = null;
      if (saved) panel.restore(saved.panel);
      if (saved?.fitting) view?.fit();
      this.events.onDisengage?.();
    }
    this.handleResize();
  }
  // ── Sizing ──────────────────────────────────────────────────────────────
  handleResize() {
    const visible = this.isVisible();
    if (visible && !this.wasVisible) this.events.onBecameVisible?.();
    this.wasVisible = visible;
    if (this.view.syncBackingStore()) this.view.renderNow();
    else this.view.requestRender();
  }
}
function chooseForManifest(live) {
  if (!live) return "restore";
  if (live.owner === "other") return live.matchesRecent ? "fork-copy" : "fork-restore";
  if (live.handedOff || live.matchesRecent) return "reuse";
  return "restore";
}
function chooseForEmpty(status, facts) {
  if (status === "invalid") return "reset";
  if (facts.handoff) return "adopt";
  return facts.hasPaint ? "reset" : "keep";
}
const SAVE_WORKFLOW_COMMAND = "Comfy.SaveWorkflow";
function readSetting(id) {
  const setting = app.extensionManager?.setting;
  if (typeof setting?.get === "function") return setting.get(id);
  return app.ui?.settings?.getSettingValue?.(id);
}
async function executeCommand(id) {
  const command = app.extensionManager?.command;
  if (typeof command?.execute !== "function") throw new Error("command API unavailable");
  await command.execute(id);
}
const ROOT_STOPPED = [
  "pointerdown",
  "pointerup",
  "pointercancel",
  "mousedown",
  "mouseup",
  "dblclick",
  "contextmenu"
];
const GUARDED_POINTER = ["pointerdown", "pointermove", "pointerup", "pointercancel"];
function isolateEvents(options) {
  const { root, stage, onWheel, onChromeWheel, onMiddlePointer } = options;
  const controller = new AbortController();
  const { signal } = controller;
  const stop = (event) => event.stopPropagation();
  for (const type of ROOT_STOPPED) root.addEventListener(type, stop, { signal });
  stage.addEventListener("auxclick", (e) => e.preventDefault(), { signal });
  root.dataset["captureWheel"] = "true";
  let hovering = false;
  let middleDrag = false;
  let armed = false;
  const inStage = (target) => target instanceof Node && stage.contains(target);
  const inRoot = (target) => target instanceof Node && root.contains(target);
  const wheelGuard = (event) => {
    if (!inRoot(event.target)) return;
    event.stopPropagation();
    if (!inStage(event.target)) {
      onChromeWheel(event);
      return;
    }
    event.preventDefault();
    onWheel(event);
  };
  const pointerGuard = (event) => {
    const middle = event.button === 1 || (event.buttons & 4) !== 0;
    if (event.type === "pointerdown" && middle && inStage(event.target)) middleDrag = true;
    if (!middleDrag) return;
    event.preventDefault();
    event.stopPropagation();
    onMiddlePointer(event);
    if (event.type === "pointerup" || event.type === "pointercancel") {
      if (!(event.buttons & 4)) middleDrag = false;
      sync();
    }
  };
  const sync = () => {
    const want = hovering || middleDrag;
    if (want === armed) return;
    armed = want;
    if (want) {
      window.addEventListener("wheel", wheelGuard, { capture: true, passive: false });
      for (const type of GUARDED_POINTER) window.addEventListener(type, pointerGuard, { capture: true });
    } else {
      window.removeEventListener("wheel", wheelGuard, { capture: true });
      for (const type of GUARDED_POINTER) window.removeEventListener(type, pointerGuard, { capture: true });
    }
  };
  const enter = () => {
    hovering = true;
    sync();
  };
  root.addEventListener("pointerenter", enter, { signal });
  root.addEventListener("pointermove", enter, { signal });
  root.addEventListener(
    "pointerleave",
    () => {
      hovering = false;
      sync();
    },
    { signal }
  );
  return {
    dispose() {
      controller.abort();
      hovering = false;
      middleDrag = false;
      sync();
    }
  };
}
const FALLBACK_DEFAULTS = {
  width: 1024,
  height: 1024,
  color: "#ffffff"
};
const MIN_FRAME_SIDE = 64;
const MAX_FRAME_SIDE = 8192;
const FRAME_SIDE_STEP = 8;
function normalizeHexColor(value, fallback = FALLBACK_DEFAULTS.color) {
  if (typeof value !== "string") return fallback;
  const hex = value.trim().replace(/^#/, "").toLowerCase();
  if (!/^[0-9a-f]+$/.test(hex)) return fallback;
  if (hex.length === 3 || hex.length === 4) {
    return `#${[...hex.slice(0, 3)].map((c) => c + c).join("")}`;
  }
  if (hex.length === 6 || hex.length === 8) return `#${hex.slice(0, 6)}`;
  return fallback;
}
function sanitizeDimension(value, fallback) {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(MAX_FRAME_SIDE, Math.max(MIN_FRAME_SIDE, Math.round(n)));
}
function resolveFallbackFrame(width, height, color) {
  return {
    size: {
      width: sanitizeDimension(width, FALLBACK_DEFAULTS.width),
      height: sanitizeDimension(height, FALLBACK_DEFAULTS.height)
    },
    color: normalizeHexColor(color)
  };
}
function widgetDimension(side) {
  const snapped = Math.round(side / FRAME_SIDE_STEP) * FRAME_SIDE_STEP;
  return Math.min(MAX_FRAME_SIDE, Math.max(MIN_FRAME_SIDE, snapped));
}
const offers = /* @__PURE__ */ new Map();
function handoffKey(node) {
  const graph = node.graph;
  if (!graph) return null;
  return `${graph.isRootGraph === false ? graph.id : "root"}:${String(node.id)}`;
}
function offerHandoff(key, handoff) {
  offers.get(key)?.element.remove();
  offers.set(key, handoff);
  queueMicrotask(() => {
    if (offers.get(key) !== handoff) return;
    offers.delete(key);
    handoff.element.remove();
  });
}
function takeHandoff(key) {
  const handoff = offers.get(key);
  offers.delete(key);
  return handoff;
}
const FOLDER_TYPES = /* @__PURE__ */ new Set(["input", "output", "temp"]);
function parseAnnotatedFilename(value, defaultType = "input") {
  if (typeof value !== "string") return null;
  let path = value.trim();
  if (!path) return null;
  let type = defaultType;
  const annotation = /\s*\[([a-z]+)\]$/i.exec(path);
  if (annotation?.[1] && FOLDER_TYPES.has(annotation[1].toLowerCase())) {
    type = annotation[1].toLowerCase();
    path = path.slice(0, annotation.index).trim();
  }
  const normalized = path.replace(/\\/g, "/");
  const slash = normalized.lastIndexOf("/");
  const filename = slash >= 0 ? normalized.slice(slash + 1) : normalized;
  if (!filename) return null;
  const subfolder = slash >= 0 ? normalized.slice(0, slash) : "";
  return { filename, subfolder, type };
}
function firstOutputImage(output) {
  const images = output?.images;
  if (!Array.isArray(images)) return null;
  for (const image of images) {
    if (image && typeof image.filename === "string" && image.filename) return image;
  }
  return null;
}
function viewQuery(item) {
  const params = new URLSearchParams();
  params.set("filename", item.filename ?? "");
  params.set("subfolder", item.subfolder ?? "");
  params.set("type", item.type ?? "output");
  return params.toString();
}
function viewUrl(item, apiURL, cacheBust = "") {
  return apiURL(`/view?${viewQuery(item)}${cacheBust}`);
}
const FILE_WIDGET_NODES = {
  LoadImage: { widget: "image", type: "input" },
  LoadImageOutput: { widget: "image", type: "output" }
};
const MAX_VIRTUAL_HOPS = 16;
function nodeLocatorId(node) {
  const graph = node.graph;
  if (!graph) return null;
  return graph.isRootGraph === false ? `${graph.id}:${String(node.id)}` : String(node.id);
}
function inputSlotIndex(node, name) {
  return (node.inputs ?? []).findIndex((input) => input.name === name);
}
function isInputConnected(node, name) {
  const slot = inputSlotIndex(node, name);
  return slot >= 0 && node.inputs[slot]?.link != null;
}
function findUpstreamNode(node, slot) {
  let current = node;
  let currentSlot = slot;
  for (let hop = 0; hop <= MAX_VIRTUAL_HOPS; hop++) {
    if (!current.graph || currentSlot < 0 || currentSlot >= (current.inputs ?? []).length) return null;
    if (current.inputs[currentSlot]?.link == null) return null;
    const upstream = current.getInputNode(currentSlot);
    if (!upstream) return null;
    if (!upstream.isVirtualNode) return upstream;
    current = upstream;
    currentSlot = 0;
  }
  return null;
}
function sourceFromNode(upstream) {
  const fileWidget = FILE_WIDGET_NODES[upstream.comfyClass ?? upstream.type ?? ""];
  if (fileWidget) {
    const widget = upstream.widgets?.find((w) => w.name === fileWidget.widget);
    const item = parseAnnotatedFilename(widget?.value, fileWidget.type);
    if (item) return resultItemSource(item, "upstream");
  }
  const locator = nodeLocatorId(upstream);
  if (locator) {
    const preview = app.nodePreviewImages[locator]?.[0];
    if (typeof preview === "string" && preview) return { key: preview, url: preview, origin: "upstream" };
    const item = firstOutputImage(app.nodeOutputs[locator]);
    if (item) return resultItemSource(item, "upstream");
  }
  const legacy = upstream.imgs?.[0]?.src;
  if (legacy) return { key: legacy, url: legacy, origin: "upstream" };
  return null;
}
function sourceFromExecuted(node, lastExecuted) {
  const fromSession = firstOutputImage(lastExecuted);
  if (fromSession) return resultItemSource(fromSession, "executed");
  const locator = nodeLocatorId(node);
  const stored = locator ? firstOutputImage(app.nodeOutputs[locator]) : null;
  return stored ? resultItemSource(stored, "executed") : null;
}
function resultItemSource(item, origin) {
  return {
    key: viewQuery(item),
    url: viewUrl(item, (route) => api.apiURL(route), app.getRandParam()),
    origin
  };
}
const PAINT_OPTION_DESCRIPTORS = [
  { kind: "number", key: "size", label: "Size", title: "Brush size ([ / ])", min: 1, max: 1e3, step: 1, unit: "px", curve: "pow" },
  { kind: "number", key: "hardness", label: "Hard", title: "Hardness (Shift+[ / ])", min: 0, max: 100, step: 1, unit: "%", scale: 100 },
  { kind: "number", key: "opacity", label: "Opac", title: "Opacity (1..9, 0)", min: 1, max: 100, step: 1, unit: "%", scale: 100 },
  { kind: "number", key: "flow", label: "Flow", title: "Flow (per-dab strength)", min: 1, max: 100, step: 1, unit: "%", scale: 100 },
  { kind: "number", key: "spacing", label: "Spc", title: "Spacing (% of diameter)", min: 1, max: 200, step: 1, unit: "%", scale: 100 },
  { kind: "toggle", key: "pressureSize", label: "Size", title: "Pen pressure controls size", group: "pressure" },
  { kind: "toggle", key: "pressureOpacity", label: "Opacity", title: "Pen pressure controls opacity", group: "pressure" },
  {
    kind: "number",
    key: "minSize",
    label: "Min size",
    title: "Size at zero pressure (% of size)",
    min: 0,
    max: 100,
    step: 1,
    unit: "%",
    scale: 100,
    group: "pressure",
    dependsOn: ["pressureSize"]
  },
  {
    kind: "number",
    key: "gamma",
    label: "Curve γ",
    title: "Pressure curve (1 = linear, > 1 = softer start)",
    min: 0.2,
    max: 5,
    step: 0.05,
    group: "pressure",
    dependsOn: ["pressureSize", "pressureOpacity"]
  }
];
const PAINT_OPTION_GROUPS = [
  { id: "pressure", icon: "stylus", title: "Pen pressure", activeWhen: ["pressureSize", "pressureOpacity"] }
];
class PaintTool {
  id;
  label;
  shortcut;
  icon;
  options;
  altEyedropper;
  /** Stored option values (edited in place through {@link options}). */
  values;
  mode;
  spacer = null;
  last = null;
  /** Current stroke's full-pressure diameter in document px. */
  docSize = 1;
  /**
   * @param spec - Id, label, shortcut, icon, mode and default options.
   */
  constructor(spec) {
    this.id = spec.id;
    this.label = spec.label;
    this.shortcut = spec.shortcut;
    this.icon = spec.icon;
    this.mode = spec.mode;
    this.altEyedropper = spec.altEyedropper ?? false;
    this.values = { ...spec.defaults };
    this.options = new OptionSet(PAINT_OPTION_DESCRIPTORS, this.values, PAINT_OPTION_GROUPS);
  }
  /** @inheritdoc */
  onPointerDown(editor, samples) {
    const first = samples[0];
    if (!first) return;
    const style = {
      mode: this.mode,
      opacity: this.values.opacity,
      hardness: this.values.hardness,
      color: editor.colors.fg
    };
    this.docSize = imageLengthToDoc(editor.frameMap, this.values.size);
    if (!editor.beginStroke(style, this.docSize)) return;
    this.spacer = createSpacer();
    const lineStart = first.shiftKey ? editor.lastStrokeEnd : null;
    if (lineStart) this.feed(editor, [{ ...first, x: lineStart.x, y: lineStart.y }]);
    this.feed(editor, samples);
  }
  /** @inheritdoc */
  onPointerMove(editor, samples) {
    if (this.spacer) this.feed(editor, samples);
  }
  /** @inheritdoc */
  onPointerUp(editor, sample) {
    if (!this.spacer) return;
    this.feed(editor, [sample]);
    const end = this.last ? { x: this.last.x, y: this.last.y } : { x: sample.x, y: sample.y };
    this.spacer = null;
    this.last = null;
    editor.endStroke(end);
  }
  /** @inheritdoc */
  onCancel(editor) {
    if (!this.spacer) return;
    this.spacer = null;
    this.last = null;
    editor.cancelStroke();
  }
  /** @inheritdoc */
  cursor() {
    return { kind: "ring", diameter: this.values.size };
  }
  feed(editor, samples) {
    const spacer = this.spacer;
    if (!spacer) return;
    const dyn = this.dynamics();
    const dabs = [];
    for (const s of samples) {
      const sample = { x: s.x, y: s.y, pressure: s.pressure };
      dabs.push(...placeDabs(spacer, sample, dyn));
      this.last = s;
    }
    editor.addDabs(dabs);
  }
  /** Spacing is a fraction of the diameter, so it scales with `docSize` too. */
  dynamics() {
    const v = this.values;
    return {
      size: this.docSize,
      flow: v.flow,
      spacing: v.spacing,
      pressureSize: v.pressureSize,
      pressureOpacity: v.pressureOpacity,
      minSizeRatio: v.minSize,
      gamma: v.gamma
    };
  }
}
function createBrushTool() {
  return new PaintTool({
    id: "brush",
    label: "Brush",
    shortcut: "b",
    icon: "brush",
    mode: "paint",
    altEyedropper: true,
    defaults: {
      size: 24,
      hardness: 0.8,
      opacity: 1,
      flow: 1,
      spacing: 0.1,
      pressureSize: true,
      pressureOpacity: false,
      minSize: 0.1,
      gamma: 1
    }
  });
}
function createEraserTool() {
  return new PaintTool({
    id: "eraser",
    label: "Eraser",
    shortcut: "e",
    icon: "eraser",
    mode: "erase",
    defaults: {
      size: 48,
      hardness: 0.8,
      opacity: 1,
      flow: 1,
      spacing: 0.1,
      pressureSize: true,
      pressureOpacity: false,
      minSize: 0.1,
      gamma: 1
    }
  });
}
const SAMPLE_CHOICES = [
  { value: "layer", label: "Current layer" },
  { value: "all", label: "All layers" }
];
const DESCRIPTORS$3 = [
  { kind: "number", key: "tolerance", label: "Tol", title: "Tolerance (0-255 per channel)", min: 0, max: 255, step: 1 },
  { kind: "number", key: "opacity", label: "Opac", title: "Opacity (1..9, 0)", min: 1, max: 100, step: 1, unit: "%", scale: 100 },
  { kind: "toggle", key: "contiguous", label: "Contiguous", title: "Only fill connected pixels", group: "mode" },
  { kind: "toggle", key: "antiAlias", label: "Anti-alias", title: "Soften the fill edge", group: "mode" },
  { kind: "select", key: "sample", label: "Sample", title: "Pixels the fill looks at", choices: SAMPLE_CHOICES, group: "sample" }
];
class FillTool {
  id = "bucket";
  label = "Paint bucket";
  shortcut = "g";
  icon = "bucket";
  altEyedropper = true;
  values = { tolerance: 32, opacity: 1, contiguous: true, antiAlias: true, sample: "all" };
  options = new OptionSet(DESCRIPTORS$3, this.values);
  /** @inheritdoc */
  onPointerDown(editor, samples) {
    const first = samples[0];
    if (!first) return;
    const v = this.values;
    editor.pixelOps.fill({
      point: { x: first.x, y: first.y },
      tolerance: v.tolerance,
      contiguous: v.contiguous,
      antiAlias: v.antiAlias,
      sample: v.sample,
      opacity: v.opacity,
      color: editor.colors.fg
    });
  }
  /** @inheritdoc */
  onPointerMove() {
  }
  /** @inheritdoc */
  onPointerUp() {
  }
  /** @inheritdoc */
  onCancel() {
  }
  /** @inheritdoc */
  cursor() {
    return { kind: "icon", icon: "bucket" };
  }
}
function createFillTool() {
  return new FillTool();
}
const DESCRIPTORS$2 = [
  { kind: "select", key: "sample", label: "Sample", title: "Pixels to pick from", choices: SAMPLE_CHOICES },
  {
    kind: "select",
    key: "size",
    label: "Size",
    title: "Sample size",
    choices: [
      { value: "1", label: "Point" },
      { value: "3", label: "3x3 average" },
      { value: "5", label: "5x5 average" }
    ]
  }
];
class EyedropperTool {
  /**
   * @param values - Stored options (shared with the temporary variant).
   * @param isTemporary - Alt-engaged from another tool: always the foreground.
   */
  constructor(values = { sample: "all", size: "1" }, isTemporary = false) {
    this.values = values;
    this.isTemporary = isTemporary;
    this.options = new OptionSet(DESCRIPTORS$2, this.values);
  }
  values;
  isTemporary;
  id = "eyedropper";
  label = "Eyedropper";
  shortcut = "i";
  icon = "eyedropper";
  options;
  picking = null;
  temp = null;
  /** Variant used while Alt is held in brush/bucket/shape tools (same options). */
  get temporary() {
    this.temp ??= new EyedropperTool(this.values, true);
    return this.temp;
  }
  /** @inheritdoc */
  onPointerDown(editor, samples) {
    const first = samples[0];
    if (!first) return;
    const slot = first.altKey && !this.isTemporary ? "bg" : "fg";
    const previous = editor.colors[slot];
    this.picking = { slot, previous, color: previous };
    this.pick(editor, first);
  }
  /** @inheritdoc */
  onPointerMove(editor, samples) {
    const last = samples[samples.length - 1];
    if (last && this.picking) this.pick(editor, last);
  }
  /** @inheritdoc */
  onPointerUp(editor, sample) {
    if (!this.picking) return;
    this.pick(editor, sample);
    this.picking = null;
  }
  /** @inheritdoc */
  onCancel() {
    this.picking = null;
  }
  /** @inheritdoc */
  cursor() {
    return { kind: "icon", icon: "eyedropper" };
  }
  /** @inheritdoc */
  overlay() {
    const p = this.picking;
    return p ? { kind: "loupe", color: p.color, previous: p.previous } : null;
  }
  pick(editor, at) {
    const p = this.picking;
    if (!p) return;
    const hex = editor.pixelOps.sampleColor({ x: at.x, y: at.y }, this.values.sample, Number(this.values.size) || 1);
    if (!hex) return;
    p.color = hex;
    editor.colors.set(p.slot, hex);
  }
}
function createEyedropperTool() {
  return new EyedropperTool();
}
const SUBROWS = 16;
function ellipseSelection(box) {
  const rx = Math.abs(box.width) / 2;
  const ry = Math.abs(box.height) / 2;
  if (rx <= 0 || ry <= 0) return null;
  const cx = Math.min(box.x, box.x + box.width) + rx;
  const cy = Math.min(box.y, box.y + box.height) + ry;
  const spans = (y) => {
    const dy = (y - cy) / ry;
    if (dy <= -1 || dy >= 1) return [];
    const half = rx * Math.sqrt(1 - dy * dy);
    return [cx - half, cx + half];
  };
  return rasterize(outerRect(cx - rx, cy - ry, cx + rx, cy + ry), spans);
}
function polygonSelection(points) {
  if (points.length < 3) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  if (maxX <= minX || maxY <= minY) return null;
  const crossings = [];
  const spans = (y) => {
    crossings.length = 0;
    for (let i = 0; i < points.length; i++) {
      const a = points[i];
      const b = points[(i + 1) % points.length];
      if (a.y === b.y) continue;
      const lo = a.y < b.y ? a : b;
      const hi = a.y < b.y ? b : a;
      if (y < lo.y || y >= hi.y) continue;
      crossings.push({ x: lo.x + (y - lo.y) * (hi.x - lo.x) / (hi.y - lo.y), dir: b.y > a.y ? 1 : -1 });
    }
    crossings.sort((p, q) => p.x - q.x);
    const out = [];
    let winding = 0;
    for (const c of crossings) {
      const was = winding;
      winding += c.dir;
      if (was === 0 && winding !== 0) out.push(c.x);
      else if (was !== 0 && winding === 0) out.push(c.x);
    }
    return out;
  };
  return rasterize(outerRect(minX, minY, maxX, maxY), spans);
}
function outerRect(x0, y0, x1, y1) {
  const x = Math.floor(x0);
  const y = Math.floor(y0);
  return { x, y, width: Math.ceil(x1) - x, height: Math.ceil(y1) - y };
}
function rasterize(area, spans) {
  const { width, height } = area;
  if (width <= 0 || height <= 0) return null;
  const coverage = new Uint8Array(width * height);
  const partial = new Float32Array(width);
  const runs = new Int32Array(width + 1);
  for (let row = 0; row < height; row++) {
    partial.fill(0);
    runs.fill(0);
    for (let j = 0; j < SUBROWS; j++) {
      const list = spans(area.y + row + (j + 0.5) / SUBROWS);
      for (let k = 0; k + 1 < list.length; k += 2) {
        addSpan(partial, runs, width, list[k] - area.x, list[k + 1] - area.x);
      }
    }
    let run2 = 0;
    const base = row * width;
    for (let x = 0; x < width; x++) {
      run2 += runs[x];
      const c = (run2 + partial[x]) * 255 / SUBROWS;
      coverage[base + x] = c >= 255 ? 255 : Math.round(c);
    }
  }
  return selectionFromCoverage(coverage, area);
}
function addSpan(partial, runs, width, a, b) {
  const x0 = Math.max(0, a);
  const x1 = Math.min(width, b);
  if (x1 <= x0) return;
  const i0 = Math.floor(x0);
  const i1 = Math.floor(x1);
  if (i0 === i1) {
    partial[i0] = partial[i0] + (x1 - x0);
    return;
  }
  partial[i0] = partial[i0] + (i0 + 1 - x0);
  runs[i0 + 1] = runs[i0 + 1] + 1;
  runs[i1] = runs[i1] - 1;
  if (i1 < width) partial[i1] = partial[i1] + (x1 - i1);
}
class SelectionModifiers {
  /** Combination mode, fixed at pointer-down. */
  mode;
  shiftConsumed;
  altConsumed;
  /**
   * @param start - Modifiers at pointer-down.
   * @param hasSelection - Whether a selection exists at pointer-down.
   */
  constructor(start, hasSelection) {
    this.mode = hasSelection ? selectionMode(start.shiftKey, start.altKey) : "replace";
    this.shiftConsumed = hasSelection && start.shiftKey;
    this.altConsumed = hasSelection && start.altKey;
  }
  /**
   * Constraints for a sample (call for every sample, in order).
   * @param flags - Current modifiers.
   * @returns Square / from-centre flags.
   */
  update(flags) {
    if (!flags.shiftKey) this.shiftConsumed = false;
    if (!flags.altKey) this.altConsumed = false;
    return { square: flags.shiftKey && !this.shiftConsumed, fromCentre: flags.altKey && !this.altConsumed };
  }
}
const DECIMATE_IMAGE_PX = 1;
const CLICK_SLOP_PX$1 = 3;
const DOUBLE_CLICK_MS = 400;
function appendDecimated(points, p, minDistance) {
  const last = points[points.length - 1];
  if (last && Math.hypot(p.x - last.x, p.y - last.y) < minDistance) return false;
  points.push({ x: p.x, y: p.y });
  return true;
}
class LassoTool {
  /**
   * @param now - Clock in ms (double-click detection; injectable for tests).
   */
  constructor(now = () => performance.now()) {
    this.now = now;
  }
  now;
  id = "lasso";
  label = "Lasso";
  shortcut = "l";
  icon = "lasso";
  options = null;
  combinesSelection = true;
  path = null;
  /** @inheritdoc */
  onPointerDown(editor, samples) {
    const first = samples[0];
    if (!first) return;
    const path = this.path;
    if (path && !path.buttonDown) {
      this.pressPending(editor, path, first);
      return;
    }
    if (path) return;
    const map = editor.frameMap;
    const scale = editor.view.current.scale;
    const mods = new SelectionModifiers(first, editor.selection.active);
    this.path = {
      points: [{ x: first.x, y: first.y }],
      mods,
      minDistance: imageLengthToDoc(map, DECIMATE_IMAGE_PX),
      slop: imageLengthToDoc(map, CLICK_SLOP_PX$1 / (scale > 0 ? scale : 1)),
      polygon: mods.update(first).fromCentre,
      buttonDown: true,
      moved: false,
      cursor: { x: first.x, y: first.y },
      lastClick: null
    };
    if (this.path.polygon) this.path.lastClick = { at: { x: first.x, y: first.y }, time: this.now() };
    this.track(samples.slice(1));
  }
  /** @inheritdoc */
  onPointerMove(_editor, samples) {
    this.track(samples);
  }
  /** @inheritdoc */
  onPointerUp(editor, sample) {
    const path = this.path;
    if (!path?.buttonDown) return;
    this.track([sample]);
    path.buttonDown = false;
    if (path.polygon) {
      appendDecimated(path.points, sample, path.minDistance);
      return;
    }
    this.finish(editor);
  }
  /** @inheritdoc */
  pending() {
    return this.path !== null && !this.path.buttonDown;
  }
  /** @inheritdoc */
  onHover(editor, sample) {
    const path = this.path;
    if (!path || path.buttonDown) return;
    path.cursor = { x: sample.x, y: sample.y };
    if (!path.mods.update(sample).fromCentre) this.finish(editor);
  }
  /** @inheritdoc */
  onCancel() {
    this.path = null;
  }
  /** @inheritdoc */
  cursor() {
    return { kind: "icon", icon: "crosshair" };
  }
  /** @inheritdoc */
  overlay() {
    const path = this.path;
    if (!path) return null;
    const points = path.polygon ? [...path.points, path.cursor] : path.points;
    return points.length > 1 ? { kind: "selection", shape: { kind: "polygon", points, closed: false } } : null;
  }
  // ── Internals ───────────────────────────────────────────────────────────
  /** Button-down samples: freehand points, or the rubber band in polygon mode. */
  track(samples) {
    const path = this.path;
    if (!path?.buttonDown) return;
    const start = path.points[0];
    for (const p of samples) {
      const straight = path.mods.update(p).fromCentre;
      if (!path.moved && Math.hypot(p.x - start.x, p.y - start.y) > path.slop) path.moved = true;
      if (path.polygon && !straight) {
        appendDecimated(path.points, p, path.minDistance);
      }
      path.polygon = straight;
      path.cursor = { x: p.x, y: p.y };
      if (!straight) appendDecimated(path.points, p, path.minDistance);
    }
  }
  /** A press while the polygon is pending: close (double-click / near start) or add a vertex. */
  pressPending(editor, path, p) {
    const time = this.now();
    const start = path.points[0];
    const last = path.lastClick;
    const nearStart = path.points.length > 2 && Math.hypot(p.x - start.x, p.y - start.y) <= path.slop * 2;
    const double = last !== null && time - last.time <= DOUBLE_CLICK_MS && Math.hypot(p.x - last.at.x, p.y - last.at.y) <= path.slop;
    if (nearStart || double) {
      this.finish(editor);
      return;
    }
    path.lastClick = { at: { x: p.x, y: p.y }, time };
    path.buttonDown = true;
    path.polygon = path.mods.update(p).fromCentre;
    path.cursor = { x: p.x, y: p.y };
    appendDecimated(path.points, p, path.minDistance);
  }
  /** Close the path and apply it (one history entry); a bare click deselects in replace mode. */
  finish(editor) {
    const path = this.path;
    this.path = null;
    if (!path) return;
    const clickOnly = !path.moved && path.points.length < 3;
    if (clickOnly) {
      if (path.mods.mode === "replace") editor.selection.deselect();
      return;
    }
    editor.selection.apply(polygonSelection(path.points), path.mods.mode);
  }
}
function createLassoTool() {
  return new LassoTool();
}
const DESCRIPTORS$1 = [
  { kind: "number", key: "tolerance", label: "Tol", title: "Tolerance (0-255 per channel)", min: 0, max: 255, step: 1 },
  { kind: "toggle", key: "contiguous", label: "Contiguous", title: "Only select connected pixels", group: "mode" },
  { kind: "toggle", key: "antiAlias", label: "Anti-alias", title: "Soften the selection edge", group: "mode" },
  { kind: "select", key: "sample", label: "Sample", title: "Pixels the wand looks at", choices: SAMPLE_CHOICES, group: "sample" }
];
class MagicWandTool {
  id = "wand";
  label = "Magic wand";
  shortcut = "w";
  icon = "magicWand";
  values = { tolerance: 32, contiguous: true, antiAlias: true, sample: "all" };
  options = new OptionSet(DESCRIPTORS$1, this.values);
  combinesSelection = true;
  /** @inheritdoc */
  onPointerDown(editor, samples) {
    const first = samples[0];
    if (!first || editor.loading) return;
    const { mode } = new SelectionModifiers(first, editor.selection.active);
    const v = this.values;
    const sel = editor.pixelOps.wandSelection({
      point: { x: first.x, y: first.y },
      tolerance: v.tolerance,
      contiguous: v.contiguous,
      antiAlias: v.antiAlias,
      sample: v.sample
    });
    editor.selection.apply(sel, mode);
  }
  /** @inheritdoc */
  onPointerMove() {
  }
  /** @inheritdoc */
  onPointerUp() {
  }
  /** @inheritdoc */
  onCancel() {
  }
  /** @inheritdoc */
  cursor() {
    return { kind: "icon", icon: "crosshair" };
  }
}
function createMagicWandTool() {
  return new MagicWandTool();
}
const CLICK_SLOP_PX = 3;
const RECT_MARQUEE = {
  coverage: (box) => rectSelection(box),
  preview: (box) => ({ kind: "rect", rect: box })
};
const ELLIPSE_MARQUEE = {
  coverage: (box) => ellipseSelection(box),
  preview: (box) => ({ kind: "ellipse", rect: box })
};
const MARQUEE_GROUP = { id: "marquee", label: "Marquee", toolIds: ["marquee-rect", "marquee-ellipse"] };
class MarqueeTool {
  id;
  label;
  shortcut = "m";
  icon;
  options = null;
  combinesSelection = true;
  kind;
  drag = null;
  /**
   * @param spec - Id, label, icon and box -> coverage kind.
   */
  constructor(spec) {
    this.id = spec.id;
    this.label = spec.label;
    this.icon = spec.icon;
    this.kind = spec.kind;
  }
  /** @inheritdoc */
  onPointerDown(editor, samples) {
    const first = samples[0];
    if (!first || this.drag) return;
    const viewScale = editor.view.current.scale;
    this.drag = {
      start: { x: first.x, y: first.y },
      mods: new SelectionModifiers(first, editor.selection.active),
      slop: imageLengthToDoc(editor.frameMap, CLICK_SLOP_PX / (viewScale > 0 ? viewScale : 1)),
      moved: false,
      box: { x: first.x, y: first.y, width: 0, height: 0 }
    };
    this.update(samples);
  }
  /** @inheritdoc */
  onPointerMove(_editor, samples) {
    this.update(samples);
  }
  /** @inheritdoc */
  onPointerUp(editor, sample) {
    const drag = this.drag;
    if (!drag) return;
    this.update([sample]);
    this.drag = null;
    if (!drag.moved) {
      if (drag.mods.mode === "replace") editor.selection.deselect();
      return;
    }
    editor.selection.apply(this.kind.coverage(drag.box), drag.mods.mode);
  }
  /** @inheritdoc */
  onCancel() {
    this.drag = null;
  }
  /** @inheritdoc */
  cursor() {
    return { kind: "icon", icon: "crosshair" };
  }
  /** @inheritdoc */
  overlay() {
    const drag = this.drag;
    return drag?.moved ? { kind: "selection", shape: this.kind.preview(drag.box) } : null;
  }
  update(samples) {
    const drag = this.drag;
    if (!drag) return;
    for (const p of samples) {
      const { square, fromCentre } = drag.mods.update(p);
      if (!drag.moved && Math.hypot(p.x - drag.start.x, p.y - drag.start.y) > drag.slop) drag.moved = true;
      drag.box = snapRect(boxFromDrag(drag.start, p, square, fromCentre));
    }
  }
}
function createMarqueeTools() {
  return [
    new MarqueeTool({ id: "marquee-rect", label: "Rectangular marquee", icon: "marqueeRect", kind: RECT_MARQUEE }),
    new MarqueeTool({ id: "marquee-ellipse", label: "Elliptical marquee", icon: "marqueeEllipse", kind: ELLIPSE_MARQUEE })
  ];
}
const OFFSET_LIMIT = 16384;
const DESCRIPTORS = [
  { kind: "number", key: "x", label: "X", title: "Horizontal offset (image px; arrows nudge)", min: -OFFSET_LIMIT, max: OFFSET_LIMIT, step: 1, unit: "px" },
  { kind: "number", key: "y", label: "Y", title: "Vertical offset (image px; arrows nudge)", min: -OFFSET_LIMIT, max: OFFSET_LIMIT, step: 1, unit: "px" },
  { kind: "number", key: "scale", label: "Scale", title: "Drawing scale (wheel while dragging)", min: 5, max: 2e3, step: 0.1, unit: "%", scale: 100, curve: "pow" },
  { kind: "button", key: "reset", label: "Reset position", title: "Put the drawing back where it was painted", group: "reset" }
];
const ARROWS = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1]
};
class MoveOptions {
  /**
   * @param editor - Editor whose placement is edited.
   */
  constructor(editor) {
    this.editor = editor;
  }
  editor;
  descriptors = DESCRIPTORS;
  /** @inheritdoc */
  get(key) {
    const placement = this.editor.placement;
    switch (key) {
      case "x":
        return placement.imageOffset.x;
      case "y":
        return placement.imageOffset.y;
      case "scale":
        return placement.current.scale;
      case "reset":
        return placement.isMoved;
      default:
        return void 0;
    }
  }
  /** @inheritdoc */
  set(key, value) {
    const { editor } = this;
    const current = editor.placement.current;
    const next = { ...current };
    if (key === "reset") {
      if (value !== true || !editor.placement.isMoved) return false;
      editor.placement.reset();
      return true;
    }
    if (typeof value !== "number" || !Number.isFinite(value)) return false;
    const toDoc = (px) => imageOffsetToPlacement(px, editor.doc.frame, editor.imageSize);
    if (key === "x") next.x = toDoc(value);
    else if (key === "y") next.y = toDoc(value);
    else if (key === "scale") next.scale = value;
    else return false;
    editor.placement.set(next);
    const after = editor.placement.current;
    return after.x !== current.x || after.y !== current.y || after.scale !== current.scale;
  }
}
class MoveTool {
  id = "move";
  label = "Move drawing";
  /** No keyboard shortcut; V is reserved for the future element Move tool. */
  shortcut = "";
  icon = "moveDrawing";
  /** Hidden from the tool rail; activated by the layers panel footer toggle. */
  rail = false;
  options;
  drag = null;
  /**
   * @param editor - Editor of the session (the options read its placement).
   */
  constructor(editor) {
    this.options = new MoveOptions(editor);
  }
  /** @inheritdoc */
  onPointerDown(editor, samples) {
    const first = samples[0];
    if (!first) return;
    const start = editor.placement.current;
    this.drag = { start, anchor: start, from: docToImage(editor.frameMap, first) };
  }
  /** @inheritdoc */
  onPointerMove(editor, samples) {
    const last = samples[samples.length - 1];
    if (last) this.moveTo(editor, last, false);
  }
  /** @inheritdoc */
  onPointerUp(editor, sample) {
    if (!this.drag) return;
    this.moveTo(editor, sample, false);
    this.drag = null;
    editor.placement.commit();
  }
  /** @inheritdoc */
  onCancel(editor) {
    const drag = this.drag;
    this.drag = null;
    if (drag) editor.placement.set(drag.start);
  }
  /** @inheritdoc */
  onWheel(editor, deltaPx, at) {
    const drag = this.drag;
    if (!drag) return;
    const point = docToImage(editor.frameMap, at);
    editor.placement.scaleAt(wheelScaleFactor(deltaPx), point, false);
    drag.anchor = editor.placement.current;
    drag.from = point;
  }
  /** @inheritdoc */
  onKey(editor, event) {
    const dir = ARROWS[event.key];
    if (!dir) return false;
    if (this.drag) return true;
    const step = event.shiftKey ? 10 : 1;
    editor.placement.translateImage(dir[0] * step, dir[1] * step);
    return true;
  }
  /** @inheritdoc */
  cursor() {
    return { kind: "icon", icon: "move" };
  }
  /**
   * Translate from the drag anchor by the pointer's (whole) image-px delta.
   * The sample was converted with the current frame map, so mapping it back
   * gives the true image point even though the placement keeps changing.
   */
  moveTo(editor, sample, commit) {
    const drag = this.drag;
    if (!drag) return;
    const q = docToImage(editor.frameMap, sample);
    const dx = Math.round(q.x - drag.from.x);
    const dy = Math.round(q.y - drag.from.y);
    editor.placement.set(translatePlacement(drag.anchor, editor.doc.frame, editor.imageSize, dx, dy), commit);
  }
}
function createMoveTool(editor) {
  return new MoveTool(editor);
}
const WIDTH_OPTION = {
  kind: "number",
  key: "width",
  label: "Width",
  title: "Line / stroke width",
  min: 1,
  max: 500,
  step: 1,
  unit: "px",
  curve: "pow"
};
const OPACITY_OPTION = {
  kind: "number",
  key: "opacity",
  label: "Opac",
  title: "Opacity (1..9, 0)",
  min: 1,
  max: 100,
  step: 1,
  unit: "%",
  scale: 100
};
class ShapeTool {
  id;
  label;
  shortcut;
  icon;
  options;
  /** Alt at pointer-down = temporary eyedropper (SPEC Tools table). */
  altEyedropper = true;
  /** Stored option values (edited in place through {@link options}). */
  values;
  drag = null;
  /**
   * @param spec - Id, label, shortcut, icon, option layout and defaults.
   */
  constructor(spec) {
    this.id = spec.id;
    this.label = spec.label;
    this.shortcut = spec.shortcut;
    this.icon = spec.icon;
    this.values = { ...spec.defaults };
    this.options = new OptionSet(spec.descriptors, this.values);
  }
  /** @inheritdoc */
  onPointerDown(editor, samples) {
    const first = samples[0];
    if (!first || this.drag) return;
    const { fg, bg } = editor.colors;
    if (!editor.beginStroke({ mode: "paint", opacity: this.values.opacity, hardness: 1, color: fg }, 1)) return;
    this.drag = { start: { x: first.x, y: first.y }, width: imageLengthToDoc(editor.frameMap, this.values.width), fg, bg };
    this.update(editor, samples.at(-1) ?? first);
  }
  /** @inheritdoc */
  onPointerMove(editor, samples) {
    const last = samples.at(-1);
    if (last) this.update(editor, last);
  }
  /** @inheritdoc */
  onPointerUp(editor, sample) {
    if (!this.drag) return;
    this.update(editor, sample);
    this.drag = null;
    editor.endStroke(null);
  }
  /** @inheritdoc */
  onCancel(editor) {
    if (!this.drag) return;
    this.drag = null;
    editor.cancelStroke();
  }
  /** @inheritdoc */
  cursor() {
    return { kind: "icon", icon: "crosshair" };
  }
  update(editor, pointer) {
    if (this.drag) editor.drawShape(this.buildShape({ ...this.drag, pointer }));
  }
}
const BOX_OPTION_DESCRIPTORS = [
  {
    kind: "select",
    key: "paint",
    label: "Mode",
    title: "Stroke (FG), fill (FG), or both (stroke FG, fill BG)",
    choices: [
      { value: "stroke", label: "Stroke" },
      { value: "fill", label: "Fill" },
      { value: "both", label: "Both" }
    ]
  },
  { ...WIDTH_OPTION, title: "Stroke width" },
  OPACITY_OPTION
];
class BoxShapeTool extends ShapeTool {
  /**
   * @param kind - Rectangle or ellipse.
   * @param spec - Tool spec (see {@link ShapeTool}).
   */
  constructor(kind, spec) {
    super(spec);
    this.kind = kind;
  }
  kind;
  /** @inheritdoc */
  buildShape(drag) {
    const { start, pointer } = drag;
    const paint2 = this.values.paint;
    return {
      kind: this.kind,
      rect: boxFromDrag(start, pointer, pointer.shiftKey, pointer.altKey),
      paint: paint2,
      strokeWidth: drag.width,
      strokeColor: drag.fg,
      fillColor: paint2 === "both" ? drag.bg : drag.fg
    };
  }
}
function createRectangleTool() {
  return new BoxShapeTool("rect", {
    id: "rectangle",
    label: "Rectangle",
    shortcut: "u",
    icon: "rectangle",
    descriptors: BOX_OPTION_DESCRIPTORS,
    defaults: { paint: "stroke", width: 4, opacity: 1 }
  });
}
function createEllipseTool() {
  return new BoxShapeTool("ellipse", {
    id: "ellipse",
    label: "Ellipse",
    shortcut: "u",
    icon: "ellipse",
    descriptors: BOX_OPTION_DESCRIPTORS,
    defaults: { paint: "stroke", width: 4, opacity: 1 }
  });
}
const LINE_OPTION_DESCRIPTORS = [
  WIDTH_OPTION,
  OPACITY_OPTION,
  {
    kind: "select",
    key: "heads",
    label: "Arrow",
    title: "Arrowheads",
    choices: [
      { value: "none", label: "None" },
      { value: "end", label: "End" },
      { value: "both", label: "Both" }
    ],
    group: "arrow"
  },
  {
    kind: "number",
    key: "headSize",
    label: "Head",
    title: "Arrowhead length (% of width)",
    min: 150,
    max: 1500,
    step: 10,
    unit: "%",
    scale: 100,
    group: "arrow"
  }
];
class LineTool extends ShapeTool {
  /** @inheritdoc */
  buildShape(drag) {
    const { start, pointer } = drag;
    const end = pointer.shiftKey ? snapAngle(start, pointer) : { x: pointer.x, y: pointer.y };
    return {
      kind: "line",
      from: start,
      to: end,
      width: drag.width,
      heads: this.values.heads,
      headRatio: this.values.headSize,
      color: drag.fg
    };
  }
}
function createLineTool() {
  return new LineTool({
    id: "line",
    label: "Line",
    shortcut: "u",
    icon: "line",
    descriptors: LINE_OPTION_DESCRIPTORS,
    defaults: { width: 4, opacity: 1, heads: "none", headSize: 4 }
  });
}
function createArrowTool() {
  return new LineTool({
    id: "arrow",
    label: "Arrow",
    shortcut: "u",
    icon: "arrow",
    descriptors: LINE_OPTION_DESCRIPTORS,
    defaults: { width: 4, opacity: 1, heads: "end", headSize: 4 }
  });
}
const SHAPE_GROUP = { id: "shape", label: "Shape", toolIds: ["line", "arrow", "rectangle", "ellipse"] };
function createShapeTools() {
  return [createLineTool(), createArrowTool(), createRectangleTool(), createEllipseTool()];
}
class ToolGroupState {
  specs;
  current = /* @__PURE__ */ new Map();
  byTool = /* @__PURE__ */ new Map();
  /**
   * @param specs - Groups (empty groups are ignored).
   */
  constructor(specs = []) {
    this.specs = specs.filter((g) => g.toolIds.length > 0);
    for (const group2 of this.specs) {
      this.current.set(group2.id, group2.toolIds[0] ?? "");
      for (const id of group2.toolIds) this.byTool.set(id, group2);
    }
  }
  /** @inheritdoc */
  groupOf(toolId) {
    return this.byTool.get(toolId);
  }
  /** @inheritdoc */
  currentOf(groupId) {
    return this.current.get(groupId);
  }
  /**
   * Record that a tool became active (it becomes its group's current tool).
   * @param toolId - Tool id.
   */
  noteActive(toolId) {
    const group2 = this.byTool.get(toolId);
    if (group2) this.current.set(group2.id, toolId);
  }
  /**
   * Tool Shift+key switches to: the member after the active tool when the
   * active tool is in the group, else the member after the group's current
   * tool (Shift+key always advances, wrapping).
   * @param groupId - Group id.
   * @param activeId - Currently active tool id.
   * @returns Next tool id, or `undefined` for unknown groups.
   */
  next(groupId, activeId) {
    const group2 = this.specs.find((g) => g.id === groupId);
    if (!group2) return void 0;
    const from = group2.toolIds.includes(activeId) ? activeId : this.current.get(groupId) ?? "";
    const index = group2.toolIds.indexOf(from);
    return group2.toolIds[(index + 1) % group2.toolIds.length];
  }
}
class ToolRegistry {
  events = new Emitter();
  tools = /* @__PURE__ */ new Map();
  activeId;
  /**
   * @param tools - Tools in rail order; the first becomes active.
   */
  constructor(tools, groups = []) {
    for (const tool of tools) this.tools.set(tool.id, tool);
    this.activeId = tools[0]?.id ?? "";
    this.groups = new ToolGroupState(groups);
  }
  /** Tool groups sharing one rail slot + key (last-used tool per group). */
  groups;
  /**
   * Shift+key: the next tool of the group bound to `key` (cycles).
   * @param key - Lowercase key.
   * @returns The tool, or `undefined` if `key` is not a group key.
   */
  cycleShortcut(key) {
    const tool = [...this.tools.values()].find((t) => t.shortcut === key);
    const group2 = tool ? this.groups.groupOf(tool.id) : void 0;
    const next = group2 ? this.groups.next(group2.id, this.activeId) : void 0;
    return next ? this.tools.get(next) : void 0;
  }
  /** Active tool. */
  get active() {
    const tool = this.tools.get(this.activeId);
    if (!tool) throw new Error("ToolRegistry has no tools");
    return tool;
  }
  /** All tools in registration order. */
  list() {
    return [...this.tools.values()];
  }
  /** Rail tools (tools with `rail !== false`), in registration order. */
  railTools() {
    return [...this.tools.values()].filter((t) => t.rail !== false);
  }
  /**
   * Tool by id.
   * @param id - Tool id.
   * @returns The tool or `undefined`.
   */
  get(id) {
    return this.tools.get(id);
  }
  /**
   * Tool bound to a single-key shortcut.
   * @param key - Lowercase key.
   * @returns The tool or `undefined`.
   */
  byShortcut(key) {
    for (const tool of this.tools.values()) {
      if (tool.rail === false) continue;
      if (tool.shortcut !== key) continue;
      const group2 = this.groups.groupOf(tool.id);
      return group2 && this.tools.get(this.groups.currentOf(group2.id) ?? "") || tool;
    }
    return void 0;
  }
  /**
   * Activate a tool.
   * @param id - Tool id.
   */
  setActive(id) {
    if (!this.tools.has(id) || id === this.activeId) return;
    this.activeId = id;
    this.groups.noteActive(id);
    this.events.emit("change", void 0);
  }
  /** Notify that the active tool's options changed. */
  notifyOptions() {
    this.events.emit("change", void 0);
  }
  // ── Alt = temporary eyedropper ──────────────────────────────────────────
  altTool = null;
  /**
   * Tool that takes over while Alt is held in tools with `altEyedropper`.
   * @param tool - Usually `EyedropperTool.temporary`; `null` disables.
   */
  setAltTool(tool) {
    this.altTool = tool;
  }
  /**
   * Tool that should receive stage input / draw the cursor right now: the
   * Alt tool while Alt is held and the active tool opts in
   * (`Tool.altEyedropper`), else the active tool.
   * @param altHeld - Alt is down.
   * @returns The effective tool.
   */
  resolve(altHeld) {
    const active = this.active;
    return altHeld && active.altEyedropper && this.altTool ? this.altTool : active;
  }
}
function createDefaultTools(editor) {
  const eyedropper = createEyedropperTool();
  const registry = new ToolRegistry(
    [
      createBrushTool(),
      createEraserTool(),
      createFillTool(),
      eyedropper,
      ...createShapeTools(),
      createMoveTool(editor),
      ...createMarqueeTools(),
      createLassoTool(),
      createMagicWandTool()
    ],
    [SHAPE_GROUP, MARQUEE_GROUP]
  );
  registry.setAltTool(eyedropper.temporary);
  return registry;
}
function contentHash(bytes, seed = 0) {
  let h1 = 3735928559 ^ seed;
  let h2 = 1103547991 ^ seed;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] ?? 0;
    h1 = Math.imul(h1 ^ b, 2654435761);
    h2 = Math.imul(h2 ^ b, 1597334677);
  }
  h1 = Math.imul(h1 ^ h1 >>> 16, 2246822507);
  h1 ^= Math.imul(h2 ^ h2 >>> 13, 3266489909);
  h2 = Math.imul(h2 ^ h2 >>> 16, 2246822507);
  h2 ^= Math.imul(h1 ^ h1 >>> 13, 3266489909);
  const value = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  return value.toString(16).padStart(14, "0");
}
function layerFileName(docId, hash, ext) {
  const prefix = docId.replace(/[^a-z0-9]/gi, "").slice(0, 8) || "doc";
  return `ps-${prefix}-${hash}.${ext}`;
}
const HEADER = 12;
function sniffWebp(bytes) {
  if (bytes.length < HEADER + 8 || fourcc(bytes, 0) !== "RIFF" || fourcc(bytes, 8) !== "WEBP") return "invalid";
  let offset = HEADER;
  while (offset + 8 <= bytes.length) {
    const id = fourcc(bytes, offset);
    const size = readU32(bytes, offset + 4);
    if (id === "VP8L") return "lossless";
    if (id === "VP8 ") return "lossy";
    if (id === "ANMF" || id === "ANIM") return "invalid";
    offset += 8 + size + (size & 1);
  }
  return "invalid";
}
function acceptWebp(mimeType, bytes) {
  if (mimeType !== "image/webp") return false;
  const kind = sniffWebp(bytes);
  return kind === "lossy" || kind === "lossless";
}
function fourcc(bytes, at) {
  return String.fromCharCode(bytes[at] ?? 0, bytes[at + 1] ?? 0, bytes[at + 2] ?? 0, bytes[at + 3] ?? 0);
}
function readU32(bytes, at) {
  return ((bytes[at] ?? 0) | (bytes[at + 1] ?? 0) << 8 | (bytes[at + 2] ?? 0) << 16 | (bytes[at + 3] ?? 0) << 24) >>> 0;
}
async function encodeLayer(canvas, kind, paintQuality) {
  if (kind === "mask" || paintQuality >= 100) {
    const png2 = await toBlob(canvas, "image/png");
    if (!png2) throw new Error("image encoding failed");
    return { blob: png2, bytes: new Uint8Array(await png2.arrayBuffer()), ext: "png" };
  }
  const webp = await toBlob(canvas, "image/webp", paintQuality / 100);
  if (webp) {
    const bytes = new Uint8Array(await webp.arrayBuffer());
    if (acceptWebp(webp.type, bytes)) return { blob: webp, bytes, ext: "webp" };
  }
  const png = await toBlob(canvas, "image/png");
  if (!png) throw new Error("image encoding failed");
  return { blob: png, bytes: new Uint8Array(await png.arrayBuffer()), ext: "png" };
}
function toBlob(canvas, type, quality) {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}
const IDLE_UPLOAD_DELAY_MS = 5e3;
class LayerUploader {
  /**
   * @param editor - Editor whose layers are uploaded.
   * @param knownFiles - Every file reference this document has used (updated).
   */
  constructor(editor, knownFiles) {
    this.editor = editor;
    this.knownFiles = knownFiles;
  }
  editor;
  knownFiles;
  running = null;
  timer = null;
  failureNotified = false;
  disposed = false;
  /**
   * Idle fallback: upload {@link IDLE_UPLOAD_DELAY_MS} after the last call
   * (debounced; call on every edit). Failures are reported, never thrown.
   */
  schedule() {
    if (this.disposed) return;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flushQuietly();
    }, IDLE_UPLOAD_DELAY_MS);
  }
  /** Upload now if dirty (disengage, fullscreen exit); failures only toast. */
  flushQuietly() {
    if (this.disposed || !this.editor.dirty) return;
    this.flush().catch(() => void 0);
  }
  /**
   * Upload every dirty layer now.
   * @throws If any upload failed (after a toast); successful layers are kept.
   */
  async flush() {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    while (this.running) await this.running.catch(() => void 0);
    if (this.disposed || !this.editor.dirty) return;
    this.running = this.uploadDirty();
    try {
      await this.running;
    } finally {
      this.running = null;
    }
  }
  /** Stop scheduled uploads. In-flight requests finish but are ignored. */
  dispose() {
    this.disposed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
  async uploadDirty() {
    const failures = [];
    const paintQuality = normalizePaintQuality(readSetting(PAINT_QUALITY_ID));
    for (const layer of [...this.editor.doc.layers]) {
      const rt = this.editor.layerRuntime(layer.id);
      if (!rt?.dirty) continue;
      const version = rt.version;
      try {
        const file = await this.uploadLayer(layer.id, layer.kind, layer.file, paintQuality);
        if (this.disposed) return;
        if (file) this.knownFiles.add(file);
        this.editor.markUploaded(layer.id, version, file);
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (failures.length) {
      if (!this.failureNotified) {
        notify("error", `Could not save paint layers (kept in memory, will retry): ${failures[0]}`);
        this.failureNotified = true;
      }
      throw new Error(`PainterSketch upload failed: ${failures[0]}`);
    }
    this.failureNotified = false;
  }
  /** @returns The file reference for the layer's current pixels (null = empty). */
  async uploadLayer(layerId, kind, currentFile, paintQuality) {
    const canvas = this.editor.layerCanvas(layerId);
    if (isCanvasEmpty(canvas)) return null;
    const { blob, bytes, ext } = await encodeLayer(canvas, kind, paintQuality);
    const name = layerFileName(this.editor.doc.docId, contentHash(bytes), ext);
    const expected = `${DOCUMENT_SUBFOLDER}/${name} [input]`;
    if (currentFile === expected || this.knownFiles.has(expected)) return expected;
    return uploadImage(blob, name);
  }
}
function isCanvasEmpty(canvas) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return false;
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  for (let i = 3; i < data.length; i += 4) if (data[i] !== 0) return false;
  return true;
}
async function uploadImage(blob, name) {
  const body = new FormData();
  body.append("image", blob, name);
  body.append("type", "input");
  body.append("subfolder", DOCUMENT_SUBFOLDER);
  body.append("overwrite", "true");
  const response = await api.fetchApi("/upload/image", { method: "POST", body });
  if (response.status !== 200) throw new Error(`upload returned ${response.status} ${response.statusText}`);
  const data = await response.json();
  if (!isUploadResponse(data)) throw new Error("upload response is missing 'name'");
  const subfolder = data.subfolder || DOCUMENT_SUBFOLDER;
  return `${subfolder}/${data.name} [${data.type || "input"}]`;
}
function isUploadResponse(value) {
  return typeof value === "object" && value !== null && typeof value.name === "string";
}
async function restoreLayers(editor, isAlive) {
  const layers = editor.doc.layers.filter((l) => l.file);
  if (!layers.length) return;
  const bounds = editor.bounds;
  editor.beginLoading();
  try {
    await Promise.all(
      layers.map(async (layer) => {
        const item = parseAnnotatedFilename(layer.file, "input");
        if (!item) return;
        try {
          const image = await loadImage(viewUrl(item, (route) => api.apiURL(route)));
          if (!isAlive()) return;
          if (image.naturalWidth !== bounds.width || image.naturalHeight !== bounds.height) {
            log.warn(
              `Layer "${layer.name}" is ${image.naturalWidth}x${image.naturalHeight}, expected ${bounds.width}x${bounds.height}`
            );
          }
          editor.restoreLayerPixels(layer.id, image);
        } catch {
          if (isAlive()) notify("warn", `Missing paint layer file ${layer.file}; layer "${layer.name}" is empty.`);
        }
      })
    );
  } finally {
    if (isAlive()) editor.endLoading();
  }
}
function loadImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = "async";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`could not load ${url}`));
    image.src = url;
  });
}
const MAX_DETACHED_SESSIONS = 6;
const RECENT_SIGNATURES = 4;
const sessions = /* @__PURE__ */ new Map();
const detachedOrder = [];
function createSession(doc, source, editor) {
  releaseSession(doc.docId);
  const ed = editor ?? new Editor(doc, source);
  const knownFiles = /* @__PURE__ */ new Set();
  for (const layer of ed.doc.layers) if (layer.file) knownFiles.add(layer.file);
  const session = {
    docId: doc.docId,
    editor: ed,
    tools: createDefaultTools(ed),
    uploader: new LayerUploader(ed, knownFiles),
    knownFiles,
    recentSignatures: [fileSignature(ed.doc)],
    owner: null,
    alive: true,
    ready: Promise.resolve()
  };
  ed.events.on("change", () => {
    const signature = fileSignature(ed.doc);
    const list = session.recentSignatures;
    if (list[list.length - 1] === signature) return;
    list.push(signature);
    if (list.length > RECENT_SIGNATURES) list.shift();
  });
  if (!editor) session.ready = restoreLayers(ed, () => session.alive);
  sessions.set(doc.docId, session);
  return session;
}
function findSession(docId) {
  return sessions.get(docId);
}
function fileSignature(doc) {
  return `${doc.frame.width}x${doc.frame.height}|${doc.layers.map((l) => `${l.id}=${l.file ?? ""}`).join(",")}`;
}
function sessionMatches(session, doc) {
  return session.recentSignatures.includes(fileSignature(doc));
}
function attachSession(session, owner) {
  session.owner = owner;
  const index = detachedOrder.indexOf(session.docId);
  if (index >= 0) detachedOrder.splice(index, 1);
}
function detachSession(session, owner) {
  if (session.owner !== owner) return;
  session.owner = null;
  if (!session.alive) return;
  detachedOrder.push(session.docId);
  while (detachedOrder.length > MAX_DETACHED_SESSIONS) {
    const oldest = detachedOrder.shift();
    if (oldest) releaseSession(oldest);
  }
}
function releaseSession(docId) {
  const session = sessions.get(docId);
  if (!session) return;
  sessions.delete(docId);
  const index = detachedOrder.indexOf(docId);
  if (index >= 0) detachedOrder.splice(index, 1);
  session.alive = false;
  session.uploader.dispose();
  session.editor.dispose();
}
const controllers = /* @__PURE__ */ new WeakMap();
function getController(node) {
  return controllers.get(node);
}
class PainterSketchController {
  /**
   * @param node - The node this controller belongs to.
   */
  constructor(node) {
    this.node = node;
    this.host = new EditorHost({
      onBecameVisible: () => this.refresh(),
      isDetached: () => this.isOffViewedGraph(),
      onDisengage: () => this.session?.uploader.flushQuietly(),
      onSave: () => void this.saveWorkflow()
    });
    this.isolation = isolateEvents({
      root: this.host.root,
      stage: this.host.stage,
      onWheel: (event) => this.host.input.handleWheel(event),
      onChromeWheel: (event) => this.host.handleChromeWheel(event),
      onMiddlePointer: (event) => this.host.input.handlePointer(event)
    });
    controllers.set(node, this);
    this.attach(createSession(createEmptyDocument(this.fallbackFrame().size), "widgets"));
  }
  node;
  /** Editor DOM shell; its `element` is the DOM widget element. */
  host;
  session = null;
  sessionUnbind = null;
  valueCache = "";
  lastExecuted = null;
  /** Last loaded background image; shown only while `image` is connected. */
  background = null;
  /** Key of the most recent source we started loading (success or not). */
  requestedKey = null;
  /** A background load is in flight. */
  loadPending = false;
  loadSeq = 0;
  /**
   * Session handed off by this node's previous instance, until the widget
   * value has been applied (same task; see `handoff.ts`).
   */
  handoff = null;
  contentKey = "";
  pollTimer = null;
  startTimer = null;
  listening = false;
  isolation;
  /** A Ctrl+S flush + save is in progress. */
  saving = false;
  disposed = false;
  handleApiExecuted = () => this.refresh();
  // ── Widget value ────────────────────────────────────────────────────────
  /** @returns The manifest string (`""` = never painted). */
  getValue() {
    return this.valueCache;
  }
  /**
   * A value arrived from outside (workflow load, paste, graph undo, ...).
   *
   * @param value - Incoming widget value.
   */
  setValue(value) {
    if (this.disposed) return;
    if (!this.handoff && typeof value === "string" && value === this.valueCache) return;
    const parsed = parseDocument(value);
    if (parsed.status === "ok") {
      this.attach(this.sessionFor(parsed.document));
      this.handoff = null;
      return;
    }
    if (parsed.status === "invalid") {
      notify("warn", `Could not read the saved painting (${parsed.reason}); starting with an empty canvas.`);
    }
    const handoff = this.handoff?.alive && this.handoff.owner === null ? this.handoff : null;
    this.handoff = null;
    const choice = chooseForEmpty(parsed.status, {
      hasPaint: this.session?.editor.hasPaint ?? false,
      handoff: handoff !== null
    });
    if (choice === "adopt" && handoff) this.attach(handoff);
    else if (choice === "reset") this.attach(createSession(createEmptyDocument(this.fallbackFrame().size), "widgets"));
  }
  /**
   * Value for the prompt: uploads dirty layers first (decision 8).
   * @returns Manifest string.
   * @throws If an upload failed (the toast has been shown); queueing stops so
   *   the output never silently differs from the editor.
   */
  async serialize() {
    const session = this.session;
    if (!session) return this.valueCache;
    await session.ready;
    await session.uploader.flush();
    if (session.editor.hiddenMaskHasContent()) {
      session.editor.events.emit("note", HIDDEN_MASK_NOTE);
    }
    return this.valueCache;
  }
  /**
   * Ctrl/Cmd+S in the editor: upload dirty layers, then run ComfyUI's save
   * command so the saved workflow references the new files (the widget value
   * is updated by the upload's `change` event before the save serializes).
   * If an upload failed (already toasted), ask before saving the workflow
   * without the latest paint; the pixels stay in memory either way.
   */
  async saveWorkflow() {
    if (this.saving) return;
    this.saving = true;
    try {
      const session = this.session;
      if (session) {
        try {
          await session.ready;
          await session.uploader.flush();
        } catch {
          if (!window.confirm("Upload failed; save anyway without the latest paint?")) return;
        }
      }
      await executeCommand(SAVE_WORKFLOW_COMMAND);
    } catch (error) {
      notify("error", `Could not save the workflow: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.saving = false;
    }
  }
  // ── Lifecycle (called from node hooks) ──────────────────────────────────
  /**
   * Node constructor finished: chain our own widgets' callbacks so fallback
   * frame edits apply immediately (the poll catches programmatic changes).
   */
  handleNodeCreated() {
    for (const name of [INPUT_NAMES.width, INPUT_NAMES.height, INPUT_NAMES.background]) {
      const widget = this.findWidget(name);
      if (!widget) continue;
      const original = widget.callback;
      widget.callback = (...args) => {
        const [value, ...rest] = args;
        original?.call(widget, value, ...rest);
        this.updateContent();
      };
    }
    this.updateContent();
  }
  /**
   * Node added to a graph (before `configure` applies saved values): claim a
   * hand-off from a predecessor re-created in this task, then start listening.
   */
  handleAdded() {
    if (this.disposed || this.listening) return;
    this.listening = true;
    const key = handoffKey(this.node);
    const handoff = key ? takeHandoff(key) : void 0;
    if (handoff) this.adoptHandoff(handoff);
    api.addEventListener("executed", this.handleApiExecuted);
    this.pollTimer = setInterval(() => this.tick(), SOURCE_POLL_MS);
    this.startTimer = setTimeout(() => {
      this.startTimer = null;
      this.refresh();
    }, 0);
  }
  /**
   * Our node executed; its `ui` output carries the input image preview.
   * @param output - Execution output.
   */
  handleExecuted(output) {
    this.lastExecuted = output;
    this.refresh();
  }
  /**
   * A link on our node changed.
   * @param type - Slot type (`LINK_INPUT` for inputs).
   * @param slot - Slot index.
   * @param isConnected - `false` when a link was removed.
   */
  handleConnectionsChange(type, slot, isConnected) {
    if (this.startTimer !== null) {
      this.updateContent();
      return;
    }
    const imageSlot = inputSlotIndex(this.node, INPUT_NAMES.image);
    if (type === LINK_INPUT && slot === imageSlot && !isConnected && this.session && this.node.graph) {
      this.handleImageDisconnected(this.session.editor.imageSize);
    }
    this.refresh();
  }
  /**
   * `image` lost its link (a user edit, not a load): the widgets take over the
   * last image size so the canvas keeps its size and the node shows it.
   * Deferred a microtask so a link replaced by another (disconnect, then
   * connect in one call) leaves the widgets alone.
   * @param size - Image size shown when the link was removed.
   */
  handleImageDisconnected(size) {
    queueMicrotask(() => {
      if (this.disposed || this.isImageConnected()) return;
      const width = this.setWidgetValue(INPUT_NAMES.width, widgetDimension(size.width));
      const height = this.setWidgetValue(INPUT_NAMES.height, widgetDimension(size.height));
      if (!width && !height) return;
      this.node.graph?.incrementVersion?.();
      app.canvas?.setDirty?.(true, true);
    });
  }
  /**
   * Set a widget's value like a user edit: the value setter (backed by the
   * widget value store, so both renderers update) plus its callback (ours
   * re-applies the frame; see `handleNodeCreated`).
   * @returns `true` if the value changed.
   */
  setWidgetValue(name, value) {
    const widget = this.findWidget(name);
    if (!widget || widget.value === value) return false;
    widget.value = value;
    widget.callback?.(widget.value);
    return true;
  }
  /**
   * Release node-bound resources; the session is only detached. The widget
   * element and state are offered to a successor re-created in the same task
   * (graph undo/redo), else the element is removed. Idempotent.
   */
  dispose() {
    if (this.disposed) return;
    const key = handoffKey(this.node);
    const session = this.session;
    this.disposed = true;
    this.loadSeq++;
    if (this.listening) api.removeEventListener("executed", this.handleApiExecuted);
    this.listening = false;
    if (this.pollTimer !== null) clearInterval(this.pollTimer);
    if (this.startTimer !== null) clearTimeout(this.startTimer);
    this.pollTimer = null;
    this.startTimer = null;
    this.detach();
    this.isolation.dispose();
    this.host.dispose();
    controllers.delete(this.node);
    const element = this.host.element;
    if (!key) {
      element.remove();
      return;
    }
    offerHandoff(key, {
      element,
      session: session?.alive ? session : null,
      background: this.background,
      lastExecuted: this.lastExecuted
    });
  }
  /**
   * Take over from the removed previous instance of this node: put our
   * element into its renderer slot (Nodes 2.0 does not remount the widget),
   * reuse its background, and remember its session for `setValue`.
   */
  adoptHandoff(handoff) {
    const element = this.host.element;
    if (!element.isConnected && handoff.element.isConnected) handoff.element.replaceWith(element);
    else handoff.element.remove();
    this.lastExecuted ??= handoff.lastExecuted;
    if (handoff.background) {
      this.background = handoff.background;
      this.requestedKey = handoff.background.key;
    }
    const session = handoff.session;
    if (!session?.alive || session.owner !== null) return;
    this.handoff = session;
    queueMicrotask(() => {
      if (this.handoff !== session) return;
      this.handoff = null;
      if (!this.disposed && session.alive && session.owner === null && this.valueCache === "") this.attach(session);
    });
  }
  // ── Sessions ────────────────────────────────────────────────────────────
  /** Pick/create the session for a parsed manifest. */
  sessionFor(doc) {
    const existing = findSession(doc.docId);
    if (!existing) return createSession(doc, "document");
    const choice = chooseForManifest({
      owner: existing.owner === null ? "none" : existing.owner === this ? "self" : "other",
      matchesRecent: sessionMatches(existing, doc),
      handedOff: existing === this.handoff
    });
    switch (choice) {
      case "reuse":
        return existing;
      case "restore":
        return createSession(doc, "document");
      case "fork-copy":
      case "fork-restore": {
        const docId = createId();
        return choice === "fork-copy" ? createSession({ ...doc, docId }, "document", existing.editor.fork(docId)) : createSession({ ...doc, docId }, "document");
      }
    }
  }
  attach(session) {
    if (session === this.session) {
      this.syncValue();
      return;
    }
    this.detach();
    this.session = session;
    attachSession(session, this);
    const { editor } = session;
    const offChange = editor.events.on("change", () => {
      this.syncValue();
      if (editor.dirty) session.uploader.schedule();
    });
    this.sessionUnbind = offChange;
    this.host.setSession(session);
    this.contentKey = "";
    this.syncValue();
    this.updateContent();
    if (editor.dirty) session.uploader.schedule();
  }
  detach() {
    const session = this.session;
    if (!session) return;
    this.sessionUnbind?.();
    this.sessionUnbind = null;
    this.session = null;
    this.host.setSession(null);
    if (!session.editor.hasPaint && !session.editor.dirty) releaseSession(session.docId);
    else {
      session.uploader.flushQuietly();
      detachSession(session, this);
    }
  }
  syncValue() {
    const editor = this.session?.editor;
    if (!editor) return;
    const untouched = !editor.hasPaint && editor.doc.layers.every((l) => l.file === null);
    this.valueCache = untouched ? "" : stringifyDocument(editor.doc);
  }
  // ── Background resolution ───────────────────────────────────────────────
  /**
   * Re-resolve the background source and reload only if it changed. While
   * `image` is disconnected no source is used and in-flight loads are dropped.
   */
  refresh() {
    if (this.disposed) return;
    if (this.isImageConnected()) {
      const source = this.resolveSource();
      if (source && source.key !== this.requestedKey) this.load(source);
    } else if (this.requestedKey !== (this.background?.key ?? null)) {
      this.loadSeq++;
      this.loadPending = false;
      this.requestedKey = this.background?.key ?? null;
    }
    this.updateContent();
  }
  tick() {
    if (!this.host.isVisible()) return;
    this.host.refreshScale();
    this.refresh();
  }
  /**
   * Fullscreen exit check: the node left its graph (removal, tab switch
   * clears `node.graph`) or another graph is being viewed (subgraph
   * navigation; Nodes 2.0 also unmounts the widget then).
   */
  isOffViewedGraph() {
    const graph = this.node.graph;
    if (!graph) return true;
    const viewed = app.canvas?.graph;
    return viewed != null && viewed !== graph;
  }
  isImageConnected() {
    return isInputConnected(this.node, INPUT_NAMES.image);
  }
  /** Live upstream source first, else our own last executed preview. */
  resolveSource() {
    const slot = inputSlotIndex(this.node, INPUT_NAMES.image);
    const upstream = slot >= 0 ? findUpstreamNode(this.node, slot) : null;
    return (upstream ? sourceFromNode(upstream) : null) ?? sourceFromExecuted(this.node, this.lastExecuted);
  }
  /** Load `source`; results of superseded loads are ignored. */
  load(source) {
    this.requestedKey = source.key;
    this.loadPending = true;
    const seq = ++this.loadSeq;
    const image = new Image();
    image.decoding = "async";
    image.onload = () => {
      if (seq !== this.loadSeq || this.disposed) return;
      this.loadPending = false;
      if (!image.naturalWidth || !image.naturalHeight) {
        this.updateContent();
        return;
      }
      this.background = {
        key: source.key,
        image,
        size: { width: image.naturalWidth, height: image.naturalHeight }
      };
      this.updateContent();
    };
    image.onerror = () => {
      if (seq !== this.loadSeq || this.disposed) return;
      this.loadPending = false;
      this.updateContent();
      log.warn(`Could not load background image from ${source.origin} node:`, source.url);
    };
    image.src = source.url;
  }
  // ── Content ─────────────────────────────────────────────────────────────
  /**
   * Push background + frame decisions to the editor when anything relevant
   * changed. The current image is the loaded upstream image while connected,
   * else `width` x `height` filled with `background`; either way an empty
   * editor adopts its size and a painted one only maps onto it.
   */
  updateContent() {
    const session = this.session;
    if (this.disposed || !session) return;
    const { editor } = session;
    const connected = this.isImageConnected();
    const bg = connected ? this.background : null;
    if (bg) {
      const key2 = `${session.docId}|image|${bg.key}`;
      if (key2 === this.contentKey) return;
      this.contentKey = key2;
      editor.setBackground({ kind: "image", image: bg.image }, bg.size);
      editor.handleBackgroundSize(bg.size);
      return;
    }
    const awaitingImage = connected && (this.loadPending || this.requestedKey === null);
    if (awaitingImage && editor.background.kind === "image") return;
    const frame = this.fallbackFrame();
    const key = `${session.docId}|fill|${frame.color}|${frame.size.width}x${frame.size.height}`;
    if (key === this.contentKey) return;
    this.contentKey = key;
    editor.setBackground({ kind: "fill", color: frame.color }, frame.size);
    editor.handleBackgroundSize(frame.size);
  }
  /**
   * The current image while disconnected: `width` x `height` filled with
   * `background`. Like any upstream image, an empty document adopts it and a
   * painted one is shown through the frame map (decision 4).
   */
  fallbackFrame() {
    return resolveFallbackFrame(
      this.findWidget(INPUT_NAMES.width)?.value,
      this.findWidget(INPUT_NAMES.height)?.value,
      this.findWidget(INPUT_NAMES.background)?.value
    );
  }
  findWidget(name) {
    return this.node.widgets?.find((widget) => widget.name === name);
  }
}
function installNodeHooks(nodeType) {
  const proto = nodeType.prototype;
  const onNodeCreated = proto.onNodeCreated;
  proto.onNodeCreated = function() {
    onNodeCreated?.call(this);
    this.hideOutputImages = true;
    const [width, height] = this.size;
    this.setSize([Math.max(width, DEFAULT_NODE_SIZE[0]), Math.max(height, DEFAULT_NODE_SIZE[1])]);
    getController(this)?.handleNodeCreated();
  };
  const onAdded = proto.onAdded;
  proto.onAdded = function(graph) {
    onAdded?.call(this, graph);
    getController(this)?.handleAdded();
  };
  const onExecuted = proto.onExecuted;
  proto.onExecuted = function(output) {
    onExecuted?.call(this, output);
    getController(this)?.handleExecuted(output);
  };
  const onConnectionsChange = proto.onConnectionsChange;
  proto.onConnectionsChange = function(...args) {
    onConnectionsChange?.apply(this, args);
    const [type, slot, isConnected] = args;
    getController(this)?.handleConnectionsChange(type, slot, isConnected);
  };
  const onRemoved = proto.onRemoved;
  proto.onRemoved = function() {
    onRemoved?.call(this);
    getController(this)?.dispose();
  };
  proto.onDrawBackground = function() {
  };
}
const colorPickerCss = "/*\n * PainterSketch colour picker popover (M3.2). Scoped under .cps-* to avoid\n * collisions with ComfyUI. Injected together with editor.css by inject.ts.\n * CSS variables are inherited from .cps-root (editor.css).\n */\n\n/* ── Picker container ──────────────────────────────────────────────────── */\n\n.cps-picker {\n  display: flex;\n  flex-direction: column;\n  gap: 6px;\n  width: 200px;\n  user-select: none;\n}\n\n/* ── Title row ─────────────────────────────────────────────────────────── */\n\n.cps-picker-title {\n  font-size: 10px;\n  font-weight: 600;\n  color: var(--cps-fg-muted);\n  text-transform: uppercase;\n  letter-spacing: 0.04em;\n  padding: 0 2px;\n}\n\n/* ── SV square ─────────────────────────────────────────────────────────── */\n\n.cps-picker-sv {\n  position: relative;\n  width: 100%;\n  aspect-ratio: 1 / 1;\n  border-radius: 3px;\n  overflow: hidden;\n  cursor: crosshair;\n  touch-action: none;\n  flex: none;\n}\n\n.cps-picker-sv-canvas {\n  display: block;\n  width: 100%;\n  height: 100%;\n}\n\n/* Thumb marker on the SV square */\n.cps-picker-sv-thumb {\n  position: absolute;\n  width: 10px;\n  height: 10px;\n  border-radius: 50%;\n  border: 2px solid #fff;\n  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.6);\n  transform: translate(-50%, -50%);\n  pointer-events: none;\n  will-change: left, top;\n}\n\n/* ── Hue slider ────────────────────────────────────────────────────────── */\n\n.cps-picker-hue {\n  position: relative;\n  height: 12px;\n  border-radius: 6px;\n  background: linear-gradient(\n    to right,\n    #f00 0%,\n    #ff0 16.67%,\n    #0f0 33.33%,\n    #0ff 50%,\n    #00f 66.67%,\n    #f0f 83.33%,\n    #f00 100%\n  );\n  cursor: ew-resize;\n  touch-action: none;\n  flex: none;\n}\n\n.cps-picker-hue-thumb {\n  position: absolute;\n  top: 50%;\n  width: 14px;\n  height: 14px;\n  border-radius: 50%;\n  border: 2px solid #fff;\n  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.6);\n  transform: translate(-50%, -50%);\n  pointer-events: none;\n  will-change: left;\n}\n\n/* ── Hex input row ─────────────────────────────────────────────────────── */\n\n.cps-picker-hex-row {\n  display: flex;\n  align-items: center;\n  gap: 4px;\n}\n\n.cps-picker-hex-label {\n  font-size: 10px;\n  color: var(--cps-fg-muted);\n  flex: none;\n}\n\n.cps-picker-hex-input {\n  flex: 1 1 auto;\n  height: 20px;\n  padding: 0 4px;\n  border: 1px solid var(--cps-border);\n  border-radius: 3px;\n  background: var(--cps-input-bg);\n  color: var(--cps-fg);\n  font: inherit;\n  font-variant-numeric: tabular-nums;\n  text-transform: uppercase;\n  outline: none;\n  min-width: 0;\n}\n\n.cps-picker-hex-input:focus {\n  border-color: var(--cps-accent);\n}\n\n.cps-picker-hex-input.cps-invalid {\n  border-color: #c0392b;\n  color: #c0392b;\n}\n\n/* ── Old / new preview ─────────────────────────────────────────────────── */\n\n.cps-picker-preview {\n  display: flex;\n  height: 16px;\n  border-radius: 3px;\n  overflow: hidden;\n  border: 1px solid var(--cps-border);\n  cursor: pointer;\n  flex: none;\n}\n\n.cps-picker-preview-old,\n.cps-picker-preview-new {\n  flex: 1 1 auto;\n}\n\n.cps-picker-preview-old {\n  cursor: pointer; /* click to revert */\n}\n\n/* ── Recent colours ────────────────────────────────────────────────────── */\n\n.cps-picker-recents {\n  display: flex;\n  flex-wrap: wrap;\n  gap: 3px;\n  flex: none;\n}\n\n.cps-picker-recent {\n  width: 16px;\n  height: 16px;\n  border-radius: 2px;\n  border: 1px solid rgba(0, 0, 0, 0.35);\n  box-shadow: 0 0 0 1px color-mix(in srgb, #fff 25%, transparent);\n  cursor: pointer;\n  padding: 0;\n  background: transparent; /* set via inline style */\n  flex: none;\n}\n\n.cps-picker-recent:hover {\n  outline: 2px solid var(--cps-accent);\n  outline-offset: 1px;\n}\r\n";
const controlsCss = "/*\n * PainterSketch options bar, option controls and popovers (split from\n * editor.css to keep files small; theme variables are defined on .cps-root\n * there). Injected together by styles/inject.ts.\n */\n\n/* ── Main column: options bar + body ───────────────────────────────────── */\n\n.cps-main {\n  flex: 1 1 auto;\n  display: flex;\n  flex-direction: column;\n  min-width: 0;\n  min-height: 0;\n}\n\n.cps-bar {\n  flex: 0 0 var(--cps-bar-height);\n  display: flex;\n  align-items: center;\n  min-width: 0;\n  background: var(--cps-chrome-bg);\n  border-bottom: 1px solid var(--cps-border);\n}\n\n.cps-bar-leading,\n.cps-bar-trailing {\n  flex: none;\n  display: flex;\n  align-items: center;\n  gap: 4px;\n  padding: 0 4px;\n}\n\n.cps-bar-leading:empty {\n  display: none;\n}\n\n.cps-bar-trailing {\n  border-left: 1px solid var(--cps-border);\n}\n\n.cps-bar-scroller {\n  flex: 1 1 auto;\n  display: flex;\n  flex-wrap: nowrap;\n  align-items: center;\n  gap: 8px;\n  min-width: 0;\n  height: 100%;\n  padding: 0 6px;\n  overflow-x: auto;\n  overflow-y: hidden;\n  scrollbar-width: none;\n  white-space: nowrap;\n}\n\n.cps-bar-sep {\n  flex: none;\n  width: 1px;\n  height: 16px;\n  background: var(--cps-border);\n}\n\n/* Number option: scrubby label + value button. */\n.cps-num,\n.cps-select {\n  flex: none;\n  display: flex;\n  align-items: center;\n  gap: 3px;\n}\n\n.cps-num-label {\n  color: var(--cps-fg-muted);\n  cursor: ew-resize;\n  touch-action: none;\n}\n\n.cps-num-label:hover,\n.cps-num-label.cps-scrubbing {\n  color: var(--cps-fg);\n}\n\n.cps-num-value,\n.cps-select select,\n.cps-num-input {\n  height: 20px;\n  padding: 0 4px;\n  border: 1px solid var(--cps-border);\n  border-radius: 3px;\n  background: var(--cps-input-bg);\n  color: var(--cps-fg);\n  font: inherit;\n  font-variant-numeric: tabular-nums;\n}\n\n.cps-num-value {\n  min-width: 3.4em;\n  text-align: right;\n  cursor: pointer;\n}\n\n.cps-num-value:hover,\n.cps-select select:hover {\n  border-color: var(--cps-fg-muted);\n}\n\n.cps-toggle {\n  flex: none;\n  height: 20px;\n  padding: 0 6px;\n  border: 1px solid var(--cps-border);\n  border-radius: 10px;\n  background: transparent;\n  color: var(--cps-fg-muted);\n  font: inherit;\n  cursor: pointer;\n}\n\n.cps-toggle:hover {\n  background: var(--cps-hover);\n}\n\n.cps-toggle.cps-active {\n  border-color: var(--cps-accent);\n  background: var(--cps-active-bg);\n  color: var(--cps-fg);\n}\n\n.cps-dim {\n  opacity: 0.45;\n}\n\n/* Quick Mask indicator. */\n.cps-mask-badge {\n  padding: 2px 6px;\n  border-radius: 3px;\n  color: #fff;\n  font-weight: 600;\n  text-shadow: 0 0 2px rgba(0, 0, 0, 0.8);\n  white-space: nowrap;\n}\n\n/* Selection actions (shown while a selection exists). */\n.cps-selection-actions:not([hidden]) {\n  display: flex;\n  align-items: center;\n  gap: 4px;\n}\n\n.cps-selection-actions .cps-toggle {\n  display: flex;\n  align-items: center;\n  gap: 3px;\n}\n\n/* ── Popovers ──────────────────────────────────────────────────────────── */\n\n.cps-popover-host {\n  position: absolute;\n  inset: 0;\n  z-index: 10;\n  overflow: hidden;\n  pointer-events: none;\n}\n\n.cps-popover {\n  position: absolute;\n  left: 0;\n  top: 0;\n  pointer-events: auto;\n  padding: 6px;\n  background: var(--cps-surface);\n  border: 1px solid var(--cps-border);\n  border-radius: 4px;\n  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.45);\n}\n\n.cps-slider-pop {\n  display: flex;\n  align-items: center;\n  gap: 6px;\n}\n\n.cps-slider {\n  width: 120px;\n  margin: 0;\n  accent-color: var(--cps-accent);\n}\n\n.cps-num-input {\n  width: 48px;\n  text-align: right;\n  user-select: text;\n  outline: none;\n}\n\n.cps-num-input:focus {\n  border-color: var(--cps-accent);\n}\n\n.cps-num-unit {\n  min-width: 1.2em;\n  color: var(--cps-fg-muted);\n}\n\n/* Collapsed option group (pen pressure): icon button + popover. */\n.cps-option-group {\n  flex: none;\n  color: var(--cps-fg-muted);\n}\n\n.cps-option-group.cps-on {\n  color: var(--cps-accent);\n}\n\n.cps-group-pop {\n  display: flex;\n  flex-direction: column;\n  align-items: flex-start;\n  gap: 6px;\n  min-width: 120px;\n}\n\n.cps-group-title {\n  color: var(--cps-fg-muted);\n  font-weight: 600;\n}\n";
const editorCss = "/*\n * PainterSketch editor styles. Every selector is scoped under .cps-* so we\n * never collide with the ComfyUI frontend. Injected once by styles/inject.ts.\n * Colours come from ComfyUI's palette variables where they exist (so the\n * editor follows the user's theme), with dark fallbacks.\n */\n\n.cps-root {\n  --cps-rail-width: 36px;\n  --cps-bar-height: 28px;\n  --cps-panel-width: 180px;\n  --cps-chrome-bg: var(--comfy-menu-secondary-bg, #292929);\n  --cps-surface: var(--comfy-menu-bg, #353535);\n  --cps-input-bg: var(--comfy-input-bg, #222);\n  --cps-fg: var(--input-text, #ddd);\n  --cps-fg-muted: var(--descrip-text, #999);\n  --cps-border: var(--border-color, #4e4e4e);\n  --cps-accent: var(--p-primary-color, #3b82f6);\n  --cps-hover: color-mix(in srgb, var(--cps-fg) 12%, transparent);\n  --cps-active-bg: color-mix(in srgb, var(--cps-accent) 30%, transparent);\n\n  position: relative;\n  box-sizing: border-box;\n  display: flex;\n  flex-direction: row;\n  width: 100%;\n  height: 100%;\n  /* Nodes 2.0 ignores getMinHeight for DOM widgets; keep a usable floor. */\n  min-height: 244px;\n  min-width: 0;\n  overflow: hidden;\n  background: var(--cps-chrome-bg);\n  border: 1px solid var(--cps-border);\n  border-radius: 4px;\n  color: var(--cps-fg);\n  font: 11px/1.2 system-ui, sans-serif;\n  user-select: none;\n}\n\n.cps-root *,\n.cps-root *::before,\n.cps-root *::after {\n  box-sizing: border-box;\n}\n\n.cps-root [hidden] {\n  display: none !important;\n}\n\n.cps-focus-sink {\n  position: absolute;\n  left: 0;\n  top: 0;\n  width: 1px;\n  height: 1px;\n  padding: 0;\n  border: 0;\n  opacity: 0;\n  pointer-events: none;\n}\n\n.cps-icon {\n  display: block;\n  flex: none;\n}\n\n/* ── Shared buttons ────────────────────────────────────────────────────── */\n\n.cps-rail-button,\n.cps-icon-button {\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  padding: 0;\n  border: 1px solid transparent;\n  border-radius: 4px;\n  background: transparent;\n  color: var(--cps-fg);\n  cursor: pointer;\n}\n\n.cps-rail-button {\n  width: 28px;\n  height: 28px;\n}\n\n.cps-icon-button {\n  width: 24px;\n  height: 22px;\n}\n\n.cps-rail-button:hover:not(:disabled),\n.cps-icon-button:hover:not(:disabled) {\n  background: var(--cps-hover);\n}\n\n.cps-rail-button.cps-active,\n.cps-icon-button.cps-active {\n  border-color: var(--cps-accent);\n  background: var(--cps-active-bg);\n}\n\n.cps-rail-button:disabled {\n  color: var(--cps-fg-muted);\n  opacity: 0.5;\n  cursor: default;\n}\n\n/* ── Tool rail ─────────────────────────────────────────────────────────── */\n\n.cps-rail {\n  flex: 0 0 var(--cps-rail-width);\n  display: flex;\n  flex-direction: column;\n  min-height: 0;\n  background: var(--cps-chrome-bg);\n  border-right: 1px solid var(--cps-border);\r\n}\r\n\r\n/* Focus indicator: the editor owns the keyboard (set by ui/keyboard.ts). */\r\n.cps-root.cps-has-keys .cps-rail {\r\n  box-shadow: inset 2px 0 0 #fff;\r\n}\r\n\r\n.cps-rail-tools {\n  flex: 1 1 auto;\n  display: flex;\n  flex-direction: column;\n  align-items: center;\n  gap: 2px;\n  min-height: 0;\n  padding: 4px 0;\n  overflow-x: hidden;\n  overflow-y: auto;\n  scrollbar-width: none;\n}\n\n.cps-rail-tools::-webkit-scrollbar,\n.cps-bar-scroller::-webkit-scrollbar {\n  display: none;\n}\n\n.cps-rail-group {\n  display: flex;\n  flex-direction: column;\n  gap: 1px;\n  padding-bottom: 3px;\n  border-bottom: 1px solid color-mix(in srgb, var(--cps-border) 60%, transparent);\n}\n\n.cps-rail-group:last-child {\n  border-bottom: 0;\n}\n\n.cps-rail-spacer {\n  flex: 1 1 auto;\n}\n\n.cps-rail-swatches {\n  flex: none;\n  display: flex;\n  justify-content: center;\n  padding: 4px 0 6px;\n  border-top: 1px solid var(--cps-border);\n}\n\n/* ── FG/BG swatches (Photoshop layout) ─────────────────────────────────── */\n\n.cps-swatches {\n  position: relative;\n  width: 30px;\n  height: 30px;\n}\n\n.cps-swatch {\n  position: absolute;\n  width: 19px;\n  height: 19px;\n  padding: 0;\n  border: 1px solid #000;\n  border-radius: 2px;\n  box-shadow: 0 0 0 1px color-mix(in srgb, #fff 45%, transparent);\n  cursor: pointer;\n}\n\n.cps-swatch-fg {\n  left: 0;\n  top: 0;\n  z-index: 1;\n}\n\n.cps-swatch-bg {\n  right: 0;\n  bottom: 0;\n}\n\n.cps-swatch-swap,\n.cps-swatch-reset {\n  position: absolute;\n  width: 11px;\n  height: 11px;\n  padding: 0;\n  border: 0;\n  background: transparent;\n  color: var(--cps-fg-muted);\n  cursor: pointer;\n}\n\n.cps-swatch-swap {\n  right: 0;\n  top: 0;\n}\n\n.cps-swatch-reset {\n  left: 0;\n  bottom: 0;\n}\n\n.cps-swatch-swap:hover,\n.cps-swatch-reset:hover {\n  color: var(--cps-fg);\n}\n\n.cps-reset-bg,\n.cps-reset-fg {\n  position: absolute;\n  width: 6px;\n  height: 6px;\n  border: 1px solid var(--cps-fg-muted);\n}\n\n.cps-reset-fg {\n  left: 0;\n  top: 0;\n  background: #000;\n}\n\n.cps-reset-bg {\n  right: 0;\n  bottom: 0;\n  background: #fff;\n}\n\n/* Colours do not apply while painting the mask. */\n.cps-root.cps-quickmask .cps-swatches {\n  filter: grayscale(1);\n  opacity: 0.6;\n}\n\n.cps-native-color {\n  position: absolute;\n  left: 4px;\n  bottom: 4px;\n  width: 1px;\n  height: 1px;\n  padding: 0;\n  border: 0;\n  opacity: 0;\n  pointer-events: none;\n}\n\n/* ── Body: stage + side panel ──────────────────────────────────────────── */\n\n.cps-body {\n  flex: 1 1 auto;\n  display: flex;\n  flex-direction: row;\n  min-width: 0;\n  min-height: 0;\n}\n\n.cps-stage {\n  position: relative;\n  flex: 1 1 auto;\n  min-width: 0;\n  min-height: 0;\n  overflow: hidden;\n  background: var(--cps-input-bg);\n  touch-action: none;\n  outline: none;\r\n  /* Tool cursor (ui/cursors.ts via StageView.syncCursor); pan/loading below win. */\r\n  cursor: var(--cps-tool-cursor, crosshair);\r\n}\n\n.cps-stage.cps-pan-ready {\n  cursor: grab;\n}\n\n.cps-stage.cps-panning {\n  cursor: grabbing;\n}\n\n.cps-stage.cps-loading {\n  cursor: progress;\n}\n\n.cps-canvas {\n  position: absolute;\n  inset: 0;\n  display: block;\n  width: 100%;\n  height: 100%;\n  touch-action: none;\n}\n\n.cps-overlay {\n  pointer-events: none;\n}\n\n.cps-note {\n  position: absolute;\n  left: 50%;\n  bottom: 8px;\n  transform: translateX(-50%);\n  max-width: calc(100% - 16px);\n  padding: 4px 8px;\n  border-radius: 4px;\n  background: rgba(0, 0, 0, 0.75);\n  color: #fff;\n  pointer-events: none;\n  white-space: nowrap;\n  overflow: hidden;\n  text-overflow: ellipsis;\n}\n\n.cps-side {\n  flex: 0 0 var(--cps-panel-width);\n  display: flex;\n  flex-direction: column;\n  min-height: 0;\n  background: var(--cps-chrome-bg);\n  border-left: 1px solid var(--cps-border);\n}\n\n.cps-side-content {\n  flex: 1 1 auto;\n  min-height: 0;\n  overflow-x: hidden;\n  overflow-y: auto;\n}\n\n.cps-side-placeholder {\n  padding: 6px 8px;\n  color: var(--cps-fg-muted);\n  font-weight: 600;\n  border-bottom: 1px solid var(--cps-border);\n}\r\n";
const fullscreenCss = `/*
 * Widget container + fullscreen overlay (M3.4, ui/fullscreen.ts).
 *
 * .cps-widget is the DOM widget element and never moves; the editor root is
 * its child and moves into .cps-fullscreen (on document.body) while
 * fullscreen, leaving the placeholder button behind.
 *
 * z-index: above ComfyUI's static chrome (top menu 1001, splitter overlay
 * 999, side bars) but below PrimeVue layers (modal/overlay/menu base 1800,
 * tooltips 2000). Toasts share the modal counter with dialogs, so "above
 * dialogs, below toasts" is not possible; dialogs/toasts showing on top of
 * the editor is the safer choice.
 */

.cps-widget {
  position: relative;
  display: flex;
  width: 100%;
  height: 100%;
  /* Nodes 2.0 ignores getMinHeight for DOM widgets; keep a usable floor. */
  min-height: 244px;
  min-width: 0;
}

.cps-widget > .cps-root {
  flex: 1 1 auto;
}

.cps-fullscreen-placeholder {
  flex: 1 1 auto;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  margin: 0;
  padding: 12px;
  border: 1px dashed var(--border-color, #4e4e4e);
  border-radius: 4px;
  background: var(--comfy-menu-secondary-bg, #292929);
  color: var(--descrip-text, #999);
  font: 12px/1.4 system-ui, sans-serif;
  text-align: center;
  cursor: pointer;
  appearance: none;
}

.cps-fullscreen-placeholder:hover {
  color: var(--input-text, #ddd);
  border-color: var(--p-primary-color, #3b82f6);
}

.cps-fullscreen {
  position: fixed;
  inset: 0;
  z-index: 1790;
  box-sizing: border-box;
  display: flex;
  /* Top strip holds the exit button so it never covers the options bar. */
  padding: 40px 12px 12px;
  background: color-mix(in srgb, var(--bg-color, #202020) 92%, black);
  overscroll-behavior: contain;
}

.cps-fullscreen > .cps-root {
  flex: 1 1 auto;
  width: auto;
  height: auto;
  min-height: 0;
  box-shadow: 0 4px 24px rgba(0, 0, 0, 0.5);
}

.cps-fullscreen-exit {
  position: absolute;
  top: 6px;
  right: 12px;
  display: flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  margin: 0;
  padding: 0 10px;
  border: 1px solid var(--border-color, #4e4e4e);
  border-radius: 4px;
  background: var(--comfy-menu-bg, #353535);
  color: var(--input-text, #ddd);
  font: 12px/1 system-ui, sans-serif;
  cursor: pointer;
  appearance: none;
}

.cps-fullscreen-exit:hover {
  background: color-mix(in srgb, var(--input-text, #ddd) 14%, var(--comfy-menu-bg, #353535));
}

.cps-fullscreen-exit:focus-visible,
.cps-fullscreen-placeholder:focus-visible {
  outline: 2px solid var(--p-primary-color, #3b82f6);
  outline-offset: 1px;
}
`;
const layersCss = '/*\n * PainterSketch layers panel (M3.3): header (title + opacity), scrolling row\n * list, footer actions. Lives inside .cps-side-content (editor.css); theme\n * variables come from .cps-root. Injected by styles/inject.ts.\n */\n\n.cps-layers {\n  display: flex;\n  flex-direction: column;\n  height: 100%;\n  min-height: 0;\n  font-size: 11px;\n}\n\n.cps-layers-header {\n  flex: none;\n  display: flex;\n  align-items: center;\n  justify-content: space-between;\n  gap: 4px;\n  padding: 4px 6px;\n  border-bottom: 1px solid var(--cps-border);\n}\n\n.cps-layers-title {\n  font-weight: 600;\n  color: var(--cps-fg-muted);\n}\n\n.cps-layers-list {\n  flex: 1 1 auto;\n  min-height: 0;\n  overflow-x: hidden;\n  overflow-y: auto;\n  overscroll-behavior: contain;\n}\n\n.cps-layers-footer {\n  flex: none;\n  display: flex;\n  align-items: center;\n  justify-content: flex-end;\n  gap: 2px;\n  padding: 3px 4px;\n  border-top: 1px solid var(--cps-border);\n}\n\n/* "Move drawing" toggle sits at the left; a thin divider separates it from\n   the Add/Duplicate/Delete buttons on the right. */\n.cps-layers-move-drawing {\n  margin-right: auto;\n}\n\n.cps-layers-footer-divider {\n  width: 1px;\n  height: 16px;\n  background: var(--cps-border);\n  flex: none;\n  margin: 0 2px;\n}\n\n.cps-layers-action:disabled {\n  opacity: 0.35;\n  cursor: default;\n}\n\n/* ── Rows ──────────────────────────────────────────────────────────────── */\n\n.cps-layer-row {\n  position: relative;\n  padding: 3px 4px;\n  border-bottom: 1px solid color-mix(in srgb, var(--cps-border) 60%, transparent);\n  border-left: 2px solid transparent;\n  cursor: default;\n  user-select: none;\n  touch-action: none;\n}\n\n.cps-layer-paint,\n.cps-layer-mask {\n  cursor: pointer;\n}\n\n.cps-layer-row:hover:not(.cps-layer-background) {\n  background: var(--cps-hover);\n}\n\n.cps-layer-row.cps-selected {\n  background: var(--cps-active-bg);\n  border-left-color: var(--cps-accent);\n}\n\n.cps-layer-row.cps-standby {\n  border-left-color: color-mix(in srgb, var(--cps-accent) 45%, transparent);\n}\n\n.cps-layer-row.cps-dragging {\n  opacity: 0.5;\n}\n\n.cps-layer-row.cps-drop-above::before,\n.cps-layer-row.cps-drop-below::after {\n  content: "";\n  position: absolute;\n  left: 0;\n  right: 0;\n  height: 2px;\n  background: var(--cps-accent);\n  pointer-events: none;\n}\n\n.cps-layer-row.cps-drop-above::before {\n  top: -1px;\n}\n\n.cps-layer-row.cps-drop-below::after {\n  bottom: -1px;\n}\n\n.cps-layer-main,\n.cps-layer-extra {\n  display: flex;\n  align-items: center;\n  gap: 4px;\n  min-width: 0;\n}\n\n.cps-layer-extra {\n  margin: 2px 0 0 42px;\n}\n\n.cps-layer-thumb-box {\n  flex: 0 0 38px;\n  height: 38px;\n  display: flex;\n  align-items: center;\n  justify-content: center;\n}\n\n.cps-layer-thumb {\n  display: block;\n  /* Hard cap so a freshly-created canvas (default 300×150) never escapes the\n   * thumb-box before update() applies its inline style. */\n  max-width: 100%;\n  max-height: 100%;\n  border: 1px solid var(--cps-border);\n  background-color: #fff;\n  background-image:\n    linear-gradient(45deg, #ccc 25%, transparent 25%, transparent 75%, #ccc 75%),\n    linear-gradient(45deg, #ccc 25%, transparent 25%, transparent 75%, #ccc 75%);\n  background-position: 0 0, 4px 4px;\n  background-size: 8px 8px;\n}\n\n.cps-layer-name {\n  flex: 1 1 auto;\n  min-width: 0;\n  overflow: hidden;\n  text-overflow: ellipsis;\n  white-space: nowrap;\n}\n\n.cps-layer-row.cps-hidden-layer .cps-layer-name,\n.cps-layer-row.cps-hidden-layer .cps-layer-thumb {\n  opacity: 0.5;\n}\n\n.cps-layer-rename {\n  width: 100%;\n  height: 18px;\n  box-sizing: border-box;\n  padding: 0 3px;\n  border: 1px solid var(--cps-accent);\n  border-radius: 3px;\n  background: var(--cps-input-bg);\n  color: var(--cps-fg);\n  font: inherit;\n}\n\n.cps-layer-button {\n  flex: none;\n  width: 20px;\n  height: 20px;\n  color: var(--cps-fg-muted);\n}\n\n.cps-layer-button:hover:not(:disabled) {\n  color: var(--cps-fg);\n}\n\n.cps-layer-eye.cps-off,\n.cps-layer-lock:not(.cps-on) {\n  opacity: 0.55;\n}\n\n.cps-layer-lock.cps-on {\n  color: var(--cps-fg);\n}\n\n.cps-layer-lock:disabled {\n  cursor: default;\n  opacity: 0.55;\n}\n\n.cps-layer-swatch {\n  width: 16px;\n  height: 16px;\n  border: 1px solid var(--cps-fg-muted);\n  border-radius: 3px;\n}\n\n.cps-layer-swatch:hover:not(:disabled) {\n  border-color: var(--cps-fg);\n}\n\n.cps-layer-opacity .cps-num-value {\n  min-width: 3em;\n  height: 18px;\n}\n\n.cps-layers .cps-native-color {\n  position: absolute;\n  width: 1px;\n  height: 1px;\n  opacity: 0;\n  pointer-events: none;\n}\n';
const toolGroupsCss = "/* ── Tool group slot + flyout (ui/toolGroupSlot.ts) ─────────────────────── */\n\n.cps-rail-grouped {\n  position: relative;\n}\n\n/* Photoshop's corner triangle: this slot holds more tools. */\n.cps-rail-corner {\n  position: absolute;\n  right: 2px;\n  bottom: 2px;\n  width: 0;\n  height: 0;\n  border-left: 4px solid transparent;\n  border-bottom: 4px solid currentColor;\n  opacity: 0.7;\n  pointer-events: none;\n}\n\n.cps-tool-flyout {\n  display: flex;\n  flex-direction: column;\n  gap: 1px;\n  min-width: 120px;\n}\n\n.cps-tool-flyout-item {\n  display: flex;\n  align-items: center;\n  gap: 8px;\n  padding: 3px 6px;\n  border: 1px solid transparent;\n  border-radius: 3px;\n  background: transparent;\n  color: var(--cps-fg);\n  text-align: left;\n  cursor: pointer;\n}\n\n.cps-tool-flyout-item:hover {\n  background: var(--cps-hover);\n}\n\n.cps-tool-flyout-item.cps-active {\n  border-color: var(--cps-accent);\n  background: var(--cps-active-bg);\n}\n\n.cps-tool-flyout-key {\n  margin-left: auto;\n  color: var(--cps-fg-muted);\n}\n";
const STYLE_ELEMENT_ID = "cps-styles";
function injectStyles() {
  if (document.getElementById(STYLE_ELEMENT_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ELEMENT_ID;
  style.textContent = `${editorCss}
${controlsCss}
${colorPickerCss}
${layersCss}
${fullscreenCss}
${toolGroupsCss}`;
  document.head.appendChild(style);
}
function createPainterSketchWidget(node, inputName, inputData) {
  injectStyles();
  const options = inputData[1] ?? {};
  const controller = new PainterSketchController(node);
  controller.setValue(options.default ?? "");
  const widget = node.addDOMWidget(inputName, DOM_WIDGET_TYPE, controller.host.element, {
    getValue: () => controller.getValue(),
    setValue: (value) => controller.setValue(value),
    getMinHeight: () => WIDGET_MIN_HEIGHT,
    margin: WIDGET_MARGIN,
    socketless: options.socketless ?? true,
    serialize: true
  });
  widget.serializeValue = () => controller.serialize();
  return { widget };
}
app.registerExtension({
  name: EXTENSION_NAME,
  settings: SETTINGS,
  getCustomWidgets: () => ({
    [WIDGET_SPEC_TYPE]: (node, inputName, inputData) => createPainterSketchWidget(node, inputName, inputData)
  }),
  beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_NAME) return;
    installNodeHooks(nodeType);
  }
});
