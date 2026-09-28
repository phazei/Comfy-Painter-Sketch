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
class HttpError extends Error {
  /**
   * @param status - HTTP status code.
   * @param statusText - HTTP status text.
   * @param serverMessage - `error` field of a JSON error body, if any.
   */
  constructor(status, statusText, serverMessage) {
    super(`HTTP ${status}${statusText ? ` ${statusText}` : ""}${serverMessage ? `: ${serverMessage}` : ""}`);
    this.status = status;
    this.statusText = statusText;
    this.serverMessage = serverMessage;
    this.name = "HttpError";
  }
  status;
  statusText;
  serverMessage;
}
class EncodeError extends Error {
  /** @param layerName - Layer that failed to encode. */
  constructor(layerName) {
    super(`could not encode layer "${layerName}"`);
    this.layerName = layerName;
    this.name = "EncodeError";
  }
  layerName;
}
class DecodeError extends Error {
  /** @param url - Image URL (console detail). */
  constructor(url) {
    super(`could not decode ${url}`);
    this.name = "DecodeError";
  }
}
function classifyStatus(status) {
  if (status === 0) return "offline";
  if (status === 404 || status === 405) return "missing";
  if (status === 413) return "tooLarge";
  if (status >= 400 && status < 500) return "rejected";
  if (status >= 500) return "server";
  return "unexpected";
}
function classifyError(error) {
  if (error instanceof HttpError) return classifyStatus(error.status);
  if (error instanceof EncodeError) return "encode";
  if (error instanceof DecodeError) return "unreadable";
  if (error instanceof TypeError) return "offline";
  return "unexpected";
}
function serverErrorMessage(data) {
  if (typeof data !== "object" || data === null) return void 0;
  const message = data.error;
  return typeof message === "string" && message.trim() ? message : void 0;
}
function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}
function uploadFailureMessage(error) {
  const status = error instanceof HttpError ? error.status : 0;
  let reason;
  switch (classifyError(error)) {
    case "offline":
      reason = "the ComfyUI server is unreachable";
      break;
    case "tooLarge":
      reason = "the server rejected the file as too large (HTTP 413)";
      break;
    case "missing":
    case "rejected":
      reason = `the server rejected the upload (${errorText(error)})`;
      break;
    case "server":
      reason = `the server reported an error (HTTP ${status}); check the ComfyUI console (disk full?)`;
      break;
    case "encode":
      reason = `the browser ${errorText(error)} (out of memory? try a smaller canvas)`;
      break;
    default:
      reason = errorText(error);
  }
  return `Could not save paint layers: ${reason}. Your paint is kept in the editor and retried automatically; don't reload the page until it is saved.`;
}
function cleanupFailureReason(error) {
  const kind = classifyError(error);
  if (kind === "offline") return "the ComfyUI server is unreachable";
  if (kind === "missing") {
    return "the cleanup route is not available; the PainterSketch Python node probably failed to load (check the ComfyUI console) or ComfyUI needs a restart after an update";
  }
  if (error instanceof HttpError) {
    if (kind === "server") return `server error (HTTP ${error.status}): ${error.serverMessage ?? "see the ComfyUI console"}`;
    return error.serverMessage ?? error.message;
  }
  return errorText(error);
}
function invalidDocumentMessage(reason) {
  const hint = reason.startsWith("unsupported document version") ? " It was probably saved by a newer PainterSketch; update the node." : "";
  return `Could not read the saved painting (${reason}); showing an empty canvas.${hint} The saved data is kept in the workflow unless you paint on this node.`;
}
function skippedLayersMessage(count) {
  const what = count === 1 ? "1 layer entry" : `${count} layer entries`;
  return `The saved painting has ${what} that could not be read; loaded the rest (details in the console).`;
}
const MAX_NAMES = 3;
function nameList(problems) {
  const names = problems.slice(0, MAX_NAMES).map((p) => `"${p.name}"`);
  const more = problems.length - names.length;
  return more > 0 ? `${names.join(", ")} +${more} more` : names.join(", ");
}
function layers(n) {
  return n === 1 ? "1 layer" : `${n} layers`;
}
function restoreSummary(problems) {
  if (!problems.length) return null;
  const missing = problems.filter((p) => p.kind === "missing");
  const unreadable = problems.filter((p) => p.kind === "unreadable");
  const stale = problems.filter((p) => p.kind === "stale");
  const transient = problems.filter((p) => !["missing", "unreadable", "stale"].includes(p.kind));
  const parts = [];
  if (transient.length) {
    const offline = transient.every((p) => p.kind === "offline");
    const reason = offline ? "the ComfyUI server is unreachable" : "server error, see the console";
    parts.push(
      `${layers(transient.length)} could not be loaded (${reason}): ${nameList(transient)}. Reload the workflow to retry before painting on them.`
    );
  }
  if (missing.length) {
    parts.push(
      `${layers(missing.length)} lost ${missing.length === 1 ? "its" : "their"} file (deleted from input/painter-sketch?): ${nameList(missing)}; loaded empty.`
    );
  }
  if (unreadable.length) {
    parts.push(`${layers(unreadable.length)} could not be decoded (corrupt file?): ${nameList(unreadable)}; loaded empty.`);
  }
  if (missing.length || unreadable.length || transient.length) {
    parts.push("Their saved file references are kept until you edit those layers.");
  }
  if (stale.length) {
    parts.push(
      `${layers(stale.length)} ${stale.length === 1 ? "was" : "were"} saved at an older canvas size (latest edits probably never uploaded): ${nameList(stale)}; check their position.`
    );
  }
  return { severity: transient.length ? "error" : "warn", message: parts.join(" ") };
}
const DEFAULT_TOAST_WINDOW_MS = 1e4;
const MAX_KEYS = 64;
class ToastLimiter {
  /**
   * @param now - Clock in ms (injectable for tests).
   */
  constructor(now2 = () => Date.now()) {
    this.now = now2;
  }
  now;
  /** Key -> time it was last shown. Insertion order = oldest first. */
  shownAt = /* @__PURE__ */ new Map();
  /**
   * Whether a toast with `key` should be shown now; records it if so.
   * A suppressed occurrence does not extend the window, so a persistent
   * problem is re-announced once per window.
   *
   * @param key - Message key (same problem = same key).
   * @param windowMs - Suppression window for this key.
   * @returns `true` to show the toast.
   */
  shouldShow(key, windowMs = DEFAULT_TOAST_WINDOW_MS) {
    const t = this.now();
    const last = this.shownAt.get(key);
    if (last !== void 0 && t - last < windowMs) return false;
    this.shownAt.delete(key);
    this.shownAt.set(key, t);
    while (this.shownAt.size > MAX_KEYS) {
      const oldest = this.shownAt.keys().next().value;
      if (oldest === void 0) break;
      this.shownAt.delete(oldest);
    }
    return true;
  }
  /**
   * Forget a key, so its next occurrence shows immediately (e.g. after the
   * problem was resolved).
   * @param key - Message key.
   */
  reset(key) {
    this.shownAt.delete(key);
  }
}
const limiter = new ToastLimiter();
function notify(severity, detail, options = {}) {
  const details = options.details ?? [];
  if (severity === "error") log.error(detail, ...details);
  else if (severity === "warn") log.warn(detail, ...details);
  if (!limiter.shouldShow(options.key ?? `${severity}:${detail}`, options.windowMs)) return;
  const toast = app.extensionManager?.toast;
  if (toast && typeof toast.add === "function") {
    toast.add({ severity, summary: "PainterSketch", detail, life: severity === "error" ? 1e4 : 6e3 });
  }
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
function isRecord$2(value) {
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
  const store2 = isRecord$2(manager) ? manager["workflow"] : void 0;
  const open = isRecord$2(store2) ? store2["openWorkflows"] : void 0;
  if (!Array.isArray(open)) return;
  for (const workflow of open) {
    if (!isRecord$2(workflow)) continue;
    scanValue(workflow["content"], into);
    scanValue(workflow["originalContent"], into);
    const tracker = workflow["changeTracker"];
    if (!isRecord$2(tracker)) continue;
    for (const key of ["activeState", "initialState", "undoQueue", "redoQueue"]) scanValue(tracker[key], into);
  }
}
function scanCurrentGraph(into) {
  const root = app;
  const graph = isRecord$2(root) ? root["graph"] : void 0;
  if (!isRecord$2(graph) || typeof graph["serialize"] !== "function") return;
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
    const data = await postRoute({ mode: "stats" });
    if (!isStatsResponse(data)) throw new Error("unexpected server response");
    statsLine.textContent = statsText(data);
  } catch (error) {
    log.warn("cleanup stats request failed:", error);
    statsLine.textContent = `Could not load file counts: ${cleanupFailureReason(error)}.`;
  }
}
function statsText(stats) {
  const all = `${stats.all.count} (${formatBytes(stats.all.bytes)})`;
  const old = `${stats.old.count} (${formatBytes(stats.old.bytes)})`;
  return `Files: ${all} · Older than 24 h: ${old}`;
}
async function postRoute(body) {
  const response = await api.fetchApi(CLEANUP_ROUTE, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new HttpError(response.status, response.statusText, serverErrorMessage(data));
  return data;
}
async function postCleanup(dryRun, referenced) {
  const data = await postRoute({ dryRun, referenced });
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
    notify("warn", `File cleanup failed: ${cleanupFailureReason(error)}.`, { details: [error] });
  } finally {
    void fetchStats(statsLine);
  }
}
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
function clampNumber(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
function rectContainsPoint(rect, p) {
  return p.x >= rect.x && p.y >= rect.y && p.x <= rect.x + rect.width && p.y <= rect.y + rect.height;
}
function frameRect(frame) {
  return { x: 0, y: 0, width: frame.width, height: frame.height };
}
const DEFAULT_LINE_HEIGHT = 1.25;
const MIN_TEXT_SIZE = 1;
const MAX_TEXT_SIZE = 4096;
const MAX_TEXT_LENGTH = 1e4;
const MAX_FONT_LENGTH = 100;
const DEFAULT_TEXT_STYLE = {
  font: "sans-serif",
  size: 48,
  color: "#000000",
  align: "left"
};
const ALIGNS = /* @__PURE__ */ new Set(["left", "center", "right"]);
function readTextData(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const v = value;
  const text = v["text"];
  const x = v["x"];
  const y = v["y"];
  if (typeof text !== "string" || !isFiniteNumber(x) || !isFiniteNumber(y)) return null;
  const font = typeof v["font"] === "string" ? cleanFontName(v["font"]) : "";
  const size = v["size"];
  const color = v["color"];
  const align = v["align"];
  const data = {
    text: text.slice(0, MAX_TEXT_LENGTH),
    x,
    y,
    font: font || DEFAULT_TEXT_STYLE.font,
    size: isFiniteNumber(size) ? clampSize(size) : DEFAULT_TEXT_STYLE.size,
    color: typeof color === "string" && /^#[0-9a-f]{6}$/i.test(color) ? color.toLowerCase() : DEFAULT_TEXT_STYLE.color,
    bold: v["bold"] === true,
    italic: v["italic"] === true,
    align: typeof align === "string" && ALIGNS.has(align) ? align : DEFAULT_TEXT_STYLE.align
  };
  const lineHeight = v["lineHeight"];
  if (isFiniteNumber(lineHeight) && lineHeight > 0) data.lineHeight = Math.min(10, lineHeight);
  const rotation = v["rotation"];
  if (isFiniteNumber(rotation) && normalizeDegrees(rotation) !== 0) data.rotation = normalizeDegrees(rotation);
  return data;
}
function serializeTextData(data) {
  const out = {
    text: data.text,
    x: data.x,
    y: data.y,
    font: data.font,
    size: data.size,
    color: data.color,
    bold: data.bold,
    italic: data.italic,
    align: data.align
  };
  if (data.lineHeight !== void 0) out["lineHeight"] = data.lineHeight;
  if (data.rotation) out["rotation"] = data.rotation;
  return out;
}
function sameTextData(a, b) {
  return a.text === b.text && a.x === b.x && a.y === b.y && a.font === b.font && a.size === b.size && a.color === b.color && a.bold === b.bold && a.italic === b.italic && a.align === b.align && (a.lineHeight ?? DEFAULT_LINE_HEIGHT) === (b.lineHeight ?? DEFAULT_LINE_HEIGHT) && (a.rotation ?? 0) === (b.rotation ?? 0);
}
function normalizeDegrees(deg) {
  if (!Number.isFinite(deg)) return 0;
  let a = deg % 360;
  if (a <= -180) a += 360;
  if (a > 180) a -= 360;
  return a === 0 ? 0 : a;
}
function withRotation(td, deg) {
  const { rotation: _old, ...rest } = td;
  const r = normalizeDegrees(deg);
  return r === 0 ? rest : { ...rest, rotation: r };
}
function cleanFontName(font) {
  return font.replace(/\s+/g, " ").trim().slice(0, MAX_FONT_LENGTH);
}
function clampSize(size) {
  return Math.min(MAX_TEXT_SIZE, Math.max(MIN_TEXT_SIZE, size));
}
const TEXT_NAME_LENGTH = 20;
const EMPTY_TEXT_NAME = "Text";
function nameFromText(text) {
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return EMPTY_TEXT_NAME;
  const chars = [...flat];
  if (chars.length <= TEXT_NAME_LENGTH) return flat;
  return `${chars.slice(0, TEXT_NAME_LENGTH).join("").trimEnd()}…`;
}
function commitName(currentName, previousText, nextText) {
  return currentName === nameFromText(previousText) ? nameFromText(nextText) : currentName;
}
const MAX_RECENT_FONTS = 5;
function pushRecentFont(list, font, max = MAX_RECENT_FONTS) {
  const clean2 = cleanFontName(font);
  if (!clean2) return [...list];
  const key = clean2.toLowerCase();
  return [clean2, ...list.filter((f) => f.toLowerCase() !== key)].slice(0, max);
}
function parseRecentFonts(raw) {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    let out = [];
    for (const entry of [...value].reverse()) if (typeof entry === "string") out = pushRecentFont(out, entry);
    return out;
  } catch {
    return [];
  }
}
function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
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
function createTextLayer(textData) {
  return { ...createPaintLayer(nameFromText(textData.text)), kind: "text", textData };
}
const DEFAULT_MASK_COLOR = "#ff0000";
const DEFAULT_MASK_OPACITY = 0.5;
const FIRST_MASK_NAME = "Mask 1";
const DEFAULT_MASK_STYLE = { color: DEFAULT_MASK_COLOR, opacity: DEFAULT_MASK_OPACITY };
function createMaskLayer(name = FIRST_MASK_NAME, style = DEFAULT_MASK_STYLE) {
  return {
    id: createId(8),
    name,
    kind: "mask",
    visible: true,
    locked: false,
    opacity: style.opacity,
    blendMode: "normal",
    file: null,
    color: style.color,
    invert: false
  };
}
function createEmptyDocument(frame, docId = createId(), maskStyle = DEFAULT_MASK_STYLE) {
  const layer = createPaintLayer("Layer 1");
  const size = { width: Math.round(frame.width), height: Math.round(frame.height) };
  return {
    version: DOCUMENT_VERSION,
    docId,
    frame: size,
    bounds: frameRect(size),
    regions: [],
    activeLayerId: layer.id,
    layers: [layer, createMaskLayer(FIRST_MASK_NAME, maskStyle)]
  };
}
const MASK_COLOR_ID = "PainterSketch.DefaultMaskColor";
const MASK_OPACITY_ID = "PainterSketch.DefaultMaskOpacity";
const OPACITY_MIN = 10;
const OPACITY_MAX = 100;
const MASK_COLOR_SETTING = {
  id: MASK_COLOR_ID,
  category: ["PainterSketch", "Defaults", "Mask colour"],
  name: "Mask colour",
  tooltip: "Overlay colour of the mask in new documents. Existing masks keep their colour.",
  type: "color",
  defaultValue: DEFAULT_MASK_STYLE.color.slice(1)
};
const MASK_OPACITY_SETTING = {
  id: MASK_OPACITY_ID,
  category: ["PainterSketch", "Defaults", "Mask overlay opacity"],
  name: "Mask overlay opacity (%)",
  tooltip: "How strongly the mask overlay is drawn in new documents (display only; the MASK output is unaffected). Existing masks keep theirs.",
  type: "slider",
  attrs: { min: OPACITY_MIN, max: OPACITY_MAX, step: 1 },
  defaultValue: Math.round(DEFAULT_MASK_STYLE.opacity * 100)
};
function normalizeMaskColor(raw) {
  if (typeof raw !== "string") return DEFAULT_MASK_STYLE.color;
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(raw.trim());
  const hex = match?.[1]?.toLowerCase();
  if (!hex) return DEFAULT_MASK_STYLE.color;
  if (hex.length === 3) return `#${[...hex].map((c) => c + c).join("")}`;
  return `#${hex.slice(0, 6)}`;
}
function normalizeMaskOpacity(raw) {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return DEFAULT_MASK_STYLE.opacity;
  return Math.min(OPACITY_MAX, Math.max(OPACITY_MIN, Math.round(raw))) / 100;
}
function firstMaskStyleFrom(read) {
  return { color: normalizeMaskColor(read(MASK_COLOR_ID)), opacity: normalizeMaskOpacity(read(MASK_OPACITY_ID)) };
}
const MASK_PALETTE = ["#0000ff", "#00ff00", "#ffff00", "#ff00ff", "#00ffff", "#ff8000"];
function nextMaskStyle(usedColors, first) {
  if (usedColors.length === 0) return { ...first };
  const used = new Set(usedColors.map((c) => normalizeMaskColor(c)));
  const free = MASK_PALETTE.find((c) => !used.has(c));
  const color = free ?? MASK_PALETTE[(usedColors.length - 1) % MASK_PALETTE.length] ?? DEFAULT_MASK_STYLE.color;
  return { color, opacity: first.opacity };
}
const PRESSURE_DEFAULTS = {
  pressureSize: true,
  pressureOpacity: false,
  minSize: 0.1,
  gamma: 1
};
const PRESSURE_SIZE_ID = "PainterSketch.PressureSize";
const PRESSURE_OPACITY_ID = "PainterSketch.PressureOpacity";
const PRESSURE_MIN_SIZE_ID = "PainterSketch.PressureMinSize";
const PRESSURE_GAMMA_ID = "PainterSketch.PressureGamma";
const MIN_SIZE_MAX = 100;
const GAMMA_MIN = 0.2;
const GAMMA_MAX = 5;
const GAMMA_STEP = 0.05;
const NOTE$1 = " Applies to the brush and eraser of editors opened afterwards; changes in the options bar win.";
const PRESSURE_SETTINGS = [
  {
    id: PRESSURE_SIZE_ID,
    category: ["PainterSketch", "Defaults", "Pressure size"],
    name: "Pen pressure controls size",
    tooltip: "Default of the brush/eraser 'Size' pressure toggle." + NOTE$1,
    type: "boolean",
    defaultValue: PRESSURE_DEFAULTS.pressureSize
  },
  {
    id: PRESSURE_OPACITY_ID,
    category: ["PainterSketch", "Defaults", "Pressure opacity"],
    name: "Pen pressure controls opacity",
    tooltip: "Default of the brush/eraser 'Opacity' pressure toggle." + NOTE$1,
    type: "boolean",
    defaultValue: PRESSURE_DEFAULTS.pressureOpacity
  },
  {
    id: PRESSURE_MIN_SIZE_ID,
    category: ["PainterSketch", "Defaults", "Pressure min size"],
    name: "Pressure min size (%)",
    tooltip: "Brush size at zero pressure, as a percentage of the size." + NOTE$1,
    type: "slider",
    attrs: { min: 0, max: MIN_SIZE_MAX, step: 1 },
    defaultValue: Math.round(PRESSURE_DEFAULTS.minSize * 100)
  },
  {
    id: PRESSURE_GAMMA_ID,
    category: ["PainterSketch", "Defaults", "Pressure curve"],
    name: "Pressure curve (gamma)",
    tooltip: "1 = linear; above 1 = softer start (needs more pressure)." + NOTE$1,
    type: "slider",
    attrs: { min: GAMMA_MIN, max: GAMMA_MAX, step: GAMMA_STEP },
    defaultValue: PRESSURE_DEFAULTS.gamma
  }
];
function toBool(raw, fallback) {
  return typeof raw === "boolean" ? raw : fallback;
}
function normalizeMinSize(raw) {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return PRESSURE_DEFAULTS.minSize;
  return Math.min(MIN_SIZE_MAX, Math.max(0, Math.round(raw))) / 100;
}
function normalizeGamma(raw) {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return PRESSURE_DEFAULTS.gamma;
  const snapped = Math.round(raw / GAMMA_STEP) * GAMMA_STEP;
  return Number(Math.min(GAMMA_MAX, Math.max(GAMMA_MIN, snapped)).toFixed(2));
}
function pressureDefaultsFrom(read) {
  return {
    pressureSize: toBool(read(PRESSURE_SIZE_ID), PRESSURE_DEFAULTS.pressureSize),
    pressureOpacity: toBool(read(PRESSURE_OPACITY_ID), PRESSURE_DEFAULTS.pressureOpacity),
    minSize: normalizeMinSize(read(PRESSURE_MIN_SIZE_ID)),
    gamma: normalizeGamma(read(PRESSURE_GAMMA_ID))
  };
}
const SAMPLE_DEFAULTS = {
  bucket: "background",
  wand: "background"
};
const BUCKET_SAMPLE_ID = "PainterSketch.BucketSample";
const WAND_SAMPLE_ID = "PainterSketch.WandSample";
const CHOICES = [
  { text: "Background (input image only)", value: "background" },
  { text: "Current layer", value: "layer" },
  { text: "All layers (what you see)", value: "all" }
];
const NOTE = " Applies to editors opened afterwards; the options-bar 'Sample' choice wins.";
const SAMPLE_SETTINGS = [
  {
    id: BUCKET_SAMPLE_ID,
    category: ["PainterSketch", "Defaults", "Bucket sample"],
    name: "Paint bucket samples",
    tooltip: "Which pixels the paint bucket looks at to find the area to fill." + NOTE,
    type: "combo",
    options: CHOICES,
    defaultValue: SAMPLE_DEFAULTS.bucket
  },
  {
    id: WAND_SAMPLE_ID,
    category: ["PainterSketch", "Defaults", "Wand sample"],
    name: "Magic wand samples",
    tooltip: "Which pixels the magic wand looks at to find the area to select." + NOTE,
    type: "combo",
    options: CHOICES,
    defaultValue: SAMPLE_DEFAULTS.wand
  }
];
function normalizeSample(raw, fallback) {
  return raw === "background" || raw === "layer" || raw === "all" ? raw : fallback;
}
function sampleDefaultsFrom(read) {
  return {
    bucket: normalizeSample(read(BUCKET_SAMPLE_ID), SAMPLE_DEFAULTS.bucket),
    wand: normalizeSample(read(WAND_SAMPLE_ID), SAMPLE_DEFAULTS.wand)
  };
}
const PAINT_QUALITY_ID = "PainterSketch.PaintQuality";
const PAINT_QUALITY_DEFAULT = 99;
const MIN = 50;
const MAX$1 = 100;
const PAINT_QUALITY_SETTING = {
  id: PAINT_QUALITY_ID,
  category: ["PainterSketch", "Storage", "Paint layer quality"],
  name: "Paint layer quality",
  tooltip: "Paint layer quality. Below 100 saves lossy WebP (much smaller); 100 saves lossless PNG. Masks are always PNG.",
  type: "slider",
  attrs: { min: MIN, max: MAX$1, step: 1 },
  defaultValue: PAINT_QUALITY_DEFAULT
};
function normalizePaintQuality(raw) {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return PAINT_QUALITY_DEFAULT;
  return Math.min(MAX$1, Math.max(MIN, Math.round(raw)));
}
const SETTINGS = [
  PAINT_QUALITY_SETTING,
  CLEANUP_SETTING,
  MASK_COLOR_SETTING,
  MASK_OPACITY_SETTING,
  ...PRESSURE_SETTINGS,
  ...SAMPLE_SETTINGS
];
const EXTENSION_NAME = "phazei.PainterSketch";
const NODE_NAME = "PainterSketch";
const WIDGET_SPEC_TYPE = "PAINTERSKETCH";
const DOM_WIDGET_TYPE = "paintersketch";
const INPUT_NAMES = {
  image: "image",
  /** M12: optional image offered in the Images panel. */
  layerSource: "layer_source",
  document: "document",
  width: "width",
  height: "height",
  background: "background"
};
const LINK_INPUT = 1;
const WIDGET_MIN_HEIGHT = 256;
const WIDGET_MARGIN = 6;
const DEFAULT_NODE_SIZE = [512, 640];
const SOURCE_POLL_MS = 500;
const SAVE_WORKFLOW_COMMAND = "Comfy.SaveWorkflow";
const settingFailures = /* @__PURE__ */ new Set();
function readSetting(id) {
  try {
    const setting = app.extensionManager?.setting;
    if (typeof setting?.get === "function") return setting.get(id);
    return app.ui?.settings?.getSettingValue?.(id);
  } catch (error) {
    if (!settingFailures.has(id)) log.warn(`could not read setting ${id}; using its default:`, error);
    settingFailures.add(id);
    return void 0;
  }
}
async function executeCommand(id) {
  const command = app.extensionManager?.command;
  if (typeof command?.execute !== "function") throw new Error("command API unavailable");
  await command.execute(id);
}
function safeRead(id) {
  try {
    return readSetting(id);
  } catch {
    return void 0;
  }
}
function readFirstMaskStyle() {
  return firstMaskStyleFrom(safeRead);
}
function readPressureDefaults() {
  return pressureDefaultsFrom(safeRead);
}
function readSampleDefaults() {
  return sampleDefaultsFrom(safeRead);
}
const MAX_BORDER_SIZE = 4096;
const DEFAULT_OUTPUT_OPTIONS = Object.freeze({
  applyMask: "none",
  fillColor: "#000000",
  cropPadding: 0,
  borderSize: 64,
  borderColor: "#ffffff",
  borderMask: true
});
function readColor(value, fallback) {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : fallback;
}
function readMode$1(value) {
  return value === "fill" || value === "crop" || value === "border" ? value : "none";
}
function readBorderSize(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_OUTPUT_OPTIONS.borderSize;
  return Math.min(MAX_BORDER_SIZE, Math.max(1, Math.floor(value)));
}
function readOutputOptions(value) {
  const record = typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
  const padding = record["cropPadding"];
  const borderMask = record["borderMask"];
  return {
    applyMask: readMode$1(record["applyMask"]),
    fillColor: readColor(record["fillColor"], DEFAULT_OUTPUT_OPTIONS.fillColor),
    cropPadding: typeof padding === "number" && Number.isFinite(padding) ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(padding))) : 0,
    borderSize: readBorderSize(record["borderSize"]),
    borderColor: readColor(record["borderColor"], DEFAULT_OUTPUT_OPTIONS.borderColor),
    borderMask: typeof borderMask === "boolean" ? borderMask : DEFAULT_OUTPUT_OPTIONS.borderMask
  };
}
function cloneOutputOptions(options = DEFAULT_OUTPUT_OPTIONS) {
  return {
    applyMask: options.applyMask,
    fillColor: options.fillColor,
    cropPadding: options.cropPadding,
    borderSize: options.borderSize ?? DEFAULT_OUTPUT_OPTIONS.borderSize,
    borderColor: options.borderColor ?? DEFAULT_OUTPUT_OPTIONS.borderColor,
    borderMask: options.borderMask ?? DEFAULT_OUTPUT_OPTIONS.borderMask
  };
}
function outputOptionsEqual(a, b) {
  return a.applyMask === b.applyMask && a.fillColor === b.fillColor && a.cropPadding === b.cropPadding && a.borderSize === b.borderSize && a.borderColor === b.borderColor && a.borderMask === b.borderMask;
}
const MAX_REGIONS = 6;
const DEFAULT_REGION_FRACTION = 0.5;
function isRegionSlot(value) {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_REGIONS;
}
function nextRegionSlot(regions) {
  const used = new Set(regions.map((region) => region.slot));
  for (let slot = 1; slot <= MAX_REGIONS; slot++) {
    if (!used.has(slot)) return slot;
  }
  return null;
}
function defaultRegionName(slot) {
  return `Region ${slot}`;
}
function commitRegionName(input, slot) {
  const name = input.trim();
  return name || defaultRegionName(slot);
}
function regionName(region) {
  return commitRegionName(region.name, region.slot);
}
function regionSlotLabel(region) {
  return `${region.slot} · ${regionName(region)}`;
}
function roundRegionEdge(value) {
  return Math.floor(value + 0.5);
}
function regionArea(image) {
  return { x: -image.width, y: -image.height, width: 3 * image.width, height: 3 * image.height };
}
function clampRegionRect(rect, image) {
  const area = regionArea(image);
  const [x, right] = clampEdges(rect.x, rect.x + rect.width, area.x, area.x + area.width);
  const [y, bottom] = clampEdges(rect.y, rect.y + rect.height, area.y, area.y + area.height);
  return { x, y, width: right - x, height: bottom - y };
}
function defaultRegionRect(image) {
  const width = Math.max(1, roundRegionEdge(image.width * DEFAULT_REGION_FRACTION));
  const height = Math.max(1, roundRegionEdge(image.height * DEFAULT_REGION_FRACTION));
  const x = Math.floor((image.width - width) / 2);
  const y = Math.floor((image.height - height) / 2);
  return { x, y, width, height };
}
function clampEdges(start, end, min, max) {
  const low = clamp$1(roundRegionEdge(start), min, max - 1);
  const high = clamp$1(roundRegionEdge(end), low + 1, max);
  return [low, high];
}
function clamp$1(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
function createRegion(id, slot, rect) {
  return {
    id,
    slot,
    name: defaultRegionName(slot),
    rect: { ...rect },
    visible: true,
    output: cloneOutputOptions()
  };
}
function cloneRegion(region) {
  const { x, y, width, height } = region.rect;
  return {
    id: region.id,
    slot: region.slot,
    name: region.name,
    rect: { x, y, width, height },
    visible: region.visible,
    output: cloneOutputOptions(region.output)
  };
}
function readRegions(value) {
  if (value === void 0) return { regions: [], repaired: false };
  if (!Array.isArray(value)) return { regions: [], repaired: true };
  const regions = [];
  const ids = /* @__PURE__ */ new Set();
  const slots = /* @__PURE__ */ new Set();
  let repaired = false;
  for (const entry of value) {
    const region = isRecord$1(entry) ? readRegion(entry) : null;
    if (!region || ids.has(region.id) || slots.has(region.slot)) {
      repaired = true;
      continue;
    }
    if (entry["slot"] === void 0 || !sameRect(entry["rect"], region.rect)) repaired = true;
    ids.add(region.id);
    slots.add(region.slot);
    regions.push(region);
  }
  return { regions, repaired };
}
function readRegionRect(value) {
  if (!isRecord$1(value)) return null;
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
function readRegion(entry) {
  const id = entry["id"];
  if (typeof id !== "string" || !id.trim()) return null;
  const slot = entry["slot"] === void 0 ? legacySlot(entry["index"]) : entry["slot"];
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
    output: readOutputOptions(entry["output"])
  };
}
function legacySlot(index) {
  if (typeof index !== "number" || !Number.isInteger(index)) return null;
  return index + 1;
}
function sameRect(raw, rect) {
  if (!isRecord$1(raw)) return false;
  return raw["x"] === rect.x && raw["y"] === rect.y && raw["width"] === rect.width && raw["height"] === rect.height;
}
function isRecord$1(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}
function hasOutputMetadata(doc) {
  return doc.regions.length > 0 || doc.mainOutput !== void 0 || doc.backgroundVisible === false;
}
function hasDocumentContent(doc, hasPaint = false) {
  return hasPaint || doc.layers.some((layer) => layer.file !== null) || hasOutputMetadata(doc);
}
function outputMetadataSignature(doc) {
  return JSON.stringify({
    regions: [...doc.regions].sort((a, b) => a.slot - b.slot).map(cloneRegion),
    mainOutput: cloneOutputOptions(doc.mainOutput),
    backgroundVisible: doc.backgroundVisible !== false
  });
}
const PLACEMENT_MIN_SCALE = 0.05;
const PLACEMENT_MAX_SCALE = 10;
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
  const read = readLayers(rawLayers);
  const { layers: layers2, seen, skippedLayers } = read;
  if (read.repaired) repaired = true;
  if (!layers2.some((l) => l.kind === "paint")) {
    layers2.unshift(createPaintLayer("Layer 1"));
    repaired = true;
  }
  const masks = layers2.filter((l) => l.kind === "mask");
  const stacked = [...layers2.filter((l) => l.kind !== "mask"), ...masks];
  if (stacked.some((l, i) => l !== layers2[i])) {
    layers2.splice(0, layers2.length, ...stacked);
    repaired = true;
  }
  let activeLayerId = typeof data["activeLayerId"] === "string" ? data["activeLayerId"] : "";
  if (!seen.has(activeLayerId)) {
    activeLayerId = (layers2.find((l) => l.kind === "paint") ?? layers2[0])?.id ?? "";
    repaired = true;
  }
  let docId = data["docId"];
  if (typeof docId !== "string" || !/^[a-z0-9]{4,64}$/i.test(docId)) {
    docId = createId();
    repaired = true;
  }
  const regions = readRegions(data["regions"]);
  if (regions.repaired) repaired = true;
  if (data["regionsReferenceSize"] !== void 0) repaired = true;
  const bgVisible = data["backgroundVisible"];
  if (bgVisible !== void 0 && typeof bgVisible !== "boolean") repaired = true;
  const placed = readPlacement(data["placement"]);
  if (placed.repaired) repaired = true;
  return {
    status: "ok",
    repaired,
    ...skippedLayers ? { skippedLayers } : {},
    document: {
      version: DOCUMENT_VERSION,
      docId,
      frame,
      bounds,
      regions: regions.regions,
      ...data["mainOutput"] !== void 0 ? { mainOutput: readOutputOptions(data["mainOutput"]) } : {},
      ...bgVisible === false ? { backgroundVisible: false } : {},
      ...placed.placement ? { placement: placed.placement } : {},
      activeLayerId,
      layers: layers2
    }
  };
}
const LAYER_KINDS = /* @__PURE__ */ new Set(["paint", "text", "mask"]);
function readLayers(rawLayers) {
  const layers2 = [];
  const seen = /* @__PURE__ */ new Set();
  let skippedLayers = 0;
  let repaired = false;
  rawLayers.forEach((entry, index) => {
    const layer = readLayer(entry);
    if (!layer) {
      log.warn(`layer[${index}] is malformed; skipping it`, entry);
      skippedLayers++;
      repaired = true;
      return;
    }
    if (seen.has(layer.id)) {
      const id = createId();
      log.warn(`layer[${index}] repeats id ${layer.id}; loading it as ${id}`);
      layer.id = id;
      repaired = true;
    }
    seen.add(layer.id);
    layers2.push(layer);
  });
  return { layers: layers2, seen, skippedLayers, repaired };
}
function readLayer(value) {
  if (!isRecord(value)) return null;
  const id = value["id"];
  const kind = value["kind"];
  if (typeof id !== "string" || !id) return null;
  if (typeof kind !== "string" || !LAYER_KINDS.has(kind)) return null;
  let file = value["file"];
  if (file !== null && file !== void 0 && (typeof file !== "string" || !file.trim())) {
    log.warn(`layer ${id} has an invalid file reference; loading it empty`);
    file = null;
  }
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
  if (layer.kind === "text") {
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
    regions: doc.regions.map(cloneRegion),
    ...doc.mainOutput ? { mainOutput: cloneOutputOptions(doc.mainOutput) } : {},
    ...doc.backgroundVisible === false ? { backgroundVisible: false } : {},
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
  if (layer.kind === "text" && layer.textData !== void 0) out["textData"] = serializeTextData(layer.textData);
  return out;
}
function cloneDocument(doc) {
  return {
    ...doc,
    frame: { ...doc.frame },
    bounds: { ...doc.bounds },
    regions: doc.regions.map(cloneRegion),
    ...doc.mainOutput ? { mainOutput: cloneOutputOptions(doc.mainOutput) } : {},
    ...doc.placement ? { placement: { ...doc.placement } } : {},
    layers: doc.layers.map((l) => ({ ...l, ...l.textData ? { textData: { ...l.textData } } : {} }))
  };
}
const PASTED_LAYER_NAME = "Pasted";
function applyCoverage(rgba, coverage) {
  let any = false;
  const n = rgba.length >> 2;
  for (let i = 0; i < n; i++) {
    const p = i * 4 + 3;
    const c = coverage ? coverage[i] ?? 0 : 255;
    const a = c === 255 ? rgba[p] : Math.round(rgba[p] * c / 255);
    rgba[p] = a;
    if (a === 0) {
      rgba[p - 3] = 0;
      rgba[p - 2] = 0;
      rgba[p - 1] = 0;
    } else {
      any = true;
    }
  }
  return any;
}
function maskToGray(rgba, coverage) {
  let any = false;
  const n = rgba.length >> 2;
  for (let i = 0; i < n; i++) {
    const p = i * 4;
    const c = coverage ? coverage[i] ?? 0 : 255;
    const v = Math.round(rgba[p + 3] * c / 255);
    rgba[p] = v;
    rgba[p + 1] = v;
    rgba[p + 2] = v;
    rgba[p + 3] = 255;
    if (v > 0) any = true;
  }
  return any;
}
function unionMaskCoverage(union, area, read, rgba, invert2) {
  for (let y = 0; y < area.height; y++) {
    const ry = area.y + y - (read?.y ?? 0);
    for (let x = 0; x < area.width; x++) {
      const rx = area.x + x - (read?.x ?? 0);
      const inside2 = read !== null && rx >= 0 && ry >= 0 && rx < read.width && ry < read.height;
      const a = inside2 ? rgba[(ry * read.width + rx) * 4 + 3] : 0;
      const v = invert2 ? 255 - a : a;
      const i = y * area.width + x;
      if (v > union[i]) union[i] = v;
    }
  }
}
function pasteRect(source, docPerSource, at) {
  const k = Number.isFinite(docPerSource) && docPerSource > 0 ? docPerSource : 1;
  const width = Math.max(1, Math.round(source.width * k));
  const height = Math.max(1, Math.round(source.height * k));
  if ("topLeft" in at) return { x: Math.round(at.topLeft.x), y: Math.round(at.topLeft.y), width, height };
  return { x: Math.round(at.centre.x - width / 2), y: Math.round(at.centre.y - height / 2), width, height };
}
function cropToCap(rect, cap) {
  const kept = intersectRect(rect, cap);
  if (isEmptyRect(kept)) return { rect: null, cropped: true };
  return { rect: kept, cropped: kept.width !== rect.width || kept.height !== rect.height };
}
function pastedLayerName(layers2) {
  const taken = new Set(layers2.map((l) => l.name.trim()));
  if (!taken.has(PASTED_LAYER_NAME)) return PASTED_LAYER_NAME;
  let n = 2;
  while (taken.has(`${PASTED_LAYER_NAME} ${n}`)) n++;
  return `${PASTED_LAYER_NAME} ${n}`;
}
function imageLayerName(layers2) {
  const taken = new Set(layers2.map((l) => l.name.trim()));
  let n = 1;
  while (taken.has(`Image ${n}`)) n++;
  return `Image ${n}`;
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
const EPS = 1e-6;
function clampIntoArea(topLeft, size, area) {
  const axis = (v, len, lo, span) => {
    if (len > span) return Math.round(lo + (span - len) / 2);
    const min = Math.ceil(lo - EPS);
    const max = Math.floor(lo + span - len + EPS);
    return Math.min(Math.max(Math.round(v), min), Math.max(min, max)) + 0;
  };
  return { x: axis(topLeft.x, size.width, area.x, area.width), y: axis(topLeft.y, size.height, area.y, area.height) };
}
function pasteTopLeft(size, ctx) {
  const centreOn = (r) => ({ x: r.x + r.width / 2 - size.width / 2, y: r.y + r.height / 2 - size.height / 2 });
  let at;
  if (ctx.selection) at = centreOn(ctx.selection);
  else if (ctx.original) at = ctx.original;
  else if (!ctx.view || contains(ctx.view, ctx.imageArea)) at = centreOn(ctx.imageArea);
  else at = centreOn(ctx.view);
  return clampIntoArea(at, size, ctx.imageArea);
}
function imageAreaDoc(imageSize2, map) {
  return imageRectToDoc(map, frameRect(imageSize2));
}
function viewRectDoc(view, stage, map) {
  if (!(stage.width > 0 && stage.height > 0 && view.scale > 0)) return null;
  const r = { x: -view.offsetX / view.scale, y: -view.offsetY / view.scale, width: stage.width / view.scale, height: stage.height / view.scale };
  return imageRectToDoc(map, r);
}
function selectionBox(sel, imageArea) {
  if (!sel) return null;
  if (sel.outside > 0 || sel.rect.width <= 0 || sel.rect.height <= 0) return imageArea;
  return sel.rect;
}
function pasteContext(e, original) {
  const imageArea = imageAreaDoc(e.imageSize, e.map);
  return { selection: selectionBox(e.selection, imageArea), original, imageArea, view: viewRectDoc(e.view, e.stage, e.map) };
}
function contains(outer, inner) {
  return inner.x >= outer.x - EPS && inner.y >= outer.y - EPS && inner.x + inner.width <= outer.x + outer.width + EPS && inner.y + inner.height <= outer.y + outer.height + EPS;
}
function choosePasteSource(f) {
  if (f.systemImage) return f.systemIsOurs && f.internal ? "internal" : "system";
  if (f.internal) return "internal";
  if (f.clipspace) return "clipspace";
  return "none";
}
const URL_TYPES = ["text/uri-list", "text/x-moz-url", "text/html"];
function shouldClaimDrag(types, fileTypes) {
  if (fileTypes.some((t) => t.startsWith("image/"))) return true;
  if (fileTypes.some((t) => t !== "")) return false;
  return URL_TYPES.some((t) => types.includes(t));
}
const IMAGE_URL = /^(https?:|data:image\/|blob:)/i;
function imageUrlFromDrop(uriList, html) {
  const img = /<img\b[^>]*?\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(html);
  const src = img ? decodeEntities((img[1] ?? img[2] ?? img[3] ?? "").trim()) : "";
  if (IMAGE_URL.test(src)) return src;
  const first = uriList.split(/\r?\n/).map((line) => line.trim()).find((line) => line !== "" && !line.startsWith("#")) ?? "";
  return IMAGE_URL.test(first) ? first : null;
}
function decodeEntities(text) {
  return text.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}
const SIGNATURE_SIDE = 16;
function signaturesMatch(a, b, tolerance = 4) {
  if (!a || !b || a.width !== b.width || a.height !== b.height || a.thumb.length !== b.thumb.length) return false;
  let sum = 0;
  for (let i = 0; i < a.thumb.length; i++) sum += Math.abs(a.thumb[i] - b.thumb[i]);
  return sum / Math.max(1, a.thumb.length) <= tolerance;
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
function imageSignature(source, width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = SIGNATURE_SIDE;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(source, 0, 0, SIGNATURE_SIDE, SIGNATURE_SIDE);
  const thumb = ctx.getImageData(0, 0, SIGNATURE_SIDE, SIGNATURE_SIDE).data;
  canvas.width = canvas.height = 0;
  return { width, height, thumb };
}
function imageFiles(data) {
  if (!data) return [];
  const files = [];
  for (const item of Array.from(data.items)) {
    if (item.kind !== "file" || !item.type.startsWith("image/")) continue;
    const file = item.getAsFile();
    if (file) files.push(file);
  }
  if (files.length === 0) {
    for (const file of Array.from(data.files)) if (file.type.startsWith("image/")) files.push(file);
  }
  return files;
}
function dragTypes(data) {
  if (!data) return { types: [], fileTypes: [] };
  const fileTypes = Array.from(data.items).filter((item) => item.kind === "file").map((item) => item.type);
  return { types: Array.from(data.types), fileTypes };
}
function droppedImageUrl(data) {
  if (!data) return null;
  const uris = data.getData("text/uri-list") || data.getData("text/x-moz-url");
  return imageUrlFromDrop(uris, data.getData("text/html"));
}
async function fetchImageBlob(url) {
  let blob2;
  try {
    const response = await fetch(url, { credentials: "omit" });
    if (!response.ok) {
      log.warn(`Could not fetch the dragged image (HTTP ${response.status}):`, url);
      return { error: "blocked" };
    }
    blob2 = await response.blob();
  } catch (error) {
    log.warn("Could not fetch the dragged image (CORS or network):", url, error);
    return { error: "blocked" };
  }
  return blob2.type === "" || blob2.type.startsWith("image/") || blob2.type === "application/octet-stream" ? { blob: blob2 } : { error: "not-image" };
}
async function readSystemImage() {
  const clipboard = navigator.clipboard;
  if (!clipboard || typeof clipboard.read !== "function") return null;
  try {
    for (const item of await clipboard.read()) {
      const type = item.types.find((t) => t.startsWith("image/"));
      if (type) return await item.getType(type);
    }
  } catch (error) {
    log.warn("Clipboard read unavailable:", error);
  }
  return null;
}
function clipspaceImageUrl() {
  const ctor = app.constructor;
  if (typeof ctor !== "function" || !("clipspace" in ctor)) return null;
  const clip = ctor.clipspace;
  if (!clip || typeof clip !== "object") return null;
  const index = typeof clip.selectedIndex === "number" && clip.selectedIndex >= 0 ? clip.selectedIndex : 0;
  const img = Array.isArray(clip.imgs) ? clip.imgs[index] ?? clip.imgs[0] : void 0;
  if (img instanceof HTMLImageElement && img.src) return img.src;
  const item = Array.isArray(clip.images) ? clip.images[index] ?? clip.images[0] : void 0;
  if (item && typeof item === "object" && typeof item.filename === "string" && item.filename) {
    return viewUrl(item, (route) => api.apiURL(route));
  }
  return null;
}
async function decodeBlob(blob2) {
  try {
    return await createImageBitmap(blob2);
  } catch (error) {
    log.warn("Could not decode the pasted image:", error);
    return null;
  }
}
async function decodeUrl(url) {
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    return await decodeBlob(await response.blob());
  } catch (error) {
    log.warn("Could not load the clipspace image:", error);
    return null;
  }
}
const NOTHING_TO_PASTE_NOTE = "Nothing to paste.";
const CLIPSPACE_EMPTY_NOTE = "Clipspace has no image -- nothing to paste.";
const SYSTEM_EMPTY_NOTE = "The clipboard has no image -- nothing to paste.";
const PASTE_WAIT_MS = 1e3;
let internal = null;
class ClipboardActions {
  /**
   * @param getSession - Current session.
   * @param stage - Stage element (drop points).
   */
  constructor(getSession, stage) {
    this.getSession = getSession;
    this.stage = stage;
  }
  getSession;
  stage;
  armed = null;
  onPaste = (event) => this.handlePaste(event);
  /** Whether an internal copy exists (Ctrl+Shift+V pastes it in place). */
  get hasInternal() {
    return internal !== null;
  }
  /**
   * Ctrl+C / Ctrl+Shift+C / Copy button.
   * @param merged - Copy merged (what is visible, incl. the image).
   */
  copy(merged) {
    const editor = this.getSession()?.editor;
    const clip = editor?.clipboard.copy(merged);
    if (editor && clip) store(clip, editor);
  }
  /** Ctrl+X / Cut button. */
  cut() {
    const editor = this.getSession()?.editor;
    const clip = editor?.clipboard.cut();
    if (editor && clip) store(clip, editor);
  }
  /**
   * Ctrl+V keydown (editor owns the keyboard; also Ctrl+Shift+V without an
   * internal copy): wait for the browser's `paste` event.
   * @param plainText - Chrome's Ctrl+Shift+V ("paste as plain text") carries
   *   no image: read the async clipboard instead when the event has none.
   */
  armPaste(plainText) {
    this.disarm();
    const timer = setTimeout(() => this.disarm(), PASTE_WAIT_MS);
    this.armed = { plainText, timer };
    window.addEventListener("paste", this.onPaste, true);
  }
  /**
   * Ctrl+Shift+V: the internal copy at its copied position; the system
   * clipboard is ignored.
   * @returns `false` without an internal copy (the caller pastes like Ctrl+V).
   */
  pasteInPlace() {
    const editor = this.getSession()?.editor;
    if (!editor || !internal) return false;
    this.place(editor, internalImage(internal.clip), true);
    return true;
  }
  /**
   * Rail Paste button (a user gesture: `navigator.clipboard.read()` may ask
   * for permission) or one of its menu entries.
   * @param request - `"system"` (Ctrl+V order: system, internal, clipspace) or `"clipspace"` only.
   */
  async pasteFromButton(request) {
    const editor = this.getSession()?.editor;
    if (!editor) return;
    if (request === "clipspace") return this.pasteClipspace(editor);
    await this.pasteFacts(editor, await readSystemImage(), SYSTEM_EMPTY_NOTE);
  }
  /**
   * Dropped images: one layer each, in order, centred at the drop point.
   * @param images - Image files / blobs (decoded here) or decoded bitmaps.
   * @param clientPoint - Drop point (client px).
   * @returns `true` if at least one image decoded.
   */
  async pasteDropped(images, clientPoint) {
    const editor = this.getSession()?.editor;
    if (!editor) return false;
    const at = this.docPoint(editor, this.toStage(clientPoint));
    let any = false;
    for (const item of images) {
      const bitmap = item instanceof Blob ? await decodeBlob(item) : item;
      if (!bitmap) continue;
      any = true;
      this.place(editor, foreignImage(bitmap), false, at);
    }
    return any;
  }
  /** Remove the armed paste listener. */
  dispose() {
    this.disarm();
  }
  // ── Internals ───────────────────────────────────────────────────────────
  disarm() {
    if (!this.armed) return;
    clearTimeout(this.armed.timer);
    this.armed = null;
    window.removeEventListener("paste", this.onPaste, true);
  }
  handlePaste(event) {
    const plainText = this.armed?.plainText ?? false;
    this.disarm();
    event.preventDefault();
    event.stopPropagation();
    const editor = this.getSession()?.editor;
    if (!editor) return;
    const file = Array.from(event.clipboardData?.items ?? []).find((i) => i.kind === "file" && i.type.startsWith("image/"));
    const blob2 = file?.getAsFile() ?? null;
    void (async () => this.pasteFacts(editor, blob2 ?? (plainText ? await readSystemImage() : null)))();
  }
  /** Ctrl+V order (`pasteChoice.ts`): decode the system image (if any), choose the source, paste. */
  async pasteFacts(editor, systemBlob, emptyNote = NOTHING_TO_PASTE_NOTE) {
    const bitmap = systemBlob ? await decodeBlob(systemBlob) : null;
    const signature = bitmap ? imageSignature(bitmap, bitmap.width, bitmap.height) : null;
    const clipspaceUrl = clipspaceImageUrl();
    const facts = {
      systemImage: bitmap !== null,
      systemIsOurs: signaturesMatch(signature, internal?.signature ?? null),
      internal: internal !== null,
      clipspace: clipspaceUrl !== null
    };
    const kind = choosePasteSource(facts);
    if (kind !== "system") bitmap?.close();
    if (kind === "system" && bitmap) return this.place(editor, foreignImage(bitmap), false);
    if (kind === "internal" && internal) return this.place(editor, internalImage(internal.clip), false, void 0, internal.from === editor);
    if (kind === "clipspace") return this.pasteClipspace(editor);
    editor.events.emit("note", emptyNote);
  }
  /** The ComfyUI clipspace image, centred on the image. */
  async pasteClipspace(editor) {
    const url = clipspaceImageUrl();
    const image = url ? await decodeUrl(url) : null;
    if (image) return this.place(editor, foreignImage(image), false);
    editor.events.emit("note", CLIPSPACE_EMPTY_NOTE);
  }
  /** Paste one decoded image as a new layer (in Free Transform when it reaches past the paint area). */
  place(editor, image, inPlace, dropAt, ownDoc = false) {
    const map = editor.frameMap;
    const docPerSource = image.imagePerSource / map.scale;
    const size = pasteRect({ width: image.width, height: image.height }, docPerSource, { topLeft: { x: 0, y: 0 } });
    let at;
    if (inPlace && image.topLeft) at = { topLeft: image.topLeft };
    else if (dropAt) {
      const want = { x: dropAt.x - size.width / 2, y: dropAt.y - size.height / 2 };
      at = { topLeft: clampIntoArea(want, size, imageAreaDoc(editor.imageSize, map)) };
    } else {
      const ctx = pasteContext(
        { selection: editor.selection.current, view: editor.view.current, stage: editor.view.stageSize, map, imageSize: editor.imageSize },
        ownDoc ? image.topLeft : null
      );
      at = { topLeft: pasteTopLeft(size, ctx) };
    }
    editor.clipboard.paste(image.source, { width: image.width, height: image.height }, docPerSource, at);
    image.release();
  }
  toStage(client) {
    const rect = this.stage.getBoundingClientRect();
    const sx = rect.width > 0 ? this.stage.clientWidth / rect.width : 1;
    const sy = rect.height > 0 ? this.stage.clientHeight / rect.height : 1;
    return { x: (client.x - rect.left) * sx, y: (client.y - rect.top) * sy };
  }
  docPoint(editor, stagePoint) {
    return imageToDoc(editor.frameMap, stageToDoc(editor.view.current, stagePoint));
  }
}
function store(clip, from) {
  const canvas = document.createElement("canvas");
  canvas.width = clip.data.width;
  canvas.height = clip.data.height;
  canvas.getContext("2d")?.putImageData(clip.data, 0, 0);
  const entry = { clip, signature: imageSignature(canvas, canvas.width, canvas.height), systemWritten: false, from };
  internal = entry;
  const png = new Promise((resolve, reject) => {
    canvas.toBlob((blob2) => blob2 ? resolve(blob2) : reject(new Error("PNG encoding failed")), "image/png");
  });
  const release = () => {
    canvas.width = canvas.height = 0;
  };
  if (typeof ClipboardItem !== "function" || typeof navigator.clipboard?.write !== "function") {
    log.warn("System clipboard unavailable; the copy is kept inside PainterSketch only.");
    void png.then(release, release);
    return;
  }
  navigator.clipboard.write([new ClipboardItem({ "image/png": png })]).then(() => {
    entry.systemWritten = true;
  }).catch((error) => log.warn("Could not write the system clipboard; the copy is kept inside PainterSketch only.", error)).finally(release);
}
function internalImage(clip) {
  const canvas = document.createElement("canvas");
  canvas.width = clip.data.width;
  canvas.height = clip.data.height;
  canvas.getContext("2d")?.putImageData(clip.data, 0, 0);
  return {
    source: canvas,
    width: canvas.width,
    height: canvas.height,
    imagePerSource: clip.imageScale,
    topLeft: { x: clip.rect.x, y: clip.rect.y },
    release: () => {
      canvas.width = canvas.height = 0;
    }
  };
}
function foreignImage(bitmap) {
  return { source: bitmap, width: bitmap.width, height: bitmap.height, imagePerSource: 1, topLeft: null, release: () => bitmap.close() };
}
const PATHS = {
  // Output regions (Outputs button): box with a "1" and corner handles.
  region: "M4 4h16v16H4zM8 9l3-2v10M8 17h6M2 2h4v4H2zM18 18h4v4h-4z",
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
  // Clipboard (M10b): two sheets (copy), scissors (cut), clipboard board (paste).
  copy: "M9 9h11v11H9zM5 15H4V4h11v1",
  cut: "M6 4a3 3 0 1 0 0 6a3 3 0 1 0 0-6M6 14a3 3 0 1 0 0 6a3 3 0 1 0 0-6M8.5 8.5 20 20M8.5 15.5 20 4",
  paste: "M8 4H5v17h14V4h-3M9 2h6v4H9zM9 11h6M9 15h6",
  // Paste from the ComfyUI clipspace: the paste board (bottom-right corner
  // left open) with a small "C" badge there.
  pasteClipspace: "M8 4H5v17h9M16 4h3v9M9 2h6v4H9zM9 11h6M9 15h3M22 15.9A3 3 0 1 0 22 20.1",
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
  // Solo (view only): a ring with a centre dot ("only this one").
  solo: "M12 4a8 8 0 1 0 0 16a8 8 0 1 0 0-16M12 10a2 2 0 1 0 0 4a2 2 0 1 0 0-4",
  // "New mask": the Quick Mask glyph (smaller) with a plus at the top-right.
  maskAdd: "M3 8h12v12H3zM9 11a3 3 0 1 0 0 6a3 3 0 1 0 0-6M19 2v6M16 5h6",
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
  moveDrawing: "M12 2.5 21.5 8.5 12 14.5 2.5 8.5zM2.5 13.5V15L12 20.5 21.5 15v-1.5M9.4 6.8l5.2 3.4M14.6 6.8l-5.2 3.4M10.7 6.8H9.4v1.1M13.3 6.8h1.3v1.1M10.7 10.2H9.4V9.1M13.3 10.2h1.3V9.1",
  // Merge Down: one isometric sheet with a large straight-down arrow whose
  // tip sits at its centre; the sheet's top edges stop short of the arrowhead.
  mergeDown: "M8 13.6 2.5 16.5 12 21.5 21.5 16.5 16 13.6M12 2.5v12M6.5 10.5 12 16l5.5-5.5",
  // Selection (M): dashed rectangle.
  marqueeRect: "M4 8V6h2M10 6h4M18 6h2v2M20 11v2M20 16v2h-2M14 18h-4M6 18H4v-2M4 13v-2",
  // Elliptical marquee (M): dashed ellipse, 8 short arcs evenly spaced by arc
  // length with ~3.6 px gaps, so the gaps stay open under the round caps
  // (like the rectangle marquee's dashes).
  marqueeEllipse: "M20.4 10.9A8.5 6.5 0 0 1 20.4 13.2M18.5 16.2A8.5 6.5 0 0 1 16.6 17.5M13.1 18.4A8.5 6.5 0 0 1 10.8 18.4M7.4 17.5A8.5 6.5 0 0 1 5.5 16.2M3.6 13.1A8.5 6.5 0 0 1 3.6 10.8M5.5 7.8A8.5 6.5 0 0 1 7.4 6.5M10.9 5.6A8.5 6.5 0 0 1 13.2 5.6M16.6 6.5A8.5 6.5 0 0 1 18.5 7.8",
  // Lasso (L): rope loop with a knot and a dangling tail.
  lasso: "M8.5 14.6C5.8 13.8 4 12.1 4 10c0-3 3.6-5.5 8-5.5s8 2.5 8 5.5-3.6 5.5-8 5.5c-1.3 0-2.5-.2-3.5-.4M8.5 14.6c-1.4.6-1.4 2.2 0 2.6s1.2 2.3-.8 3.3",
  // Magic wand (W): diagonal stick with a sparkle at its tip.
  magicWand: "M4 20 14.5 9.5M13 8l3 3M17 3v4M15 5h4M20.5 9.5v2M19.5 10.5h2M10.5 3.5v2M9.5 4.5h2",
  // Free Transform (M11): box with corner handles and a rotate arc; flips = mirrored
  // triangles about a dashed axis; commit tick; cancel cross.
  transform: "M6 6h12v12H6zM4 4h4v4H4zM16 4h4v4h-4zM16 16h4v4h-4zM4 16h4v4H4zM14 2.5a9 9 0 0 1 7.5 7.5",
  flipH: "M12 3v2M12 8v2M12 13v2M12 18v3M9 6 3 18h6zM15 6l6 12h-6z",
  flipV: "M3 12h2M8 12h2M13 12h2M18 12h3M6 9 18 3v6zM6 15l12 6v-6z",
  check: "M5 12.5 10 17.5 19 7",
  close: "M6 6l12 12M18 6 6 18",
  // "Selection to mask": dashed square with the Quick Mask circle.
  selectionToMask: "M4 7V4h3M10 4h4M17 4h3v3M20 10v4M20 17v3h-3M14 20h-4M7 20H4v-3M4 14v-4M12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6",
  // Image sources (M12): stacked pictures (mountain + sun in the front frame).
  images: "M7 3h14v12M3 7h14v14H3zM3 18l4.5-5 3.5 4 2-2 4 4.5M12.5 10.5a1 1 0 1 0 0 .01"
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
const INSET = 4;
class ImagesPanel {
  /**
   * @param options - History, popover host, layout elements, callbacks.
   */
  constructor(options) {
    this.options = options;
    const button2 = document.createElement("button");
    button2.type = "button";
    button2.className = "cps-rail-button cps-images-button";
    button2.title = "Images from the layer_source input (insert as a new layer)";
    button2.setAttribute("aria-label", button2.title);
    button2.setAttribute("aria-haspopup", "dialog");
    setIcon(button2, "images");
    this.badge = document.createElement("span");
    this.badge.className = "cps-images-badge";
    button2.appendChild(this.badge);
    button2.addEventListener("click", () => this.toggle());
    this.button = button2;
    this.list = document.createElement("div");
    this.list.className = "cps-images-list";
    this.list.setAttribute("role", "listbox");
    const content = document.createElement("div");
    content.className = "cps-images-panel";
    content.appendChild(this.list);
    this.panel = document.createElement("div");
    this.panel.className = "cps-popover cps-images-popover";
    this.panel.appendChild(content);
    const { signal } = this.abort;
    const closeOnPress = () => this.close();
    options.stage.addEventListener("pointerdown", closeOnPress, { capture: true, signal });
    options.toolBox.addEventListener("pointerdown", closeOnPress, { capture: true, signal });
    this.unlisten = options.history?.onChange((change) => this.changed(change)) ?? (() => void 0);
    this.sync();
  }
  options;
  button;
  badge;
  list;
  panel;
  open = false;
  unlisten;
  abort = new AbortController();
  resize = new ResizeObserver(() => this.place());
  /** Whether the panel is open. */
  get isOpen() {
    return this.open;
  }
  /**
   * Keydown from the editor's keyboard scope, before any other handler.
   * @param event - Key event.
   * @returns `true` if consumed (Esc while open).
   */
  handleKey(event) {
    if (!this.open || event.key !== "Escape") return false;
    this.close();
    return true;
  }
  /** Close the panel (idempotent). */
  close() {
    if (!this.open) return;
    this.open = false;
    this.resize.disconnect();
    this.panel.remove();
    this.button.classList.remove("cps-active");
  }
  /** Close and stop listening. */
  dispose() {
    this.close();
    this.unlisten();
    this.abort.abort();
  }
  // ── Internals ───────────────────────────────────────────────────────────
  get entries() {
    return this.options.history?.entries ?? [];
  }
  toggle() {
    if (this.open) {
      this.close();
      return;
    }
    this.options.beforeOpen();
    this.show();
  }
  /** Open (no-op when open or empty). */
  show() {
    if (this.open || this.entries.length === 0) return;
    this.open = true;
    this.render();
    this.options.popovers.element.appendChild(this.panel);
    this.button.classList.add("cps-active");
    this.list.scrollTop = 0;
    this.place();
    this.resize.observe(this.options.stage);
  }
  changed(change) {
    this.sync();
    if (change === "new") this.show();
  }
  /** Badge, disabled state, and the open list. */
  sync() {
    const count = this.entries.length;
    this.badge.textContent = count > 0 ? String(count) : "";
    this.badge.hidden = count === 0;
    this.button.disabled = count === 0;
    if (!this.open) return;
    if (count === 0) this.close();
    else this.render();
  }
  render() {
    this.list.replaceChildren(
      ...this.entries.map((entry, i) => {
        const item = document.createElement("button");
        item.type = "button";
        item.className = "cps-images-item";
        item.setAttribute("role", "option");
        const label = entry.name ? `${entry.name} -- ` : i === 0 ? "Newest -- " : "";
        item.title = label ? `${label}click to insert as a new layer` : "Click to insert as a new layer";
        const img = document.createElement("img");
        img.className = "cps-images-thumb";
        img.alt = "";
        img.decoding = "async";
        img.draggable = false;
        img.src = entry.url;
        item.appendChild(img);
        item.addEventListener("click", () => this.options.pick(entry));
        return item;
      })
    );
  }
  /** Over the left edge of the stage, at most the stage height (root-local CSS px; the root may be CSS-scaled). */
  place() {
    if (!this.open) return;
    const element = this.panel;
    const root = this.options.root;
    const r = root.getBoundingClientRect();
    const s = this.options.stage.getBoundingClientRect();
    const scale = root.offsetWidth > 0 && r.width > 0 ? r.width / root.offsetWidth : 1;
    const left = (s.left - r.left) / scale - root.clientLeft + INSET;
    const top = (s.top - r.top) / scale - root.clientTop + INSET;
    element.style.left = `${Math.round(left)}px`;
    element.style.top = `${Math.round(top)}px`;
    element.style.maxHeight = `${Math.max(40, Math.round(s.height / scale - 2 * INSET))}px`;
  }
}
const MAX_SOURCE_SIDE = 8192;
const SOURCE_LOAD_FAILED_NOTE = "Could not load the image.";
function cappedSourceSize(size, max = MAX_SOURCE_SIDE) {
  const long = Math.max(size.width, size.height);
  if (long <= max) return { width: size.width, height: size.height };
  const k = max / long;
  return { width: Math.max(1, Math.round(size.width * k)), height: Math.max(1, Math.round(size.height * k)) };
}
async function insertSourceUrl(editor, url, current, name) {
  const bitmap = await decodeUrl(url);
  if (!bitmap) {
    log.warn("Could not load the image source:", url);
    editor.events.emit("note", SOURCE_LOAD_FAILED_NOTE);
    return false;
  }
  try {
    if (current() !== editor) return false;
    const size = cappedSourceSize({ width: bitmap.width, height: bitmap.height });
    const canvas = document.createElement("canvas");
    canvas.width = size.width;
    canvas.height = size.height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return false;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, 0, 0, size.width, size.height);
    const pixels = ctx.getImageData(0, 0, size.width, size.height);
    canvas.width = canvas.height = 0;
    if (size.width !== bitmap.width) {
      editor.events.emit("note", `Image reduced to ${size.width} x ${size.height} px (max ${MAX_SOURCE_SIDE} px per side).`);
    }
    return editor.insert.insert(pixels, name);
  } finally {
    bitmap.close();
  }
}
function hexToRgb$1(hex) {
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
function rgbToHex$1(rgb) {
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
  const rgb = hexToRgb$1(hex);
  return rgb ? rgbToHsv(rgb) : null;
}
function hsvToHex(hsv) {
  return rgbToHex$1(hsvToRgb(hsv));
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
function bindCaptureDrag(target, update) {
  target.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    target.setPointerCapture(event.pointerId);
    update(event);
  });
  target.addEventListener("pointermove", (event) => {
    if (!target.hasPointerCapture(event.pointerId)) return;
    update(event);
  });
  target.addEventListener("wheel", (e) => e.stopPropagation());
}
function createSvSquare(getHsv, onChange) {
  const element = document.createElement("div");
  element.className = "cps-picker-sv";
  const canvas = document.createElement("canvas");
  canvas.className = "cps-picker-sv-canvas";
  const thumb = document.createElement("div");
  thumb.className = "cps-picker-sv-thumb";
  element.append(canvas, thumb);
  bindCaptureDrag(element, (event) => {
    const rect = canvas.getBoundingClientRect();
    const s = clamp01((event.clientX - rect.left) / rect.width);
    const v = clamp01(1 - (event.clientY - rect.top) / rect.height);
    onChange({ h: getHsv().h, s, v });
  });
  return {
    element,
    draw: () => {
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const w = canvas.width;
      const h = canvas.height;
      const satGrad = ctx.createLinearGradient(0, 0, w, 0);
      satGrad.addColorStop(0, "#ffffff");
      satGrad.addColorStop(1, hsvToHex({ h: getHsv().h, s: 1, v: 1 }));
      ctx.fillStyle = satGrad;
      ctx.fillRect(0, 0, w, h);
      const valGrad = ctx.createLinearGradient(0, 0, 0, h);
      valGrad.addColorStop(0, "rgba(0,0,0,0)");
      valGrad.addColorStop(1, "#000000");
      ctx.fillStyle = valGrad;
      ctx.fillRect(0, 0, w, h);
    },
    position: () => {
      const hsv = getHsv();
      thumb.style.left = `${clamp01(hsv.s) * 100}%`;
      thumb.style.top = `${(1 - clamp01(hsv.v)) * 100}%`;
    },
    resize: () => {
      const rect = canvas.getBoundingClientRect();
      const w = Math.max(1, Math.round(rect.width));
      const h = Math.max(1, Math.round(rect.height));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
    }
  };
}
function createHueSlider(getHsv, onChange) {
  const element = document.createElement("div");
  element.className = "cps-picker-hue";
  const thumb = document.createElement("div");
  thumb.className = "cps-picker-hue-thumb";
  element.appendChild(thumb);
  bindCaptureDrag(element, (event) => {
    const rect = element.getBoundingClientRect();
    const h = clamp01((event.clientX - rect.left) / rect.width) * 360;
    const hsv = getHsv();
    onChange({ h, s: hsv.s, v: hsv.v });
  });
  return {
    element,
    position: () => {
      thumb.style.left = `${getHsv().h / 360 * 100}%`;
    }
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
const RECENT_KEY = "PainterSketch.recentColors";
const MAX_RECENTS = 10;
function getRecentColors() {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v) => typeof v === "string" && normalizeHex(v) !== null);
  } catch {
    return [];
  }
}
function saveRecentColor(hex) {
  const normalized = normalizeHex(hex);
  if (!normalized) return;
  const existing = getRecentColors().filter((c) => c !== normalized);
  const updated = [normalized, ...existing].slice(0, MAX_RECENTS);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(updated));
  } catch {
  }
}
function renderRecentColors(container, onPick) {
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
  const sv = createSvSquare(() => hsv, (next) => applyHsv(next));
  const hue = createHueSlider(() => hsv, (next) => applyHsv(next));
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
  root.append(sv.element, hue.element, hexRow, preview, recentsEl);
  const applyHsv = (newHsv, skipHexField = false) => {
    hsv = newHsv;
    current = hsvToHex(hsv);
    sv.draw();
    sv.position();
    hue.position();
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
  requestAnimationFrame(() => {
    sv.resize();
    sv.draw();
    sv.position();
    hue.position();
    syncHexField();
    previewOld.style.backgroundColor = initial;
    previewNew.style.backgroundColor = current;
    renderRecentColors(recentsEl, applyHex);
  });
  const handle = host.open(root, {
    anchor,
    placement: "below",
    onClose: () => {
      if (!escaped && !committed) {
        committed = true;
        if (current !== initial) {
          saveRecentColor(current);
          opts.onCommit?.(current);
        }
      } else if (escaped) {
        opts.onInput(initial);
      }
      opts.onClose?.(escaped);
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
const DRAG_BLOCKED_TEXT = "Couldn't load the dragged image (the site doesn't allow it). Save it and drop the file instead.";
const DRAG_NOT_IMAGE_NOTE = "The dropped item is not an image.";
function debug(...args) {
  console.debug("[PainterSketch] drop:", ...args);
}
function installDropImport(stage, actions, note) {
  let lastLogged = "";
  const over = (event) => {
    const data = event.dataTransfer;
    const { types, fileTypes } = dragTypes(data);
    const claim = shouldClaimDrag(types, fileTypes);
    const summary = `${event.type} claim=${claim} types=[${types.join(", ")}] files=[${fileTypes.join(", ")}]`;
    if (event.type === "dragenter" || summary !== lastLogged) debug(summary);
    lastLogged = summary;
    if (!claim) return;
    event.preventDefault();
    event.stopPropagation();
    if (data) data.dropEffect = "copy";
  };
  const drop = (event) => {
    lastLogged = "";
    const data = event.dataTransfer;
    const { types, fileTypes } = dragTypes(data);
    if (!shouldClaimDrag(types, fileTypes)) {
      debug("not claimed, left to ComfyUI", types, fileTypes);
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const point = { x: event.clientX, y: event.clientY };
    const files = imageFiles(data);
    const url = droppedImageUrl(data);
    debug(files.length > 0 ? `files (${files.map((f) => `${f.name} ${f.type}`).join(", ")})` : url ? `url ${url.slice(0, 120)}` : "nothing usable");
    void pasteDrop(actions, files, url, point, note);
  };
  const opts = { capture: true };
  stage.addEventListener("dragenter", over, opts);
  stage.addEventListener("dragover", over, opts);
  stage.addEventListener("drop", drop, opts);
  return () => {
    stage.removeEventListener("dragenter", over, opts);
    stage.removeEventListener("dragover", over, opts);
    stage.removeEventListener("drop", drop, opts);
  };
}
async function pasteDrop(actions, files, url, point, note) {
  if (files.length > 0 && await actions.pasteDropped(files, point)) return;
  if (!url) {
    note(DRAG_NOT_IMAGE_NOTE);
    return;
  }
  const result = await fetchImageBlob(url);
  if ("error" in result) {
    debug(`fetch failed (${result.error})`);
    if (result.error === "blocked") notify("warn", DRAG_BLOCKED_TEXT, { key: "drag-image-blocked" });
    else note(DRAG_NOT_IMAGE_NOTE);
    return;
  }
  if (!await actions.pasteDropped([result.blob], point)) note(DRAG_NOT_IMAGE_NOTE);
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
function findMaskLayer(doc, currentMaskId) {
  if (currentMaskId) {
    const current = doc.layers.find((l) => l.id === currentMaskId);
    if (current?.kind === "mask") return current;
  }
  for (let i = doc.layers.length - 1; i >= 0; i--) {
    const layer = doc.layers[i];
    if (layer?.kind === "mask") return layer;
  }
  return void 0;
}
function findPaintLayer(doc) {
  const active = doc.layers.find((l) => l.id === doc.activeLayerId);
  if (active && active.kind !== "mask") return active;
  for (let i = doc.layers.length - 1; i >= 0; i--) {
    const layer = doc.layers[i];
    if (layer?.kind === "paint") return layer;
  }
  return void 0;
}
function targetLayer(doc, target, currentMaskId) {
  return target === "mask" ? findMaskLayer(doc, currentMaskId) : findPaintLayer(doc);
}
function activeEditLayer(doc, target, currentMaskId) {
  if (target === "mask") return findMaskLayer(doc, currentMaskId);
  const active = doc.layers.find((l) => l.id === doc.activeLayerId);
  return active && active.kind !== "mask" ? active : findPaintLayer(doc);
}
function ensureMaskLayer(doc, style = () => DEFAULT_MASK_STYLE, currentMaskId) {
  const existing = findMaskLayer(doc, currentMaskId);
  if (existing) return { layer: existing, created: false };
  const layer = createMaskLayer(FIRST_MASK_NAME, style());
  doc.layers.push(layer);
  return { layer, created: true };
}
function maskDisplayColor(layer) {
  const color = layer.color;
  return typeof color === "string" && /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(color) ? color : DEFAULT_MASK_COLOR;
}
function soloGroup(layer) {
  return layer.kind === "mask" ? "mask" : "paint";
}
function shownOnStage(layer, solo) {
  if (solo.paint === null && solo.mask === null) return layer.visible;
  return solo[soloGroup(layer)] === layer.id;
}
const BACKGROUND_SOLO_ID = "\0background";
function backgroundShown(visible, solo) {
  return solo.paint === BACKGROUND_SOLO_ID || visible;
}
function toggleSolo(solo, layer) {
  const group2 = soloGroup(layer);
  return { ...solo, [group2]: solo[group2] === layer.id ? null : layer.id };
}
function pruneSolo(solo, layers2) {
  const keep = (group2) => {
    const id = solo[group2];
    if (group2 === "paint" && id === BACKGROUND_SOLO_ID) return id;
    return id !== null && layers2.some((l) => l.id === id && soloGroup(l) === group2) ? id : null;
  };
  return { paint: keep("paint"), mask: keep("mask") };
}
class SoloState {
  /**
   * @param onChange - Called after the solos changed.
   */
  constructor(onChange) {
    this.onChange = onChange;
  }
  onChange;
  ids = { paint: null, mask: null };
  /** Current solos (read-only copy). */
  get current() {
    return this.ids;
  }
  /**
   * Replace the solos.
   * @param next - New solos.
   */
  set(next) {
    if (next.paint === this.ids.paint && next.mask === this.ids.mask) return;
    this.ids = { ...next };
    this.onChange();
  }
  /** End every solo. */
  clear() {
    this.set({ paint: null, mask: null });
  }
}
const PROP_KEYS = ["name", "opacity", "color", "invert"];
function isPaintLike(layer) {
  return layer.kind !== "mask";
}
function paintLayerCount(layers2) {
  let n = 0;
  for (const layer of layers2) if (isPaintLike(layer)) n++;
  return n;
}
const MAX_MASKS = 7;
function maskLayerCount(layers2) {
  let n = 0;
  for (const layer of layers2) if (layer.kind === "mask") n++;
  return n;
}
function canAddMask(layers2) {
  return maskLayerCount(layers2) < MAX_MASKS;
}
function nextMaskName(layers2) {
  const used = /* @__PURE__ */ new Set();
  for (const layer of layers2) {
    if (layer.kind !== "mask") continue;
    const name = layer.name.trim();
    if (name === "Mask") used.add(1);
    const match = /^Mask (\d+)$/.exec(name);
    if (match) used.add(Number(match[1]));
  }
  let n = 1;
  while (used.has(n)) n++;
  return `Mask ${n}`;
}
function maskInsertIndex(layers2, currentMaskId) {
  const current = layers2.findIndex((l) => l.id === currentMaskId);
  if (current >= 0 && layers2[current]?.kind === "mask") return current + 1;
  return layers2.length;
}
function nextLayerName(layers2) {
  let max = 0;
  for (const layer of layers2) {
    const match = /^Layer (\d+)$/.exec(layer.name.trim());
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `Layer ${max + 1}`;
}
function copyLayerName(source, layers2) {
  const base = source.trim().replace(/ copy(?: \d+)?$/, "");
  const taken = new Set(layers2.map((l) => l.name.trim()));
  if (!taken.has(`${base} copy`)) return `${base} copy`;
  let n = 2;
  while (taken.has(`${base} copy ${n}`)) n++;
  return `${base} copy ${n}`;
}
function paintInsertIndex(doc) {
  const layers2 = doc.layers;
  const active = layers2.findIndex((l) => l.id === doc.activeLayerId);
  if (active >= 0 && isPaintLike(layers2[active])) return active + 1;
  for (let i = layers2.length - 1; i >= 0; i--) if (isPaintLike(layers2[i])) return i + 1;
  const firstMask = layers2.findIndex((l) => l.kind === "mask");
  return firstMask >= 0 ? firstMask : layers2.length;
}
function canDeleteLayer(layers2, id) {
  const layer = layers2.find((l) => l.id === id);
  if (!layer) return false;
  return isPaintLike(layer) ? paintLayerCount(layers2) > 1 : maskLayerCount(layers2) > 1;
}
function canDuplicateLayer(layers2, id) {
  const layer = layers2.find((l) => l.id === id);
  return !!layer && isPaintLike(layer);
}
function activeAfterRemoval(layers2, removed) {
  for (let i = Math.min(removed - 1, layers2.length - 1); i >= 0; i--) {
    const layer = layers2[i];
    if (layer && isPaintLike(layer)) return layer.id;
  }
  for (let i = Math.max(0, removed); i < layers2.length; i++) {
    const layer = layers2[i];
    if (layer && isPaintLike(layer)) return layer.id;
  }
  return void 0;
}
function resolveMove(layers2, id, targetId, above) {
  const from = layers2.findIndex((l) => l.id === id);
  const target = layers2.findIndex((l) => l.id === targetId);
  const src = layers2[from];
  const dst = layers2[target];
  if (!src || !dst || isPaintLike(src) !== isPaintLike(dst)) return null;
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
function propsEqual(before, after) {
  return PROP_KEYS.every((key) => key in before === key in after && before[key] === after[key]);
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
function applyLayerChange(layers2, change, forward) {
  switch (change.op) {
    case "insert":
    case "remove": {
      const inserting = change.op === "insert" === forward;
      if (inserting) {
        if (layers2.some((l) => l.id === change.layer.id)) return false;
        layers2.splice(Math.min(change.index, layers2.length), 0, { ...change.layer });
        return true;
      }
      const index = layers2.findIndex((l) => l.id === change.layer.id);
      const live = layers2[index];
      if (!live) return false;
      change.layer = { ...live };
      layers2.splice(index, 1);
      return true;
    }
    case "move": {
      const from = forward ? change.from : change.to;
      const to = forward ? change.to : change.from;
      if (layers2[from]?.id !== change.id) return false;
      const [moved] = layers2.splice(from, 1);
      if (!moved) return false;
      layers2.splice(Math.min(to, layers2.length), 0, moved);
      return true;
    }
    case "props": {
      const layer = layers2.find((l) => l.id === change.id);
      if (!layer) return false;
      writeProps(layer, forward ? change.after : change.before);
      return true;
    }
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
function selectionFromAlpha(rgba, area) {
  const n = area.width * area.height;
  if (rgba.length < n * 4) return null;
  const coverage = new Uint8Array(n);
  for (let i = 0; i < n; i++) coverage[i] = rgba[i * 4 + 3];
  return selectionFromCoverage(coverage, area);
}
function hardenSelection(sel) {
  if (!sel) return null;
  const data = new Uint8Array(sel.data.length);
  for (let i = 0; i < data.length; i++) data[i] = sel.data[i] > 0 ? 255 : 0;
  return { rect: sel.rect, data, outside: sel.outside };
}
function coverageAt(sel, x, y) {
  if (!sel) return 0;
  const { rect } = sel;
  const px = x - rect.x;
  const py = y - rect.y;
  if (px < 0 || py < 0 || px >= rect.width || py >= rect.height) return sel.outside;
  return sel.data[py * rect.width + px];
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
const MOVE_LAYER_ID = "move-layer";
const OUTLINE_ID = "selection-outline";
function moveCursorKind(state) {
  if (state.toolId === OUTLINE_ID) return "outline";
  if (state.toolId !== MOVE_LAYER_ID) return null;
  if (state.floatActive || !state.inSelection) return "move";
  return state.alt ? "copy" : "cut";
}
const SIZE = 32;
const MOVE_PATH = "M11 1.5l-3.5 3.5h2.5v5H5V7.5L1.5 11 5 14.5V12h5v5H7.5l3.5 3.5 3.5-3.5H12v-5h5v2.5l3.5-3.5L17 7.5V10h-5V5h2.5z";
const ARROW_PATH = "M2 2v16l4.2-4 3 6.6 2.6-1.2-3-6.4H14.5z";
const MARQUEE_BADGE = `<path transform='translate(14.2 16.8) scale(0.7)' vector-effect='non-scaling-stroke' d='${iconPath("marqueeRect")}'/>`;
const MODE_MARKS = {
  replace: "",
  add: "<path d='M26 9v6M23 12h6'/>",
  subtract: "<path d='M23 12h6'/>",
  intersect: "<path d='M23.5 9.5l5 5M28.5 9.5l-5 5'/>"
};
const BADGES = {
  cut: "<circle cx='22' cy='28' r='2.2'/><circle cx='28.5' cy='28' r='2.2'/><path d='M23.2 26.2L28 18.5M27.3 26.2L22.5 18.5'/>",
  copy: "<path d='M25 19v10M20 24h10'/>",
  outline: MARQUEE_BADGE
};
const HOTSPOTS$1 = {
  cut: [11, 11, "move"],
  copy: [11, 11, "move"],
  outline: [2, 2, "default"]
};
const cache$1 = /* @__PURE__ */ new Map();
function moveCursorCss(kind) {
  if (kind === "move") return "move";
  const cached = cache$1.get(kind);
  if (cached) return cached;
  const shape = kind === "outline" ? ARROW_PATH : MOVE_PATH;
  const [x, y, fallback] = HOTSPOTS$1[kind];
  const value = badgedCursor(shape, BADGES[kind], x, y, fallback);
  cache$1.set(kind, value);
  return value;
}
function badgedCursor(shape, badge, x, y, fallback) {
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='${SIZE}' height='${SIZE}' viewBox='0 0 ${SIZE} ${SIZE}'><path d='${shape}' fill='#000' stroke='#fff' stroke-width='1.5' stroke-linejoin='round' paint-order='stroke'/><g fill='none' stroke='#fff' stroke-width='3.5' stroke-linecap='round'>${badge}</g><g fill='none' stroke='#000' stroke-width='1.5' stroke-linecap='round'>${badge}</g></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${x} ${y}, ${fallback}`;
}
function layerSelectMode(mods) {
  return mods.ctrl ? selectionMode(mods.shift, mods.alt) : null;
}
const selectCache = /* @__PURE__ */ new Map();
function layerSelectCursorCss(mode) {
  const cached = selectCache.get(mode);
  if (cached) return cached;
  const value = badgedCursor(ARROW_PATH, MARQUEE_BADGE + MODE_MARKS[mode], 2, 2, "default");
  selectCache.set(mode, value);
  return value;
}
const ROTATE_ARCS = "M16 7A9 9 0 0 1 24.46 19.08M16 25A9 9 0 0 1 7.54 12.92";
const ROTATE_HEADS = "M27.5 17.5 24 23.5 20.2 18.4zM4.5 14.5 8 8.5 11.8 13.6z";
let rotateCursor = "";
function rotateCursorCss() {
  if (rotateCursor) return rotateCursor;
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='${SIZE}' height='${SIZE}' viewBox='0 0 ${SIZE} ${SIZE}'><path d='${ROTATE_ARCS}' fill='none' stroke='#fff' stroke-width='4.5'/><path d='${ROTATE_HEADS}' fill='#fff' stroke='#fff' stroke-width='3' stroke-linejoin='round'/><path d='${ROTATE_ARCS}' fill='none' stroke='#000' stroke-width='2'/><path d='${ROTATE_HEADS}' fill='#000'/></svg>`;
  rotateCursor = `url("data:image/svg+xml,${encodeURIComponent(svg)}") 16 16, crosshair`;
  return rotateCursor;
}
const MAX_NAME_LENGTH = 100;
function startInlineRename(host, initial, finish) {
  const input = document.createElement("input");
  input.type = "text";
  input.className = "cps-layer-rename";
  input.value = initial;
  input.spellcheck = false;
  input.maxLength = MAX_NAME_LENGTH;
  host.replaceChildren(input);
  let done = false;
  const end = (commit) => {
    if (done) return;
    done = true;
    finish(commit ? input.value : null);
  };
  input.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Enter") {
      event.preventDefault();
      end(true);
    } else if (event.key === "Escape") {
      event.preventDefault();
      end(false);
    }
  });
  input.addEventListener("blur", () => end(true));
  input.addEventListener("pointerdown", (event) => event.stopPropagation());
  input.addEventListener("click", (event) => event.stopPropagation());
  input.focus({ preventScroll: true });
  input.select();
  return input;
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
    if (kind === "paint") {
      this.textBadge = document.createElement("span");
      this.textBadge.className = "cps-layer-text-badge";
      this.textBadge.title = "Text layer (click it with the Text tool to edit)";
      this.textBadge.hidden = true;
      setIcon(this.textBadge, "text", 12);
      thumbBox.appendChild(this.textBadge);
    }
    this.nameEl = document.createElement("span");
    this.nameEl.className = "cps-layer-name";
    main.append(thumbBox, this.nameEl);
    this.soloButton = button("cps-layer-solo", () => actions.toggleSolo(id));
    setIcon(this.soloButton, "solo", 11);
    this.eye = button("cps-layer-eye", () => actions.toggleVisible(id));
    main.append(this.soloButton, this.eye);
    this.lock = button("cps-layer-lock", () => actions.toggleLocked(id));
    main.appendChild(this.lock);
    this.element.appendChild(main);
    if (kind === "background") {
      this.lock.disabled = true;
      this.lock.title = "The background (input image) is locked";
      setIcon(this.lock, "lock", 14);
    } else {
      this.element.addEventListener("click", (event) => {
        if (isControl(event.target)) return;
        const mode = layerSelectMode({ ctrl: event.ctrlKey || event.metaKey, shift: event.shiftKey, alt: event.altKey });
        if (mode) actions.loadSelection(id, mode);
        else actions.select(id);
      });
      this.nameEl.addEventListener("dblclick", (event) => {
        event.stopPropagation();
        if (!event.ctrlKey && !event.metaKey) this.startRename();
      });
    }
    if (kind === "mask") {
      const extra = document.createElement("div");
      extra.className = "cps-layer-extra";
      const swatch2 = button("cps-layer-swatch", () => actions.pickColor(id, swatch2));
      swatch2.title = "Mask colour (display only)";
      const invert2 = button("cps-layer-invert", () => actions.toggleInvert(id));
      setIcon(invert2, "invert", 14);
      extra.append(swatch2, invert2);
      if (maskOpacity) extra.appendChild(maskOpacity.element);
      this.element.appendChild(extra);
      this.swatch = swatch2;
      this.invertButton = invert2;
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
  textBadge = null;
  soloButton = null;
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
    if (this.textBadge) this.textBadge.hidden = model.text !== true;
    const current = model.current === true;
    el2.classList.toggle("cps-current-mask", current);
    if (current && model.color) el2.style.setProperty("--cps-mask-color", model.color);
    else el2.style.removeProperty("--cps-mask-color");
    el2.title = current ? "Current mask (Quick Mask paints into it)" : "";
    const solo = model.solo ?? "off";
    if (this.soloButton) {
      this.soloButton.classList.toggle("cps-active", solo === "on");
      this.soloButton.setAttribute("aria-pressed", String(solo === "on"));
      this.soloButton.title = solo === "on" ? "End solo (view only)" : this.kind === "background" ? "Solo the background: hide all paint layers (view only)" : "Solo: show only this layer in its group (view only)";
    }
    if (!this.editor) this.nameEl.textContent = model.name;
    this.nameEl.title = this.kind === "background" ? "Input image" : `${model.name} (double-click to rename)`;
    if (this.eye) {
      const icon = model.visible ? "eye" : "eyeOff";
      if (icon !== this.icons.eye) setIcon(this.eye, icon, 14);
      this.icons.eye = icon;
      this.eye.classList.toggle("cps-off", !model.visible);
      this.eye.classList.toggle("cps-solo-dimmed", solo === "dimmed");
      this.eye.classList.toggle("cps-solo-on", solo === "on");
      this.eye.setAttribute("aria-pressed", String(model.visible));
      this.eye.title = this.kind === "background" ? model.visible ? "Hide background (shows transparency; outputs use the background colour instead of the image)" : "Show background (input image)" : this.kind === "mask" ? model.visible ? "Hide mask (also excludes it from the MASK output)" : "Show mask (hidden masks are excluded from the MASK output)" : model.visible ? "Hide layer" : "Show layer";
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
    this.actions.renaming(true);
    this.editor = startInlineRename(this.nameEl, this.model?.name ?? "", (value) => {
      this.editor = null;
      this.nameEl.textContent = this.model?.name ?? "";
      if (value !== null) this.actions.rename(this.id, value);
      this.actions.renaming(false);
    });
  }
}
function button(className, onClick) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = `cps-icon-button cps-layer-button ${className}`;
  b.addEventListener("click", (event) => {
    event.stopPropagation();
    event.preventDefault();
    onClick(event);
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
    if (event.button !== 0 || event.ctrlKey || event.metaKey || isControl(event.target) || !(event.target instanceof Element)) return;
    const row = event.target.closest(".cps-layer-paint, .cps-layer-mask");
    const id = row?.dataset["layerId"];
    if (!row || !id) return;
    const group2 = row.classList.contains("cps-layer-mask") ? ".cps-layer-mask" : ".cps-layer-paint";
    this.press = { id, pointerId: event.pointerId, startY: event.clientY, row, group: group2 };
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
    this.drop = this.findDrop(event.clientY, press.group);
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
  /** Row of the dragged row's group under (or nearest to) the pointer, above/below its middle. */
  findDrop(clientY, group2) {
    const rows = [...this.list.querySelectorAll(group2)];
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
    case "text": {
      if (typeof value !== "string") return void 0;
      const clean2 = value.replace(/\s+/g, " ").trim();
      return clean2 && clean2.length <= (desc.maxLength ?? 100) ? clean2 : void 0;
    }
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
const GENERIC_FAMILIES = /* @__PURE__ */ new Set([
  "serif",
  "sans-serif",
  "monospace",
  "cursive",
  "fantasy",
  "system-ui",
  "ui-serif",
  "ui-sans-serif",
  "ui-monospace",
  "ui-rounded",
  "math",
  "emoji"
]);
const INK_PAD = 2;
function isGenericFamily(font) {
  return GENERIC_FAMILIES.has(font.trim().toLowerCase());
}
function cssFontFamily(font) {
  const name = font.trim();
  if (!name) return "sans-serif";
  if (isGenericFamily(name)) return name.toLowerCase();
  return `"${name.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}", sans-serif`;
}
function fontString(td) {
  const style = td.italic ? "italic " : "";
  const weight = td.bold ? "bold " : "";
  return `${style}${weight}${roundPx(td.size)}px ${cssFontFamily(td.font)}`;
}
function lineHeightPx(td) {
  return td.size * (td.lineHeight ?? DEFAULT_LINE_HEIGHT);
}
function isFontAvailable(font) {
  if (!font.trim() || isGenericFamily(font)) return true;
  const fonts = typeof document !== "undefined" ? document.fonts : void 0;
  if (!fonts || typeof fonts.check !== "function") return true;
  try {
    return fonts.check(`12px ${cssFontFamily(font).replace(/, sans-serif$/, "")}`);
  } catch {
    return true;
  }
}
function layoutText(td, measure) {
  const lineHeight = lineHeightPx(td);
  const texts = td.text.split("\n");
  const metrics = texts.map((t) => measure(t));
  const first = metrics[0] ?? measure("");
  const fontAscent = first.fontAscent;
  const halfLeading = (lineHeight - (fontAscent + first.fontDescent)) / 2;
  const maxWidth = Math.max(0, ...metrics.map((m) => m.width));
  const lines = [];
  let ink = null;
  for (let i = 0; i < texts.length; i++) {
    const text = texts[i] ?? "";
    const m = metrics[i] ?? first;
    const baseline = td.y + i * lineHeight;
    const x = alignedX(td, m.width);
    lines.push({ text, x, baseline, width: m.width });
    if (!text) continue;
    const left = Math.min(x, x - m.left);
    const right = Math.max(x + m.width, x + m.right);
    const top = baseline - Math.max(m.ascent, m.fontAscent);
    const bottom = baseline + Math.max(m.descent, m.fontDescent);
    const r = { x: left, y: top, width: right - left, height: bottom - top };
    ink = ink ? unionRect(ink, r) : r;
  }
  const box = {
    x: alignedX(td, maxWidth),
    y: td.y - halfLeading - fontAscent,
    width: maxWidth,
    height: lineHeight * texts.length
  };
  const inkRect = ink ?? { x: box.x, y: box.y, width: 0, height: 0 };
  const bbox = inkRect.width > 0 && inkRect.height > 0 ? roundOutRect({
    x: inkRect.x - INK_PAD,
    y: inkRect.y - INK_PAD,
    width: inkRect.width + INK_PAD * 2,
    height: inkRect.height + INK_PAD * 2
  }) : { x: Math.floor(box.x), y: Math.floor(box.y), width: 0, height: 0 };
  const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const rotation = td.rotation ?? 0;
  const paint2 = rotation && bbox.width > 0 ? rotatedAabb(bbox, rotation, centre) : bbox;
  return { lines, lineHeight, box, bbox, centre, rotation, paint: paint2 };
}
function rotatedAabb(rect, deg, centre) {
  const pts = [
    { x: rect.x, y: rect.y },
    { x: rect.x + rect.width, y: rect.y },
    { x: rect.x + rect.width, y: rect.y + rect.height },
    { x: rect.x, y: rect.y + rect.height }
  ].map((p) => rotatePoint(p, deg, centre));
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const x0 = Math.floor(Math.min(...xs) + 1e-6);
  const y0 = Math.floor(Math.min(...ys) + 1e-6);
  const x1 = Math.ceil(Math.max(...xs) - 1e-6);
  const y1 = Math.ceil(Math.max(...ys) - 1e-6);
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}
function rotatePoint(p, deg, centre) {
  const r = deg * Math.PI / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  const dx = p.x - centre.x;
  const dy = p.y - centre.y;
  return { x: centre.x + cos * dx - sin * dy, y: centre.y + sin * dx + cos * dy };
}
function alignedX(td, width) {
  if (td.align === "center") return td.x - width / 2;
  if (td.align === "right") return td.x - width;
  return td.x;
}
let scratch = null;
function measureContext() {
  if (!scratch && typeof document !== "undefined") scratch = document.createElement("canvas").getContext("2d");
  return scratch;
}
function canvasMeasure(td) {
  const ctx = measureContext();
  const size = td.size;
  if (!ctx) {
    return (line) => {
      const width = line.length * size * 0.55;
      return { width, left: 0, right: width, ascent: size * 0.8, descent: size * 0.2, fontAscent: size * 0.9, fontDescent: size * 0.25 };
    };
  }
  const font = fontString(td);
  return (line) => {
    ctx.font = font;
    const m = ctx.measureText(line);
    const probe = line ? m : ctx.measureText("Hg");
    return {
      width: m.width,
      left: m.actualBoundingBoxLeft ?? 0,
      right: m.actualBoundingBoxRight ?? m.width,
      ascent: m.actualBoundingBoxAscent ?? size * 0.8,
      descent: m.actualBoundingBoxDescent ?? size * 0.2,
      fontAscent: probe.fontBoundingBoxAscent ?? size * 0.9,
      fontDescent: probe.fontBoundingBoxDescent ?? size * 0.25
    };
  };
}
const layoutCache = /* @__PURE__ */ new WeakMap();
function textLayout(td) {
  let layout = layoutCache.get(td);
  if (!layout) {
    layout = layoutText(td, canvasMeasure(td));
    layoutCache.set(td, layout);
  }
  return layout;
}
function drawText(ctx, td, origin) {
  const layout = textLayout(td);
  ctx.save();
  const r = layout.rotation * Math.PI / 180;
  const cos = layout.rotation ? Math.cos(r) : 1;
  const sin = layout.rotation ? Math.sin(r) : 0;
  const cx = layout.centre.x - origin.x;
  const cy = layout.centre.y - origin.y;
  ctx.setTransform(cos, sin, -sin, cos, cx - (cos * cx - sin * cy), cy - (sin * cx + cos * cy));
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  ctx.font = fontString(td);
  ctx.fillStyle = td.color;
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  for (const line of layout.lines) {
    if (line.text) ctx.fillText(line.text, line.x - origin.x, line.baseline - origin.y);
  }
  ctx.restore();
  return layout.paint;
}
function roundPx(size) {
  return Math.round(size * 100) / 100;
}
const CUSTOM = "\0custom";
function textControl(desc, ctx) {
  const element = document.createElement("label");
  element.className = "cps-select cps-text-option";
  if (desc.title) element.title = desc.title;
  const name = document.createElement("span");
  name.className = "cps-num-label";
  name.textContent = desc.label;
  const select = document.createElement("select");
  const field = document.createElement("input");
  field.type = "text";
  field.className = "cps-num-input cps-text-field";
  field.spellcheck = false;
  field.maxLength = desc.maxLength ?? 100;
  field.hidden = true;
  element.append(name, select, field);
  let signature = "";
  let typing = false;
  const current = () => {
    const v = ctx.options.get(desc.key);
    return typeof v === "string" ? v : "";
  };
  const rebuild = () => {
    const value = current();
    const list = desc.suggestions();
    const listed = list.find((v) => v.toLowerCase() === value.toLowerCase());
    const entries = listed || !value ? list : [value, ...list];
    const next = `${entries.join("\n")}|${value}`;
    if (next !== signature) {
      signature = next;
      const options = entries.map((v) => option(v, v, desc.previewFont === true));
      select.replaceChildren(...options, option(CUSTOM, desc.customLabel, false));
    }
    select.value = listed ?? value;
  };
  const finish = (commit) => {
    if (!typing) return;
    typing = false;
    field.hidden = true;
    select.hidden = false;
    if (commit && ctx.options.set(desc.key, field.value)) ctx.changed();
    refresh();
  };
  select.addEventListener("change", () => {
    if (select.value !== CUSTOM) {
      if (ctx.options.set(desc.key, select.value)) ctx.changed();
      return;
    }
    typing = true;
    select.hidden = true;
    field.hidden = false;
    field.value = current();
    field.focus({ preventScroll: true });
    field.select();
  });
  field.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== "Escape") return;
    event.preventDefault();
    finish(event.key === "Enter");
  });
  field.addEventListener("blur", () => finish(true));
  const refresh = () => {
    if (!typing) rebuild();
    element.classList.toggle("cps-dim", !isOptionEnabled(desc, (k) => ctx.options.get(k)));
  };
  refresh();
  return { element, refresh };
}
function option(value, label, preview) {
  const el2 = document.createElement("option");
  el2.value = value;
  el2.textContent = label;
  if (preview) el2.style.fontFamily = cssFontFamily(value);
  return el2;
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
    case "text":
      return textControl(desc, ctx);
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
  const endEdit = () => ctx.options.endEdit?.(desc.key);
  let popover = null;
  const refresh = () => {
    value.textContent = `${formatDisplay(desc, display())}${desc.unit ?? ""}`;
    element.classList.toggle("cps-dim", !isOptionEnabled(desc, (k) => ctx.options.get(k)));
    popover?.sync();
  };
  label.addEventListener("pointerdown", (event) => startScrub(event, label, desc, display, commit, endEdit));
  value.addEventListener("click", () => {
    if (popover) {
      popover.handle.close();
      return;
    }
    popover = openSlider(desc, ctx, value, display, commit, endEdit, () => {
      popover = null;
      endEdit();
    });
  });
  refresh();
  return { element, refresh };
}
function startScrub(event, label, desc, display, commit, endEdit) {
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
    endEdit();
  };
  const { signal } = controller;
  label.addEventListener("pointermove", move, { signal });
  label.addEventListener("pointerup", end, { signal });
  label.addEventListener("pointercancel", end, { signal });
  label.addEventListener("lostpointercapture", end, { signal });
}
function openSlider(desc, ctx, anchor, display, commit, endEdit, onClose) {
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
    endEdit();
    field.value = formatDisplay(desc, display());
  };
  range.addEventListener("input", () => commit(sliderToDisplay(desc, Number(range.value) / SLIDER_STEPS)));
  range.addEventListener("change", endEdit);
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
  if (desc.icon) {
    element.classList.add("cps-icon-command");
    element.setAttribute("aria-label", desc.label);
    setIcon(element, desc.icon, 16);
  } else {
    element.textContent = desc.label;
  }
  element.title = desc.title ?? desc.label;
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
    const option2 = document.createElement("option");
    option2.value = choice.value;
    option2.textContent = choice.label;
    select.appendChild(option2);
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
    const apply2 = (hex) => {
      target.editor.layerOps.setMaskColor(target.layerId, hex, gesture);
    };
    this.pick(anchor, { initial, title: "Mask colour", onInput: apply2, onCommit: apply2 });
  }
}
const ROW_SELECTOR = ".cps-layer-paint, .cps-layer-mask";
class LayerSelectHover {
  controller = new AbortController();
  keys = null;
  row = null;
  mods = { ctrl: false, shift: false, alt: false };
  /**
   * @param list - The rows container.
   */
  constructor(list) {
    const { signal } = this.controller;
    list.addEventListener("pointerenter", () => this.listenKeys(), { signal });
    list.addEventListener("pointerleave", () => this.leave(), { signal });
    list.addEventListener("pointermove", (e) => this.move(e), { signal });
  }
  /** Remove listeners and any cursor override. */
  dispose() {
    this.leave();
    this.controller.abort();
  }
  move(event) {
    const target = event.target;
    const row = target instanceof Element && !isControl(target) ? target.closest(ROW_SELECTOR) : null;
    if (row !== this.row) {
      this.clear();
      this.row = row;
    }
    this.read(event);
    this.listenKeys();
  }
  listenKeys() {
    if (this.keys) return;
    this.keys = new AbortController();
    const opts = { capture: true, signal: this.keys.signal };
    window.addEventListener("keydown", (e) => this.read(e), opts);
    window.addEventListener("keyup", (e) => this.read(e), opts);
  }
  leave() {
    this.keys?.abort();
    this.keys = null;
    this.clear();
    this.row = null;
  }
  read(event) {
    this.mods = { ctrl: event.ctrlKey || event.metaKey, shift: event.shiftKey, alt: event.altKey };
    this.apply();
  }
  apply() {
    const row = this.row;
    if (!row) return;
    const mode = layerSelectMode(this.mods);
    row.style.cursor = mode ? layerSelectCursorCss(mode) : "";
  }
  clear() {
    if (this.row) this.row.style.cursor = "";
  }
}
function soloMark(layer, solo) {
  if (solo.paint === null && solo.mask === null) return "off";
  return solo[soloGroup(layer)] === layer.id ? "on" : "dimmed";
}
function rowModel(layer, flags) {
  const model = {
    id: layer.id,
    name: layer.name,
    visible: layer.visible,
    locked: layer.locked,
    selected: flags.selected,
    standby: flags.standby,
    solo: flags.solo
  };
  if (layer.kind === "mask") {
    model.color = maskDisplayColor(layer);
    model.invert = layer.invert === true;
    model.current = flags.current;
  }
  if (layer.kind === "text") model.text = true;
  return model;
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
const BACKGROUND_ID = BACKGROUND_SOLO_ID;
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
    this.addMaskButton = footerButton("maskAdd", "New mask", () => this.addMask());
    this.duplicateButton = footerButton("duplicate", "Duplicate layer", () => this.withEditor((e) => e.layerOps.duplicate()));
    this.mergeButton = footerButton("mergeDown", "Merge Down (Ctrl+E)", () => this.withEditor((e) => e.mergeDown()));
    this.deleteButton = footerButton("trash", "Delete layer", () => this.deleteSelected());
    this.moveDrawingButton = moveDrawingBtn(() => this.ctx.toggleMoveDrawing());
    const footerDivider = document.createElement("div");
    footerDivider.className = "cps-layers-footer-divider";
    footer.append(this.moveDrawingButton, footerDivider, this.addButton, this.addMaskButton, this.duplicateButton, this.mergeButton, this.deleteButton);
    this.element.append(header, this.list, footer);
    this.maskColor = new MaskColorPicker(ctx.pickColor);
    this.actions = this.rowActions();
    this.drag = new LayerDrag(
      this.list,
      (id, drop) => this.withEditor((e) => e.layerOps.move(id, drop.targetId, drop.above))
    );
    this.unbind.push(ctx.sidePanel.events.on("collapse", (collapsed) => !collapsed && this.thumbs.request()));
    const hover = new LayerSelectHover(this.list);
    this.unbind.push(() => hover.dispose());
  }
  ctx;
  element;
  list;
  opacity;
  addButton;
  addMaskButton;
  duplicateButton;
  mergeButton;
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
        editor.events.on("solo", () => this.sync()),
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
  /**
   * Red Move drawing icon while the image is much finer than the drawing grid.
   * @param on - Mismatch notice showing.
   */
  setMoveDrawingWarning(on) {
    this.moveDrawingButton.classList.toggle("cps-resolution-warn", on);
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
        const isCurrentMask = kind === "mask" && layer.id === maskId;
        const selected = kind === "mask" ? targeting && isCurrentMask : !targeting && active;
        const solo = soloMark(layer, editor.solo);
        row.update(rowModel(layer, { selected, standby: targeting && active, current: isCurrentMask, solo }));
        wanted.push(row);
      }
      const bg = this.rowFor("background", BACKGROUND_ID);
      const bgSolo = editor.solo.paint === BACKGROUND_ID ? "on" : "off";
      bg.update({ id: BACKGROUND_ID, name: "Background", visible: doc.backgroundVisible !== false, locked: true, selected: false, standby: false, solo: bgSolo });
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
    const targeting = editor?.paintTarget === "mask";
    const paintId = editor && target && !targeting ? target.layerId : null;
    this.addButton.disabled = !editor;
    const canAddMask2 = !!editor && editor.layerOps.canAddMask();
    this.addMaskButton.disabled = !canAddMask2;
    this.addMaskButton.title = !editor || canAddMask2 ? "New mask (above the current mask)" : `At most ${MAX_MASKS} masks`;
    this.duplicateButton.disabled = !(editor && paintId && editor.layerOps.canDuplicate(paintId));
    this.mergeButton.disabled = !editor?.canMergeDown();
    const deletable = !!(editor && target && editor.layerOps.canDelete(target.layerId));
    this.deleteButton.disabled = !deletable;
    this.deleteButton.title = !targeting ? "Delete layer" : deletable ? "Delete mask" : "The last mask can't be deleted (clear it instead)";
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
    const imageSize2 = editor.imageSize;
    const fmap = editor.frameMap;
    const imgInDoc = imageRectToDoc(fmap, { x: 0, y: 0, width: imageSize2.width, height: imageSize2.height });
    const region = { x: imgInDoc.x - bounds.x, y: imgInDoc.y - bounds.y, width: imgInDoc.width, height: imgInDoc.height };
    const placement = doc.placement;
    const placementKey = placement ? `${placement.x},${placement.y},${placement.scale}` : "0,0,1";
    const geometry = `${bounds.x},${bounds.y},${bounds.width},${bounds.height}|${imageSize2.width}x${imageSize2.height}|${placementKey}`;
    for (const layer of doc.layers) {
      const row = this.rows.get(layer.id);
      if (!row) continue;
      const mask = layer.kind === "mask";
      const invert2 = mask && layer.invert === true;
      const key = `${editor.layerOps.revision(layer.id)}|${geometry}|${invert2}`;
      row.thumb.update(key, imageSize2, { kind: "layer", canvas: editor.layerCanvas(layer.id), region, mask, invert: invert2 });
    }
    const bg = this.rows.get(BACKGROUND_ID);
    if (bg) {
      const background = editor.background;
      const id = background.kind === "fill" ? background.color : this.backgroundId(background.image);
      bg.thumb.update(`${id}|${imageSize2.width}x${imageSize2.height}`, imageSize2, { kind: "background", background, size: imageSize2 });
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
        if (e.selectMask(id)) return;
        e.layerOps.setActiveLayer(id);
        e.setPaintTarget("paint");
      }),
      // Selection only: the current layer, Quick Mask and solo stay as they are.
      loadSelection: (id, mode) => this.withEditor((e) => e.selection.fromLayer(id, mode)),
      toggleVisible: (id) => this.withEditor(
        (e) => id === BACKGROUND_ID ? e.layerOps.setBackgroundVisible(e.doc.backgroundVisible === false) : e.layerOps.setVisible(id, !findLayer$1(e, id)?.visible)
      ),
      // View only: no beforeEdit (a stage drag in progress is not an edit conflict).
      toggleSolo: (id) => this.editor?.toggleSolo(id),
      toggleLocked: (id) => this.withEditor((e) => e.layerOps.setLocked(id, !findLayer$1(e, id)?.locked)),
      rename: (id, name) => this.withEditor((e) => e.layerOps.rename(id, name)),
      toggleInvert: (id) => this.withEditor((e) => e.layerOps.setMaskInvert(id, findLayer$1(e, id)?.invert !== true)),
      pickColor: (id, anchor) => {
        const editor = this.editor;
        const layer = editor && findLayer$1(editor, id);
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
  addMask() {
    this.withEditor((e) => {
      const id = e.layerOps.addMask();
      if (id) e.selectMask(id);
    });
  }
  /** Delete the selected row's layer (the current mask in Quick Mask, else the active layer). */
  deleteSelected() {
    this.withEditor((e) => {
      const target = this.selectedTarget();
      if (target) e.layerOps.remove(target.layerId);
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
    return editor && findLayer$1(editor, id) ? { editor, layerId: id } : null;
  }
}
function findLayer$1(editor, id) {
  return editor.doc.layers.find((l) => l.id === id);
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
    const invert2 = document.createElement("button");
    invert2.type = "button";
    invert2.className = "cps-toggle";
    invert2.title = "Invert selection (Ctrl+Shift+I)";
    setIcon(invert2, "invert", 14);
    invert2.append("Invert");
    invert2.addEventListener("click", () => this.editor?.selection.invert());
    this.element.append(toMask, invert2);
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
const LONG_PRESS_MS$1 = 400;
const MODES$1 = {
  system: { icon: "paste", label: "System clipboard" },
  clipspace: { icon: "pasteClipspace", label: "Clipspace" }
};
function pasteButtonTitle(mode) {
  const source = mode === "clipspace" ? "from the ComfyUI clipspace" : "from the system clipboard (else our copy, else clipspace), Ctrl+V";
  return `Paste as new layer ${source}. Ctrl+Shift+V pastes our copy in place. Hold for sources`;
}
class PasteButton {
  /**
   * @param options - Popover host and callbacks.
   */
  constructor(options) {
    this.options = options;
    const button2 = document.createElement("button");
    button2.type = "button";
    button2.className = "cps-rail-button cps-rail-grouped";
    button2.setAttribute("aria-haspopup", "menu");
    button2.addEventListener("click", () => this.handleClick());
    button2.addEventListener("pointerdown", (e) => this.startPress(e));
    button2.addEventListener("pointerup", () => this.endPress());
    button2.addEventListener("pointerleave", () => this.endPress());
    button2.addEventListener("pointercancel", () => this.endPress());
    button2.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      this.endPress();
      this.openMenu();
    });
    this.element = button2;
    this.render();
  }
  options;
  element;
  pressTimer = null;
  suppressClick = false;
  menu = null;
  /** Current main action (per instance, like `ToolGroupSlot.currentId`). */
  currentMode = "system";
  /** Close the menu and stop timers. */
  dispose() {
    this.endPress();
    this.menu?.close();
  }
  // ── Internals ───────────────────────────────────────────────────────────
  /** Icon + tooltip for the current mode (the corner mark shows there is a menu). */
  render() {
    const button2 = this.element;
    setIcon(button2, MODES$1[this.currentMode].icon);
    const corner = document.createElement("span");
    corner.className = "cps-rail-corner";
    button2.appendChild(corner);
    const title = pasteButtonTitle(this.currentMode);
    button2.title = title;
    button2.setAttribute("aria-label", title);
  }
  handleClick() {
    if (this.suppressClick) {
      this.suppressClick = false;
      return;
    }
    this.menu?.close();
    this.options.paste(this.currentMode);
  }
  startPress(event) {
    this.suppressClick = false;
    if (event.button !== 0) return;
    this.endPress();
    this.pressTimer = setTimeout(() => {
      this.pressTimer = null;
      this.suppressClick = true;
      this.openMenu();
    }, LONG_PRESS_MS$1);
  }
  endPress() {
    if (this.pressTimer !== null) clearTimeout(this.pressTimer);
    this.pressTimer = null;
  }
  openMenu() {
    if (this.menu) return;
    const menu = document.createElement("div");
    menu.className = "cps-tool-flyout";
    menu.setAttribute("role", "menu");
    menu.append(this.item("system"), this.item("clipspace"));
    this.menu = this.options.popovers.open(menu, {
      anchor: this.element,
      placement: "right",
      onClose: () => {
        this.menu = null;
      }
    });
  }
  item(mode) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "cps-tool-flyout-item";
    if (mode === this.currentMode) item.classList.add("cps-active");
    item.setAttribute("role", "menuitem");
    setIcon(item, MODES$1[mode].icon, 18);
    const text = document.createElement("span");
    text.textContent = MODES$1[mode].label;
    item.appendChild(text);
    item.addEventListener("click", () => {
      this.menu?.close();
      this.currentMode = mode;
      this.render();
      this.options.paste(mode);
    });
    return item;
  }
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
    const clipboardGroup = group();
    clipboardGroup.classList.add("cps-rail-clipboard");
    this.pasteButton = new PasteButton({
      popovers,
      paste: (request) => this.actions.paste(request)
    });
    clipboardGroup.append(
      railButton("copy", "Copy (Ctrl+C; Ctrl+Shift+C copies merged)", () => this.actions.copy()),
      railButton("cut", "Cut (Ctrl+X)", () => this.actions.cut()),
      this.pasteButton.element
    );
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
    container.append(this.toolBox, maskGroup, spacer, clipboardGroup, actionGroup);
  }
  actions;
  popovers;
  toolButtons = /* @__PURE__ */ new Map();
  /** Tool buttons group (the Images panel closes on presses here). */
  toolBox;
  undoButton;
  redoButton;
  quickMaskButton;
  fullscreenButton;
  pasteButton;
  toolIds = "";
  groupSlots = [];
  /**
   * Add a button to the clipboard group, after Paste (M12 Images button).
   * @param element - Button element.
   */
  appendClipboardButton(element) {
    this.pasteButton.element.after(element);
  }
  /** Stop the Paste button's long-press timer and close its menu. */
  dispose() {
    this.pasteButton.dispose();
    for (const slot of this.groupSlots) slot.dispose();
  }
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
const REGION_HANDLES = [
  { x: -1, y: -1 },
  { x: 1, y: -1 },
  { x: 1, y: 1 },
  { x: -1, y: 1 },
  { x: 0, y: -1 },
  { x: 1, y: 0 },
  { x: 0, y: 1 },
  { x: -1, y: 0 }
];
function regionHandlePoint(rect, handle) {
  return {
    x: rect.x + (handle.x + 1) * rect.width / 2,
    y: rect.y + (handle.y + 1) * rect.height / 2
  };
}
function hitRegionHandle(rect, p, tolerance) {
  const hit = REGION_HANDLES.find((handle) => {
    const at = regionHandlePoint(rect, handle);
    return Math.abs(p.x - at.x) <= tolerance && Math.abs(p.y - at.y) <= tolerance;
  });
  return hit ?? null;
}
function insideRegion(rect, p) {
  return rectContainsPoint(rect, p);
}
function drawRegionRect(start, end, image) {
  const x = Math.min(start.x, end.x);
  const y = Math.min(start.y, end.y);
  const rect = { x, y, width: Math.max(start.x, end.x) - x, height: Math.max(start.y, end.y) - y };
  return clampRegionRect(rect, image);
}
function dragRegionRect(rect, delta, image, handle) {
  const dx = roundRegionEdge(delta.x);
  const dy = roundRegionEdge(delta.y);
  if (!handle) return moveRect(rect, dx, dy, image);
  let left = rect.x;
  let top = rect.y;
  let right = rect.x + rect.width;
  let bottom = rect.y + rect.height;
  if (handle.x < 0) left = Math.min(left + dx, right - 1);
  if (handle.x > 0) right = Math.max(right + dx, left + 1);
  if (handle.y < 0) top = Math.min(top + dy, bottom - 1);
  if (handle.y > 0) bottom = Math.max(bottom + dy, top + 1);
  return clampRegionRect({ x: left, y: top, width: right - left, height: bottom - top }, image);
}
function moveRect(rect, dx, dy, image) {
  const area = regionArea(image);
  const x = clampNumber(rect.x + dx, area.x, area.x + area.width - rect.width);
  const y = clampNumber(rect.y + dy, area.y, area.y + area.height - rect.height);
  return clampRegionRect({ x, y, width: rect.width, height: rect.height }, image);
}
function regionFieldBounds(rect, field, image) {
  const area = regionArea(image);
  const right = area.x + area.width;
  const bottom = area.y + area.height;
  if (field === "x") return { min: area.x, max: right - rect.width };
  if (field === "y") return { min: area.y, max: bottom - rect.height };
  if (field === "width") return { min: 1, max: right - rect.x };
  return { min: 1, max: bottom - rect.y };
}
const SCRUB_PX_PER_STEP = 2;
const SCRUB_SHIFT_FACTOR = 10;
function outputField(options) {
  const element = document.createElement("label");
  element.className = "cps-output-field";
  const label = document.createElement("span");
  label.textContent = options.label;
  const input = document.createElement("input");
  input.type = options.bounds ? "number" : "text";
  input.step = "1";
  input.spellcheck = false;
  input.setAttribute("aria-label", options.title ?? options.label);
  element.append(label, input);
  let editing = false;
  let scrub = null;
  let releaseCapture = null;
  const refresh = () => {
    if (!editing || scrub) input.value = String(options.read());
    if (!options.bounds) return;
    const bounds = options.bounds();
    input.min = String(bounds.min);
    input.max = String(bounds.max);
  };
  const begin = () => {
    if (editing) return;
    options.beforeEdit();
    editing = options.ops.begin();
  };
  const end = (cancel) => {
    scrub?.abort();
    scrub = null;
    releaseCapture?.();
    releaseCapture = null;
    if (!editing) return;
    editing = false;
    if (cancel) options.ops.cancel();
    else options.ops.commit();
    refresh();
  };
  const typedValueValid = () => {
    if (!options.bounds) return true;
    return input.value !== "" && Number.isFinite(input.valueAsNumber);
  };
  input.addEventListener("focus", begin);
  input.addEventListener("input", () => {
    begin();
    if (editing && typedValueValid()) options.write(input.value);
  });
  input.addEventListener("blur", () => {
    end(false);
    options.releaseFocus();
  });
  input.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" && event.key !== "Enter") return;
    event.preventDefault();
    event.stopPropagation();
    end(event.key === "Escape");
    input.blur();
  });
  if (options.bounds) {
    label.className = "cps-output-scrub";
    label.title = `${options.title ?? options.label}: drag to scrub (Shift = x10), Esc reverts`;
    label.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      input.focus({ preventScroll: true });
      begin();
      if (editing) startScrub2(event);
    });
  }
  function startScrub2(event) {
    const start = Number(options.read());
    const x0 = event.clientX;
    const id = event.pointerId;
    label.setPointerCapture(id);
    scrub = new AbortController();
    releaseCapture = () => {
      if (label.hasPointerCapture(id)) label.releasePointerCapture(id);
    };
    const { signal } = scrub;
    label.addEventListener(
      "pointermove",
      (e) => {
        const bounds = options.bounds?.();
        if (e.pointerId !== id || !bounds) return;
        const steps = Math.trunc((e.clientX - x0) / SCRUB_PX_PER_STEP);
        const step = e.shiftKey ? SCRUB_SHIFT_FACTOR : 1;
        options.write(String(clampNumber(start + steps * step, bounds.min, bounds.max)));
        refresh();
      },
      { signal }
    );
    const finish = (e) => {
      if (e.pointerId !== id) return;
      end(e.type !== "pointerup");
      input.blur();
    };
    label.addEventListener("pointerup", finish, { signal });
    label.addEventListener("pointercancel", finish, { signal });
    label.addEventListener("lostpointercapture", finish, { signal });
  }
  refresh();
  return { element, input, refresh, dispose: () => end(true) };
}
const MODES = [
  ["none", "None"],
  ["fill", "Fill mask"],
  ["crop", "Crop to mask"],
  ["border", "Add border"]
];
function readMode(value) {
  return value === "none" || value === "fill" || value === "crop" || value === "border" ? value : null;
}
class OutputOptionsRow {
  /**
   * @param id - Region id, or null for Main.
   * @param ctx - Card services.
   */
  constructor(id, ctx) {
    this.id = id;
    this.ctx = ctx;
    const ops = ctx.editor.regionOps;
    this.element.className = "cps-output-options";
    this.mode.className = "cps-output-mode";
    this.mode.title = "Modify this output";
    this.mode.setAttribute("aria-label", this.mode.title);
    for (const [value, text] of MODES) {
      const option2 = document.createElement("option");
      option2.value = value;
      option2.textContent = text;
      this.mode.append(option2);
    }
    this.mode.addEventListener("change", () => {
      const mode = readMode(this.mode.value);
      if (!mode) return;
      ctx.beforeEdit();
      ops.setOptions(id, { applyMask: mode });
    });
    this.swatch.type = "button";
    this.swatch.className = "cps-output-swatch";
    this.swatch.addEventListener("click", () => this.pickColor());
    this.padding = outputField({
      label: "Pad",
      title: "Crop padding (output px)",
      ops,
      beforeEdit: ctx.beforeEdit,
      releaseFocus: ctx.releaseFocus,
      read: () => ops.options(id).cropPadding,
      bounds: () => ({ min: 0, max: Number.MAX_SAFE_INTEGER }),
      write: (value) => ops.setOptions(id, { cropPadding: Number(value) })
    });
    this.borderSize = outputField({
      label: "W",
      title: `Border width per side (output px, 1..${MAX_BORDER_SIZE})`,
      ops,
      beforeEdit: ctx.beforeEdit,
      releaseFocus: ctx.releaseFocus,
      read: () => ops.options(id).borderSize,
      bounds: () => ({ min: 1, max: MAX_BORDER_SIZE }),
      write: (value) => ops.setOptions(id, { borderSize: Number(value) })
    });
    this.borderMaskBox.type = "checkbox";
    this.borderMaskBox.addEventListener("change", () => {
      ctx.beforeEdit();
      ops.setOptions(id, { borderMask: this.borderMaskBox.checked });
    });
    this.borderMask.className = "cps-output-check";
    this.borderMask.title = "Border area white in the MASK (for outpainting)";
    const checkText = document.createElement("span");
    checkText.textContent = "Mask border";
    this.borderMask.append(this.borderMaskBox, checkText);
    const label = document.createElement("span");
    label.className = "cps-output-label";
    label.textContent = "Modify";
    this.element.append(
      label,
      this.mode,
      this.padding.element,
      this.borderSize.element,
      this.swatch,
      this.borderMask
    );
    this.refresh();
  }
  id;
  ctx;
  element = document.createElement("div");
  mode = document.createElement("select");
  swatch = document.createElement("button");
  padding;
  borderSize;
  borderMask = document.createElement("label");
  borderMaskBox = document.createElement("input");
  /** Show the current options (fields being edited keep their text). */
  refresh() {
    const options = this.ctx.editor.regionOps.options(this.id);
    this.mode.value = options.applyMask;
    const border = options.applyMask === "border";
    this.swatch.hidden = options.applyMask !== "fill" && !border;
    this.swatch.style.backgroundColor = border ? options.borderColor : options.fillColor;
    this.swatch.title = border ? "Border colour (output only)" : "Fill colour (output only)";
    this.swatch.setAttribute("aria-label", this.swatch.title);
    this.padding.element.hidden = options.applyMask !== "crop";
    this.padding.refresh();
    this.borderSize.element.hidden = !border;
    this.borderSize.refresh();
    this.borderMask.hidden = !border;
    this.borderMaskBox.checked = options.borderMask;
  }
  /** Close the picker / revert open sessions. */
  dispose() {
    this.ctx.popovers.closeAnchoredIn(this.element);
    this.padding.dispose();
    this.borderSize.dispose();
  }
  /** Fill / border colour picker: one session = one undo step; Esc reverts. */
  pickColor() {
    const { popovers, editor } = this.ctx;
    const ops = editor.regionOps;
    this.ctx.beforeEdit();
    popovers.close();
    const border = ops.options(this.id).applyMask === "border";
    if (!ops.begin()) return;
    const options = ops.options(this.id);
    openColorPicker(popovers, this.swatch, {
      initial: border ? options.borderColor : options.fillColor,
      title: border ? "Border colour" : "Fill colour",
      onInput: (hex) => {
        if (!ops.active) return;
        ops.setOptions(this.id, border ? { borderColor: hex } : { fillColor: hex });
      },
      onClose: (cancelled) => {
        if (cancelled) ops.cancel();
        else ops.commit();
      }
    });
  }
}
const RECT_FIELDS = [
  ["x", "X", "Left edge (image px)"],
  ["y", "Y", "Top edge (image px)"],
  ["width", "W", "Width (image px)"],
  ["height", "H", "Height (image px)"]
];
function cardElement(ctx, id) {
  const element = document.createElement("section");
  element.className = "cps-output-card";
  element.addEventListener("pointerdown", (event) => {
    if (isControl(event.target)) return;
    ctx.editor.regionOps.select(id);
  });
  element.addEventListener("focusin", () => ctx.editor.regionOps.select(id));
  return element;
}
function iconButton(className, icon, onClick) {
  const button2 = document.createElement("button");
  button2.type = "button";
  button2.className = `cps-icon-button cps-layer-button ${className}`;
  setIcon(button2, icon, 14);
  button2.addEventListener("click", (event) => {
    event.stopPropagation();
    event.preventDefault();
    onClick();
  });
  return button2;
}
class RegionCard {
  /**
   * @param id - Region id.
   * @param ctx - Card services.
   */
  constructor(id, ctx) {
    this.id = id;
    this.ctx = ctx;
    const ops = ctx.editor.regionOps;
    this.element = cardElement(ctx, id);
    const header = document.createElement("div");
    header.className = "cps-output-header";
    this.eye = iconButton("cps-layer-eye", "eye", () => {
      ctx.beforeEdit();
      ops.setVisible(id, !(this.region()?.visible ?? true));
    });
    this.title.className = "cps-layer-name cps-output-title";
    this.title.addEventListener("dblclick", (event) => {
      event.stopPropagation();
      this.startRename();
    });
    const remove = iconButton("cps-output-delete", "trash", () => {
      ctx.beforeEdit();
      ops.remove(id);
    });
    remove.title = "Delete region (empties the slot)";
    remove.setAttribute("aria-label", remove.title);
    header.append(this.eye, this.title, remove);
    const geometry = document.createElement("div");
    geometry.className = "cps-output-geometry";
    for (const [key, label, title] of RECT_FIELDS) {
      const field = this.rectField(key, label, title);
      this.fields.push(field);
      geometry.append(field.element);
    }
    this.options = new OutputOptionsRow(id, ctx);
    this.element.append(header, geometry, this.options.element);
    this.refresh();
  }
  id;
  ctx;
  element;
  eye;
  title = document.createElement("span");
  fields = [];
  options;
  renaming = false;
  eyeIcon = "";
  /** Show the region's current state. */
  refresh() {
    const region = this.region();
    if (!region) return;
    const selected = this.ctx.editor.regionOps.selectedId === this.id;
    this.element.classList.toggle("cps-selected", selected);
    this.element.classList.toggle("cps-hidden-layer", !region.visible);
    if (!this.renaming) this.title.textContent = regionSlotLabel(region);
    this.title.title = `${regionSlotLabel(region)} -- output pair ${region.slot} (double-click to rename)`;
    const icon = region.visible ? "eye" : "eyeOff";
    if (icon !== this.eyeIcon) setIcon(this.eye, icon, 14);
    this.eyeIcon = icon;
    this.eye.classList.toggle("cps-off", !region.visible);
    this.eye.title = region.visible ? "Hide outline (output unaffected)" : "Show outline";
    this.eye.setAttribute("aria-label", this.eye.title);
    this.eye.setAttribute("aria-pressed", String(region.visible));
    for (const field of this.fields) field.refresh();
    this.options.refresh();
  }
  /** Revert open sessions and remove the element. */
  dispose() {
    for (const field of this.fields) field.dispose();
    this.options.dispose();
    this.element.remove();
  }
  // ── Internals ───────────────────────────────────────────────────────────
  region() {
    return this.ctx.editor.doc.regions.find((region) => region.id === this.id);
  }
  /** Inline rename of just the name, pre-filled with the effective name. */
  startRename() {
    const region = this.region();
    if (this.renaming || !region) return;
    this.renaming = true;
    startInlineRename(this.title, regionName(region), (value) => {
      this.renaming = false;
      if (value !== null) {
        this.ctx.beforeEdit();
        this.ctx.editor.regionOps.rename(this.id, value);
      }
      this.refresh();
      this.ctx.releaseFocus();
    });
  }
  /** One X / Y / W / H field, clamped to the paint area. */
  rectField(key, label, title) {
    const { editor } = this.ctx;
    const ops = editor.regionOps;
    const bounds = () => {
      const rect = ops.imageRect(this.id);
      return rect ? regionFieldBounds(rect, key, editor.imageSize) : { min: 0, max: 0 };
    };
    return outputField({
      label,
      title,
      ops,
      beforeEdit: this.ctx.beforeEdit,
      releaseFocus: this.ctx.releaseFocus,
      read: () => ops.imageRect(this.id)?.[key] ?? 0,
      bounds,
      write: (value) => {
        const rect = ops.imageRect(this.id);
        if (!rect) return;
        const { min, max } = bounds();
        ops.setRect(this.id, { ...rect, [key]: clampNumber(Math.round(Number(value)), min, max) });
      }
    });
  }
}
class MainCard {
  /**
   * @param ctx - Card services.
   */
  constructor(ctx) {
    this.ctx = ctx;
    this.element = cardElement(ctx, null);
    this.element.classList.add("cps-output-main");
    const header = document.createElement("div");
    header.className = "cps-output-header";
    const title = document.createElement("span");
    title.className = "cps-layer-name cps-output-title";
    title.textContent = "Main";
    this.size.className = "cps-output-size";
    this.size.title = "Output size (current image px)";
    header.append(title, this.size);
    this.options = new OutputOptionsRow(null, ctx);
    this.element.append(header, this.options.element);
    this.refresh();
  }
  ctx;
  element;
  size = document.createElement("span");
  options;
  /** Show selection, size and options. */
  refresh() {
    const { editor } = this.ctx;
    this.element.classList.toggle("cps-selected", editor.regionOps.selectedId === null);
    this.size.textContent = `${editor.imageSize.width} x ${editor.imageSize.height}`;
    this.options.refresh();
  }
  /** Revert open sessions and remove the element. */
  dispose() {
    this.options.dispose();
    this.element.remove();
  }
}
class OutputsPanel {
  /**
   * @param ctx - Host services.
   */
  constructor(ctx) {
    this.ctx = ctx;
    this.element.className = "cps-outputs";
    this.list.className = "cps-outputs-list";
    const hint = document.createElement("div");
    hint.className = "cps-outputs-hint";
    hint.textContent = "Drag on the image to add a region; Shift-drag starts a new one inside another.";
    for (let slot = 1; slot <= MAX_REGIONS; slot++) this.slots.push(this.slotView(slot));
    this.list.append(...this.slots.map((view) => view.element));
    this.element.append(this.list, hint);
  }
  ctx;
  element = document.createElement("div");
  list = document.createElement("div");
  slots = [];
  main = null;
  editor = null;
  unbind = [];
  /**
   * Bind to an editor (or none).
   * @param editor - Session editor, or null on detach.
   */
  setEditor(editor) {
    for (const off of this.unbind) off();
    this.unbind = [];
    this.main?.dispose();
    this.main = null;
    for (const view of this.slots) this.setCard(view, null);
    this.editor = editor;
    if (!editor) return;
    const ctx = { ...this.ctx, editor };
    this.main = new MainCard(ctx);
    this.list.prepend(this.main.element);
    this.unbind.push(editor.events.on("outputs", () => this.sync()));
    this.sync();
  }
  /** Unbind and remove. */
  dispose() {
    this.setEditor(null);
    this.element.remove();
  }
  // ── Internals ───────────────────────────────────────────────────────────
  /** Bring every card up to date; a slot's card is replaced only when its region changes. */
  sync() {
    const editor = this.editor;
    if (!editor) return;
    this.main?.refresh();
    for (const view of this.slots) {
      const region = editor.regionOps.inSlot(view.slot);
      if (!region) {
        this.setCard(view, null);
        continue;
      }
      if (view.card?.id !== region.id) this.setCard(view, new RegionCard(region.id, { ...this.ctx, editor }));
      view.card?.refresh();
    }
  }
  /** Swap a slot between its empty row and a card. */
  setCard(view, card) {
    if (view.card === card) return;
    view.card?.dispose();
    view.card = card;
    view.empty.hidden = card !== null;
    if (card) view.element.append(card.element);
  }
  /** Wrapper + `+ Region N` row of one slot. */
  slotView(slot) {
    const element = document.createElement("div");
    element.className = "cps-output-slot";
    const empty2 = document.createElement("button");
    empty2.type = "button";
    empty2.className = "cps-output-empty";
    empty2.title = `Add a centred region in slot ${slot}`;
    const icon = document.createElement("span");
    setIcon(icon, "plus", 12);
    const text = document.createElement("span");
    text.textContent = defaultRegionName(slot);
    empty2.append(icon, text);
    empty2.addEventListener("click", () => {
      this.ctx.beforeEdit();
      this.editor?.regionOps.addDefault(slot);
    });
    element.append(empty2);
    return { slot, element, empty: empty2, card: null };
  }
}
const toldDocs = /* @__PURE__ */ new Set();
const FIT_LABEL = "The image's shape doesn't fit the drawing — parts can't be painted.";
const CONFIRM_TEXT = "Resample all layers to the current image resolution? This clears the undo history.";
const CROP_TEXT = "\n\nSome paint far outside the image exceeds the 16384 px paint-area limit and will be cropped.";
function formatRatio(ratio) {
  return `${(Math.floor(ratio * 10) / 10).toFixed(1)}x`;
}
class ResolutionNotice {
  /**
   * @param setWarning - Turns the Move drawing icon red / back.
   * @param beforeMatch - Cancel drags / pending tool interactions first.
   */
  constructor(setWarning, beforeMatch) {
    this.setWarning = setWarning;
    this.beforeMatch = beforeMatch;
    this.element = document.createElement("div");
    this.element.className = "cps-resolution-notice";
    this.element.hidden = true;
    this.label = document.createElement("span");
    this.label.className = "cps-resolution-label";
    this.button = document.createElement("button");
    this.button.type = "button";
    this.button.className = "cps-toggle cps-resolution-match";
    this.button.textContent = "Match image resolution";
    this.button.title = "Resample all layers to the current image resolution (clears undo history)";
    this.button.addEventListener("click", () => this.confirmMatch());
    this.element.append(this.label, this.button);
  }
  setWarning;
  beforeMatch;
  /** Root element (goes into the bar's trailing area). */
  element;
  label;
  button;
  editor = null;
  /** Last shown label (`""` = hidden); skips DOM writes on unchanged syncs. */
  shown = null;
  /**
   * Bind to an editor (or none) and sync.
   * @param editor - Editor shown by the host.
   */
  setEditor(editor) {
    this.editor = editor;
    this.shown = null;
    this.sync();
  }
  /** Re-evaluate the mismatch (after frame, placement or image-size changes). */
  sync() {
    const editor = this.editor;
    const notice = editor && !editor.loading ? editor.resolution.notice() : null;
    const ratio = notice ? formatRatio(notice.info.ratio) : "";
    const text = !notice ? "" : notice.kind === "resolution" ? `Drawing grid ${notice.info.gridPx} px — image ${notice.info.imagePx} px (${ratio})` : FIT_LABEL;
    if (text === this.shown) return;
    this.shown = text;
    const show = notice !== null;
    this.element.hidden = !show;
    this.setWarning(show);
    this.label.textContent = text;
    if (!notice || !editor) return;
    const told = `${notice.kind}:${editor.doc.docId}`;
    if (toldDocs.has(told)) return;
    toldDocs.add(told);
    if (notice.kind === "resolution") {
      notify("warn", `The image is ${ratio} the drawing's resolution — use Match image resolution for full detail.`, {
        key: `resolution-mismatch:${editor.doc.docId}`
      });
    } else {
      notify("warn", `${FIT_LABEL} Use Match image resolution to fix it.`, { key: `resolution-fit:${editor.doc.docId}` });
    }
  }
  /** Button: confirm, then resample. */
  confirmMatch() {
    const editor = this.editor;
    if (!editor || editor.loading || !editor.resolution.notice()) return;
    const text = CONFIRM_TEXT + (editor.resolution.wouldCrop() ? CROP_TEXT : "");
    if (!window.confirm(text)) return;
    this.beforeMatch();
    editor.matchImageResolution();
    this.sync();
  }
}
const REGION_TOOL_ID = "region";
const CLICK_SLOP_PX$3 = 3;
const HANDLE_HIT_PX = 6;
const FULL_NOTE = "All 6 region slots are used. Delete a region to draw another.";
function grabAt(editor, p) {
  const ops = editor.regionOps;
  const regions = editor.doc.regions.filter((region) => region.visible);
  const selected = regions.find((region) => region.id === ops.selectedId);
  if (selected) {
    const tolerance = HANDLE_HIT_PX / editor.view.screenScale;
    const handle = hitRegionHandle(selected.rect, p, tolerance);
    if (handle) return { mode: "resize", id: selected.id, rect: { ...selected.rect }, handle };
    if (insideRegion(selected.rect, p)) return { mode: "move", id: selected.id, rect: { ...selected.rect }, handle: null };
  }
  const top = [...regions].reverse().find((region) => insideRegion(region.rect, p));
  return top ? { mode: "move", id: top.id, rect: { ...top.rect }, handle: null } : null;
}
function createRegionTool() {
  let drag = null;
  const update = (editor, sample) => {
    if (!drag) return;
    const ops = editor.regionOps;
    const p = docToImage(editor.frameMap, sample);
    const delta = { x: p.x - drag.start.x, y: p.y - drag.start.y };
    if (!drag.moved) {
      if (Math.hypot(delta.x, delta.y) * editor.view.screenScale < CLICK_SLOP_PX$3) return;
      drag.moved = true;
      if (drag.mode === "draw" && !ops.canAdd()) {
        editor.events.emit("note", FULL_NOTE);
        return;
      }
      if (!ops.begin()) {
        drag = null;
        return;
      }
    }
    if (drag.mode !== "draw" && drag.id && drag.rect) {
      ops.setRect(drag.id, dragRegionRect(drag.rect, delta, editor.imageSize, drag.handle));
      return;
    }
    if (!ops.active) return;
    const rect = drawRegionRect(drag.start, p, editor.imageSize);
    if (drag.id) ops.setRect(drag.id, rect);
    else drag.id = ops.add(rect);
  };
  return {
    id: REGION_TOOL_ID,
    label: "Regions",
    shortcut: "",
    icon: "region",
    options: null,
    rail: false,
    ctrlMove: false,
    cursor: () => ({ kind: "icon", icon: "crosshair" }),
    onPointerDown(editor, samples) {
      const sample = samples[0];
      if (!sample) return;
      const start = docToImage(editor.frameMap, sample);
      const grab = sample.shiftKey ? null : grabAt(editor, start);
      if (grab?.id) editor.regionOps.select(grab.id);
      drag = { start, moved: false, ...grab ?? { mode: "draw", id: null, rect: null, handle: null } };
    },
    onPointerMove(editor, samples) {
      const sample = samples.at(-1);
      if (sample) update(editor, sample);
    },
    onPointerUp(editor, sample) {
      if (!drag) return;
      update(editor, sample);
      const { moved, mode } = drag;
      drag = null;
      if (moved) editor.regionOps.commit();
      else if (mode === "draw") editor.regionOps.select(null);
    },
    onCancel(editor) {
      if (drag) editor.regionOps.cancel();
      drag = null;
    },
    pending: () => drag !== null
  };
}
const LAYERS_TAB = "layers";
const OUTPUTS_TAB = "outputs";
function tabForTool(toolId) {
  return toolId === REGION_TOOL_ID ? OUTPUTS_TAB : LAYERS_TAB;
}
function toolForTab(tab, activeId, lastRailId) {
  if (tab === OUTPUTS_TAB) return activeId === REGION_TOOL_ID ? null : REGION_TOOL_ID;
  return activeId === REGION_TOOL_ID ? lastRailId : null;
}
class HostSync {
  /**
   * @param getSession - Returns the currently active session (or null).
   * @param onOptionsChanged - Called after the user edits a tool option.
   * @param onCancelDrag - Called before mode switches that need a clean state.
   * @param releaseFocus - Hand keyboard focus back after a panel text field blurs.
   * @param shell - Editor shell (regions + popover host).
   * @param clipboard - Copy / cut / paste commands (rail buttons).
   */
  constructor(getSession, onOptionsChanged, onCancelDrag, releaseFocus, shell, clipboard) {
    this.getSession = getSession;
    this.onOptionsChanged = onOptionsChanged;
    this.onCancelDrag = onCancelDrag;
    this.shell = shell;
    this.rail = new ToolRail(
      shell.rail.tools,
      {
        selectTool: (id) => {
          this.onCancelDrag();
          this.getSession()?.tools.setActive(id);
        },
        toggleQuickMask: () => {
          this.onCancelDrag();
          this.getSession()?.editor.togglePaintTarget();
        },
        undo: () => this.getSession()?.editor.undo(),
        redo: () => this.getSession()?.editor.redo(),
        // `view.fit()` emits `render` itself (engine/view.ts `onChange`).
        fit: () => this.getSession()?.editor.view.fit(),
        clear: () => this.confirmClear(),
        fullscreen: () => this.shell.events.emit("fullscreen", void 0),
        copy: () => (this.onCancelDrag(), clipboard.copy(false)),
        cut: () => (this.onCancelDrag(), clipboard.cut()),
        paste: (request) => (this.onCancelDrag(), void clipboard.pasteFromButton(request))
      },
      shell.popoverHost
    );
    this.swatches = new SwatchWidget({
      pick: (slot, anchor) => {
        const colors = this.getSession()?.editor.colors;
        if (colors)
          this.shell.requestColorPick(slot, anchor, colors[slot], (hex) => colors.set(slot, hex));
      },
      swap: () => this.getSession()?.editor.colors.swap(),
      reset: () => this.getSession()?.editor.colors.reset()
    });
    shell.rail.swatchSlot.appendChild(this.swatches.element);
    this.optionsBar = new OptionsBar(shell.bar, shell.popoverHost, () => this.onOptionsChanged());
    this.selectionActions = new SelectionActions();
    shell.bar.leading.append(this.selectionActions.element);
    this.layers = new LayersPanel({
      sidePanel: shell.sidePanel,
      popovers: shell.popoverHost,
      pickColor: (anchor, options) => openColorPicker(shell.popoverHost, anchor, options),
      beforeEdit: () => this.onCancelDrag(),
      releaseFocus,
      toggleMoveDrawing: () => this.toggleMoveDrawing()
    });
    this.outputs = new OutputsPanel({
      popovers: shell.popoverHost,
      beforeEdit: () => this.onCancelDrag(),
      releaseFocus
    });
    this.resolution = new ResolutionNotice((on) => this.layers.setMoveDrawingWarning(on), () => this.onCancelDrag());
    shell.bar.trailing.prepend(this.resolution.element);
    shell.sidePanel.setTabs([
      { id: LAYERS_TAB, label: "Layers", panel: this.layers.element },
      { id: OUTPUTS_TAB, label: "Outputs", panel: this.outputs.element }
    ]);
    shell.sidePanel.events.on("tab", (tab) => this.tabChanged(tab));
    shell.events.on("outputs", () => this.toggleOutputs());
  }
  getSession;
  onOptionsChanged;
  onCancelDrag;
  shell;
  /** Left tool rail (tool buttons, Quick Mask, Undo/Redo, …). */
  rail;
  /** FG/BG colour swatches. */
  swatches;
  /** Top options bar (bound to the active tool). */
  optionsBar;
  /** "To mask / Invert" actions shown while a selection exists. */
  selectionActions;
  /** Layers panel (owned here; side panel content set by EditorHost). */
  layers;
  /** Output metadata panel, bound alongside Layers. */
  outputs;
  /** Drawing-resolution mismatch notice + Match image resolution (options bar). */
  resolution;
  /**
   * Last active rail tool per registry (restored when "Move drawing" is
   * toggled off). Keyed by registry so a host showing another session (tab
   * switch, hand-off, fork) never restores a stale id; the toggle's
   * highlight itself is always derived from `tools.active` ({@link syncMoveMode}).
   */
  lastRailTool = /* @__PURE__ */ new WeakMap();
  // ── Sync called by EditorHost ─────────────────────────────────────────────
  /**
   * Bind the layers panel and selection actions to a new editor (or null).
   * Called by `EditorHost.setSession`.
   * @param editor - The incoming session's editor, or `null`.
   */
  bindEditor(editor) {
    this.layers.setEditor(editor);
    this.outputs.setEditor(editor);
    this.selectionActions.setEditor(editor);
    this.resolution.setEditor(editor);
  }
  /** Sync rail, options bar and cursor when the active tool changes. */
  syncTools() {
    const session = this.getSession();
    if (!session) return;
    const active = session.tools.active;
    if (active.rail !== false) this.lastRailTool.set(session.tools, active.id);
    const regionMode = active.id === REGION_TOOL_ID;
    this.shell.sidePanel.showTab(tabForTool(active.id));
    this.shell.outputsButton.classList.toggle("cps-active", regionMode);
    this.shell.outputsButton.setAttribute("aria-pressed", String(regionMode));
    this.rail.setTools(session.tools.railTools(), session.tools.active.id, session.tools.groups);
    this.optionsBar.bind(session.tools.barOptions());
    this.syncMoveMode();
  }
  /**
   * Re-bind the options bar (Free Transform session start / end, selection
   * appearing for the selection tools' Transform buttons); a refresh when
   * the options object is unchanged (live transform fields).
   */
  syncOptions() {
    const tools = this.getSession()?.tools;
    if (tools) this.optionsBar.bind(tools.barOptions());
  }
  /**
   * Toggle "Move drawing" mode from the registry's state (single source of
   * truth): if the Move tool is active, return to the last rail tool (brush
   * as fallback), else activate Move. Any drag or pending interaction (open
   * text edit, polygonal lasso) is committed/cancelled first so it cannot
   * swallow the switch. Always re-syncs the chrome, even if nothing changed.
   */
  toggleMoveDrawing() {
    const session = this.getSession();
    if (!session) return;
    const { tools } = session;
    this.onCancelDrag();
    if (tools.active.id === "move") {
      const lastId = this.lastRailTool.get(tools);
      const prev = (lastId !== void 0 ? tools.get(lastId) : void 0) ?? tools.railTools()[0];
      if (prev) tools.setActive(prev.id);
    } else {
      tools.setActive("move");
    }
    this.syncTools();
  }
  /**
   * Outputs button / `O`: open the side panel on the Outputs tab (region
   * mode); when region mode is already showing, go back to Layers.
   */
  toggleOutputs() {
    const session = this.getSession();
    if (!session) return;
    const panel = this.shell.sidePanel;
    this.onCancelDrag();
    if (session.tools.active.id === REGION_TOOL_ID && !panel.collapsed) {
      panel.showTab(LAYERS_TAB);
      return;
    }
    panel.setCollapsed(false);
    panel.showTab(OUTPUTS_TAB);
    session.tools.setActive(REGION_TOOL_ID);
  }
  /** Sync the Quick Mask rail button + badge + root class. */
  syncMask() {
    const editor = this.getSession()?.editor;
    if (!editor) return;
    const mask = editor.maskLayer;
    const color = mask ? maskDisplayColor(mask) : readFirstMaskStyle().color;
    const targeting = editor.paintTarget === "mask";
    this.rail.setQuickMask(targeting, color);
    this.shell.root.classList.toggle("cps-quickmask", targeting);
    this.optionsBar.setMask({ targeting, color });
  }
  /** Sync undo/redo button enable state. */
  syncHistory() {
    const editor = this.getSession()?.editor;
    this.rail.setHistory(editor?.canUndo ?? false, editor?.canRedo ?? false);
  }
  /**
   * Notify the options bar and the tool's own options listener that an
   * option changed (e.g. via shortcut).
   */
  optionsChanged() {
    this.optionsBar.refresh();
    this.getSession()?.tools.notifyOptions();
  }
  /** Dispose components that need it. */
  dispose() {
    this.rail.dispose();
    this.layers.dispose();
    this.outputs.dispose();
  }
  // ── Private helpers ───────────────────────────────────────────────────────
  /** The visible side-panel tab changed: enter or leave region mode. */
  tabChanged(tab) {
    const tools = this.getSession()?.tools;
    if (!tools) return;
    const fallback = this.lastRailTool.get(tools) ?? tools.railTools()[0]?.id ?? "";
    const next = toolForTab(tab, tools.active.id, fallback);
    if (next === null) return;
    this.onCancelDrag();
    tools.setActive(next);
  }
  /** Sync the "Move drawing" button on the layers panel. */
  syncMoveMode() {
    const active = this.getSession()?.tools.active;
    this.layers.setMoveDrawing(active?.id === "move");
  }
  /** Clear button: confirm, then one undoable Clear. */
  confirmClear() {
    const editor = this.getSession()?.editor;
    if (!editor || editor.loading) return;
    if (!window.confirm("Clear all paint, regions and output options? This can be undone.")) return;
    this.onCancelDrag();
    editor.clear();
  }
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
const MODIFIER_KEYS$1 = /* @__PURE__ */ new Set(["control", "shift", "alt", "altgraph", "meta", "os"]);
function fullscreenKeyPolicy(event) {
  const key = event.key.toLowerCase();
  if (MODIFIER_KEYS$1.has(key)) return "pass";
  if (/^f([1-9]|1[0-9]|2[0-4])$/.test(key)) return "pass";
  const mod = event.ctrlKey || event.metaKey;
  if (event.altKey && !mod && (key === "arrowleft" || key === "arrowright")) return "pass";
  if (mod && !event.altKey) {
    if (key === "v") return "pass";
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
  ctrlDown = false;
  listening = false;
  onKeyDown = (event) => {
    if (event.key === "Alt") {
      event.preventDefault();
      this.setAlt(true);
    } else if (event.key === " " || event.code === "Space") {
      if (!this.handlers.isTextTarget?.(event.target)) this.setSpace(true);
    }
    this.setShift(event.shiftKey);
    this.setCtrl(event.ctrlKey || event.metaKey);
  };
  onKeyUp = (event) => {
    if (event.key === "Alt") this.setAlt(false);
    else if (event.key === " " || event.code === "Space") this.setSpace(false);
    this.setShift(event.shiftKey);
    this.setCtrl(event.ctrlKey || event.metaKey);
  };
  onBlur = () => {
    this.setSpace(false);
    this.setAlt(false);
    this.setShift(false);
    this.setCtrl(false);
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
    this.setCtrl(false);
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
  setCtrl(down) {
    if (this.ctrlDown === down) return;
    this.ctrlDown = down;
    this.handlers.onCtrlChange?.(down);
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
      onShiftChange: (down) => handlers.onShiftChange?.(down),
      onCtrlChange: (down) => handlers.onCtrlChange?.(down),
      isTextTarget: (target) => this.isForeignTextTarget(target)
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
  tabs = [];
  currentTab = "";
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
  /** Id of the visible tab ("" before {@link SidePanel.setTabs}). */
  get activeTab() {
    return this.currentTab;
  }
  // ── Tabs ────────────────────────────────────────────────────────────────
  /**
   * Install named tab panels (mounted once; hidden rather than recreated).
   * The first tab is shown.
   * @param panels - Tabs in order.
   */
  setTabs(panels) {
    const bar = document.createElement("div");
    bar.className = "cps-side-tabs";
    bar.setAttribute("role", "tablist");
    this.tabs = panels.map(({ id, label, panel }) => {
      const button2 = document.createElement("button");
      button2.type = "button";
      button2.textContent = label;
      button2.setAttribute("role", "tab");
      button2.addEventListener("click", () => this.showTab(id));
      panel.setAttribute("role", "tabpanel");
      bar.append(button2);
      return { id, button: button2, panel };
    });
    this.content.replaceChildren(bar, ...panels.map((p) => p.panel));
    this.currentTab = "";
    this.showTab(panels[0]?.id ?? "");
  }
  /**
   * Reveal a tab (the choice survives collapse and fullscreen). Emits `tab`
   * when the visible tab changes.
   * @param id - Tab id.
   */
  showTab(id) {
    for (const tab of this.tabs) {
      const active = tab.id === id;
      tab.panel.hidden = !active;
      tab.button.classList.toggle("cps-active", active);
      tab.button.setAttribute("aria-selected", String(active));
    }
    if (id === this.currentTab) return;
    this.currentTab = id;
    this.events.emit("tab", id);
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
  /** Opens the side panel on the Outputs tab (region mode); next to the panel toggle. */
  outputsButton;
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
    this.outputsButton = document.createElement("button");
    this.outputsButton.type = "button";
    this.outputsButton.className = "cps-icon-button cps-outputs-button";
    this.outputsButton.title = "Output regions (O)";
    this.outputsButton.setAttribute("aria-label", this.outputsButton.title);
    this.outputsButton.setAttribute("aria-pressed", "false");
    setIcon(this.outputsButton, "region", 18);
    this.outputsButton.addEventListener("click", () => this.events.emit("outputs", void 0));
    this.bar.trailing.append(this.outputsButton, this.panelButton);
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
  requestColorPick(slot, anchor, current, apply2) {
    const request = { slot, anchor, handled: false };
    this.events.emit("pick-color", request);
    if (!request.handled) this.nativeColorPick(current, apply2);
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
    this.panelButton.title = open ? "Hide side panel" : "Show side panel";
  }
  /** Fallback picker until M3.2: a hidden native `<input type=color>`. */
  nativeColorPick(current, apply2) {
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
    this.nativeApply = apply2;
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
function handleClipboardShortcut(event, actions, cancelDrag) {
  const ctrl = event.ctrlKey || event.metaKey;
  if (!ctrl || event.altKey) return false;
  const key = event.key.toLowerCase();
  if (key === "v") {
    if (event.shiftKey && actions.hasInternal) {
      if (!event.repeat) {
        cancelDrag();
        actions.pasteInPlace();
      }
      return true;
    }
    event.stopPropagation();
    if (!event.repeat) {
      cancelDrag();
      actions.armPaste(event.shiftKey);
    }
    return false;
  }
  if (key === "c" || key === "x" && !event.shiftKey) {
    if (!event.repeat) {
      cancelDrag();
      if (key === "x") actions.cut();
      else actions.copy(event.shiftKey);
    }
    return true;
  }
  return false;
}
function handleFloatShortcut(event, editor, effects) {
  const ctrl = event.ctrlKey || event.metaKey;
  const key = event.key.toLowerCase();
  if (ctrl && !event.altKey && !event.shiftKey && key === "e") {
    if (!event.repeat) {
      effects.cancelDrag();
      editor.mergeDown();
    }
    return true;
  }
  if (isTransformChord(event)) {
    if (!event.repeat) {
      effects.cancelDrag();
      editor.float.transform.enter();
    }
    return true;
  }
  if (!(editor.float.active || editor.float.transform.active) || ctrl || event.altKey) return false;
  if (key === "escape") {
    effects.cancelDrag();
    editor.float.cancel();
    return true;
  }
  if (key === "enter" && !event.shiftKey) {
    effects.cancelDrag();
    if (editor.float.transform.active) editor.float.transform.commit();
    else editor.float.commit();
    return true;
  }
  return false;
}
function isTransformChord(event) {
  const ctrl = event.ctrlKey || event.metaKey;
  return ctrl && event.altKey && !event.shiftKey && (event.key === "t" || event.key === "T");
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
  if (handleFloatShortcut(event, editor, { cancelDrag: () => effects.cancelDrag() })) return true;
  if (key === "escape" && !ctrl && !event.altKey) {
    return (effects.cancelToolDrag?.() ?? false) || effects.closePopover() || effects.exitFullscreen();
  }
  if (effects.clipboard && handleClipboardShortcut(event, effects.clipboard, () => effects.cancelDrag())) return true;
  if (ctrl && !event.altKey && key === "v") return false;
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
  if (tools.resolve(false).onKey?.(editor, event)) return true;
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
    case "o":
      if (!effects.toggleOutputs) return false;
      effects.toggleOutputs();
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
function dabAlpha(dyn) {
  return Math.min(1, Math.max(0, dyn.flow));
}
function dabCap(pressure, dyn) {
  return dyn.pressureOpacity ? curvePressure(pressure, dyn.gamma) : 1;
}
function createSpacer(from = null, residual = 0) {
  return { last: from, residual: from ? Math.max(0, residual) : 0 };
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
  return { x, y, size: dabSize(pressure, dyn), alpha: dabAlpha(dyn), cap: dabCap(pressure, dyn) };
}
function dabBounds(dab, reach = 1) {
  const r = dab.size / 2 * reach + 2;
  return { x: dab.x - r, y: dab.y - r, width: r * 2, height: r * 2 };
}
const FADE_CUTOFF = 1.5;
function stampProfile(hardness, radius) {
  const h = Math.min(1, Math.max(0, Number.isFinite(hardness) ? hardness : 0));
  const fade = Math.max(1 - h, 1 / Math.max(1, radius));
  const core = Math.min(h, 1 - fade / 2);
  return { core, fade, reach: core + fade * FADE_CUTOFF };
}
const RING_FADE_POSITION = 0.77;
function ringDiameter(size, hardness) {
  const p = stampProfile(hardness, size / 2);
  return size * Math.min(1, p.core + p.fade * RING_FADE_POSITION);
}
function stampAlpha(u, profile) {
  if (u <= profile.core) return 1;
  const t = (u - profile.core) / profile.fade;
  return t >= FADE_CUTOFF ? 0 : Math.pow(10, -t * t);
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
    this.abortDrag();
    this.endToolDrag();
    const session = this.host.session();
    if (session) {
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
    const stale = this.drag;
    if (stale && (stale.pointerId === event.pointerId && event.pointerType === "mouse" || stale.pointerId !== event.pointerId && event.isPrimary)) {
      this.abortDrag();
    }
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
    const ctrl = event.ctrlKey || event.metaKey;
    this.host.setCtrl?.(ctrl);
    const samples = this.samples(event, session);
    const at = samples[0];
    const inSelection = at ? session.editor.selectionMove.hit(at.x, at.y) : false;
    const tool = session.tools.resolve(event.altKey, ctrl, { shift: event.shiftKey, inSelection });
    this.drag = { kind: "tool", pointerId: event.pointerId, tool };
    this.lastToolEvent = event;
    this.modifierWatch.start();
    tool.onPointerDown(session.editor, samples);
    const deferred = tool.takeDeferred?.() ?? null;
    if (deferred) this.abortDrag();
    deferred?.();
    this.setHover(this.toStage(event));
  }
  move(event) {
    const point = this.toStage(event);
    this.host.setShift?.(event.shiftKey);
    this.host.setAlt?.(event.altKey);
    this.host.setCtrl?.(event.ctrlKey || event.metaKey);
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
    if ((event.pointerType === "mouse" || event.pointerType === "pen") && event.buttons === 0) {
      this.up(event, true);
      return;
    }
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
  /**
   * End the drag in progress as a cancel (tool `onCancel`, pan class and
   * pointer capture cleared). No-op without a drag.
   */
  abortDrag() {
    const drag = this.drag;
    if (!drag) return;
    this.drag = null;
    this.stage.classList.remove("cps-panning");
    this.release(drag.pointerId);
    this.endToolDrag();
    this.host.setDragging(false);
    const session = this.host.session();
    if (drag.kind === "tool" && session) drag.tool.onCancel(session.editor);
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
const DEFAULT_GROWTH = { chunk: 256, marginFactor: 1, maxSide: 16384 };
function boundsCap(frame, limits = DEFAULT_GROWTH) {
  const margin = Math.round(Math.min(frame.width, frame.height) * limits.marginFactor);
  const width = Math.max(frame.width, Math.min(frame.width + 2 * margin, limits.maxSide));
  const height = Math.max(frame.height, Math.min(frame.height + 2 * margin, limits.maxSide));
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
const STEP = 1.7;
const COBWEB_DEFAULTS = {
  color: [88, 80, 112],
  drapeColor: [120, 110, 156],
  genSize: 600,
  margin: 700,
  seedSpacing: 7,
  step: STEP,
  join: 5.5,
  branch: 0.052,
  maxNodes: 7e4,
  maxTips: 1400,
  lineWidth: [1.3, 0.5],
  drape: { maxAngle: 160, length: Math.round(80 / STEP), start: 0.03, ramp: 0.12 },
  seed: 1,
  budgetMs: 6,
  stepsPerFrame: 2,
  rasterDelayMs: 120,
  maxBitmapPixels: 16e6,
  panPad: 0.5
};
function mergeCobwebOptions(base, o = {}) {
  return { ...base, ...o, drape: { ...base.drape, ...o.drape ?? {} } };
}
function genExtent(genSize, aspect) {
  const gw = aspect >= 1 ? genSize : genSize * aspect;
  return { gw, gh: gw / aspect };
}
const COBWEB_BUCKETS = 24;
const CELL = 8;
const KEY_OFFSET = 1 << 14;
const KEY_STRIDE = 1 << 15;
function mulberry32(seed) {
  let a = seed | 0;
  return () => {
    a = a + 1831565813 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function wrapAngle(a) {
  return Math.atan2(Math.sin(a), Math.cos(a));
}
const now = () => typeof performance !== "undefined" ? performance.now() : Date.now();
class CobwebCore {
  /**
   * @param o - Options.
   * @param aspect - Rect width / height.
   */
  constructor(o, aspect) {
    this.o = o;
    this.rand = mulberry32(o.seed);
    const { gw, gh } = genExtent(o.genSize, aspect);
    this.gw = gw;
    this.gh = gh;
    this.segs = Array.from({ length: COBWEB_BUCKETS }, () => []);
    this.seedEdges();
  }
  o;
  /** Rect width / height in gen units. */
  gw;
  gh;
  /** Per brightness bucket: flat `x1, y1, x2, y2` runs. */
  segs;
  drapes = [];
  /** Growth finished. */
  done = false;
  rand;
  nodes = 0;
  grid = /* @__PURE__ */ new Map();
  tips = [];
  tipId = 0;
  /**
   * Grow for up to `ms` milliseconds (`Infinity` = to completion).
   * @param ms - Time budget.
   * @returns Whether growth has finished.
   */
  grow(ms) {
    const t0 = now();
    while (this.tips.length && this.nodes < this.o.maxNodes) {
      this.step();
      if (now() - t0 >= ms) break;
    }
    this.done = !(this.tips.length && this.nodes < this.o.maxNodes);
    return this.done;
  }
  /**
   * Grow a fixed number of steps (rate-limited animated growth).
   * @param n - Steps to run.
   * @returns Whether growth has finished.
   */
  growSteps(n) {
    for (let i = 0; i < n && this.tips.length && this.nodes < this.o.maxNodes; i++) {
      this.step();
    }
    this.done = !(this.tips.length && this.nodes < this.o.maxNodes);
    return this.done;
  }
  /**
   * Distance from the rect (0 on or inside it).
   * @param x - Gen x.
   * @param y - Gen y.
   * @returns Distance in gen units.
   */
  dist(x, y) {
    const dx = Math.max(-x, 0, x - this.gw);
    const dy = Math.max(-y, 0, y - this.gh);
    return Math.hypot(dx, dy);
  }
  // ── Setup ─────────────────────────────────────────────────────────────────
  seedEdges() {
    const R = this.rand;
    const W2 = this.gw;
    const H = this.gh;
    const per = 2 * (W2 + H);
    const count = Math.round(per / this.o.seedSpacing);
    for (let i = 0; i < count; i++) {
      let t = (i + R() * 0.8) / count * per;
      let x;
      let y;
      let a;
      if (t < W2) {
        x = t;
        y = 0;
        a = -Math.PI / 2;
      } else if ((t -= W2) < H) {
        x = W2;
        y = t;
        a = 0;
      } else if ((t -= H) < W2) {
        x = W2 - t;
        y = H;
        a = Math.PI / 2;
      } else {
        t -= W2;
        x = 0;
        y = H - t;
        a = Math.PI;
      }
      const n = this.addNode(x, y, 0);
      const angle = a + (R() - 0.5) * 1.2;
      this.tips.push({ id: ++this.tipId, parent: -1, x, y, a: angle, drift: (R() - 0.5) * 0.04, last: n, age: 0, feeds: [] });
    }
  }
  // ── Mesh ──────────────────────────────────────────────────────────────────
  key(gx, gy) {
    return (gx + KEY_OFFSET) * KEY_STRIDE + (gy + KEY_OFFSET);
  }
  addNode(x, y, owner) {
    const n = { x, y, owner };
    this.nodes++;
    const k = this.key(Math.trunc(x / CELL), Math.trunc(y / CELL));
    let cell = this.grid.get(k);
    if (!cell) {
      cell = [];
      this.grid.set(k, cell);
    }
    cell.push(n);
    return n;
  }
  /** Nearest foreign node within `join` (not the tip's own or its parent's). */
  near(x, y, tip) {
    const gx = Math.trunc(x / CELL);
    const gy = Math.trunc(y / CELL);
    let best = null;
    let bd = this.o.join * this.o.join;
    for (let i = -1; i <= 1; i++) {
      for (let j = -1; j <= 1; j++) {
        const cell = this.grid.get(this.key(gx + i, gy + j));
        if (!cell) continue;
        for (const n of cell) {
          if (n.owner <= 0 || n.owner === tip.id || n.owner === tip.parent) continue;
          const d = (n.x - x) ** 2 + (n.y - y) ** 2;
          if (d < bd) {
            bd = d;
            best = n;
          }
        }
      }
    }
    return best;
  }
  seg(a, b, d) {
    const i = Math.min(COBWEB_BUCKETS - 1, Math.trunc(d / this.o.margin * COBWEB_BUCKETS));
    this.segs[i].push(a.x, a.y, b.x, b.y);
  }
  // ── Drapes ────────────────────────────────────────────────────────────────
  drapeWeight(d) {
    const { start, ramp } = this.o.drape;
    const M = this.o.margin;
    return Math.max(0, Math.min(1, (d - M * start) / (M * ramp)));
  }
  /** One arm of a fork ended; when both have, maybe drape it. */
  endSide(f) {
    if (++f.ends < 2) return;
    const n = Math.min(f.a.length, f.b.length);
    if (n < 4) return;
    const o = f.o;
    const A = f.a[n - 1];
    const B = f.b[n - 1];
    const ang = Math.abs(wrapAngle(Math.atan2(A.y - o.y, A.x - o.x) - Math.atan2(B.y - o.y, B.x - o.x)));
    if (ang > this.o.drape.maxAngle * Math.PI / 180) return;
    const w = this.drapeWeight(this.dist(o.x, o.y));
    const R = this.rand;
    if (w <= 0 || R() > w) return;
    const diag = [];
    for (let i = 0; i < n; i++) diag.push(R() < 0.5);
    this.drapes.push({ o, a: f.a.slice(0, n), b: f.b.slice(0, n), alpha: 0.35 + 0.65 * w, sag: 0.18 + R() * 0.22, diag });
  }
  kill(t) {
    for (const f of t.feeds) this.endSide(f.fork);
    t.feeds = [];
  }
  // ── Step ──────────────────────────────────────────────────────────────────
  step() {
    const o = this.o;
    const R = this.rand;
    const M = o.margin;
    const cx = this.gw / 2;
    const cy = this.gh / 2;
    const next = [];
    for (const t of this.tips) {
      const out = Math.atan2(t.y - cy, t.x - cx);
      t.a += (R() - 0.5) * 0.45 + t.drift + wrapAngle(out - t.a) * 0.015;
      const x = t.x + Math.cos(t.a) * o.step;
      const y = t.y + Math.sin(t.a) * o.step;
      const inside2 = x > 0 && x < this.gw && y > 0 && y < this.gh;
      if (inside2 || x < -M || y < -M || x > this.gw + M || y > this.gh + M) {
        this.kill(t);
        continue;
      }
      const d = this.dist(x, y);
      t.age++;
      const hit = t.age > 14 ? this.near(x, y, t) : null;
      if (hit) {
        this.seg(t.last, hit, d);
        if (R() < 0.45) {
          this.kill(t);
          continue;
        }
      }
      const n = this.addNode(x, y, t.id);
      this.seg(t.last, n, d);
      t.x = x;
      t.y = y;
      t.last = n;
      t.feeds = t.feeds.filter((feed) => {
        const arm = feed.fork[feed.side];
        arm.push(n);
        if (arm.length < feed.fork.L) return true;
        this.endSide(feed.fork);
        return false;
      });
      if (R() < 15e-4 + d / M * 0.012) {
        this.kill(t);
        continue;
      }
      next.push(t);
      if (R() < o.branch) this.fork(t, n, d, next);
    }
    if (next.length > o.maxTips) {
      for (let i = next.length - 1; i > 0; i--) {
        const j = Math.trunc(R() * (i + 1));
        const tmp = next[i];
        next[i] = next[j];
        next[j] = tmp;
      }
      for (const t of next.slice(o.maxTips)) this.kill(t);
      next.length = o.maxTips;
    }
    this.tips = next;
  }
  fork(t, n, d, next) {
    const R = this.rand;
    const s = R() < 0.5 ? -1 : 1;
    const L = Math.max(4, Math.round(this.o.drape.length * (0.5 + R()) * (1 + 0.8 * this.drapeWeight(d))));
    const f = { o: n, a: [], b: [], ends: 0, L };
    t.feeds.push({ fork: f, side: "a" });
    const a = t.a + s * (0.35 + R() * 0.7);
    next.push({ id: ++this.tipId, parent: t.id, x: n.x, y: n.y, a, drift: (R() - 0.5) * 0.04, last: n, age: 0, feeds: [{ fork: f, side: "b" }] });
  }
}
function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== "undefined") {
    const canvas2 = new OffscreenCanvas(w, h);
    const ctx2 = canvas2.getContext("2d");
    return ctx2 ? { canvas: canvas2, ctx: ctx2 } : null;
  }
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  return ctx ? { canvas, ctx } : null;
}
class CobwebRaster {
  /**
   * @param core - Growth state.
   * @param pair - Target canvas (sized by {@link CobwebRaster.create}).
   * @param scale - Device px per gen unit.
   * @param k - Screen units per gen unit.
   * @param reg - Covered gen region.
   */
  constructor(core, pair, scale, k, reg) {
    this.core = core;
    this.reg = reg;
    this.canvas = pair.canvas;
    this.ctx = pair.ctx;
    this.px = 1 / k;
    this.ctx.setTransform(scale, 0, 0, scale, -reg.x0 * scale, -reg.y0 * scale);
    this.ctx.lineCap = "round";
  }
  core;
  reg;
  canvas;
  ctx;
  /** One screen px in gen units. */
  px;
  drawnSegs = new Array(COBWEB_BUCKETS).fill(0);
  drawnDrapes = 0;
  /**
   * New bitmap at zoom `k` and pixel ratio `pr` covering `reg`, with
   * everything grown so far drawn.
   * @param core - Growth state.
   * @param k - Screen units per gen unit.
   * @param pr - Device px per screen unit.
   * @param reg - Gen region.
   * @returns The raster, or `null` without canvas support.
   */
  static create(core, k, pr, reg) {
    let W2 = (reg.x1 - reg.x0) * k * pr;
    let H = (reg.y1 - reg.y0) * k * pr;
    const es = Math.min(1, Math.sqrt(core.o.maxBitmapPixels / Math.max(1, W2 * H)));
    W2 = Math.max(1, Math.ceil(W2 * es));
    H = Math.max(1, Math.ceil(H * es));
    const pair = makeCanvas(W2, H);
    if (!pair) return null;
    const raster = new CobwebRaster(core, pair, k * pr * es, k, reg);
    raster.drawNew();
    return raster;
  }
  /** Draw whatever has grown since the last pass. */
  drawNew() {
    const core = this.core;
    const ctx = this.ctx;
    if (this.drawnDrapes < core.drapes.length) {
      ctx.save();
      ctx.globalCompositeOperation = "destination-over";
      for (let i = this.drawnDrapes; i < core.drapes.length; i++) this.drawDrape(core.drapes[i]);
      ctx.restore();
      this.drawnDrapes = core.drapes.length;
    }
    const [c0, c1, c2] = core.o.color;
    const [lw0, lw1] = core.o.lineWidth;
    for (let b = 0; b < COBWEB_BUCKETS; b++) {
      const arr = core.segs[b];
      const from = this.drawnSegs[b];
      if (from >= arr.length) continue;
      const p = new Path2D();
      for (let i = from; i < arr.length; i += 4) {
        p.moveTo(arr[i], arr[i + 1]);
        p.lineTo(arr[i + 2], arr[i + 3]);
      }
      const t = (b + 0.5) / COBWEB_BUCKETS;
      ctx.strokeStyle = `rgba(${c0},${c1},${c2},${0.85 * (1 - t) ** 1.4 + 0.06})`;
      ctx.lineWidth = (lw0 + (lw1 - lw0) * t) * this.px;
      ctx.stroke(p);
      this.drawnSegs[b] = arr.length;
    }
  }
  // ── Drapes ────────────────────────────────────────────────────────────────
  drawDrape(d) {
    const ctx = this.ctx;
    const { o, a, b, alpha, sag, diag } = d;
    const n = a.length;
    const [r, g, bl] = this.core.o.drapeColor;
    const col = (x) => `rgba(${r},${g},${bl},${x})`;
    const A = a[n - 1];
    const B = b[n - 1];
    const across = (p, q, k) => {
      const mx = (p.x + q.x) / 2;
      const my = (p.y + q.y) / 2;
      return [mx + (o.x - mx) * k, my + (o.y - my) * k];
    };
    const grad = ctx.createRadialGradient(o.x, o.y, 0, o.x, o.y, Math.hypot(A.x - o.x, A.y - o.y) + 1);
    grad.addColorStop(0, col(0.42 * alpha));
    grad.addColorStop(1, col(0.08 * alpha));
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(o.x, o.y);
    for (let i = 0; i < n; i++) ctx.lineTo(a[i].x, a[i].y);
    const [qx, qy] = across(A, B, sag);
    ctx.quadraticCurveTo(qx, qy, B.x, B.y);
    for (let i = n - 1; i >= 0; i--) ctx.lineTo(b[i].x, b[i].y);
    ctx.closePath();
    ctx.fill();
    ctx.lineWidth = 0.55 * this.px;
    for (let i = 1; i < n; i += 1 + Math.trunc(i / 6)) {
      const p = a[i];
      const q = b[i];
      const k = sag * (i / n);
      const [cx, cy] = across(p, q, k);
      ctx.strokeStyle = col(alpha * (0.95 - 0.45 * i / n));
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.quadraticCurveTo(cx, cy, q.x, q.y);
      ctx.stroke();
      if (i + 3 < n && diag[i]) {
        const q2 = b[i + 3];
        const [dx, dy] = across(p, q2, k);
        ctx.strokeStyle = col(alpha * 0.5);
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.quadraticCurveTo(dx, dy, q2.x, q2.y);
        ctx.stroke();
      }
    }
  }
}
const jsContent = '(function() {\n  "use strict";\n  function genExtent(genSize, aspect) {\n    const gw = aspect >= 1 ? genSize : genSize * aspect;\n    return { gw, gh: gw / aspect };\n  }\n  const COBWEB_BUCKETS = 24;\n  const CELL = 8;\n  const KEY_OFFSET = 1 << 14;\n  const KEY_STRIDE = 1 << 15;\n  function mulberry32(seed) {\n    let a = seed | 0;\n    return () => {\n      a = a + 1831565813 | 0;\n      let t = Math.imul(a ^ a >>> 15, 1 | a);\n      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;\n      return ((t ^ t >>> 14) >>> 0) / 4294967296;\n    };\n  }\n  function wrapAngle(a) {\n    return Math.atan2(Math.sin(a), Math.cos(a));\n  }\n  const now = () => typeof performance !== "undefined" ? performance.now() : Date.now();\n  class CobwebCore {\n    /**\n     * @param o - Options.\n     * @param aspect - Rect width / height.\n     */\n    constructor(o, aspect) {\n      this.o = o;\n      this.rand = mulberry32(o.seed);\n      const { gw, gh } = genExtent(o.genSize, aspect);\n      this.gw = gw;\n      this.gh = gh;\n      this.segs = Array.from({ length: COBWEB_BUCKETS }, () => []);\n      this.seedEdges();\n    }\n    o;\n    /** Rect width / height in gen units. */\n    gw;\n    gh;\n    /** Per brightness bucket: flat `x1, y1, x2, y2` runs. */\n    segs;\n    drapes = [];\n    /** Growth finished. */\n    done = false;\n    rand;\n    nodes = 0;\n    grid = /* @__PURE__ */ new Map();\n    tips = [];\n    tipId = 0;\n    /**\n     * Grow for up to `ms` milliseconds (`Infinity` = to completion).\n     * @param ms - Time budget.\n     * @returns Whether growth has finished.\n     */\n    grow(ms) {\n      const t0 = now();\n      while (this.tips.length && this.nodes < this.o.maxNodes) {\n        this.step();\n        if (now() - t0 >= ms) break;\n      }\n      this.done = !(this.tips.length && this.nodes < this.o.maxNodes);\n      return this.done;\n    }\n    /**\n     * Grow a fixed number of steps (rate-limited animated growth).\n     * @param n - Steps to run.\n     * @returns Whether growth has finished.\n     */\n    growSteps(n) {\n      for (let i = 0; i < n && this.tips.length && this.nodes < this.o.maxNodes; i++) {\n        this.step();\n      }\n      this.done = !(this.tips.length && this.nodes < this.o.maxNodes);\n      return this.done;\n    }\n    /**\n     * Distance from the rect (0 on or inside it).\n     * @param x - Gen x.\n     * @param y - Gen y.\n     * @returns Distance in gen units.\n     */\n    dist(x, y) {\n      const dx = Math.max(-x, 0, x - this.gw);\n      const dy = Math.max(-y, 0, y - this.gh);\n      return Math.hypot(dx, dy);\n    }\n    // ── Setup ─────────────────────────────────────────────────────────────────\n    seedEdges() {\n      const R = this.rand;\n      const W = this.gw;\n      const H = this.gh;\n      const per = 2 * (W + H);\n      const count = Math.round(per / this.o.seedSpacing);\n      for (let i = 0; i < count; i++) {\n        let t = (i + R() * 0.8) / count * per;\n        let x;\n        let y;\n        let a;\n        if (t < W) {\n          x = t;\n          y = 0;\n          a = -Math.PI / 2;\n        } else if ((t -= W) < H) {\n          x = W;\n          y = t;\n          a = 0;\n        } else if ((t -= H) < W) {\n          x = W - t;\n          y = H;\n          a = Math.PI / 2;\n        } else {\n          t -= W;\n          x = 0;\n          y = H - t;\n          a = Math.PI;\n        }\n        const n = this.addNode(x, y, 0);\n        const angle = a + (R() - 0.5) * 1.2;\n        this.tips.push({ id: ++this.tipId, parent: -1, x, y, a: angle, drift: (R() - 0.5) * 0.04, last: n, age: 0, feeds: [] });\n      }\n    }\n    // ── Mesh ──────────────────────────────────────────────────────────────────\n    key(gx, gy) {\n      return (gx + KEY_OFFSET) * KEY_STRIDE + (gy + KEY_OFFSET);\n    }\n    addNode(x, y, owner) {\n      const n = { x, y, owner };\n      this.nodes++;\n      const k = this.key(Math.trunc(x / CELL), Math.trunc(y / CELL));\n      let cell = this.grid.get(k);\n      if (!cell) {\n        cell = [];\n        this.grid.set(k, cell);\n      }\n      cell.push(n);\n      return n;\n    }\n    /** Nearest foreign node within `join` (not the tip\'s own or its parent\'s). */\n    near(x, y, tip) {\n      const gx = Math.trunc(x / CELL);\n      const gy = Math.trunc(y / CELL);\n      let best = null;\n      let bd = this.o.join * this.o.join;\n      for (let i = -1; i <= 1; i++) {\n        for (let j = -1; j <= 1; j++) {\n          const cell = this.grid.get(this.key(gx + i, gy + j));\n          if (!cell) continue;\n          for (const n of cell) {\n            if (n.owner <= 0 || n.owner === tip.id || n.owner === tip.parent) continue;\n            const d = (n.x - x) ** 2 + (n.y - y) ** 2;\n            if (d < bd) {\n              bd = d;\n              best = n;\n            }\n          }\n        }\n      }\n      return best;\n    }\n    seg(a, b, d) {\n      const i = Math.min(COBWEB_BUCKETS - 1, Math.trunc(d / this.o.margin * COBWEB_BUCKETS));\n      this.segs[i].push(a.x, a.y, b.x, b.y);\n    }\n    // ── Drapes ────────────────────────────────────────────────────────────────\n    drapeWeight(d) {\n      const { start, ramp } = this.o.drape;\n      const M = this.o.margin;\n      return Math.max(0, Math.min(1, (d - M * start) / (M * ramp)));\n    }\n    /** One arm of a fork ended; when both have, maybe drape it. */\n    endSide(f) {\n      if (++f.ends < 2) return;\n      const n = Math.min(f.a.length, f.b.length);\n      if (n < 4) return;\n      const o = f.o;\n      const A = f.a[n - 1];\n      const B = f.b[n - 1];\n      const ang = Math.abs(wrapAngle(Math.atan2(A.y - o.y, A.x - o.x) - Math.atan2(B.y - o.y, B.x - o.x)));\n      if (ang > this.o.drape.maxAngle * Math.PI / 180) return;\n      const w = this.drapeWeight(this.dist(o.x, o.y));\n      const R = this.rand;\n      if (w <= 0 || R() > w) return;\n      const diag = [];\n      for (let i = 0; i < n; i++) diag.push(R() < 0.5);\n      this.drapes.push({ o, a: f.a.slice(0, n), b: f.b.slice(0, n), alpha: 0.35 + 0.65 * w, sag: 0.18 + R() * 0.22, diag });\n    }\n    kill(t) {\n      for (const f of t.feeds) this.endSide(f.fork);\n      t.feeds = [];\n    }\n    // ── Step ──────────────────────────────────────────────────────────────────\n    step() {\n      const o = this.o;\n      const R = this.rand;\n      const M = o.margin;\n      const cx = this.gw / 2;\n      const cy = this.gh / 2;\n      const next = [];\n      for (const t of this.tips) {\n        const out = Math.atan2(t.y - cy, t.x - cx);\n        t.a += (R() - 0.5) * 0.45 + t.drift + wrapAngle(out - t.a) * 0.015;\n        const x = t.x + Math.cos(t.a) * o.step;\n        const y = t.y + Math.sin(t.a) * o.step;\n        const inside = x > 0 && x < this.gw && y > 0 && y < this.gh;\n        if (inside || x < -M || y < -M || x > this.gw + M || y > this.gh + M) {\n          this.kill(t);\n          continue;\n        }\n        const d = this.dist(x, y);\n        t.age++;\n        const hit = t.age > 14 ? this.near(x, y, t) : null;\n        if (hit) {\n          this.seg(t.last, hit, d);\n          if (R() < 0.45) {\n            this.kill(t);\n            continue;\n          }\n        }\n        const n = this.addNode(x, y, t.id);\n        this.seg(t.last, n, d);\n        t.x = x;\n        t.y = y;\n        t.last = n;\n        t.feeds = t.feeds.filter((feed) => {\n          const arm = feed.fork[feed.side];\n          arm.push(n);\n          if (arm.length < feed.fork.L) return true;\n          this.endSide(feed.fork);\n          return false;\n        });\n        if (R() < 15e-4 + d / M * 0.012) {\n          this.kill(t);\n          continue;\n        }\n        next.push(t);\n        if (R() < o.branch) this.fork(t, n, d, next);\n      }\n      if (next.length > o.maxTips) {\n        for (let i = next.length - 1; i > 0; i--) {\n          const j = Math.trunc(R() * (i + 1));\n          const tmp = next[i];\n          next[i] = next[j];\n          next[j] = tmp;\n        }\n        for (const t of next.slice(o.maxTips)) this.kill(t);\n        next.length = o.maxTips;\n      }\n      this.tips = next;\n    }\n    fork(t, n, d, next) {\n      const R = this.rand;\n      const s = R() < 0.5 ? -1 : 1;\n      const L = Math.max(4, Math.round(this.o.drape.length * (0.5 + R()) * (1 + 0.8 * this.drapeWeight(d))));\n      const f = { o: n, a: [], b: [], ends: 0, L };\n      t.feeds.push({ fork: f, side: "a" });\n      const a = t.a + s * (0.35 + R() * 0.7);\n      next.push({ id: ++this.tipId, parent: t.id, x: n.x, y: n.y, a, drift: (R() - 0.5) * 0.04, last: n, age: 0, feeds: [{ fork: f, side: "b" }] });\n    }\n  }\n  function makeCanvas(w, h) {\n    if (typeof OffscreenCanvas !== "undefined") {\n      const canvas2 = new OffscreenCanvas(w, h);\n      const ctx2 = canvas2.getContext("2d");\n      return ctx2 ? { canvas: canvas2, ctx: ctx2 } : null;\n    }\n    if (typeof document === "undefined") return null;\n    const canvas = document.createElement("canvas");\n    canvas.width = w;\n    canvas.height = h;\n    const ctx = canvas.getContext("2d");\n    return ctx ? { canvas, ctx } : null;\n  }\n  class CobwebRaster {\n    /**\n     * @param core - Growth state.\n     * @param pair - Target canvas (sized by {@link CobwebRaster.create}).\n     * @param scale - Device px per gen unit.\n     * @param k - Screen units per gen unit.\n     * @param reg - Covered gen region.\n     */\n    constructor(core2, pair, scale, k, reg) {\n      this.core = core2;\n      this.reg = reg;\n      this.canvas = pair.canvas;\n      this.ctx = pair.ctx;\n      this.px = 1 / k;\n      this.ctx.setTransform(scale, 0, 0, scale, -reg.x0 * scale, -reg.y0 * scale);\n      this.ctx.lineCap = "round";\n    }\n    core;\n    reg;\n    canvas;\n    ctx;\n    /** One screen px in gen units. */\n    px;\n    drawnSegs = new Array(COBWEB_BUCKETS).fill(0);\n    drawnDrapes = 0;\n    /**\n     * New bitmap at zoom `k` and pixel ratio `pr` covering `reg`, with\n     * everything grown so far drawn.\n     * @param core - Growth state.\n     * @param k - Screen units per gen unit.\n     * @param pr - Device px per screen unit.\n     * @param reg - Gen region.\n     * @returns The raster, or `null` without canvas support.\n     */\n    static create(core2, k, pr, reg) {\n      let W = (reg.x1 - reg.x0) * k * pr;\n      let H = (reg.y1 - reg.y0) * k * pr;\n      const es = Math.min(1, Math.sqrt(core2.o.maxBitmapPixels / Math.max(1, W * H)));\n      W = Math.max(1, Math.ceil(W * es));\n      H = Math.max(1, Math.ceil(H * es));\n      const pair = makeCanvas(W, H);\n      if (!pair) return null;\n      const raster2 = new CobwebRaster(core2, pair, k * pr * es, k, reg);\n      raster2.drawNew();\n      return raster2;\n    }\n    /** Draw whatever has grown since the last pass. */\n    drawNew() {\n      const core2 = this.core;\n      const ctx = this.ctx;\n      if (this.drawnDrapes < core2.drapes.length) {\n        ctx.save();\n        ctx.globalCompositeOperation = "destination-over";\n        for (let i = this.drawnDrapes; i < core2.drapes.length; i++) this.drawDrape(core2.drapes[i]);\n        ctx.restore();\n        this.drawnDrapes = core2.drapes.length;\n      }\n      const [c0, c1, c2] = core2.o.color;\n      const [lw0, lw1] = core2.o.lineWidth;\n      for (let b = 0; b < COBWEB_BUCKETS; b++) {\n        const arr = core2.segs[b];\n        const from = this.drawnSegs[b];\n        if (from >= arr.length) continue;\n        const p = new Path2D();\n        for (let i = from; i < arr.length; i += 4) {\n          p.moveTo(arr[i], arr[i + 1]);\n          p.lineTo(arr[i + 2], arr[i + 3]);\n        }\n        const t = (b + 0.5) / COBWEB_BUCKETS;\n        ctx.strokeStyle = `rgba(${c0},${c1},${c2},${0.85 * (1 - t) ** 1.4 + 0.06})`;\n        ctx.lineWidth = (lw0 + (lw1 - lw0) * t) * this.px;\n        ctx.stroke(p);\n        this.drawnSegs[b] = arr.length;\n      }\n    }\n    // ── Drapes ────────────────────────────────────────────────────────────────\n    drawDrape(d) {\n      const ctx = this.ctx;\n      const { o, a, b, alpha, sag, diag } = d;\n      const n = a.length;\n      const [r, g, bl] = this.core.o.drapeColor;\n      const col = (x) => `rgba(${r},${g},${bl},${x})`;\n      const A = a[n - 1];\n      const B = b[n - 1];\n      const across = (p, q, k) => {\n        const mx = (p.x + q.x) / 2;\n        const my = (p.y + q.y) / 2;\n        return [mx + (o.x - mx) * k, my + (o.y - my) * k];\n      };\n      const grad = ctx.createRadialGradient(o.x, o.y, 0, o.x, o.y, Math.hypot(A.x - o.x, A.y - o.y) + 1);\n      grad.addColorStop(0, col(0.42 * alpha));\n      grad.addColorStop(1, col(0.08 * alpha));\n      ctx.fillStyle = grad;\n      ctx.beginPath();\n      ctx.moveTo(o.x, o.y);\n      for (let i = 0; i < n; i++) ctx.lineTo(a[i].x, a[i].y);\n      const [qx, qy] = across(A, B, sag);\n      ctx.quadraticCurveTo(qx, qy, B.x, B.y);\n      for (let i = n - 1; i >= 0; i--) ctx.lineTo(b[i].x, b[i].y);\n      ctx.closePath();\n      ctx.fill();\n      ctx.lineWidth = 0.55 * this.px;\n      for (let i = 1; i < n; i += 1 + Math.trunc(i / 6)) {\n        const p = a[i];\n        const q = b[i];\n        const k = sag * (i / n);\n        const [cx, cy] = across(p, q, k);\n        ctx.strokeStyle = col(alpha * (0.95 - 0.45 * i / n));\n        ctx.beginPath();\n        ctx.moveTo(p.x, p.y);\n        ctx.quadraticCurveTo(cx, cy, q.x, q.y);\n        ctx.stroke();\n        if (i + 3 < n && diag[i]) {\n          const q2 = b[i + 3];\n          const [dx, dy] = across(p, q2, k);\n          ctx.strokeStyle = col(alpha * 0.5);\n          ctx.beginPath();\n          ctx.moveTo(p.x, p.y);\n          ctx.quadraticCurveTo(dx, dy, q2.x, q2.y);\n          ctx.stroke();\n        }\n      }\n    }\n  }\n  const scope = self;\n  let core = null;\n  let raster = null;\n  let gen = 0;\n  let animate = false;\n  let timer;\n  function send() {\n    if (!core || !raster || !(raster.canvas instanceof OffscreenCanvas)) return;\n    const bitmap = raster.canvas.transferToImageBitmap();\n    const ctx = raster.ctx;\n    ctx.save();\n    ctx.setTransform(1, 0, 0, 1, 0, 0);\n    ctx.drawImage(bitmap, 0, 0);\n    ctx.restore();\n    scope.postMessage({ gen, reg: raster.reg, done: core.done, bitmap }, [bitmap]);\n  }\n  function loop() {\n    if (!core) return;\n    const done = animate ? core.growSteps(core.o.stepsPerFrame) : core.grow(Infinity);\n    if (animate || done) {\n      raster?.drawNew();\n      send();\n    }\n    if (!done) timer = setTimeout(loop, animate ? 16 : 0);\n  }\n  scope.onmessage = (event) => {\n    const m = event.data;\n    if (m.type === "start") {\n      clearTimeout(timer);\n      gen = m.gen;\n      animate = m.animate;\n      core = new CobwebCore(m.opts, m.aspect);\n      raster = CobwebRaster.create(core, m.k, m.pr, m.reg);\n      loop();\n    } else if (m.gen === gen && core) {\n      raster = CobwebRaster.create(core, m.k, m.pr, m.reg);\n      if (core.done || animate) send();\n    }\n  };\n})();\n';
const blob = typeof self !== "undefined" && self.Blob && new Blob(["(self.URL || self.webkitURL).revokeObjectURL(self.location.href);", jsContent], { type: "text/javascript;charset=utf-8" });
function WorkerWrapper(options) {
  let objURL;
  try {
    objURL = blob && (self.URL || self.webkitURL).createObjectURL(blob);
    if (!objURL) throw "";
    const worker = new Worker(objURL, {
      name: options?.name
    });
    worker.addEventListener("error", () => {
      (self.URL || self.webkitURL).revokeObjectURL(objURL);
    });
    return worker;
  } catch (e) {
    return new Worker(
      "data:text/javascript;charset=utf-8," + encodeURIComponent(jsContent),
      {
        name: options?.name
      }
    );
  }
}
function workerSupported() {
  return typeof Worker !== "undefined" && typeof OffscreenCanvas !== "undefined" && typeof URL !== "undefined" && typeof URL.createObjectURL === "function";
}
class CobwebBackdrop {
  /**
   * @param onUpdate - Called when the host should redraw.
   * @param options - Option overrides.
   * @param useWorker - `false` forces main-thread mode.
   */
  constructor(onUpdate, options = {}, useWorker = true) {
    this.onUpdate = onUpdate;
    this.o = mergeCobwebOptions(COBWEB_DEFAULTS, options);
    if (useWorker && workerSupported()) {
      try {
        const worker = new WorkerWrapper();
        worker.onmessage = (e) => this.receive(e.data);
        worker.onerror = () => this.dropWorker();
        this.worker = worker;
      } catch {
        this.worker = null;
      }
    }
  }
  onUpdate;
  o;
  aspect = null;
  /** Latest bitmap and the gen region it covers. */
  img = null;
  imgReg = null;
  gen = 0;
  /** View last asked for. */
  want = null;
  animate = false;
  timer;
  raf = 0;
  worker = null;
  core = null;
  raster = null;
  disposed = false;
  /**
   * Regrow with a new seed, animated (the web-area click).
   * @param seed - Seed (random if omitted).
   */
  regrow(seed = Math.trunc(Math.random() * 2 ** 31)) {
    this.o = mergeCobwebOptions(this.o, { seed });
    this.restart(true);
  }
  /** Stop timers, terminate the worker, drop bitmaps. Idempotent. */
  dispose() {
    this.disposed = true;
    this.gen++;
    clearTimeout(this.timer);
    if (this.raf) cancelAnimationFrame(this.raf);
    this.worker?.terminate();
    this.worker = null;
    this.closeImg();
    this.core = null;
    this.raster = null;
  }
  /**
   * Draw the web around `rect`.
   * @param ctx - Target context (any transform; units = "screen" units).
   * @param rect - The rect the web grows from, in ctx units.
   * @param pixelRatio - Device px per ctx unit.
   * @param vp - Visible area in ctx units.
   */
  draw(ctx, rect, pixelRatio, vp) {
    if (this.disposed || !(rect.w > 0 && rect.h > 0)) return;
    const aspect = rect.w / rect.h;
    const M = this.o.margin;
    const { gw, gh } = genExtent(this.o.genSize, aspect);
    const k = rect.w / gw;
    const vis = {
      x0: Math.max(-M, (vp.x - rect.x) / k),
      y0: Math.max(-M, (vp.y - rect.y) / k),
      x1: Math.min(gw + M, (vp.x + vp.w - rect.x) / k),
      y1: Math.min(gh + M, (vp.y + vp.h - rect.y) / k)
    };
    if (vis.x1 <= vis.x0 || vis.y1 <= vis.y0) return;
    this.track(aspect, k, pixelRatio, vis, gw, gh);
    const img = this.img;
    const r = this.imgReg;
    if (!img || !r) return;
    const dx = rect.x + r.x0 * k;
    const dy = rect.y + r.y0 * k;
    const dw = (r.x1 - r.x0) * k;
    const dh = (r.y1 - r.y0) * k;
    const x0 = Math.max(dx, vp.x);
    const y0 = Math.max(dy, vp.y);
    const x1 = Math.min(dx + dw, vp.x + vp.w);
    const y1 = Math.min(dy + dh, vp.y + vp.h);
    if (x1 <= x0 || y1 <= y0) return;
    const sx = img.width / dw;
    const sy = img.height / dh;
    ctx.drawImage(img, (x0 - dx) * sx, (y0 - dy) * sy, (x1 - x0) * sx, (y1 - y0) * sy, x0, y0, x1 - x0, y1 - y0);
  }
  // ── View tracking ─────────────────────────────────────────────────────────
  /** New aspect -> regrow (not animated); zoom / uncovered pan -> re-raster later. */
  track(aspect, k, pr, vis, gw, gh) {
    const padded = () => {
      const M = this.o.margin;
      const px = (vis.x1 - vis.x0) * this.o.panPad;
      const py = (vis.y1 - vis.y0) * this.o.panPad;
      return { x0: Math.max(-M, vis.x0 - px), y0: Math.max(-M, vis.y0 - py), x1: Math.min(gw + M, vis.x1 + px), y1: Math.min(gh + M, vis.y1 + py) };
    };
    const w = this.want;
    if (this.aspect === null || !w || Math.abs(aspect / this.aspect - 1) > 1e-3) {
      this.aspect = aspect;
      this.want = { k, pr, reg: padded() };
      this.restart(false);
      return;
    }
    const zoomed = Math.abs(k / w.k - 1) > 0.01 || pr !== w.pr;
    const covered = vis.x0 >= w.reg.x0 && vis.y0 >= w.reg.y0 && vis.x1 <= w.reg.x1 && vis.y1 <= w.reg.y1;
    if (!zoomed && covered) return;
    this.want = { k, pr, reg: padded() };
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.view(), zoomed ? this.o.rasterDelayMs : 16);
  }
  // ── Growth ────────────────────────────────────────────────────────────────
  restart(animate) {
    const want = this.want;
    if (this.disposed || this.aspect === null || !want) return;
    this.animate = animate;
    const gen = ++this.gen;
    clearTimeout(this.timer);
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    if (!animate) this.closeImg();
    if (this.worker) {
      this.post({ type: "start", gen, opts: this.o, aspect: this.aspect, animate, ...want });
      return;
    }
    const core = new CobwebCore(this.o, this.aspect);
    this.core = core;
    this.raster = CobwebRaster.create(core, want.k, want.pr, want.reg);
    const tick = () => {
      this.raf = 0;
      if (gen !== this.gen) return;
      const done = animate ? core.growSteps(this.o.stepsPerFrame) : core.grow(this.o.budgetMs * 2);
      if ((animate || done) && this.raster) {
        this.raster.drawNew();
        this.showMain();
      }
      if (!done) this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }
  view() {
    const want = this.want;
    if (!want || this.disposed) return;
    if (this.worker) {
      this.post({ type: "view", gen: this.gen, ...want });
      return;
    }
    if (!this.core) return;
    this.raster = CobwebRaster.create(this.core, want.k, want.pr, want.reg);
    if (this.core.done || this.animate) this.showMain();
  }
  /** Main-thread mode: show the live raster canvas. */
  showMain() {
    if (!this.raster) return;
    if (this.img !== this.raster.canvas) this.closeImg();
    this.img = this.raster.canvas;
    this.imgReg = this.raster.reg;
    this.onUpdate();
  }
  // ── Worker ────────────────────────────────────────────────────────────────
  post(message) {
    try {
      this.worker?.postMessage(message);
    } catch {
      this.dropWorker();
    }
  }
  receive(m) {
    if (this.disposed || m.gen !== this.gen) {
      m.bitmap.close();
      return;
    }
    this.closeImg();
    this.img = m.bitmap;
    this.imgReg = m.reg;
    this.onUpdate();
  }
  /** Worker failed (e.g. Blob workers blocked): continue on the main thread. */
  dropWorker() {
    this.worker?.terminate();
    this.worker = null;
    console.warn("[PainterSketch] cobweb worker unavailable; growing on the main thread");
    this.restart(this.animate);
  }
  closeImg() {
    const img = this.img;
    if (img && typeof ImageBitmap !== "undefined" && img instanceof ImageBitmap) img.close();
    this.img = null;
    this.imgReg = null;
  }
}
const STAGE_STYLE = {
  surround: "#1e1e1e",
  checkerLight: "#cfcfcf",
  checkerDark: "#a8a8a8",
  checkerCell: 8,
  offFrameVeil: "rgba(30, 30, 30, 0.55)",
  frameOutline: "rgba(255, 255, 255, 0.55)",
  frameShadow: "rgba(0, 0, 0, 0.6)",
  capLine: "#000000",
  capGlow: "rgba(255, 255, 255, 0.18)"
};
const checkerPatterns = /* @__PURE__ */ new WeakMap();
function composite(input) {
  const { ctx, pixelRatio: pr, view, imageSize: imageSize2, map, bounds } = input;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  ctx.fillStyle = STAGE_STYLE.surround;
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  const capScreen = input.paintArea ? capStageRect(input, input.paintArea) : null;
  if (capScreen && input.paintArea && input.cobweb) drawCobwebs(ctx, capScreen, capExact(input, input.paintArea), input.cobweb, pr);
  const imageRect = frameRect(imageSize2);
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
  if (input.backgroundHidden === true) ;
  else if (input.background.kind === "image") {
    ctx.drawImage(input.background.image, 0, 0, imageSize2.width, imageSize2.height);
  } else {
    ctx.fillStyle = input.background.color;
    ctx.fillRect(0, 0, imageSize2.width, imageSize2.height);
  }
  const placed = layerPlacement(map, bounds);
  const resampled = placed.width !== bounds.width || placed.height !== bounds.height;
  if (resampled) ctx.imageSmoothingEnabled = true;
  const at = (offset) => offset ? layerPlacement(map, { ...bounds, x: bounds.x + offset.x, y: bounds.y + offset.y }) : placed;
  for (const layer of input.layers) {
    if (layer.opacity <= 0) continue;
    ctx.globalAlpha = layer.opacity;
    const r = at(layer.offset);
    ctx.drawImage(layer.source, r.x, r.y, r.width, r.height);
  }
  for (const mask of input.masks) {
    if (mask.opacity <= 0) continue;
    ctx.globalAlpha = mask.opacity;
    const r = at(mask.offset);
    ctx.drawImage(mask.tint, r.x, r.y, r.width, r.height);
    if (mask.invert) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, imageSize2.width, imageSize2.height);
      ctx.clip();
      ctx.fillStyle = mask.color;
      ctx.beginPath();
      ctx.rect(0, 0, imageSize2.width, imageSize2.height);
      ctx.rect(r.x, r.y, r.width, r.height);
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
  if (capScreen) drawCapBorder(ctx, capScreen);
}
function capExact(input, cap) {
  return scaleRect(docRectToStage(input.view, layerPlacement(input.map, cap)), input.pixelRatio);
}
function capStageRect(input, cap) {
  const r = capExact(input, cap);
  const x0 = Math.round(r.x);
  const y0 = Math.round(r.y);
  return { x: x0, y: y0, width: Math.round(r.x + r.width) - x0, height: Math.round(r.y + r.height) - y0 };
}
function drawCobwebs(ctx, cap, exact, web, pr) {
  const { width, height } = ctx.canvas;
  if (cap.x <= 0 && cap.y <= 0 && cap.x + cap.width >= width && cap.y + cap.height >= height) return;
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, width, height);
  ctx.rect(cap.x, cap.y, cap.width, cap.height);
  ctx.clip("evenodd");
  ctx.setTransform(pr, 0, 0, pr, 0, 0);
  const rect = { x: exact.x / pr, y: exact.y / pr, w: exact.width / pr, h: exact.height / pr };
  web.draw(ctx, rect, pr, { x: 0, y: 0, w: width / pr, h: height / pr });
  ctx.restore();
}
function drawCapBorder(ctx, cap) {
  ctx.lineWidth = 1;
  ctx.strokeStyle = STAGE_STYLE.capLine;
  ctx.strokeRect(cap.x - 0.5, cap.y - 0.5, cap.width + 1, cap.height + 1);
  ctx.strokeStyle = STAGE_STYLE.capGlow;
  ctx.strokeRect(cap.x - 1.5, cap.y - 1.5, cap.width + 3, cap.height + 3);
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
  if (icon === "text") return "text";
  if (isTransformIcon(icon)) return icon === "rotate" ? rotateCursorCss() : `${icon.slice("resize-".length)}-resize`;
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
const TRANSFORM_ICONS = /* @__PURE__ */ new Set(["resize-ns", "resize-ew", "resize-nwse", "resize-nesw", "rotate"]);
function isTransformIcon(icon) {
  return TRANSFORM_ICONS.has(icon);
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
const SELECTED_COLOR = "#62d5ff";
const HANDLE_PX$1 = 6;
function regionOutlineStyle(regionMode, selected) {
  if (!regionMode) {
    return { lineWidth: 1, dash: [4, 4], alpha: 0.3, color: "#ffffff", halo: false, labelPx: 9, badge: false, handles: false };
  }
  return {
    lineWidth: selected ? 2 : 1,
    dash: [],
    alpha: 1,
    color: selected ? SELECTED_COLOR : "#ffffff",
    halo: true,
    labelPx: 12,
    badge: true,
    handles: selected
  };
}
function highlightMainBorder(regionMode, selectedId) {
  return regionMode && selectedId === null;
}
function drawRegionOverlay(ctx, editor, pixelRatio, regionMode) {
  const view = editor.view.current;
  const px = pixelRatio / editor.view.graphScale;
  const selectedId = editor.regionOps.selectedId;
  ctx.save();
  if (highlightMainBorder(regionMode, selectedId)) {
    strokeOutline(ctx, backingRect(view, frameRect(editor.imageSize), pixelRatio), regionOutlineStyle(true, true), px);
  }
  const regions = editor.doc.regions.filter((region) => region.visible);
  regions.sort((a, b) => Number(a.id === selectedId) - Number(b.id === selectedId));
  for (const region of regions) {
    const style = regionOutlineStyle(regionMode, region.id === selectedId);
    const box = backingRect(view, region.rect, pixelRatio);
    strokeOutline(ctx, box, style, px);
    drawLabel(ctx, box, String(region.slot), style, px);
    if (style.handles) drawHandles(ctx, view, region.rect, pixelRatio, px);
  }
  ctx.restore();
}
function backingRect(view, rect, pixelRatio) {
  const stage = docRectToStage(view, rect);
  return {
    x: stage.x * pixelRatio,
    y: stage.y * pixelRatio,
    width: stage.width * pixelRatio,
    height: stage.height * pixelRatio
  };
}
function strokeOutline(ctx, box, style, px) {
  ctx.globalAlpha = style.alpha;
  ctx.setLineDash(style.dash.map((d) => d * px));
  if (style.halo) {
    ctx.strokeStyle = "#111111";
    ctx.lineWidth = (style.lineWidth + 2) * px;
    ctx.strokeRect(box.x, box.y, box.width, box.height);
  }
  if (style.dash.length > 0) {
    const period = style.dash.reduce((sum, d) => sum + d, 0) * px;
    ctx.strokeStyle = "#000000";
    ctx.lineWidth = style.lineWidth * px;
    ctx.lineDashOffset = period / 2;
    ctx.strokeRect(box.x, box.y, box.width, box.height);
    ctx.lineDashOffset = 0;
  }
  ctx.strokeStyle = style.color;
  ctx.lineWidth = style.lineWidth * px;
  ctx.strokeRect(box.x, box.y, box.width, box.height);
  ctx.setLineDash([]);
}
function drawLabel(ctx, box, text, style, px) {
  ctx.globalAlpha = style.alpha;
  ctx.font = `bold ${style.labelPx * px}px sans-serif`;
  ctx.textBaseline = "top";
  const inset = 2 * px;
  if (style.badge) {
    const side = (style.labelPx + 5) * px;
    ctx.fillStyle = style.color;
    ctx.fillRect(box.x + inset, box.y + inset, side, side);
    ctx.fillStyle = "#111111";
    ctx.fillText(text, box.x + inset + 4 * px, box.y + inset + 2 * px);
    return;
  }
  const x = box.x + inset + px;
  const y = box.y + inset;
  ctx.lineJoin = "round";
  ctx.lineWidth = 3 * px;
  ctx.strokeStyle = "#000000";
  ctx.strokeText(text, x, y);
  ctx.fillStyle = style.color;
  ctx.fillText(text, x, y);
}
function drawHandles(ctx, view, rect, pixelRatio, px) {
  ctx.globalAlpha = 1;
  ctx.lineWidth = px;
  const half = HANDLE_PX$1 / 2 * px;
  for (const handle of REGION_HANDLES) {
    const p = regionHandlePoint(rect, handle);
    const at = backingRect(view, { x: p.x, y: p.y, width: 0, height: 0 }, pixelRatio);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(at.x - half, at.y - half, 2 * half, 2 * half);
    ctx.strokeStyle = "#111111";
    ctx.strokeRect(at.x - half, at.y - half, 2 * half, 2 * half);
  }
}
const FONT_PX = 10;
const GAP_PX = 4;
function drawResolutionLabel(ctx, editor, pixelRatio) {
  const { width, height } = editor.imageSize;
  if (width <= 0 || height <= 0) return;
  const px = pixelRatio / (editor.view.graphScale || 1);
  const area = docRectToStage(editor.view.current, frameRect(editor.imageSize));
  const text = `${width} x ${height}`;
  const x = (area.x + area.width / 2) * pixelRatio;
  const y = (area.y + area.height) * pixelRatio + GAP_PX * px;
  ctx.save();
  ctx.font = `${FONT_PX * px}px sans-serif`;
  const half = ctx.measureText(text).width / 2;
  const bottom = y + (FONT_PX + 2) * px;
  if (y < 0 || bottom > ctx.canvas.height || x - half < 0 || x + half > ctx.canvas.width) {
    ctx.restore();
    return;
  }
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.globalAlpha = 0.55;
  ctx.lineJoin = "round";
  ctx.lineWidth = 3 * px;
  ctx.strokeStyle = "#000000";
  ctx.strokeText(text, x, y);
  ctx.fillStyle = "#ffffff";
  ctx.fillText(text, x, y);
  ctx.restore();
}
const HANDLES = [
  { hx: -1, hy: -1 },
  { hx: 0, hy: -1 },
  { hx: 1, hy: -1 },
  { hx: 1, hy: 0 },
  { hx: 1, hy: 1 },
  { hx: 0, hy: 1 },
  { hx: -1, hy: 1 },
  { hx: -1, hy: 0 }
];
const ROTATE_SNAP = Math.PI / 12;
const MIN_SIDE = 1;
function translation(x, y) {
  return { a: 1, b: 0, c: 0, d: 1, e: x, f: y };
}
function multiply(m, n) {
  return {
    a: m.a * n.a + m.c * n.b,
    b: m.b * n.a + m.d * n.b,
    c: m.a * n.c + m.c * n.d,
    d: m.b * n.c + m.d * n.d,
    e: m.a * n.e + m.c * n.f + m.e,
    f: m.b * n.e + m.d * n.f + m.f
  };
}
function invert(m) {
  const det = m.a * m.d - m.b * m.c;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  return {
    a: m.d / det,
    b: -m.b / det,
    c: -m.c / det,
    d: m.a / det,
    e: (m.c * m.f - m.d * m.e) / det,
    f: (m.b * m.e - m.a * m.f) / det
  };
}
function apply(m, p) {
  return { x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f };
}
function affineEquals(m, n, eps = 1e-6) {
  return Math.abs(m.a - n.a) < eps && Math.abs(m.b - n.b) < eps && Math.abs(m.c - n.c) < eps && Math.abs(m.d - n.d) < eps && Math.abs(m.e - n.e) < eps && Math.abs(m.f - n.f) < eps;
}
function mirrorAbout(axis, centre) {
  return axis === "h" ? { a: -1, b: 0, c: 0, d: 1, e: 2 * centre.x, f: 0 } : { a: 1, b: 0, c: 0, d: -1, e: 0, f: 2 * centre.y };
}
function paramsMatrix(p, w, h) {
  const cos = Math.cos(p.angle);
  const sin = Math.sin(p.angle);
  const a = cos * p.sx;
  const b = sin * p.sx;
  const c = -sin * p.sy;
  const d = cos * p.sy;
  return { a, b, c, d, e: p.cx - (a * w + c * h) / 2, f: p.cy - (b * w + d * h) / 2 };
}
function decomposeAffine(m, w, h) {
  const sx = Math.hypot(m.a, m.b);
  const angle = sx > 0 ? Math.atan2(m.b, m.a) : 0;
  const sy = sx > 0 ? (m.a * m.d - m.b * m.c) / sx : Math.hypot(m.c, m.d);
  const centre = apply(m, { x: w / 2, y: h / 2 });
  return { cx: centre.x, cy: centre.y, sx, sy, angle };
}
function normalizeAngle(angle) {
  let a = angle % (2 * Math.PI);
  if (a <= -Math.PI) a += 2 * Math.PI;
  if (a > Math.PI) a -= 2 * Math.PI;
  return a;
}
function flipParams(p, axis) {
  return axis === "h" ? { ...p, sx: -p.sx, angle: normalizeAngle(-p.angle) } : { ...p, sy: -p.sy, angle: normalizeAngle(-p.angle) };
}
function transformedCorners(m, w, h) {
  return [apply(m, { x: 0, y: 0 }), apply(m, { x: w, y: 0 }), apply(m, { x: w, y: h }), apply(m, { x: 0, y: h })];
}
function transformedAabb(m, w, h) {
  const pts = transformedCorners(m, w, h);
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const x0 = Math.floor(Math.min(...xs) + 1e-6);
  const y0 = Math.floor(Math.min(...ys) + 1e-6);
  const x1 = Math.ceil(Math.max(...xs) - 1e-6);
  const y1 = Math.ceil(Math.max(...ys) - 1e-6);
  return { x: x0, y: y0, width: Math.max(0, x1 - x0), height: Math.max(0, y1 - y0) };
}
function scaleDrag(start, w, h, handle, at, opts) {
  const dir = HANDLES[handle];
  if (!dir) return start;
  const cos = Math.cos(start.angle);
  const sin = Math.sin(start.angle);
  const dx = at.x - start.cx;
  const dy = at.y - start.cy;
  const P = { x: cos * dx + sin * dy, y: -sin * dx + cos * dy };
  const H = { x: dir.hx * start.sx * w / 2, y: dir.hy * start.sy * h / 2 };
  const A = opts.fromCentre ? { x: 0, y: 0 } : { x: -H.x, y: -H.y };
  const D = { x: H.x - A.x, y: H.y - A.y };
  let kx = dir.hx !== 0 && D.x !== 0 ? (P.x - A.x) / D.x : 1;
  let ky = dir.hy !== 0 && D.y !== 0 ? (P.y - A.y) / D.y : 1;
  if (opts.proportional) {
    let k;
    if (dir.hx !== 0 && dir.hy !== 0) {
      const dd = D.x * D.x + D.y * D.y;
      k = dd > 0 ? ((P.x - A.x) * D.x + (P.y - A.y) * D.y) / dd : 1;
    } else {
      k = dir.hx !== 0 ? kx : ky;
    }
    kx = k;
    ky = k;
  }
  const sx = clampScale(start.sx * kx, w);
  const sy = clampScale(start.sy * ky, h);
  kx = start.sx !== 0 ? sx / start.sx : 1;
  ky = start.sy !== 0 ? sy / start.sy : 1;
  const C = opts.fromCentre ? { x: 0, y: 0 } : { x: A.x + D.x * kx / 2, y: A.y + D.y * ky / 2 };
  return { ...start, sx, sy, cx: start.cx + cos * C.x - sin * C.y, cy: start.cy + sin * C.x + cos * C.y };
}
function rotateDrag(start, from, at, snap) {
  const a0 = Math.atan2(from.y - start.cy, from.x - start.cx);
  const a1 = Math.atan2(at.y - start.cy, at.x - start.cx);
  let angle = start.angle + (a1 - a0);
  if (snap) angle = Math.round(angle / ROTATE_SNAP) * ROTATE_SNAP;
  return { ...start, angle: normalizeAngle(angle) };
}
function clampScale(s, side) {
  if (side <= 0 || !Number.isFinite(s)) return 1;
  const min = MIN_SIDE / side;
  if (Math.abs(s) >= min) return s;
  return s < 0 ? -min : min;
}
function handlePoint(m, w, h, dir) {
  return apply(m, { x: (dir.hx + 1) * w / 2, y: (dir.hy + 1) * h / 2 });
}
function hitTransform(m, w, h, at, handleTol, rotateTol) {
  let best = -1;
  let bestDist = handleTol;
  HANDLES.forEach((dir, i) => {
    const p = handlePoint(m, w, h, dir);
    const dist = Math.hypot(p.x - at.x, p.y - at.y);
    if (dist <= bestDist) {
      best = i;
      bestDist = dist;
    }
  });
  if (best >= 0) return { kind: "scale", handle: best };
  const inv = invert(m);
  if (!inv) return { kind: "outside" };
  const local = apply(inv, at);
  if (local.x >= 0 && local.y >= 0 && local.x <= w && local.y <= h) return { kind: "move" };
  for (const corner of transformedCorners(m, w, h)) {
    if (Math.hypot(corner.x - at.x, corner.y - at.y) <= handleTol + rotateTol) return { kind: "rotate" };
  }
  return { kind: "outside" };
}
function resizeAxis(m, w, h, handle) {
  const dir = HANDLES[handle] ?? { hx: 1, hy: 0 };
  const centre = handlePoint(m, w, h, { hx: 0, hy: 0 });
  const p = handlePoint(m, w, h, dir);
  let deg = Math.atan2(p.y - centre.y, p.x - centre.x) * 180 / Math.PI;
  deg = (deg % 180 + 180) % 180;
  if (deg < 22.5 || deg >= 157.5) return "ew";
  if (deg < 67.5) return "nwse";
  if (deg < 112.5) return "ns";
  return "nesw";
}
const HANDLE_PX = 7;
const CENTRE_PX = 3.5;
function drawTransformOverlay(ctx, editor, pixelRatio) {
  const box = editor.float.transform.box();
  if (!box) return;
  const view = editor.view.current;
  const map = editor.frameMap;
  const toBacking = (p) => {
    const img = docToImage(map, p);
    return { x: (img.x * view.scale + view.offsetX) * pixelRatio, y: (img.y * view.scale + view.offsetY) * pixelRatio };
  };
  const px = pixelRatio / editor.view.graphScale;
  const corners = transformedCorners(box.m, box.w, box.h).map(toBacking);
  ctx.save();
  ctx.globalAlpha = 1;
  ctx.setLineDash([]);
  ctx.lineJoin = "miter";
  outline(ctx, corners, "#111111", 3 * px);
  outline(ctx, corners, "#ffffff", px);
  ctx.lineWidth = px;
  const half = HANDLE_PX / 2 * px;
  for (const dir of HANDLES) {
    const p = toBacking(handlePoint(box.m, box.w, box.h, dir));
    const x = Math.round(p.x - half) + 0.5;
    const y = Math.round(p.y - half) + 0.5;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(x, y, 2 * half, 2 * half);
    ctx.strokeStyle = "#111111";
    ctx.strokeRect(x, y, 2 * half, 2 * half);
  }
  const c = toBacking(handlePoint(box.m, box.w, box.h, { hx: 0, hy: 0 }));
  ctx.beginPath();
  ctx.arc(c.x, c.y, CENTRE_PX * px, 0, Math.PI * 2);
  ctx.strokeStyle = "#111111";
  ctx.lineWidth = 3 * px;
  ctx.stroke();
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = px;
  ctx.stroke();
  ctx.restore();
}
function outline(ctx, pts, color, width) {
  ctx.beginPath();
  pts.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
  ctx.closePath();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.stroke();
}
const CLICK_SLOP = 4;
const CLICK_MS = 500;
function isPlainClick(down, up) {
  return Math.hypot(up.x - down.x, up.y - down.y) <= CLICK_SLOP && up.t - down.t <= CLICK_MS;
}
class WebClick {
  /**
   * @param stage - Stage element.
   * @param onWeb - Whether a stage CSS point lies on the web (outside the cap).
   * @param onClick - Called on a plain click on the web.
   */
  constructor(stage, onWeb, onClick) {
    this.stage = stage;
    this.onWeb = onWeb;
    this.onClick = onClick;
    const opts = { signal: this.controller.signal, passive: true, capture: true };
    stage.addEventListener("pointerdown", (e) => this.down(e), opts);
    stage.addEventListener("pointerup", (e) => this.up(e), opts);
    stage.addEventListener("pointercancel", () => this.press = null, opts);
  }
  stage;
  onWeb;
  onClick;
  press = null;
  controller = new AbortController();
  /** Remove listeners. */
  dispose() {
    this.controller.abort();
  }
  down(e) {
    this.press = null;
    const panning = this.stage.classList.contains("cps-pan-ready") || this.stage.classList.contains("cps-panning");
    if (e.button !== 0 || !e.isPrimary || panning || e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) return;
    this.press = { id: e.pointerId, x: e.clientX, y: e.clientY, t: e.timeStamp };
  }
  up(e) {
    const press = this.press;
    this.press = null;
    if (!press || press.id !== e.pointerId || e.button !== 0) return;
    const scale = this.cssScale();
    const down = { x: press.x / scale, y: press.y / scale, t: press.t };
    if (!isPlainClick(down, { x: e.clientX / scale, y: e.clientY / scale, t: e.timeStamp })) return;
    if (this.onWeb(this.toStage(press.x, press.y)) && this.onWeb(this.toStage(e.clientX, e.clientY))) this.onClick();
  }
  /** Screen px per stage CSS px (graph zoom). */
  cssScale() {
    const rect = this.stage.getBoundingClientRect();
    return this.stage.clientWidth > 0 && rect.width > 0 ? rect.width / this.stage.clientWidth : 1;
  }
  toStage(clientX, clientY) {
    const rect = this.stage.getBoundingClientRect();
    const s = this.cssScale();
    return { x: (clientX - rect.left) / s, y: (clientY - rect.top) / s };
  }
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
    this.webClick = new WebClick(stage, (p) => this.onWeb(p), () => this.cobweb.regrow());
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
  /** Ctrl/Cmd held: the cursor is that of `tools.resolve(alt, true)` (temporary layer Move). */
  ctrlDown = false;
  /** Shift held (selection-mode cursor badge). */
  shiftDown = false;
  /** Selection-mode badge on the cursor (kept fixed during a drag). */
  badge = null;
  /** Move cursor kind (cut / copy / outline / move; kept fixed during a drag). */
  moveKind = null;
  /** Web around the maximum paint area (one per stage / editor instance). */
  cobweb = new CobwebBackdrop(() => this.requestRender());
  webClick;
  /** Maximum paint area in stage CSS px at the last render. */
  capCss = null;
  /** Called after every full render (DOM overlays that follow the view, e.g. the text editor). */
  onRendered = null;
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
   * `tools.resolve(altDown, ctrlDown)` (Ctrl = temporary layer Move, else
   * Alt = temporary eyedropper). Synchronous, so Alt/Ctrl down/up updates the cursor without pointer movement. Selection tools
   * with a selection add the Shift/Alt mode badge (`cursors.ts`). Written to the
   * `--cps-tool-cursor` property so the pan/loading class cursors still win.
   * @returns The tool in effect, or `null` without a session.
   */
  syncCursor() {
    const session = this.session();
    const dragTool = this.getDragTool();
    const inSelection = session !== null && dragTool === null && this.hoverInSelection(session);
    const press = { shift: this.shiftDown, inSelection };
    const tool = session ? dragTool ?? session.tools.resolve(this.altDown, this.ctrlDown, press) : null;
    const locked = dragTool !== null || (tool?.pending?.() ?? false);
    if (!locked) {
      this.moveKind = tool && session ? moveCursorKind({ toolId: tool.id, alt: this.altDown, inSelection, floatActive: session.editor.float.active }) : null;
      this.badge = cursorBadge({
        combinesSelection: tool?.combinesSelection ?? false,
        hasSelection: session?.editor.selection.active ?? false,
        shift: this.shiftDown,
        alt: this.altDown
      });
    }
    const value = !tool ? "crosshair" : this.moveKind ? moveCursorCss(this.moveKind) : cssCursor(this.toolCursor(tool, session), this.badge);
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
    this.webClick.dispose();
    this.cobweb.dispose();
    this.canvas.width = this.canvas.height = 0;
    this.overlay.width = this.overlay.height = 0;
  }
  // ── Internals ───────────────────────────────────────────────────────────
  /** The tool's cursor, per hover position for tools with `cursorAt` (Free Transform zones). */
  toolCursor(tool, session) {
    if (!session || !this.hover || !tool.cursorAt) return tool.cursor();
    const { editor } = session;
    return tool.cursorAt(editor, imageToDoc(editor.frameMap, stageToDoc(editor.view.current, this.hover)));
  }
  /** Whether the hover point is inside the selection (the press test, `selectionMove.hit`). */
  hoverInSelection(session) {
    const { editor } = session;
    if (!this.hover || !editor.selection.active) return false;
    const doc = imageToDoc(editor.frameMap, stageToDoc(editor.view.current, this.hover));
    return editor.selectionMove.hit(doc.x, doc.y);
  }
  /** Whether a stage CSS point is on the web (inside the stage, outside the cap). */
  onWeb(p) {
    const cap = this.capCss;
    const size = this.stageSize();
    if (!cap || p.x < 0 || p.y < 0 || p.x > size.width || p.y > size.height) return false;
    return p.x < cap.x || p.y < cap.y || p.x > cap.x + cap.width || p.y > cap.y + cap.height;
  }
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
    const paintArea = boundsCap(editor.doc.frame);
    this.capCss = docRectToStage(editor.view.current, layerPlacement(editor.frameMap, paintArea));
    composite({
      ctx: this.ctx,
      cssSize: this.stageSize(),
      pixelRatio: this.pixelRatio,
      view: editor.view.current,
      imageSize: editor.imageSize,
      map: editor.frameMap,
      bounds: editor.bounds,
      background: editor.background,
      backgroundHidden: !backgroundShown(editor.doc.backgroundVisible !== false, editor.solo),
      layers: editor.compositeLayers(),
      masks: editor.maskOverlays(),
      paintArea,
      cobweb: this.cobweb
    });
    this.stage.classList.toggle("cps-loading", editor.loading);
    this.drawOverlay();
    this.onRendered?.();
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
    if (session) drawRegionOverlay(ctx, session.editor, pr, session.tools.active.id === REGION_TOOL_ID);
    if (session) drawTransformOverlay(ctx, session.editor, pr);
    if (session) drawResolutionLabel(ctx, session.editor, pr);
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
function groupEntries(older, newer) {
  const entries = older.kind === "group" ? [...older.entries, newer] : [older, newer];
  return { kind: "group", entries, bytes: older.bytes + newer.bytes };
}
const LOCKED_LAYER_NOTE = "Layer is locked.";
const MASK_STROKE_COLOR = "#ffffff";
const HIDDEN_LAYER_NOTE = "The layer is hidden.";
const SOLO_HIDDEN_NOTE = "The layer is hidden by solo.";
const HIDDEN_MASK_NOTE = "The mask is hidden; show it to output it.";
const TEXT_ENTRY_BYTES = 256;
const HIT_MARGIN = 0.15;
function renderTextLayer(s, layer) {
  const td = layer.kind === "text" ? layer.textData : void 0;
  if (!td) return;
  const bbox = textLayout(td).paint;
  if (bbox.width > 0 && bbox.height > 0) s.ensureBounds(bbox, true);
  const surface = s.store.ensure(layer.id);
  surface.ctx.clearRect(0, 0, surface.canvas.width, surface.canvas.height);
  const bounds = s.store.bounds;
  drawText(surface.ctx, td, { x: bounds.x, y: bounds.y });
}
function textStateOf(layer) {
  return layer.kind === "text" && layer.textData ? { kind: "text", name: layer.name, textData: layer.textData } : { kind: layer.kind, name: layer.name };
}
function sameTextState(a, b) {
  return a.kind === b.kind && a.name === b.name && JSON.stringify(a.textData) === JSON.stringify(b.textData);
}
function applyTextState(s, layer, state) {
  layer.kind = state.kind;
  layer.name = state.name;
  if (state.kind === "text" && state.textData) {
    layer.textData = state.textData;
    renderTextLayer(s, layer);
  } else {
    delete layer.textData;
  }
}
function recordTextChange(s, layerId, before, after, gesture) {
  const merge = gesture ? s.history.mergeTarget() : void 0;
  if (merge?.kind === "text" && merge.gesture === gesture && merge.layerId === layerId) {
    merge.after = after;
    if (sameTextState(merge.before, merge.after)) s.history.discardNewest();
    return;
  }
  const entry = { kind: "text", layerId, before, after, bytes: TEXT_ENTRY_BYTES };
  if (gesture) entry.gesture = gesture;
  s.history.push(entry);
}
function applyTextEntry(s, entry, forward) {
  const layer = s.doc.layers.find((l) => l.id === entry.layerId);
  if (!layer) return;
  applyTextState(s, layer, forward ? entry.after : entry.before);
  s.runtime.touch(layer.id);
  s.events.emit("layers", void 0);
}
function moveTextLayer(s, layer, dx, dy, gesture) {
  const td = layer.kind === "text" ? layer.textData : void 0;
  if (!td || dx === 0 && dy === 0) return false;
  const before = textStateOf(layer);
  layer.textData = { ...td, x: td.x + dx, y: td.y + dy };
  renderTextLayer(s, layer);
  recordTextChange(s, layer.id, before, textStateOf(layer), gesture);
  s.runtime.touch(layer.id);
  return true;
}
function hitTestText(layers2, point, boxOf) {
  for (let i = layers2.length - 1; i >= 0; i--) {
    const layer = layers2[i];
    if (!layer || layer.kind !== "text" || !layer.visible || !layer.textData) continue;
    const box = boxOf(layer.textData);
    const m = layer.textData.size * HIT_MARGIN;
    const rot = layer.textData.rotation ?? 0;
    const p = rot ? rotatePoint(point, -rot, { x: box.x + box.width / 2, y: box.y + box.height / 2 }) : point;
    if (p.x >= box.x - m && p.x <= box.x + box.width + m && p.y >= box.y - m && p.y <= box.y + box.height + m) {
      return layer.id;
    }
  }
  return null;
}
const RASTERIZE_PROMPT = "Rasterize text layer? It will no longer be editable as text.";
function rasterizeDecision(layer, confirm) {
  if (layer.kind !== "text") return "edit";
  return confirm() ? "rasterize" : "cancel";
}
function editBlockNote(s, layer) {
  if (!layer.visible) return layer.kind === "mask" ? HIDDEN_MASK_NOTE : HIDDEN_LAYER_NOTE;
  if (!shownOnStage(layer, s.solo.current)) return SOLO_HIDDEN_NOTE;
  if (layer.locked) return LOCKED_LAYER_NOTE;
  return null;
}
function preparePixelEdit(s, layer) {
  s.settleFloat();
  const note = editBlockNote(s, layer);
  if (note) {
    s.events.emit("note", note);
    return "blocked";
  }
  const decision = rasterizeDecision(layer, () => s.confirmRasterize());
  if (decision === "cancel") return "blocked";
  if (decision === "edit") return "proceed";
  rasterizeLayer(s, layer);
  return "rasterized";
}
function rasterizeLayer(s, layer) {
  const before = textStateOf(layer);
  layer.kind = "paint";
  delete layer.textData;
  recordTextChange(s, layer.id, before, textStateOf(layer));
  s.history.joinNext((entry) => entryLayerId(entry) === layer.id);
  s.events.emit("layers", void 0);
  s.events.emit("change", void 0);
  s.events.emit("history", void 0);
}
function entryLayerId(entry) {
  return entry.kind === "patch" || entry.kind === "translate" || entry.kind === "text" ? entry.layerId : null;
}
const CARET_PAD = 0.1;
class TextOverlay {
  /**
   * @param stage - Stage element (the textarea is placed in it).
   * @param root - Editor root (focus tracking).
   * @param onEditChange - An edit opened/changed/closed (refresh the options bar).
   */
  constructor(stage, root, onEditChange) {
    this.stage = stage;
    this.root = root;
    this.onEditChange = onEditChange;
    root.addEventListener("focusin", this.rootFocusIn);
  }
  stage;
  root;
  onEditChange;
  editor = null;
  area = null;
  layerId = null;
  unbind = null;
  timer = null;
  rootFocusIn = (event) => {
    const target = event.target;
    if (this.area && target instanceof HTMLElement && target.classList.contains("cps-focus-sink")) this.later(() => this.area?.focus({ preventScroll: true }));
  };
  /**
   * Follow a session's text edits (or none).
   * @param session - Session shown by the host.
   */
  bind(session) {
    this.unbind?.();
    this.unbind = null;
    this.editor = session?.editor ?? null;
    if (this.editor) {
      this.editor.text.setConfirmRasterize(() => window.confirm(RASTERIZE_PROMPT));
      this.unbind = this.editor.events.on("text", () => {
        this.onEditChange();
        this.sync();
      });
    }
    this.sync();
  }
  /** Open, update, re-position or close the textarea to match the editor. */
  sync() {
    const editor = this.editor;
    const edit = editor?.text.editing ?? null;
    if (!editor || !edit) {
      this.close();
      return;
    }
    if (!this.area || this.layerId !== edit.layerId) {
      this.close();
      this.open(edit.layerId, edit.textData.text);
    }
    const area = this.area;
    if (!area) return;
    if (area.value !== edit.textData.text) area.value = edit.textData.text;
    this.layout(area, editor, edit.textData);
  }
  /** Remove the textarea and listeners. */
  dispose() {
    this.bind(null);
    this.root.removeEventListener("focusin", this.rootFocusIn);
  }
  // ── Internals ───────────────────────────────────────────────────────────
  open(layerId, text) {
    const area = document.createElement("textarea");
    area.className = "cps-text-edit";
    area.wrap = "off";
    area.spellcheck = false;
    area.autocomplete = "off";
    area.setAttribute("autocapitalize", "off");
    area.setAttribute("aria-label", "Text");
    area.rows = 1;
    area.maxLength = MAX_TEXT_LENGTH;
    area.value = text;
    area.addEventListener("input", () => this.editor?.text.update({ text: area.value }));
    area.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" && !(event.key === "Enter" && (event.ctrlKey || event.metaKey))) return;
      event.preventDefault();
      event.stopPropagation();
      this.editor?.text.commit();
    });
    area.addEventListener("pointerdown", (event) => event.stopPropagation());
    area.addEventListener("blur", () => this.later(() => this.focusLeft()));
    area.addEventListener("scroll", () => {
      area.scrollTop = 0;
      area.scrollLeft = 0;
    });
    this.stage.appendChild(area);
    this.area = area;
    this.layerId = layerId;
    area.focus({ preventScroll: true });
    area.setSelectionRange(area.value.length, area.value.length);
  }
  /** Commit when focus went outside the editor (graph, another node, the page). */
  focusLeft() {
    const active = document.activeElement;
    if (!this.area || active === this.area) return;
    if (active && active !== document.body && this.root.contains(active)) return;
    this.editor?.text.commit();
  }
  layout(area, editor, td) {
    const lay = textLayout(td);
    const map = editor.frameMap;
    const view = editor.view.current;
    const k = map.scale * view.scale;
    const pad = Math.max(2, td.size * CARET_PAD);
    const left = lay.box.x - (td.align === "right" ? pad : td.align === "center" ? pad / 2 : 0);
    const sx = (map.offsetX + left * map.scale) * view.scale + view.offsetX;
    const sy = (map.offsetY + lay.box.y * map.scale) * view.scale + view.offsetY;
    const style = area.style;
    const ox = lay.centre.x - left;
    const oy = lay.box.height / 2;
    const rot = lay.rotation ? ` translate(${ox}px, ${oy}px) rotate(${lay.rotation}deg) translate(${-ox}px, ${-oy}px)` : "";
    style.transform = `translate(${sx}px, ${sy}px) scale(${k})${rot}`;
    style.width = `${lay.box.width + pad}px`;
    style.height = `${lay.box.height}px`;
    style.font = fontString(td);
    style.lineHeight = `${lay.lineHeight}px`;
    style.textAlign = td.align;
    style.caretColor = td.color;
    style.outlineWidth = `${1 / Math.max(k, 1e-6)}px`;
    style.outlineOffset = `${pad / 2}px`;
  }
  close() {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    const area = this.area;
    if (!area) return;
    this.area = null;
    this.layerId = null;
    if (document.activeElement === area) area.blur();
    area.remove();
  }
  /** Run after the current event (focus has settled). */
  later(fn) {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      fn();
    }, 0);
  }
}
class EditorHost {
  /**
   * @param events - Owner callbacks.
   */
  constructor(events = {}, sources = null) {
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
    this.clipboard = new ClipboardActions(() => this.session, this.stage);
    this.removeDrop = installDropImport(this.stage, this.clipboard, (text) => this.view.showNote(text));
    this.sync = new HostSync(
      () => this.session,
      () => this.optionsChanged(),
      () => this.input.cancel(),
      () => this.keyboard.reclaimFocus(),
      this.shell,
      this.clipboard
    );
    this.images = new ImagesPanel({
      history: sources,
      popovers: this.shell.popoverHost,
      root: this.root,
      stage: this.stage,
      toolBox: this.sync.rail.toolBox,
      beforeOpen: () => this.input.cancel(),
      pick: (entry) => {
        const editor = this.session?.editor;
        if (editor) void insertSourceUrl(editor, entry.url, () => this.session?.editor ?? null, entry.name);
      }
    });
    this.sync.rail.appendClipboardButton(this.images.button);
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
      setCtrl: (down) => this.setCtrl(down),
      viewChanged: () => this.view.requestRender()
    });
    this.keyboard = new KeyboardScope(this.root, {
      onKeyDown: (event) => this.images.handleKey(event) || (this.session ? handleShortcut(event, this.session, {
        optionsChanged: () => this.optionsChanged(),
        viewChanged: () => this.view.requestRender(),
        cancelDrag: () => this.input.cancel(),
        cancelToolDrag: () => this.input.cancelToolDrag(),
        fullscreen: () => this.shell.events.emit("fullscreen", void 0),
        toggleOutputs: () => this.sync.toggleOutputs(),
        closePopover: () => {
          if (!this.shell.popoverHost.isOpen) return false;
          this.session?.editor.regionOps.cancel();
          return this.shell.popoverHost.close();
        },
        exitFullscreen: () => {
          if (!this.fullscreen.isOpen) return false;
          this.fullscreen.exit();
          return true;
        },
        clipboard: this.clipboard
      }) : false),
      onSpaceChange: (down) => this.stage.classList.toggle("cps-pan-ready", down),
      onAltChange: (down) => this.setAlt(down),
      onShiftChange: (down) => this.setShift(down),
      onCtrlChange: (down) => this.setCtrl(down),
      onSave: () => this.events.onSave?.(),
      onDeactivate: () => this.events.onDisengage?.()
    });
    this.shell.popoverHost.events.on("close", () => this.keyboard.reclaimFocus());
    this.shell.events.on("fullscreen", () => this.fullscreen.toggle());
    this.textOverlay = new TextOverlay(this.stage, this.root, () => this.sync.optionsBar.refresh());
    this.view.onRendered = () => this.textOverlay.sync();
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
  /** Rail/options-bar sync layer (owns rail, swatches, options bar, selection actions, side panels). */
  sync;
  /** Text tool's in-canvas `<textarea>` + rasterize prompt. */
  textOverlay;
  keyboard;
  resizeObserver;
  fullscreen;
  /** Copy / cut / paste (keys, rail, drops). */
  clipboard;
  removeDrop;
  /** M12: Images button + thumbnail panel. */
  images;
  restoreState = null;
  session = null;
  unbind = [];
  wasVisible = false;
  disposed = false;
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
    this.sync.bindEditor(session?.editor ?? null);
    this.textOverlay.bind(session);
    if (session) {
      const { editor, tools } = session;
      this.unbind.push(
        editor.events.on("render", () => this.view.requestRender()),
        editor.events.on("history", () => this.sync.syncHistory()),
        editor.events.on("note", (text) => this.view.showNote(text)),
        editor.events.on("mask", () => this.sync.syncMask()),
        editor.events.on("change", () => this.sync.syncMask()),
        // Move tool: live X / Y / Scale fields.
        editor.events.on("placement", () => (this.sync.optionsBar.refresh(), this.sync.resolution.sync())),
        // Drawing resolution notice: frame / image size / load changes (cheap, de-duplicated).
        editor.events.on("render", () => this.sync.resolution.sync()),
        // Selection: marching ants + "To mask" button.
        editor.events.on("selection", () => (this.sync.selectionActions.sync(), this.sync.syncOptions(), this.view.requestOverlay())),
        // Free Transform: bar swaps to the session options and back; handles + cursor follow.
        editor.events.on("transform", () => (this.sync.syncOptions(), this.view.requestOverlay())),
        editor.colors.events.on("change", (colors) => this.sync.swatches.setColors(colors)),
        // Tool switch: chrome (rail, options, Move drawing toggle) + stage cursor/ring now.
        tools.events.on("change", () => (this.sync.syncTools(), this.view.requestOverlay()))
      );
      this.sync.swatches.setColors(editor.colors.current);
      this.sync.syncTools();
      this.sync.syncMask();
      this.sync.syncHistory();
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
    this.removeDrop();
    this.clipboard.dispose();
    this.images.dispose();
    this.input.dispose();
    this.keyboard.dispose();
    this.sync.dispose();
    this.textOverlay.dispose();
    this.view.dispose();
    this.shell.dispose();
    this.root.remove();
  }
  // ── Fullscreen ──────────────────────────────────────────────────────────
  /** Root just moved into (`open`) or out of the overlay. */
  fullscreenChanged(open) {
    const panel = this.shell.sidePanel;
    const view = this.session?.editor.view;
    this.sync.rail.setFullscreen(open);
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
  // ── Modifier keys ────────────────────────────────────────────────────────
  /** Alt held (keyboard or pointer modifier): the cursor follows `ToolRegistry.resolve`. */
  setAlt(down) {
    if (this.view.altDown === down) return;
    this.view.altDown = down;
    this.view.syncCursor();
    this.view.requestOverlay();
  }
  /** Ctrl/Cmd held (keyboard or pointer modifier): the cursor follows `ToolRegistry.resolve` (temporary Move). */
  setCtrl(down) {
    if (this.view.ctrlDown === down) return;
    this.view.ctrlDown = down;
    this.view.syncCursor();
    this.view.requestOverlay();
  }
  /** Shift held (keyboard or pointer modifier): selection-mode cursor badge. */
  setShift(down) {
    if (this.view.shiftDown === down) return;
    this.view.shiftDown = down;
    this.view.syncCursor();
  }
  // ── Options ─────────────────────────────────────────────────────────────
  optionsChanged() {
    this.sync.optionsChanged();
    this.view.requestOverlay();
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
    if (item) return { ...resultItemSource(item, "upstream"), name: fileStem(item.filename ?? "") };
  }
  const locator = nodeLocatorId(upstream);
  if (locator) {
    const preview = app.nodePreviewImages[locator]?.[0];
    if (typeof preview === "string" && preview) return { key: preview, url: preview, origin: "upstream" };
    const item = firstOutputImage(app.nodeOutputs[locator]);
    if (item) {
      const source = resultItemSource(item, "upstream");
      return item.type === "input" && item.filename ? { ...source, name: fileStem(item.filename) } : source;
    }
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
function fileStem(filename) {
  const dot = filename.lastIndexOf(".");
  return dot > 0 ? filename.slice(0, dot) : filename;
}
function resultItemSource(item, origin) {
  return {
    key: viewQuery(item),
    url: viewUrl(item, (route) => api.apiURL(route), app.getRandParam()),
    origin
  };
}
class BackgroundLoader {
  /**
   * @param node - The node whose `image` input is resolved.
   * @param onSettled - Called when a load finishes (success, empty or error).
   */
  constructor(node, onSettled) {
    this.node = node;
    this.onSettled = onSettled;
  }
  node;
  onSettled;
  /** Last loaded background image; shown only while `image` is connected. */
  loaded = null;
  /** Key of the most recent source we started loading (success or not). */
  requestedKey = null;
  /** A background load is in flight. */
  loadPending = false;
  loadSeq = 0;
  executed = null;
  disposed = false;
  /** @returns The last loaded background, if any. */
  get background() {
    return this.loaded;
  }
  /** @returns Our node's last executed output (input-image preview). */
  get lastExecuted() {
    return this.executed;
  }
  /**
   * @returns `true` while this instance's first load has not settled (a load
   *   is in flight, or nothing was requested yet).
   */
  get awaitingImage() {
    return this.loadPending || this.requestedKey === null;
  }
  /**
   * Record our node's executed output (a source for {@link refresh}).
   * @param output - Execution output.
   */
  setExecuted(output) {
    this.executed = output;
  }
  /**
   * Take over a predecessor's state (graph undo/redo hand-off).
   * @param background - Its loaded background, if any.
   * @param lastExecuted - Its last executed output (kept only if we have none).
   */
  adopt(background, lastExecuted) {
    this.executed ??= lastExecuted;
    if (background) {
      this.loaded = background;
      this.requestedKey = background.key;
    }
  }
  /**
   * Re-resolve the source and reload only if it changed. While `image` is
   * disconnected no source is used and in-flight loads are dropped.
   * @param connected - Whether the `image` input has a link.
   */
  refresh(connected) {
    if (connected) {
      const source = this.resolveSource();
      if (source && source.key !== this.requestedKey) this.load(source);
    } else if (this.requestedKey !== (this.loaded?.key ?? null)) {
      this.loadSeq++;
      this.loadPending = false;
      this.requestedKey = this.loaded?.key ?? null;
    }
  }
  /** Ignore all in-flight and future load results. */
  dispose() {
    this.disposed = true;
    this.loadSeq++;
  }
  /** Live upstream source first, else our own last executed preview. */
  resolveSource() {
    const slot = inputSlotIndex(this.node, INPUT_NAMES.image);
    const upstream = slot >= 0 ? findUpstreamNode(this.node, slot) : null;
    return (upstream ? sourceFromNode(upstream) : null) ?? sourceFromExecuted(this.node, this.executed);
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
        this.onSettled();
        return;
      }
      this.loaded = {
        key: source.key,
        image,
        size: { width: image.naturalWidth, height: image.naturalHeight }
      };
      this.onSettled();
    };
    image.onerror = () => {
      if (seq !== this.loadSeq || this.disposed) return;
      this.loadPending = false;
      this.onSettled();
      log.warn(`Could not load background image from ${source.origin} node:`, source.url);
    };
    image.src = source.url;
  }
}
class SourceWatcher {
  /**
   * @param refresh - Re-resolve the source (API event, deferred start).
   * @param tick - Poll callback (cheap; should skip while hidden).
   */
  constructor(refresh, tick) {
    this.refresh = refresh;
    this.tick = tick;
  }
  refresh;
  tick;
  listening = false;
  pollTimer = null;
  startTimer = null;
  handleApiExecuted = () => this.refresh();
  /** @returns `true` once {@link start} ran (until {@link stop}). */
  get active() {
    return this.listening;
  }
  /**
   * @returns `true` until the deferred first refresh ran (upstream nodes may
   *   not be configured yet).
   */
  get starting() {
    return this.startTimer !== null;
  }
  /** Start listening, polling, and schedule the deferred first refresh. */
  start() {
    this.listening = true;
    api.addEventListener("executed", this.handleApiExecuted);
    this.pollTimer = setInterval(() => this.tick(), SOURCE_POLL_MS);
    this.startTimer = setTimeout(() => {
      this.startTimer = null;
      this.refresh();
    }, 0);
  }
  /** Remove the listener and timers. Idempotent. */
  stop() {
    if (this.listening) api.removeEventListener("executed", this.handleApiExecuted);
    this.listening = false;
    if (this.pollTimer !== null) clearInterval(this.pollTimer);
    if (this.startTimer !== null) clearTimeout(this.startTimer);
    this.pollTimer = null;
    this.startTimer = null;
  }
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
    if (!middle && (event.type === "pointerdown" || event.type === "pointermove")) {
      middleDrag = false;
      sync();
      return;
    }
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
class FrameSync {
  /**
   * @param node - The node whose widgets define the fallback frame.
   * @param loader - Background loader of the same node.
   */
  constructor(node, loader) {
    this.node = node;
    this.loader = loader;
  }
  node;
  loader;
  contentKey = "";
  /** Forget the last pushed content so the next {@link apply} pushes again. */
  reset() {
    this.contentKey = "";
  }
  /**
   * Chain our own frame widgets' callbacks so fallback frame edits apply
   * immediately (the poll catches programmatic changes).
   * @param onChange - Called after the original callback.
   */
  chainWidgetCallbacks(onChange) {
    for (const name of [INPUT_NAMES.width, INPUT_NAMES.height, INPUT_NAMES.background]) {
      const widget = this.findWidget(name);
      if (!widget) continue;
      const original = widget.callback;
      widget.callback = (...args) => {
        const [value, ...rest] = args;
        original?.call(widget, value, ...rest);
        onChange();
      };
    }
  }
  /**
   * Push background + frame decisions to the editor when anything relevant
   * changed. The current image is the loaded upstream image while connected,
   * else `width` x `height` filled with `background`; either way an empty
   * editor adopts its size and a painted one only maps onto it.
   * @param session - Attached session.
   * @param connected - Whether the `image` input has a link.
   */
  apply(session, connected) {
    const { editor } = session;
    const bg = connected ? this.loader.background : null;
    if (bg) {
      const key2 = `${session.docId}|image|${bg.key}`;
      if (key2 === this.contentKey) return;
      this.contentKey = key2;
      editor.setBackground({ kind: "image", image: bg.image }, bg.size);
      editor.handleBackgroundSize(bg.size);
      return;
    }
    const awaitingImage = connected && this.loader.awaitingImage;
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
   * @returns Sanitized fallback frame.
   */
  fallbackFrame() {
    return resolveFallbackFrame(
      this.findWidget(INPUT_NAMES.width)?.value,
      this.findWidget(INPUT_NAMES.height)?.value,
      this.findWidget(INPUT_NAMES.background)?.value
    );
  }
  /**
   * A link on the node changed. If `image` lost its link (a user edit, not a
   * load), see {@link adoptSizeOnDisconnect}.
   * @param type - Slot type (`LINK_INPUT` for inputs).
   * @param slot - Slot index.
   * @param isConnected - `false` when a link was removed.
   * @param session - Attached session, if any.
   * @param stillWanted - Checked in the deferred microtask.
   */
  handleLinkChange(type, slot, isConnected, session, stillWanted) {
    const imageSlot = inputSlotIndex(this.node, INPUT_NAMES.image);
    if (type === LINK_INPUT && slot === imageSlot && !isConnected && session && this.node.graph) {
      this.adoptSizeOnDisconnect(session.editor.imageSize, stillWanted);
    }
  }
  /**
   * `image` lost its link (a user edit, not a load): the widgets take over the
   * last image size so the canvas keeps its size and the node shows it.
   * Deferred a microtask so a link replaced by another (disconnect, then
   * connect in one call) leaves the widgets alone.
   * @param size - Image size shown when the link was removed.
   * @param stillWanted - Checked in the microtask (not disposed, still
   *   disconnected).
   */
  adoptSizeOnDisconnect(size, stillWanted) {
    queueMicrotask(() => {
      if (!stillWanted()) return;
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
   * re-applies the frame; see {@link chainWidgetCallbacks}).
   * @returns `true` if the value changed.
   */
  setWidgetValue(name, value) {
    const widget = this.findWidget(name);
    if (!widget || widget.value === value) return false;
    widget.value = value;
    widget.callback?.(widget.value);
    return true;
  }
  findWidget(name) {
    return this.node.widgets?.find((widget) => widget.name === name);
  }
}
const MIN_FRAME_SHORT_SIDE = 1024;
const MAX_BOOSTED_LONG_SIDE = 4096;
const RESOLUTION_NOTICE_RATIO = 1.5;
const MAX_BOUNDS_SIDE = 16384;
function minimumFrame(size) {
  const w = Math.max(1, Math.round(size.width));
  const h = Math.max(1, Math.round(size.height));
  const boost = Math.max(1, Math.min(MIN_FRAME_SHORT_SIDE / Math.min(w, h), MAX_BOOSTED_LONG_SIDE / Math.max(w, h)));
  if (boost === 1) return { width: w, height: h };
  return { width: Math.max(1, Math.round(w * boost)), height: Math.max(1, Math.round(h * boost)) };
}
function resolutionInfo(doc, image) {
  const current = documentMap(doc, image).scale;
  const ideal = frameMap(minimumFrame(image), image).scale;
  const ratio = current > 0 && ideal > 0 ? current / ideal : 1;
  const imagePx = Math.max(image.width, image.height);
  const gridPx = current > 0 ? Math.round(imagePx / current) : imagePx;
  return { ratio, gridPx, imagePx, mismatch: ratio > RESOLUTION_NOTICE_RATIO };
}
function transformPoint(t, p) {
  return { x: p.x * t.factor + t.tx, y: p.y * t.factor + t.ty };
}
function transformRect(t, r) {
  return { x: r.x * t.factor + t.tx, y: r.y * t.factor + t.ty, width: r.width * t.factor, height: r.height * t.factor };
}
function clipSide(start, length, centre, max) {
  if (length <= max) return [start, length];
  const lo = Math.min(start + length - max, Math.max(start, Math.round(centre - max / 2)));
  return [lo, max];
}
function keepResolution(frame, image, currentScale) {
  const ideal = frameMap(frame, image).scale;
  if (!(currentScale > 0) || currentScale >= ideal) return frame;
  const k = Math.min(ideal / currentScale, MAX_BOUNDS_SIDE / Math.max(frame.width, frame.height));
  if (k <= 1) return frame;
  return { width: Math.max(1, Math.round(frame.width * k)), height: Math.max(1, Math.round(frame.height * k)) };
}
function imageFits(doc, image) {
  const r = docRectToImage(documentMap(doc, image), unionRect(boundsCap(doc.frame), doc.bounds));
  const eps = 1e-6;
  return r.x <= eps && r.y <= eps && r.x + r.width >= image.width - eps && r.y + r.height >= image.height - eps;
}
function matchGeometry(doc, image) {
  const placement = void 0;
  const before = documentMap(doc, image);
  const frame = keepResolution(minimumFrame(image), image, before.scale);
  const after = frameMap(frame, image, placement);
  const factor = before.scale / after.scale;
  const transform = { factor, tx: (before.offsetX - after.offsetX) / after.scale, ty: (before.offsetY - after.offsetY) / after.scale };
  const moved = transformRect(transform, doc.bounds);
  const x0 = Math.floor(moved.x + 1e-6);
  const y0 = Math.floor(moved.y + 1e-6);
  const out = { x: x0, y: y0, width: Math.ceil(moved.x + moved.width - 1e-6) - x0, height: Math.ceil(moved.y + moved.height - 1e-6) - y0 };
  const full = unionRect(out, { x: 0, y: 0, width: frame.width, height: frame.height });
  const [bx, bw] = clipSide(full.x, full.width, frame.width / 2, MAX_BOUNDS_SIDE);
  const [by, bh] = clipSide(full.y, full.height, frame.height / 2, MAX_BOUNDS_SIDE);
  const bounds = { x: bx, y: by, width: bw, height: bh };
  const cropped = bw < full.width || bh < full.height;
  return { frame, bounds, placement, transform, cropped };
}
function scaleTextData(td, t) {
  const p = transformPoint(t, td);
  return { ...td, x: p.x, y: p.y, size: clampSize(td.size * t.factor) };
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
const listeners = /* @__PURE__ */ new Set();
function onDocumentChange(listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
function emitDocumentChange(node) {
  for (const listener of listeners) listener(node);
}
const DEFAULT_TIMERS = {
  set: (callback, delayMs) => setTimeout(callback, delayMs),
  clear: (handle) => clearTimeout(handle)
};
class CoalescedTask {
  /**
   * @param run - The work to do.
   * @param timers - Timer functions (defaults to `setTimeout` / `clearTimeout`).
   */
  constructor(run2, timers = DEFAULT_TIMERS) {
    this.run = run2;
    this.timers = timers;
  }
  run;
  timers;
  handle = null;
  /** @returns Whether a run is scheduled. */
  get pending() {
    return this.handle !== null;
  }
  /**
   * Run `delayMs` after the latest call (replaces any pending schedule).
   * @param delayMs - Delay in ms.
   */
  schedule(delayMs) {
    this.cancel();
    this.handle = this.timers.set(() => {
      this.handle = null;
      this.run();
    }, delayMs);
  }
  /** Run now if scheduled; no-op otherwise. */
  flush() {
    if (!this.pending) return;
    this.cancel();
    this.run();
  }
  /** Drop a pending run. */
  cancel() {
    if (this.handle === null) return;
    this.timers.clear(this.handle);
    this.handle = null;
  }
}
function captureTrackerState(tracker) {
  if (typeof tracker.captureCanvasState === "function") {
    tracker.captureCanvasState();
    return true;
  }
  if (typeof tracker.checkState === "function") {
    tracker.checkState();
    return true;
  }
  return false;
}
function isInRootGraph(graph, root) {
  if (!graph || !root) return false;
  return (graph.rootGraph ?? graph) === root;
}
const EDIT_SYNC_DELAY_MS = 1e3;
const UPLOAD_SYNC_DELAY_MS = 0;
const requested = /* @__PURE__ */ new Set();
let captureFailureLogged = false;
const task = new CoalescedTask(() => {
  const nodes = [...requested];
  requested.clear();
  const root = app.graph;
  if (!nodes.some((node) => isInRootGraph(node.graph, root))) return;
  const tracker = app.extensionManager?.workflow?.activeWorkflow?.changeTracker;
  if (!tracker) return;
  try {
    captureTrackerState(tracker);
  } catch (error) {
    if (!captureFailureLogged) log.warn("workflow draft update failed (ChangeTracker capture threw):", error);
    captureFailureLogged = true;
  }
});
function requestGraphSync(node, delayMs) {
  requested.add(node);
  task.schedule(delayMs);
}
function flushGraphSync() {
  task.flush();
}
const SOURCE_HISTORY_SIZE = 10;
const LAYER_SOURCE_UI_KEY = "layer_source";
class SourceHistory {
  /**
   * @param cap - Maximum entries (default {@link SOURCE_HISTORY_SIZE}).
   */
  constructor(cap = SOURCE_HISTORY_SIZE) {
    this.cap = cap;
  }
  cap;
  list = [];
  listeners = /* @__PURE__ */ new Set();
  /** Entries, newest first. */
  get entries() {
    return this.list;
  }
  /**
   * Record a sighting: new keys go on top (the oldest falls off past the
   * cap), a known key moves to the top. Seeing the current top again is a no-op.
   * @param entry - Source seen.
   * @param announce - A new key is reported as `"new"` (else `"seed"`).
   * @returns `true` if the list changed.
   */
  add(entry, announce = true) {
    if (this.list[0]?.key === entry.key) return false;
    const known = this.list.some((e) => e.key === entry.key);
    this.list = [{ ...entry }, ...this.list.filter((e) => e.key !== entry.key)].slice(0, this.cap);
    const change = known ? "moved" : announce ? "new" : "seed";
    for (const listener of this.listeners) listener(change);
    return true;
  }
  /**
   * Listen for changes.
   * @param listener - Called after every change with its kind.
   * @returns Unsubscribe.
   */
  onChange(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
function layerSourceItem(output) {
  const items = output?.[LAYER_SOURCE_UI_KEY];
  if (!Array.isArray(items)) return null;
  for (const item of items) {
    if (isResultItem(item)) return item;
  }
  return null;
}
function layerSourceKey(item) {
  return typeof item.source_id === "string" && item.source_id ? `source:${item.source_id}` : viewQuery(item);
}
function isResultItem(value) {
  if (typeof value !== "object" || value === null) return false;
  const filename = value.filename;
  return typeof filename === "string" && filename.length > 0;
}
function resolveLayerSource(node, lastExecuted) {
  const slot = inputSlotIndex(node, INPUT_NAMES.layerSource);
  if (slot < 0 || node.inputs[slot]?.link == null) return null;
  const upstream = findUpstreamNode(node, slot);
  const live = upstream ? sourceFromNode(upstream) : null;
  if (live) return live.name ? { key: live.key, url: live.url, name: live.name } : { key: live.key, url: live.url };
  const locator = nodeLocatorId(node);
  const item = layerSourceItem(lastExecuted) ?? layerSourceItem(locator ? app.nodeOutputs[locator] : null);
  return item ? { key: layerSourceKey(item), url: viewUrl(item, (route) => api.apiURL(route), app.getRandParam()) } : null;
}
class LayerSourceWatch {
  /**
   * @param node - Our node.
   */
  constructor(node) {
    this.node = node;
  }
  node;
  /** Sources seen this session (per node instance, memory only). */
  history = new SourceHistory();
  executed = null;
  /**
   * New sources are announced (auto-open) once the initial state is known:
   * after the first source seen, or after a user link change on the input.
   */
  armed = false;
  /** A link changed after startup: the next new source is announced even if it is the first one. */
  arm() {
    this.armed = true;
  }
  /**
   * Our node executed (its output may carry a `layer_source` preview).
   * @param output - Execution output.
   */
  setExecuted(output) {
    this.executed = output;
  }
  /** Look the source up again and record it (cheap; de-duplicated by the history). */
  refresh() {
    const entry = resolveLayerSource(this.node, this.executed);
    if (!entry) return;
    this.history.add(entry, this.armed);
    this.armed = true;
  }
}
const SIZE_WIDGETS = /* @__PURE__ */ new Set([INPUT_NAMES.width, INPUT_NAMES.height]);
function syncSizeWidgets(node) {
  const hidden = isInputConnected(node, INPUT_NAMES.image);
  let changed = false;
  for (const widget of node.widgets ?? []) {
    if (!SIZE_WIDGETS.has(widget.name) || (widget.hidden ?? false) === hidden) continue;
    widget.hidden = hidden;
    changed = true;
  }
  if (!changed) return false;
  const needed = node.computeSize?.();
  const [width, height] = node.size;
  if (!hidden && needed && needed[1] > height) node.setSize([width, needed[1]]);
  node.setDirtyCanvas?.(true, true);
  return true;
}
function sceneFor(input, source) {
  return source === "background" ? { ...input, layers: [], backgroundHidden: false } : input;
}
function visibleScene(s) {
  const layers2 = [];
  for (const layer of s.doc.layers) {
    if (layer.kind === "mask" || !shownOnStage(layer, s.solo.current)) continue;
    layers2.push({ source: s.store.ensure(layer.id).canvas, opacity: layer.opacity });
  }
  return {
    background: s.background,
    backgroundHidden: !backgroundShown(s.doc.backgroundVisible !== false, s.solo.current),
    imageSize: s.imageSize,
    map: documentMap(s.doc, s.imageSize),
    bounds: s.store.bounds,
    layers: layers2
  };
}
function drawDocRegion(ctx, input, rect) {
  const { map, imageSize: imageSize2, bounds } = input;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  ctx.clearRect(0, 0, rect.width, rect.height);
  const image = imageRectToDoc(map, { x: 0, y: 0, width: imageSize2.width, height: imageSize2.height });
  const bx = image.x - rect.x;
  const by = image.y - rect.y;
  if (input.backgroundHidden === true) ;
  else if (input.background.kind === "image") {
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(input.background.image, bx, by, image.width, image.height);
  } else {
    ctx.fillStyle = input.background.color;
    ctx.fillRect(bx, by, image.width, image.height);
  }
  for (const layer of input.layers) {
    if (layer.opacity <= 0) continue;
    ctx.globalAlpha = layer.opacity;
    ctx.drawImage(layer.source, bounds.x - rect.x, bounds.y - rect.y);
  }
  ctx.globalAlpha = 1;
}
function readDocRegion(input, rect, scratch2) {
  const canvas = scratch2 ?? document.createElement("canvas");
  if (canvas.width !== rect.width) canvas.width = rect.width;
  if (canvas.height !== rect.height) canvas.height = rect.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  drawDocRegion(ctx, input, rect);
  const data = ctx.getImageData(0, 0, rect.width, rect.height);
  if (!scratch2) canvas.width = canvas.height = 0;
  return data;
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
function clean$1(n) {
  return n === 0 ? 0 : n;
}
function dragDelta(start, current) {
  return { x: clean$1(Math.round(current.x - start.x)), y: clean$1(Math.round(current.y - start.y)) };
}
function nudgeStep(imagePx, mapScale) {
  if (!(mapScale > 0) || !Number.isFinite(mapScale)) return Math.max(1, Math.round(imagePx));
  return Math.max(1, Math.round(imagePx / mapScale));
}
function alphaBounds(data, width, height) {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width * 4;
    let first = -1;
    for (let x = 0; x < width; x++) {
      if (data[row + x * 4 + 3]) {
        first = x;
        break;
      }
    }
    if (first < 0) continue;
    let last = first;
    for (let x = width - 1; x > first; x--) {
      if (data[row + x * 4 + 3]) {
        last = x;
        break;
      }
    }
    if (first < minX) minX = first;
    if (last > maxX) maxX = last;
    if (minY === height) minY = y;
    maxY = y;
  }
  if (maxX < 0) return { x: 0, y: 0, width: 0, height: 0 };
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}
function offsetRect(r, dx, dy) {
  return { x: r.x + dx, y: r.y + dy, width: r.width, height: r.height };
}
function planTranslate(bounds, content, dx, dy, frame, limits = DEFAULT_GROWTH) {
  if (dx === 0 && dy === 0 || isEmptyRect(content)) return { kind: "none" };
  const target = offsetRect(content, dx, dy);
  const grown = growBounds(bounds, target, frame, limits);
  const kind = containsRect(grown, target) ? "translate" : "patch";
  return { kind, bounds: grown, target, region: unionRect(content, target) };
}
function translateStep(entry, forward) {
  const moved = offsetRect(entry.content, entry.dx, entry.dy);
  return forward ? { from: { ...entry.content }, to: moved, dx: entry.dx, dy: entry.dy } : { from: moved, to: { ...entry.content }, dx: clean$1(-entry.dx), dy: clean$1(-entry.dy) };
}
function mergeTranslate(entry, dx, dy) {
  entry.dx = clean$1(entry.dx + dx);
  entry.dy = clean$1(entry.dy + dy);
}
const TRANSLATE_ENTRY_BYTES = 128;
const contentCache = /* @__PURE__ */ new WeakMap();
function cacheOf(s) {
  let cache2 = contentCache.get(s);
  if (!cache2) {
    cache2 = /* @__PURE__ */ new Map();
    contentCache.set(s, cache2);
  }
  return cache2;
}
function layerContentRect(s, layerId) {
  const cache2 = cacheOf(s);
  const revision = s.runtime.revision(layerId);
  const hit = cache2.get(layerId);
  if (hit && hit.revision === revision) return { ...hit.rect };
  let rect = { x: 0, y: 0, width: 0, height: 0 };
  if (s.runtime.get(layerId)?.hasContent) {
    const bounds = s.store.bounds;
    const data = s.store.snapshot(layerId);
    const local = alphaBounds(data.data, data.width, data.height);
    if (!isEmptyRect(local)) rect = offsetRect(local, bounds.x, bounds.y);
  }
  cache2.set(layerId, { revision, rect });
  return { ...rect };
}
function shiftRegion(s, layerId, from, dx, dy) {
  const bounds = s.store.bounds;
  const src = intersectRect(from, bounds);
  if (isEmptyRect(src)) return;
  const surface = s.store.ensure(layerId);
  const lx = src.x - bounds.x;
  const ly = src.y - bounds.y;
  const tmp = createSurface(src.width, src.height);
  tmp.ctx.drawImage(surface.canvas, lx, ly, src.width, src.height, 0, 0, src.width, src.height);
  const ctx = surface.ctx;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  ctx.clearRect(lx, ly, src.width, src.height);
  ctx.drawImage(tmp.canvas, lx + dx, ly + dy);
  ctx.restore();
  releaseSurface(tmp);
}
function translateLayerPixels(s, layerId, dx, dy, gesture) {
  const content = layerContentRect(s, layerId);
  const plan = planTranslate(s.store.bounds, content, dx, dy, s.doc.frame);
  if (plan.kind === "none") return false;
  s.ensureBounds(plan.target, true);
  const cache2 = cacheOf(s);
  if (plan.kind === "translate") {
    shiftRegion(s, layerId, content, dx, dy);
    const merge = gesture ? s.history.mergeTarget() : void 0;
    if (merge?.kind === "translate" && merge.gesture === gesture && merge.layerId === layerId) {
      mergeTranslate(merge, dx, dy);
      if (merge.dx === 0 && merge.dy === 0) s.history.discardNewest();
    } else {
      const entry = { kind: "translate", layerId, dx, dy, content, bytes: TRANSLATE_ENTRY_BYTES };
      if (gesture) entry.gesture = gesture;
      s.history.push(entry);
    }
    s.runtime.touch(layerId);
    cache2.set(layerId, { revision: s.runtime.revision(layerId), rect: plan.target });
    return true;
  }
  const region = intersectRect(plan.region, s.store.bounds);
  const before = s.store.read(layerId, region);
  if (!before) return false;
  shiftRegion(s, layerId, content, dx, dy);
  const after = s.store.read(layerId, before.rect);
  if (after) {
    const bytes = before.data.data.byteLength + after.data.data.byteLength;
    s.history.push({ kind: "patch", layerId, x: before.rect.x, y: before.rect.y, before: before.data, after: after.data, bytes });
  }
  s.runtime.touch(layerId);
  cache2.delete(layerId);
  return true;
}
function applyTranslateEntry(s, entry, forward) {
  if (!s.doc.layers.some((l) => l.id === entry.layerId)) return;
  const step = translateStep(entry, forward);
  s.ensureBounds(step.to, false);
  shiftRegion(s, entry.layerId, step.from, step.dx, step.dy);
  s.runtime.touch(entry.layerId);
  cacheOf(s).set(entry.layerId, { revision: s.runtime.revision(entry.layerId), rect: step.to });
}
const INSIDE_COVERAGE = 128;
function liftPixels(src, coverage, cut) {
  const float = new Uint8ClampedArray(src);
  const rest = new Uint8ClampedArray(src);
  const n = Math.min(coverage.length, src.length >> 2);
  for (let i = 0; i < src.length >> 2; i++) {
    const c = i < n ? coverage[i] : 0;
    const p = i * 4 + 3;
    const a = src[p];
    float[p] = Math.round(a * c / 255);
    if (float[p] === 0) {
      float[p - 3] = 0;
      float[p - 2] = 0;
      float[p - 1] = 0;
    }
    if (cut) rest[p] = Math.round(a * (255 - c) / 255);
  }
  return { float, rest };
}
function compositeOver(dst, dstWidth, dstHeight, src, srcWidth, srcHeight, ox, oy, opacity = 1) {
  const x0 = Math.max(0, ox);
  const y0 = Math.max(0, oy);
  const x1 = Math.min(dstWidth, ox + srcWidth);
  const y1 = Math.min(dstHeight, oy + srcHeight);
  const k = Math.min(1, Math.max(0, opacity));
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const s = ((y - oy) * srcWidth + (x - ox)) * 4;
      const sa = src[s + 3] / 255 * k;
      if (sa <= 0) continue;
      const d = (y * dstWidth + x) * 4;
      const da = dst[d + 3] / 255;
      const oa = sa + da * (1 - sa);
      for (let c = 0; c < 3; c++) {
        dst[d + c] = Math.round((src[s + c] * sa + dst[d + c] * da * (1 - sa)) / oa);
      }
      dst[d + 3] = Math.round(oa * 255);
    }
  }
}
function copyPixels(dst, dstRect, src, srcRect) {
  const x0 = Math.max(dstRect.x, srcRect.x);
  const y0 = Math.max(dstRect.y, srcRect.y);
  const x1 = Math.min(dstRect.x + dstRect.width, srcRect.x + srcRect.width);
  const y1 = Math.min(dstRect.y + dstRect.height, srcRect.y + srcRect.height);
  if (x1 <= x0) return;
  for (let y = y0; y < y1; y++) {
    const s = ((y - srcRect.y) * srcRect.width + (x0 - srcRect.x)) * 4;
    const d = ((y - dstRect.y) * dstRect.width + (x0 - dstRect.x)) * 4;
    dst.set(src.subarray(s, s + (x1 - x0) * 4), d);
  }
}
function mergeMaskCoverage(upper, upperInvert, lower, lowerInvert) {
  for (let p = 0; p < lower.length; p += 4) {
    const u = upper[p + 3];
    const l = lower[p + 3];
    const eu = upperInvert ? 255 - u : u;
    const el2 = lowerInvert ? 255 - l : l;
    const union = eu > el2 ? eu : el2;
    lower[p] = 255;
    lower[p + 1] = 255;
    lower[p + 2] = 255;
    lower[p + 3] = lowerInvert ? 255 - union : union;
  }
}
function offsetSelection(sel, dx, dy) {
  if (dx === 0 && dy === 0) return sel;
  return { rect: { ...sel.rect, x: sel.rect.x + dx, y: sel.rect.y + dy }, data: sel.data, outside: sel.outside };
}
function selectionHit(sel, x, y) {
  if (!sel || !Number.isFinite(x) || !Number.isFinite(y)) return false;
  return coverageAt(sel, Math.floor(x), Math.floor(y)) >= INSIDE_COVERAGE;
}
function recordSelectionMove(s, before, after, join) {
  if (selectionsEqual(before, after)) return;
  if (join) s.history.joinNext((entry) => entry.kind === "selection");
  s.history.push({ kind: "selection", before, after, bytes: selectionBytes(before) + selectionBytes(after) });
  s.events.emit("history", void 0);
}
function followSelection(s, dx, dy, gesture, move) {
  const sel = s.selection.current;
  if (!sel) return move();
  let before = sel;
  let unwrapped = false;
  const top = gesture ? s.history.mergeTarget() : void 0;
  if (top?.kind === "group" && top.entries.length === 2) {
    const [first, last] = top.entries;
    if (last.kind === "selection" && last.after === sel && hasGesture(first, gesture)) {
      s.history.discardNewest();
      s.history.push(first);
      before = last.before;
      unwrapped = true;
    }
  }
  const moved = move();
  const after = moved ? offsetSelection(sel, dx, dy) : sel;
  s.selection.set(after);
  if (moved || unwrapped) recordSelectionMove(s, before, after, true);
  return moved;
}
function hasGesture(entry, gesture) {
  return gesture !== void 0 && "gesture" in entry && entry.gesture === gesture;
}
class SelectionMoveOps {
  /**
   * @param s - Shared editor state.
   */
  constructor(s) {
    this.s = s;
  }
  s;
  start = null;
  /**
   * Whether a document point is inside the current selection (coverage >= 50 %).
   * @param x - Document x.
   * @param y - Document y.
   * @returns `true` if inside.
   */
  hit(x, y) {
    return selectionHit(this.s.selection.current, x, y);
  }
  /**
   * Start an outline drag (commits a floating selection first).
   * @returns `false` without a selection or while busy.
   */
  begin() {
    const s = this.s;
    if (s.loading || s.stroke.active) return false;
    s.settleFloat();
    if (!s.selection.current) return false;
    this.start = s.selection.current;
    return true;
  }
  /**
   * Show the outline at an offset from the drag start.
   * @param dx - Whole document px.
   * @param dy - Whole document px.
   */
  preview(dx, dy) {
    if (this.start) this.s.selection.set(offsetSelection(this.start, dx, dy));
  }
  /**
   * End the drag: one `selection` history entry (nothing if it did not move).
   * @returns `true` if the selection moved.
   */
  commit() {
    const start = this.start;
    this.start = null;
    if (!start) return false;
    const after = this.s.selection.current;
    if (after === start) return false;
    recordSelectionMove(this.s, start, after, false);
    return true;
  }
  /** Abort the drag: the outline goes back. */
  cancel() {
    if (this.start) this.s.selection.set(this.start);
    this.start = null;
  }
}
const NOTHING_TO_COPY_NOTE = "Nothing to copy.";
const PASTE_TRANSFORM_NOTE = "Paste is larger than the paint area -- placed in Free Transform. Commit to crop, Esc to cancel.";
class ClipboardOps {
  /**
   * @param s - Shared editor state.
   * @param layers - Layer commands (undoable insert + solo rule).
   * @param paintTargetOff - Turns Quick Mask off (`Editor.setPaintTarget("paint")`).
   * @param insertPlaced - `SourceInsertOps.insertPlaced` (oversized pastes).
   */
  constructor(s, layers2, paintTargetOff, insertPlaced) {
    this.s = s;
    this.layers = layers2;
    this.paintTargetOff = paintTargetOff;
    this.insertPlaced = insertPlaced;
  }
  s;
  layers;
  paintTargetOff;
  insertPlaced;
  /** Image px per document px (the frame map scale). */
  get imageScale() {
    return documentMap(this.s.doc, this.s.imageSize).scale;
  }
  /**
   * Ctrl+C / Ctrl+Shift+C.
   * @param merged - Copy what is visible (all layers + the image) instead of the current layer.
   * @returns Pixels, or `null` (note "Nothing to copy." when empty).
   */
  copy(merged) {
    const s = this.s;
    if (s.loading || s.stroke.active) return null;
    s.settleFloat();
    const layer = merged ? void 0 : this.editLayer();
    const block = layer ? editBlockNote(s, layer) : null;
    if (block && block !== LOCKED_LAYER_NOTE) {
      s.events.emit("note", block);
      return null;
    }
    const clip = merged ? this.copyMerged() : this.copyLayer(layer);
    if (!clip) s.events.emit("note", NOTHING_TO_COPY_NOTE);
    return clip;
  }
  /**
   * Ctrl+X: copy the current layer's selected pixels (whole content without
   * a selection) and clear them, as one undo step.
   * @returns The copied pixels, or `null` if nothing was cut.
   */
  cut() {
    const s = this.s;
    if (s.loading || s.stroke.active) return null;
    s.settleFloat();
    const layer = this.editLayer();
    if (!layer || preparePixelEdit(s, layer) === "blocked") return null;
    const area = this.layerArea(layer);
    const clip = area ? this.copyLayer(layer) : null;
    if (!clip || !area) {
      s.events.emit("note", NOTHING_TO_COPY_NOTE);
      return null;
    }
    this.clearArea(layer, area);
    return clip;
  }
  /**
   * Ctrl+V / drop: a new paint layer holding `source`.
   * @param source - Decoded image (ImageBitmap, canvas, ...).
   * @param size - Its pixel size.
   * @param docPerSource - Document px per source px (`1 / imageScale` for image px).
   * @param at - Centre point or top-left, document coords.
   * @returns What happened, or `null` (loading / nothing fits).
   */
  paste(source, size, docPerSource, at) {
    const s = this.s;
    if (s.loading || size.width <= 0 || size.height <= 0) return null;
    s.settleFloat();
    if (s.stroke.active) s.cancelStroke();
    const full = pasteRect(size, docPerSource, at);
    const { rect, cropped } = cropToCap(full, unionRect(boundsCap(s.doc.frame), s.store.bounds));
    if (cropped) return this.pasteInTransform(source, size, full);
    if (!rect) return null;
    const resampled = full.width !== size.width || full.height !== size.height;
    const surface = createSurface(rect.width, rect.height);
    surface.ctx.imageSmoothingEnabled = resampled;
    surface.ctx.imageSmoothingQuality = "high";
    surface.ctx.drawImage(source, full.x - rect.x, full.y - rect.y, full.width, full.height);
    const data = surface.ctx.getImageData(0, 0, rect.width, rect.height);
    releaseSurface(surface);
    const index = s.target === "mask" ? topPaintIndex(s.doc.layers) : paintInsertIndex(s.doc);
    if (s.target === "mask") this.paintTargetOff();
    const layer = createPaintLayer(pastedLayerName(s.doc.layers));
    const id = this.layers.addWithPixels(layer, index, { x: rect.x, y: rect.y, data });
    if (!id) return null;
    s.kept.keep(id, { pixels: data, area: { ...rect }, m: translation(rect.x, rect.y), revision: s.runtime.revision(id) });
    const sel = s.selection.current;
    if (sel) {
      s.selection.set(null);
      recordSelectionMove(s, sel, null, true);
    }
    return { layerId: id, name: layer.name, transform: false, resampled };
  }
  // ── Internals ───────────────────────────────────────────────────────────
  /** A paste reaching past the paint-area cap: new layer in Free Transform on the full image (crop on commit). */
  pasteInTransform(source, size, full) {
    const surface = createSurface(size.width, size.height);
    surface.ctx.drawImage(source, 0, 0);
    const pixels = surface.ctx.getImageData(0, 0, size.width, size.height);
    releaseSurface(surface);
    const name = pastedLayerName(this.s.doc.layers);
    const id = this.insertPlaced(pixels, name, full);
    if (!id) return null;
    this.s.events.emit("note", PASTE_TRANSFORM_NOTE);
    return { layerId: id, name, transform: true, resampled: full.width !== size.width || full.height !== size.height };
  }
  /** Layer copy/cut act on: the current mask under Quick Mask, else the active paint-like layer. */
  editLayer() {
    const s = this.s;
    return activeEditLayer(s.doc, s.target, s.currentMaskId);
  }
  /** Document area of a layer copy: the selection extent, or the content bbox. */
  layerArea(layer) {
    const s = this.s;
    const sel = s.selection.current;
    const area = sel ? selectionExtent(sel, s.store.bounds) : layerContentRect(s, layer.id);
    return isEmptyRect(area) ? null : area;
  }
  copyLayer(layer) {
    const s = this.s;
    if (!layer) return null;
    const area = this.layerArea(layer);
    const read = area ? s.store.read(layer.id, area) : null;
    if (!read) return null;
    const sel = s.selection.current;
    const coverage = sel ? coverageFor(sel, read.rect) : null;
    const px = read.data.data;
    const any = layer.kind === "mask" ? maskToGray(px, coverage) : applyCoverage(px, coverage);
    if (!any) return null;
    return layer.kind === "mask" ? this.clip(read.data, read.rect) : this.trimmed(read.data, read.rect);
  }
  copyMerged() {
    const s = this.s;
    const map = documentMap(s.doc, s.imageSize);
    const image = roundOutRect(imageRectToDoc(map, frameRect(s.imageSize)));
    const sel = s.selection.current;
    const area = sel ? selectionExtent(sel, unionRect(image, s.store.bounds)) : image;
    if (isEmptyRect(area)) return null;
    if (s.target === "mask") return this.copyMergedMasks(area);
    const data = readDocRegion(visibleScene(s), area);
    if (!data) return null;
    if (!applyCoverage(data.data, sel ? coverageFor(sel, area) : null)) return null;
    return this.trimmed(data, area);
  }
  /**
   * Copy merged with Quick Mask on: the union of the visible masks' effective
   * coverage (per-mask invert applied, like the MASK output) as opaque
   * grayscale -- the same format as a single-mask copy -- within the selection.
   */
  copyMergedMasks(area) {
    const s = this.s;
    const union = new Uint8Array(area.width * area.height);
    for (const layer of s.doc.layers) {
      if (layer.kind !== "mask" || !shownOnStage(layer, s.solo.current)) continue;
      const read = s.store.read(layer.id, area);
      unionMaskCoverage(union, area, read?.rect ?? null, read?.data.data ?? new Uint8ClampedArray(0), layer.invert === true);
    }
    const data = new ImageData(area.width, area.height);
    for (let i = 0; i < union.length; i++) data.data[i * 4 + 3] = union[i];
    const sel = s.selection.current;
    if (!maskToGray(data.data, sel ? coverageFor(sel, area) : null)) return null;
    return this.clip(data, area);
  }
  /** Crop to the non-transparent bbox. */
  trimmed(data, rect) {
    const local = alphaBounds(data.data, data.width, data.height);
    if (isEmptyRect(local)) return null;
    if (local.width === data.width && local.height === data.height) return this.clip(data, rect);
    const out = new ImageData(local.width, local.height);
    for (let y = 0; y < local.height; y++) {
      const src = ((local.y + y) * data.width + local.x) * 4;
      out.data.set(data.data.subarray(src, src + local.width * 4), y * local.width * 4);
    }
    return this.clip(out, { x: rect.x + local.x, y: rect.y + local.y, width: local.width, height: local.height });
  }
  clip(data, rect) {
    return { data, rect: { ...rect }, imageScale: this.imageScale };
  }
  /** Clear the selected (or all) pixels of `area` on a layer as one patch. */
  clearArea(layer, area) {
    const s = this.s;
    const before = s.store.read(layer.id, area);
    if (!before) return;
    const rect = intersectRect(before.rect, area);
    const sel = s.selection.current;
    const coverage = sel ? coverageFor(sel, rect) : new Uint8Array(rect.width * rect.height).fill(255);
    const next = new ImageData(new Uint8ClampedArray(before.data.data), before.data.width, before.data.height);
    eraseCoverage(next.data, { x: 0, y: 0, width: rect.width, height: rect.height }, coverage, rect.width);
    s.store.write(layer.id, rect.x, rect.y, next);
    const after = s.store.read(layer.id, rect);
    if (after) {
      const bytes = before.data.data.byteLength + after.data.data.byteLength;
      s.history.push({ kind: "patch", layerId: layer.id, x: rect.x, y: rect.y, before: before.data, after: after.data, bytes });
    }
    s.runtime.touch(layer.id);
    s.afterEdit();
  }
}
function topPaintIndex(layers2) {
  for (let i = layers2.length - 1; i >= 0; i--) if (isPaintLike(layers2[i])) return i + 1;
  const firstMask = layers2.findIndex((l) => l.kind === "mask");
  return firstMask >= 0 ? firstMask : layers2.length;
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
   *
   * A file whose size differs from `bounds` was saved before a bounds
   * growth, so its origin is unknown. A text layer is then re-rendered from
   * its `textData` (the source of truth; otherwise its first move would
   * jump by the growth) and marked dirty so a matching file is uploaded.
   * @param layerId - Layer id.
   * @param image - Decoded image (sized to `bounds`).
   */
  restoreLayerPixels(layerId, image) {
    const s = this.s;
    const layer = s.doc.layers.find((l) => l.id === layerId);
    const bounds = s.store.bounds;
    const size = imageSize(image);
    if (layer?.kind === "text" && layer.textData && (size.width !== bounds.width || size.height !== bounds.height)) {
      renderTextLayer(s, layer);
      s.runtime.touch(layerId);
      s.events.emit("render", void 0);
      return;
    }
    const surface = s.store.ensure(layerId);
    surface.ctx.clearRect(0, 0, surface.canvas.width, surface.canvas.height);
    surface.ctx.drawImage(image, 0, 0);
    s.runtime.bump(layerId);
    s.events.emit("render", void 0);
  }
  /**
   * A layer's file could not be restored. A text layer is re-rendered from
   * its `textData` (the source of truth) and marked dirty so a new file is
   * uploaded; any other layer stays empty with its `file` reference intact.
   * @param layerId - Layer id.
   * @returns `true` if the layer was recovered (text layer).
   */
  recoverMissingLayer(layerId) {
    const s = this.s;
    const layer = s.doc.layers.find((l) => l.id === layerId);
    if (layer?.kind !== "text" || !layer.textData) return false;
    renderTextLayer(s, layer);
    s.runtime.touch(layerId);
    s.events.emit("render", void 0);
    return true;
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
function imageSize(image) {
  if (typeof HTMLImageElement !== "undefined" && image instanceof HTMLImageElement) {
    return { width: image.naturalWidth, height: image.naturalHeight };
  }
  const sized = image;
  return {
    width: typeof sized.width === "number" ? sized.width : 0,
    height: typeof sized.height === "number" ? sized.height : 0
  };
}
const DEFAULT_HISTORY_BYTES = 256 * 1024 * 1024;
class HistoryStack {
  /**
   * @param maxBytes - Memory budget across both stacks.
   * @param combine - Builds one entry from two (older first) for {@link joinNext}.
   */
  constructor(maxBytes = DEFAULT_HISTORY_BYTES, combine) {
    this.maxBytes = maxBytes;
    this.combine = combine;
  }
  maxBytes;
  combine;
  undoStack = [];
  redoStack = [];
  total = 0;
  /** Pending {@link joinNext}: which next entry joins the newest one. */
  joining = null;
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
    const accept = this.joining;
    this.joining = null;
    const older = accept && this.combine && accept(entry) ? this.undoStack.pop() : void 0;
    if (older && this.combine) {
      this.total -= older.bytes;
      entry = this.combine(older, entry);
    }
    this.undoStack.push(entry);
    this.total += entry.bytes;
    return this.enforceCap();
  }
  /**
   * Make the next pushed entry part of the newest one (one undo step), if
   * `accept` approves it; any other push, undo, redo or clear drops the
   * request. Used when an edit needs a preparatory step (rasterizing a text
   * layer before painting on it).
   * @param accept - Which next entry may join (default: any).
   */
  joinNext(accept = () => true) {
    this.joining = this.undoStack.length > 0 && this.redoStack.length === 0 ? accept : null;
  }
  /**
   * Drop the newest undo entry without making it redoable (an operation that
   * turned out to be a no-op, e.g. a text layer committed empty).
   * @returns The dropped entry, or `null`.
   */
  discardNewest() {
    this.joining = null;
    const entry = this.undoStack.pop();
    if (!entry) return null;
    this.total -= entry.bytes;
    return entry;
  }
  /**
   * Fold `entry` and every undo entry newer than it into ONE step (via the
   * `combine` callback, oldest first). Used when an operation spans several
   * pushes (an inserted image: the layer add + the transform commit).
   * @param entry - Oldest entry of the step (must be on the undo side).
   * @returns `true` if entries were joined.
   */
  joinSince(entry) {
    const i = this.undoStack.indexOf(entry);
    const combine = this.combine;
    if (i < 0 || i === this.undoStack.length - 1 || !combine) return false;
    this.joining = null;
    const parts = this.undoStack.splice(i);
    this.undoStack.push(parts.reduce((older, newer) => combine(older, newer)));
    return true;
  }
  /** Drop the redo side (an undo that must not be redoable, e.g. a cancelled insert). */
  dropRedo() {
    for (const dropped of this.redoStack) this.total -= dropped.bytes;
    this.redoStack.length = 0;
  }
  /**
   * Move the newest entry to the redo stack.
   *
   * @returns The entry to revert, or `null` when there is nothing to undo.
   */
  undo() {
    this.joining = null;
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
    this.joining = null;
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
  /**
   * Split the history at the newest undo entry matching `isBarrier`.
   * @param isBarrier - Barrier test (e.g. a Clear step).
   * @returns The barrier (or `undefined`) and every entry the barrier does
   *   not cover: undo entries newer than it (all undo entries without one)
   *   plus the whole redo side.
   */
  since(isBarrier) {
    let i = this.undoStack.length - 1;
    for (; i >= 0; i--) {
      const entry = this.undoStack[i];
      if (entry !== void 0 && isBarrier(entry)) break;
    }
    return { barrier: i >= 0 ? this.undoStack[i] : void 0, newer: [...this.undoStack.slice(i + 1), ...this.redoStack] };
  }
  /**
   * Drop every undo entry newer than `entry` and the whole redo side;
   * `entry` becomes the newest step. No-op when `entry` is not on the undo side.
   * @param entry - Entry to keep as the newest.
   */
  truncateAfter(entry) {
    const i = this.undoStack.indexOf(entry);
    if (i < 0) return;
    this.joining = null;
    for (const dropped of [...this.undoStack.splice(i + 1), ...this.redoStack]) this.total -= dropped.bytes;
    this.redoStack.length = 0;
  }
  /** Drop everything. */
  clear() {
    this.joining = null;
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
const KEPT_ORIGINAL_BYTES = 128 * 1024 * 1024;
class KeptOriginals {
  /**
   * @param maxBytes - Memory cap (default {@link KEPT_ORIGINAL_BYTES}).
   */
  constructor(maxBytes = KEPT_ORIGINAL_BYTES) {
    this.maxBytes = maxBytes;
  }
  maxBytes;
  entries = /* @__PURE__ */ new Map();
  total = 0;
  /** Bytes held. */
  get bytes() {
    return this.total;
  }
  /** Number of entries. */
  get size() {
    return this.entries.size;
  }
  /**
   * Keep (replace) a layer's original, then enforce the cap (oldest first;
   * an entry larger than the whole cap is not kept at all).
   * @param layerId - Layer id.
   * @param entry - Original.
   */
  keep(layerId, entry) {
    this.drop(layerId);
    const bytes = entry.pixels.data.byteLength;
    if (bytes > this.maxBytes) return;
    this.entries.set(layerId, entry);
    this.total += bytes;
    for (const id of this.entries.keys()) {
      if (this.total <= this.maxBytes) break;
      this.drop(id);
    }
  }
  /**
   * A layer's original if still valid (dropped otherwise).
   * @param layerId - Layer id.
   * @param revision - The layer's current pixel revision.
   * @returns Entry, or `null`.
   */
  get(layerId, revision) {
    const entry = this.entries.get(layerId);
    if (!entry) return null;
    if (entry.revision === revision) return entry;
    this.drop(layerId);
    return null;
  }
  /**
   * Whether a layer has an entry (valid or not).
   * @param layerId - Layer id.
   * @returns `true` if held.
   */
  has(layerId) {
    return this.entries.has(layerId);
  }
  /**
   * Forget a layer's original.
   * @param layerId - Layer id.
   */
  drop(layerId) {
    const entry = this.entries.get(layerId);
    if (!entry) return;
    this.total -= entry.pixels.data.byteLength;
    this.entries.delete(layerId);
  }
  /**
   * Drop entries whose layer is gone.
   * @param alive - Ids of the document's layers.
   */
  prune(alive) {
    for (const id of [...this.entries.keys()]) if (!alive.has(id)) this.drop(id);
  }
  /** Drop everything. */
  clear() {
    this.entries.clear();
    this.total = 0;
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
   * The paint bounds changed size: a layer with content keeps its pixels at
   * the same document positions, but its saved file (sized to the old
   * bounds) no longer matches the manifest's `bounds`, so it must upload
   * again. Dirty + next version (an in-flight upload of the old size can't
   * mark it clean); the pixel revision is unchanged.
   * @param layerId - Layer id.
   */
  resized(layerId) {
    const rt = this.entries.get(layerId);
    if (!rt?.hasContent) return;
    rt.dirty = true;
    rt.version++;
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
   * Resample every layer once into new bounds (Match image resolution): old
   * document point `p` lands on `p * factor + (tx, ty)`, high-quality smoothing.
   * @param bounds - New bounds (new document coords).
   * @param factor - Scale, new px per old px.
   * @param tx - X shift, new document px.
   * @param ty - Y shift, new document px.
   */
  resample(bounds, factor, tx, ty) {
    const from = this.currentBounds;
    for (const [id, surface] of this.surfaces) {
      const next = createSurface(bounds.width, bounds.height);
      next.ctx.imageSmoothingEnabled = true;
      next.ctx.imageSmoothingQuality = "high";
      next.ctx.drawImage(
        surface.canvas,
        from.x * factor + tx - bounds.x,
        from.y * factor + ty - bounds.y,
        from.width * factor,
        from.height * factor
      );
      releaseSurface(surface);
      this.surfaces.set(id, next);
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
  if (!bounded && isUniform$1(data)) {
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
function isUniform$1(data) {
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
const MAX = 65535;
const TABLE_N = 1024;
const Q_FULL = 12;
const MIN_SPACING = 0.05;
class CoverageMask {
  /**
   * @param width - Bounds width, px.
   * @param height - Bounds height, px.
   */
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.data = new Uint16Array(Math.max(0, width * height));
  }
  width;
  height;
  data;
  /** `alpha x tip` and `-ln(1 - alpha x tip)` by squared distance over `[0, reach^2]`, for the current profile and flow. */
  p = null;
  q = null;
  tableKey = "";
  /**
   * Coverage at a pixel (tests / debugging).
   * @returns 0..1
   */
  at(x, y) {
    return (this.data[y * this.width + x] ?? 0) / MAX;
  }
  /**
   * Composite one segment's dabs over the coverage. A point segment is its
   * dab `a`; a run is dabs `1..intervals` along `a -> b` (dab 0 belongs to
   * the previous segment). Size and cap are interpolated from `a` to `b`;
   * flow is the segment's.
   * @param seg - Segment in document coords.
   * @param originX - Document x of mask pixel 0.
   * @param originY - Document y of mask pixel 0.
   * @param profile - Stamp profile of the stroke.
   */
  sweep(seg, originX, originY, profile) {
    const { a, b, intervals } = seg;
    const alpha = Math.min(1, Math.max(0, (a.alpha + b.alpha) / 2));
    if (alpha <= 0) return;
    this.tables(profile, alpha);
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (intervals === 0 || len < 1e-6) this.stamp(a.x - originX, a.y - originY, a.size / 2, a.cap, profile);
    else if (intervals === 1) this.stamp(b.x - originX, b.y - originY, b.size / 2, b.cap, profile);
    else this.run(seg, originX, originY, profile, len);
  }
  /** One dab (the common case on curves, where every pointer sample is its own short segment). */
  stamp(cx, cy, r, capRaw, profile) {
    const { data, width, height } = this;
    const p = this.p;
    const wk = TABLE_N / (profile.reach * profile.reach * r * r);
    const reach = r * profile.reach;
    const reach2 = reach * reach;
    const cap = Math.min(1, Math.max(0, capRaw)) * MAX;
    const y0 = Math.max(0, Math.floor(cy - reach));
    const y1 = Math.min(height - 1, Math.ceil(cy + reach));
    for (let y = y0; y <= y1; y++) {
      const py = y + 0.5 - cy;
      const h2 = reach2 - py * py;
      if (h2 <= 0) continue;
      const h = Math.sqrt(h2);
      const xs = Math.max(0, Math.floor(cx - h - 0.5));
      const xe = Math.min(width - 1, Math.ceil(cx + h - 0.5));
      const row = y * width;
      for (let x = xs; x <= xe; x++) {
        const i = row + x;
        const c = data[i];
        if (c >= MAX) continue;
        const px = x + 0.5 - cx;
        const w = (px * px + py * py) * wk;
        if (w >= TABLE_N) continue;
        const iw = w | 0;
        const added = p[iw] + (p[iw + 1] - p[iw]) * (w - iw);
        if (added <= 0) continue;
        let next = c + (MAX - c) * added;
        if (next > cap) next = c > cap ? c : cap;
        data[i] = next + 0.5 | 0;
      }
    }
  }
  /** A run of dabs `1..intervals` from `a` to `b`, summed per pixel as `q` (see the module doc). */
  run(seg, originX, originY, profile, len) {
    const { data, width, height } = this;
    const { a, b, intervals } = seg;
    const q = this.q;
    const wScale = TABLE_N / (profile.reach * profile.reach);
    const ax = a.x - originX;
    const ay = a.y - originY;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const ux = dx / len;
    const uy = dy / len;
    const step = len / intervals;
    const ra = a.size / 2;
    const rb = b.size / 2;
    const reachMax = Math.max(ra, rb) * profile.reach;
    const reach2 = reachMax * reachMax;
    const capA = Math.min(1, Math.max(0, a.cap));
    const capB = Math.min(1, Math.max(0, b.cap));
    const m = Math.max(1, Math.ceil(MIN_SPACING * (ra + rb) / step));
    const rem = intervals % m;
    const remCentre = intervals - (rem - 1) / 2;
    const wA = wScale / (ra * ra);
    const wB = wScale / (rb * rb);
    const wConst = ra === rb;
    const x0 = Math.max(0, Math.floor(Math.min(ax, ax + dx) - reachMax));
    const y0 = Math.max(0, Math.floor(Math.min(ay, ay + dy) - reachMax));
    const x1 = Math.min(width - 1, Math.ceil(Math.max(ax, ax + dx) + reachMax));
    const y1 = Math.min(height - 1, Math.ceil(Math.max(ay, ay + dy) + reachMax));
    const nx = -uy * reachMax;
    const ny = ux * reachMax;
    for (let y = y0; y <= y1; y++) {
      const py = y + 0.5 - ay;
      const row = y * width;
      let xl = Infinity;
      let xr = -Infinity;
      let h2 = reach2 - py * py;
      if (h2 >= 0) {
        const h = Math.sqrt(h2);
        xl = -h;
        xr = h;
      }
      const pyb = py - dy;
      h2 = reach2 - pyb * pyb;
      if (h2 >= 0) {
        const h = Math.sqrt(h2);
        if (dx - h < xl) xl = dx - h;
        if (dx + h > xr) xr = dx + h;
      }
      if (uy !== 0) {
        const t1 = (py - ny) / uy;
        if (t1 >= 0 && t1 <= len) {
          const xe2 = t1 * ux + nx;
          if (xe2 < xl) xl = xe2;
          if (xe2 > xr) xr = xe2;
        }
        const t2 = (py + ny) / uy;
        if (t2 >= 0 && t2 <= len) {
          const xe2 = t2 * ux - nx;
          if (xe2 < xl) xl = xe2;
          if (xe2 > xr) xr = xe2;
        }
      }
      if (xl > xr) continue;
      const xs = Math.max(x0, Math.floor(xl + ax - 0.5));
      const xe = Math.min(x1, Math.ceil(xr + ax - 0.5));
      for (let x = xs; x <= xe; x++) {
        const i = row + x;
        const c = data[i];
        if (c >= MAX) continue;
        const px = x + 0.5 - ax;
        const s = px * ux + py * uy;
        const along = s < 0 ? 0 : s > len ? len : s;
        const ox = px - ux * along;
        const oy = py - uy * along;
        const d2 = ox * ox + oy * oy;
        if (d2 >= reach2) continue;
        const perp = px * uy - py * ux;
        const p2 = perp * perp;
        const half = Math.sqrt(reach2 - p2);
        let k0 = Math.ceil((s - half) / step);
        let k1 = Math.floor((s + half) / step);
        if (k0 < 1) k0 = 1;
        if (k1 > intervals) k1 = intervals;
        const kStart = k0 + (m - k0 % m) % m;
        const shift = (m - 1) / 2;
        let sum = 0;
        for (let k = kStart; k <= k1; k += m) {
          const e = s - (k - shift) * step;
          let wk = wA;
          if (!wConst) {
            const rk = ra + (rb - ra) * (k / intervals);
            wk = wScale / (rk * rk);
          }
          const w = (p2 + e * e) * wk;
          if (w >= TABLE_N) continue;
          const iw = w | 0;
          sum += m * (q[iw] + (q[iw + 1] - q[iw]) * (w - iw));
          if (sum >= Q_FULL) break;
        }
        if (rem !== 0 && sum < Q_FULL && intervals >= k0 && intervals <= k1) {
          const e = s - remCentre * step;
          const w = (p2 + e * e) * wB;
          if (w < TABLE_N) {
            const iw = w | 0;
            sum += rem * (q[iw] + (q[iw + 1] - q[iw]) * (w - iw));
          }
        }
        if (sum <= 0) continue;
        const added = sum >= Q_FULL ? 1 : 1 - Math.exp(-sum);
        let next = c + (MAX - c) * added;
        const cap = (capA + (capB - capA) * (along / len)) * MAX;
        if (next > cap) next = c > cap ? c : cap;
        data[i] = next + 0.5 | 0;
      }
    }
  }
  /**
   * Zero an area (end of a stroke).
   * @param rect - Mask px.
   */
  clear(rect) {
    const r = this.clampRect(rect);
    for (let y = r.y; y < r.y + r.height; y++) {
      const from = y * this.width + r.x;
      this.data.fill(0, from, from + r.width);
    }
  }
  /**
   * Write an area as straight-alpha RGBA (one colour, alpha = coverage).
   * @param rect - Mask px (clamped to the mask).
   * @param rgb - Colour.
   * @param out - `rect.width * rect.height * 4` bytes.
   */
  writeRgba(rect, rgb, out) {
    for (let y = 0; y < rect.height; y++) {
      const src = (rect.y + y) * this.width + rect.x;
      let p = y * rect.width * 4;
      for (let x = 0; x < rect.width; x++, p += 4) {
        out[p] = rgb.r;
        out[p + 1] = rgb.g;
        out[p + 2] = rgb.b;
        out[p + 3] = this.data[src + x] * 255 / MAX + 0.5;
      }
    }
  }
  /**
   * A copy re-based onto new bounds (bounds grew mid-stroke; pixels keep
   * their document positions).
   * @param from - Current bounds (document).
   * @param to - New bounds (document).
   * @returns New mask.
   */
  rebased(from, to) {
    const next = new CoverageMask(to.width, to.height);
    const ox = from.x - to.x;
    const oy = from.y - to.y;
    for (let y = 0; y < this.height; y++) {
      const ty = y + oy;
      if (ty < 0 || ty >= to.height) continue;
      const sx0 = Math.max(0, -ox);
      const sx1 = Math.min(this.width, to.width - ox);
      if (sx1 <= sx0) continue;
      const from2 = y * this.width;
      const at = ty * to.width + sx0 + ox;
      next.data.set(this.data.subarray(from2 + sx0, from2 + sx1), at);
    }
    return next;
  }
  /** Build `p = alpha x tip` and `q = -ln(1 - p)` by squared distance over `[0, reach^2]` (cached for the stroke). */
  tables(profile, alpha) {
    const key = `${profile.core}|${profile.fade}|${alpha}`;
    if (this.q && this.tableKey === key) return;
    const p = new Float32Array(TABLE_N + 2);
    const q = new Float32Array(TABLE_N + 2);
    for (let i = 0; i < TABLE_N; i++) {
      const u = Math.sqrt(i / TABLE_N) * profile.reach;
      p[i] = alpha * stampAlpha(u, profile);
      q[i] = -Math.log(Math.max(1e-6, 1 - p[i]));
    }
    this.p = p;
    this.q = q;
    this.tableKey = key;
  }
  clampRect(rect) {
    const x = Math.max(0, rect.x);
    const y = Math.max(0, rect.y);
    return {
      x,
      y,
      width: Math.max(0, Math.min(this.width, rect.x + rect.width) - x),
      height: Math.max(0, Math.min(this.height, rect.y + rect.height) - y)
    };
  }
}
const MERGE_TOLERANCE = 0.35;
function canMerge(pts, i, j) {
  const a = pts[i];
  const b = pts[j];
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len > 2 * Math.max(4, a.size, b.size)) return false;
  if (len < 1e-6) return false;
  for (let k = i + 1; k < j; k++) {
    const p = pts[k];
    const rx = p.x - a.x;
    const ry = p.y - a.y;
    if (Math.abs(rx * dy - ry * dx) / len > MERGE_TOLERANCE) return false;
    if (Math.abs((rx * dx + ry * dy) / len - len * (k - i) / (j - i)) > MERGE_TOLERANCE) return false;
  }
  return true;
}
function planSegments(prev, dabs) {
  const out = [];
  const pts = prev ? [prev, ...dabs] : [...dabs];
  if (!prev && pts[0]) out.push({ a: pts[0], b: pts[0], intervals: 0 });
  let i = 0;
  while (i < pts.length - 1) {
    const start = pts[i];
    let j = i + 1;
    while (j + 1 < pts.length && canMerge(pts, i, j + 1)) j++;
    const end = pts[j];
    if (Math.hypot(end.x - start.x, end.y - start.y) < 1e-6) out.push({ a: end, b: end, intervals: 0 });
    else out.push({ a: start, b: end, intervals: j - i });
    i = j;
  }
  return out;
}
function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  const body = m?.[1];
  if (!body) return { r: 0, g: 0, b: 0 };
  const full = body.length === 3 ? [...body].map((c) => c + c).join("") : body;
  const n = parseInt(full, 16);
  return { r: n >> 16 & 255, g: n >> 8 & 255, b: n & 255 };
}
function rgbToHex(rgb) {
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
function blendCoverageBehind(dst, rect, coverage, coverageWidth, color, opacity) {
  const k = Math.min(1, Math.max(0, opacity)) / 255;
  if (k <= 0) return;
  for (let y = 0; y < rect.height; y++) {
    const row = (rect.y + y) * coverageWidth + rect.x;
    for (let x = 0; x < rect.width; x++) {
      const c = coverage[row + x];
      if (c === 0) continue;
      const p = (y * rect.width + x) * 4;
      const da = dst[p + 3] / 255;
      const add = c * k * (1 - da);
      const oa = da + add;
      if (oa <= 0) continue;
      dst[p] = (dst[p] * da + color.r * add) / oa;
      dst[p + 1] = (dst[p + 1] * da + color.g * add) / oa;
      dst[p + 2] = (dst[p + 2] * da + color.b * add) / oa;
      dst[p + 3] = oa * 255;
    }
  }
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
  /** Dab coverage (bounds-sized, created by the first dab stroke). */
  mask = null;
  /** Document rect of coverage not yet written into the buffer canvas. */
  maskDirty = EMPTY;
  /** Last dab of the stroke so far (the next batch's segments start there). */
  lastDab = null;
  /** Stamp profile of the current stroke (hardness, largest radius). */
  profile = stampProfile(0, 1);
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
  /** Stamp extent as a multiple of the radius for the current stroke ({@link StampProfile.reach}). */
  get reach() {
    return this.profile.reach;
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
   * @param maxDiameter - Largest dab diameter this stroke can produce, px
   *   (sets the stamp profile's 1 px minimum fade).
   */
  begin(layer, bounds, style, maxDiameter = 1) {
    this.ensureSize(bounds);
    this.style = style;
    this.profile = stampProfile(style.hardness, Math.max(1, maxDiameter / 2));
    this.lastDab = null;
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
    if (this.mask) this.mask = this.mask.rebased(this.bounds, bounds);
    this.bounds = { ...bounds };
  }
  /**
   * Add dabs to the stroke coverage (written to the buffer on the next
   * preview / commit).
   * @param dabs - Dabs in document coords.
   */
  addDabs(dabs) {
    if (!this.style || dabs.length === 0) return;
    this.surfaces();
    const { width, height, x, y } = this.bounds;
    if (!this.mask || this.mask.width !== width || this.mask.height !== height) this.mask = new CoverageMask(width, height);
    for (const seg of planSegments(this.lastDab, dabs)) this.mask.sweep(seg, x, y, this.profile);
    const touchedDabs = this.lastDab ? [this.lastDab, ...dabs] : dabs;
    this.lastDab = dabs[dabs.length - 1] ?? this.lastDab;
    for (const dab of touchedDabs) {
      const rect = dabBounds(dab, this.reach);
      this.strokeRect = unionRect(this.strokeRect, rect);
      this.pendingPreview = unionRect(this.pendingPreview, rect);
      this.maskDirty = unionRect(this.maskDirty, rect);
    }
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
    this.flushMask();
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
    this.flushMask();
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
    this.mask = null;
    this.style = null;
  }
  // ── Internals ───────────────────────────────────────────────────────────
  compositeBuffer(ctx, buffer, x, y, width, height) {
    if (!this.style) return;
    const source = this.sourceFor(buffer, x, y, width, height);
    ctx.save();
    ctx.globalAlpha = this.style.opacity;
    ctx.globalCompositeOperation = this.style.mode === "erase" ? "destination-out" : "source-over";
    ctx.drawImage(source, x, y, width, height, x, y, width, height);
    ctx.restore();
  }
  /** Write pending dab coverage into the buffer canvas (stroke colour, alpha = coverage). */
  flushMask() {
    const r = intersectRect(roundOutRect(this.maskDirty), this.bounds);
    this.maskDirty = EMPTY;
    if (!this.mask || !this.style || !this.buffer || isEmptyRect(r)) return;
    const local = { x: r.x - this.bounds.x, y: r.y - this.bounds.y, width: r.width, height: r.height };
    const image = new ImageData(local.width, local.height);
    const rgb = this.style.mode === "erase" ? { r: 0, g: 0, b: 0 } : hexToRgb(this.style.color);
    this.mask.writeRgba(local, rgb, image.data);
    this.buffer.ctx.putImageData(image, local.x, local.y);
  }
  /** The buffer region multiplied by the selection clip (or the buffer itself without one). */
  sourceFor(buffer, x, y, width, height) {
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
    if (!isEmptyRect(r)) {
      const local = { x: r.x - this.bounds.x, y: r.y - this.bounds.y, width: r.width, height: r.height };
      if (this.buffer) this.buffer.ctx.clearRect(local.x, local.y, local.width, local.height);
      if (this.mask) this.mask.clear(local);
    }
    this.maskDirty = EMPTY;
    this.lastDab = null;
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
class ViewState {
  /**
   * @param onChange - Called after every user view command (fit, 100%, zoom,
   *   pan) so the owner can repaint; never called from {@link setStage} /
   *   {@link setFrame}, which run inside a render.
   */
  constructor(onChange = () => {
  }) {
    this.onChange = onChange;
  }
  onChange;
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
  /** Stage CSS size the current transform was computed for. */
  get stageSize() {
    return { ...this.stage };
  }
  /** On-screen CSS pixels per image pixel (includes graph zoom). */
  get screenScale() {
    return this.transform.scale * this.displayScale;
  }
  /** On-screen CSS pixels per local stage pixel. */
  get graphScale() {
    return this.displayScale;
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
    this.onChange();
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
    this.onChange();
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
  /** View commands (Fit, Ctrl+0/1, zoom, pan) emit `render` themselves, whoever calls them. */
  view = new ViewState(() => this.events.emit("render", void 0));
  history = new HistoryStack(DEFAULT_HISTORY_BYTES, groupEntries);
  stroke = new StrokeBuffer();
  runtime = new LayerRuntimeTable();
  store;
  /** Pre-transform originals per layer (M11b, memory only; `keptOriginal.ts`). */
  kept = new KeptOriginals();
  /** Current selection (session state, not saved); strokes are clipped to it. */
  selection = new SelectionState(() => this.events.emit("selection", void 0));
  /** Solo (M8, view only; not saved/undoable, ignored by outputs). */
  solo = new SoloState(() => {
    this.events.emit("solo", void 0);
    this.events.emit("render", void 0);
  });
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
  /**
   * Current mask (M8): the last selected mask row, what Quick Mask paints
   * into (UI state, not saved). `null` or a deleted id = the top-most mask.
   */
  currentMaskId = null;
  /** Selected output row/region (session-only). */
  selectedRegionId = null;
  /** Layer the current stroke paints into. */
  strokeLayerId = null;
  /** Largest dab diameter of the current stroke, document px. */
  strokeDiameter = 1;
  /** Where the previous stroke ended, document coords. */
  lastStrokeEnd = null;
  /**
   * Move-tool drag in progress: the layer is drawn offset by (dx, dy)
   * document px; pixels move only on commit (`moveOps.ts`).
   */
  movePreview = null;
  /**
   * Asks the user whether a text layer may be rasterized (`rasterize.ts`);
   * the UI installs a `window.confirm` (the engine has no DOM UI). Default: no.
   */
  confirmRasterize = () => false;
  /**
   * Commit a floating selection, if any (`floatOps.ts` installs it). Called
   * before every other edit / history action -- the float's central hook.
   */
  settleFloat = () => void 0;
  /** Commit an open text edit, if any (`textOps.ts` installs it; Free Transform calls it first). */
  commitTextEdit = () => void 0;
  /**
   * Live display of a layer with its floating selection (hole + float at
   * its offset), or `null` when the layer has no float (`floatOps.ts`).
   */
  floatPreview = () => null;
  /**
   * Style of a mask layer added lazily ({@link ensureMask}); the session
   * installs one that reads the user's settings. Default: built-in red, 50 %.
   */
  maskStyle = () => DEFAULT_MASK_STYLE;
  /**
   * @param doc - Document (copied).
   * @param source - Origin of its frame size.
   * @param store - Existing pixels (for clones); a blank store is created otherwise.
   */
  constructor(doc, source, store2) {
    this.doc = cloneDocument(doc);
    this.frameSource = source;
    this.store = store2 ?? new LayerStore(doc.bounds);
    for (const layer of doc.layers) {
      this.store.ensure(layer.id);
      this.runtime.reset(layer.id, layer.file !== null);
    }
    this.stroke.setClip(() => this.selection.clipCanvas(this.store.bounds));
    this.syncViewFrame();
    this.events.on("layers", () => this.solo.set(pruneSolo(this.solo.current, this.doc.layers)));
    this.events.on("layers", () => this.kept.prune(new Set(this.doc.layers.map((l) => l.id))));
    this.events.on("change", () => {
      for (const layer of this.doc.layers) if (this.kept.has(layer.id)) this.kept.get(layer.id, this.runtime.revision(layer.id));
    });
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
  /**
   * The document may adopt a new frame: no paint or text, and no history
   * step since the newest Clear (or ever) other than selection changes.
   * Output metadata edits (regions, Main options) count as content, like
   * `hasDocumentContent`; Clear resets them.
   */
  get isEmpty() {
    if (this.runtime.hasPaint || this.doc.layers.some((l) => l.kind === "text")) return false;
    return this.history.since((e) => e.kind === "clear").newer.every((e) => e.kind === "selection");
  }
  /** The view fits the image, not the document frame. */
  syncViewFrame() {
    this.view.setFrame(this.imageSize);
  }
  /**
   * Grow bounds to cover `need`. Chunked + capped for strokes; exact and
   * uncapped when re-applying history. Every layer with content is marked
   * for re-upload: layer files are sized to `bounds`, and a file saved at
   * the old bounds would be restored at the wrong origin.
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
      for (const layer of this.doc.layers) this.runtime.resized(layer.id);
    }
  }
  /**
   * The current mask layer, adding a default one (not dirty, no history)
   * when the document has none -- documents saved before M2 get one lazily.
   * @returns The mask layer.
   */
  ensureMask() {
    const { layer, created } = ensureMaskLayer(this.doc, this.maskStyle, this.currentMaskId);
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
function captureOutputs(s) {
  const snapshot = { regions: s.doc.regions.map(cloneRegion), selected: s.selectedRegionId };
  if (s.doc.mainOutput) snapshot.main = cloneOutputOptions(s.doc.mainOutput);
  return snapshot;
}
function applyOutputs(s, value) {
  s.doc.regions = value?.regions.map(cloneRegion) ?? [];
  if (value?.main) s.doc.mainOutput = cloneOutputOptions(value.main);
  else delete s.doc.mainOutput;
  s.selectedRegionId = value?.selected ?? null;
  s.events.emit("outputs", void 0);
}
function outputsKey(value) {
  return JSON.stringify({ regions: value.regions, main: cloneOutputOptions(value.main) });
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
  setBackground(background, imageSize2) {
    const before = this.s.imageSize;
    this.s.background = background;
    this.s.backgroundSize = imageSize2 ? { ...imageSize2 } : null;
    this.s.syncViewFrame();
    const after = this.s.imageSize;
    if (before.width !== after.width || before.height !== after.height) this.s.events.emit("outputs", void 0);
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
    const target = minimumFrame(size);
    if (target.width === frame.width && target.height === frame.height) {
      s.frameSource = source;
      return;
    }
    if (s.isEmpty) this.adoptFrame(size, source);
  }
  /**
   * Replace the frame of an empty document (no history).
   * @param size - Image size; the frame is its {@link minimumFrame}.
   * @param source - Origin of the size.
   */
  adoptFrame(size, source) {
    const s = this.s;
    if (s.stroke.active) s.cancelStroke();
    const frame = minimumFrame(size);
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
    this.rebaseHistory(frame, source);
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
    const frame = minimumFrame(size);
    const source = !s.backgroundSize ? s.frameSource : s.background.kind === "image" ? "image" : "widgets";
    const before = this.captureSnapshot();
    const after = { frame, bounds: frameRect(frame), source, pixels: null };
    this.applySnapshot(after);
    s.solo.clear();
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
    applyOutputs(s, state.outputs);
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
      const textData = state.text?.get(layer.id);
      if (textData) {
        layer.kind = "text";
        layer.textData = textData;
      } else if (layer.kind === "text") {
        layer.kind = "paint";
        delete layer.textData;
      }
      s.runtime.touch(layer.id);
      const rt = s.runtime.get(layer.id);
      if (rt) rt.hasContent = data !== void 0 || textData !== void 0;
    }
    s.syncViewFrame();
    s.events.emit("placement", void 0);
    s.events.emit("layers", void 0);
  }
  /**
   * History after adopting `frame`: without a Clear step it is dropped (a
   * fresh document). With one, the Clear stays undoable (its `before` holds
   * the old frame, bounds and placement); only the selection steps after it
   * (stale coords) are dropped, and its `after` moves to the adopted frame
   * so redo returns the cleared document as last seen.
   */
  rebaseHistory(frame, source) {
    const s = this.s;
    const { barrier } = s.history.since((e) => e.kind === "clear");
    if (barrier?.kind !== "clear") {
      s.history.clear();
      return;
    }
    s.history.truncateAfter(barrier);
    barrier.after = { ...barrier.after, frame: { ...frame }, bounds: frameRect(frame), source };
    s.events.emit("history", void 0);
  }
  captureSnapshot() {
    const s = this.s;
    const pixels = /* @__PURE__ */ new Map();
    const text = /* @__PURE__ */ new Map();
    for (const layer of s.doc.layers) {
      pixels.set(layer.id, s.store.snapshot(layer.id));
      if (layer.kind === "text" && layer.textData) text.set(layer.id, layer.textData);
    }
    const placement = s.doc.placement ? { ...s.doc.placement } : void 0;
    return { frame: { ...s.doc.frame }, bounds: s.store.bounds, source: s.frameSource, ...placement ? { placement } : {}, pixels, text, outputs: captureOutputs(s) };
  }
}
function snapshotBytes(state) {
  let bytes = state.outputs ? outputsKey(state.outputs).length * 2 : 0;
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
      if (layer.kind === "mask" || !shownOnStage(layer, s.solo.current)) continue;
      const surface = s.store.ensure(layer.id);
      const source = s.floatPreview(layer.id) ?? (s.strokeLayerId === layer.id && s.stroke.active ? s.stroke.updatePreview(surface).canvas : surface.canvas);
      const offset = this.moveOffset(layer.id);
      out.push(offset ? { source, opacity: layer.opacity, offset } : { source, opacity: layer.opacity });
    }
    return out;
  }
  /** Move-tool drag offset of a layer (document px), or `undefined`. */
  moveOffset(layerId) {
    const p = this.s.movePreview;
    return p && p.layerId === layerId && (p.dx !== 0 || p.dy !== 0) ? { x: p.dx, y: p.dy } : void 0;
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
      if (layer.kind !== "mask" || !shownOnStage(layer, s.solo.current)) continue;
      const surface = s.store.ensure(layer.id);
      const stroking = s.strokeLayerId === layer.id && s.stroke.active;
      const source = s.floatPreview(layer.id) ?? (stroking ? s.stroke.updatePreview(surface).canvas : surface.canvas);
      let tint = this.tints.get(layer.id);
      if (!tint) {
        tint = new MaskTint();
        this.tints.set(layer.id, tint);
      }
      const color = maskDisplayColor(layer);
      const invert2 = layer.invert === true;
      const key = { bounds, color, invert: invert2, revision: s.runtime.revision(layer.id) };
      const canvas = tint.update(source, key, stroking ? s.stroke.lastRefreshed : null);
      const offset = this.moveOffset(layer.id);
      out.push({ tint: canvas, color, opacity: layer.opacity, invert: invert2, ...offset ? { offset } : {} });
    }
    return out;
  }
  /** Release the tint caches. */
  dispose() {
    for (const tint of this.tints.values()) tint.dispose();
    this.tints.clear();
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
  const empty2 = { x: 0, y: 0, width: 0, height: 0 };
  if (!isDrawableShape(shape)) return empty2;
  if (shape.kind === "line") {
    const geo = lineGeometry(shape);
    if (!geo) return empty2;
    let r = empty2;
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
    if (appeared) {
      installLayerPixels(s, change.layer.id, change.pixels);
      const layer = s.doc.layers.find((l) => l.id === change.layer.id);
      if (!change.pixels && layer?.kind === "text") {
        renderTextLayer(s, layer);
        s.runtime.touch(layer.id);
      }
    } else {
      s.runtime.remove(change.layer.id);
    }
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
function sameBytes(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
class PaintOps {
  /**
   * @param s - Shared editor state.
   * @param frames - Frame operations (Clear snapshots for undo).
   */
  constructor(s, frames) {
    this.s = s;
    this.frames = frames;
  }
  s;
  frames;
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
    if (preparePixelEdit(s, layer) !== "proceed") return false;
    const strokeStyle = layer.kind === "mask" ? { ...style, color: MASK_STROKE_COLOR } : style;
    s.strokeLayerId = layer.id;
    s.strokeDiameter = Math.max(1, maxDiameter);
    s.stroke.begin(s.store.ensure(layer.id), s.store.bounds, strokeStyle, s.strokeDiameter);
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
      const r = dab.size / 2 * s.stroke.reach + 2;
      need = unionRect(need, { x: dab.x - r, y: dab.y - r, width: r * 2, height: r * 2 });
    }
    this.growFor(need);
    s.stroke.addDabs(dabs);
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
    this.growFor(need);
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
    const sel = s.selection.current;
    const rect = sel ? intersectRect(s.stroke.touched, selectionExtent(sel, s.store.bounds)) : s.stroke.touched;
    const surface = s.store.ensure(layerId);
    if (isEmptyRect(rect)) {
      s.stroke.cancel();
    } else {
      const before = s.store.read(layerId, rect);
      s.stroke.commit(surface);
      const after = s.store.read(layerId, rect);
      if (before && after && !sameBytes(before.data.data, after.data.data)) {
        const bytes = before.data.data.byteLength + after.data.data.byteLength;
        s.history.push({ kind: "patch", layerId, x: before.rect.x, y: before.rect.y, before: before.data, after: after.data, bytes });
        s.runtime.touch(layerId);
      }
    }
    s.strokeLayerId = null;
    if (end) s.lastStrokeEnd = { ...end };
    s.afterEdit();
  }
  /**
   * Grow bounds for a stroke's need rect, limited to where the selection can
   * let paint through: a normal selection's bbox; an inverted one
   * (`outside` > 0) covers everything outside its rect, so no limit.
   */
  growFor(need) {
    const s = this.s;
    const sel = s.selection.current;
    const area = sel && !sel.outside ? intersectRect(need, sel.rect) : need;
    if (!isEmptyRect(area)) s.ensureBounds(area, true);
  }
  // ── Undo / redo ─────────────────────────────────────────────────────────
  /** Undo the last operation (no-op while stroking; cancels a Move drag preview). */
  undo() {
    const s = this.s;
    if (!s.history.canUndo || s.stroke.active) return;
    s.movePreview = null;
    const entry = s.history.undo();
    if (entry) this.applyEntry(entry, "before");
    s.afterEdit();
  }
  /** Redo the last undone operation (no-op while stroking; cancels a Move drag preview). */
  redo() {
    const s = this.s;
    if (!s.history.canRedo || s.stroke.active) return;
    s.movePreview = null;
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
    if (entry.kind === "outputs") {
      applyOutputs(s, entry[side]);
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
    if (entry.kind === "translate") {
      applyTranslateEntry(s, entry, side === "after");
      return;
    }
    if (entry.kind === "text") {
      applyTextEntry(s, entry, side === "after");
      return;
    }
    if (entry.kind === "group") {
      const parts = side === "after" ? entry.entries : [...entry.entries].reverse();
      for (const part of parts) this.applyEntry(part, side);
      return;
    }
    if (!s.doc.layers.some((l) => l.id === entry.layerId)) return;
    const data = side === "before" ? entry.before : entry.after;
    s.ensureBounds({ x: entry.x, y: entry.y, width: data.width, height: data.height }, false);
    s.store.write(entry.layerId, entry.x, entry.y, data);
    s.runtime.touch(entry.layerId);
  }
}
class EditorBase {
  events;
  view;
  /** FG/BG colours (session-scoped, not saved). */
  colors;
  s;
  frames;
  paint;
  io;
  display;
  /**
   * @param doc - Document (copied).
   * @param source - Origin of its frame size.
   * @param store - Existing pixels (for clones); a blank store is created otherwise.
   * @param colors - Colour state to start from (forks copy their source's).
   */
  constructor(doc, source, store2, colors) {
    this.s = new EditorState(doc, source, store2);
    this.events = this.s.events;
    this.view = this.s.view;
    this.colors = new ColorState(colors?.current);
    this.frames = new FrameOps(this.s);
    this.paint = new PaintOps(this.s, this.frames);
    this.io = new DocIO(this.s, (size) => this.frames.handleBackgroundSize(size));
    this.display = new LayerDisplay(this.s);
  }
  // ── Background / frame ──────────────────────────────────────────────────
  /**
   * Set what is drawn under the paint; layer pixels are untouched.
   * @param background - Image or fill.
   * @param imageSize - Current image size: the image's natural size, or the
   *   `width` x `height` widgets for a fill; `null` = show `doc.frame`.
   */
  setBackground(background, imageSize2) {
    this.frames.setBackground(background, imageSize2);
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
   * A layer file failed to restore: re-render a text layer from `textData`
   * (marked dirty); other layers stay empty with their `file` kept.
   * @param layerId - Layer id.
   * @returns `true` if the layer was recovered.
   */
  recoverMissingLayer(layerId) {
    return this.io.recoverMissingLayer(layerId);
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
}
function findLayer(s, layerId) {
  return s.doc.layers.find((l) => l.id === layerId);
}
function readyCheck(s) {
  if (s.loading) return false;
  s.settleFloat();
  if (s.stroke.active) s.cancelStroke();
  return true;
}
function insertLayer(s, layer, index, pixels, activate = true) {
  const activeBefore = s.doc.activeLayerId;
  s.doc.layers.splice(index, 0, layer);
  installLayerPixels(s, layer.id, pixels);
  if (activate) s.doc.activeLayerId = layer.id;
  recordLayerChange(s, [{ op: "insert", index, layer: { ...layer }, pixels }], activeBefore);
}
function setLayerProps(s, layerId, props, gesture) {
  const layer = findLayer(s, layerId);
  if (!layer || s.loading || !propsDiffer(layer, props)) return false;
  s.settleFloat();
  const merge = gesture ? s.history.mergeTarget() : void 0;
  const change = merge?.kind === "layers" && merge.gesture === gesture ? merge.changes[0] : void 0;
  if (change?.op === "props" && change.id === layerId && sameKeys(change.after, props)) {
    Object.assign(change.after, props);
    writeProps(layer, props);
    if (merge?.kind === "layers" && merge.changes.length === 1 && propsEqual(change.before, change.after)) {
      s.history.discardNewest();
    }
    afterMetaChange(s, true);
    return true;
  }
  const before = readProps(layer, props);
  writeProps(layer, props);
  recordLayerChange(s, [{ op: "props", id: layerId, before, after: { ...props } }], s.doc.activeLayerId, gesture);
  return true;
}
function recordLayerChange(s, changes, activeBefore, gesture) {
  s.history.push({
    kind: "layers",
    changes,
    activeBefore,
    activeAfter: s.doc.activeLayerId,
    bytes: changesBytes(changes),
    ...gesture ? { gesture } : {}
  });
  afterMetaChange(s, true);
}
function afterMetaChange(s, history = false) {
  if (history) s.events.emit("history", void 0);
  emitLayerEvents(s);
  s.events.emit("change", void 0);
  s.events.emit("render", void 0);
}
function sameKeys(a, b) {
  const ka = Object.keys(a).sort().join();
  return ka === Object.keys(b).sort().join();
}
const PICK_ALPHA_THRESHOLD = 10;
function pickLayer(layers2, alphaAt, threshold = PICK_ALPHA_THRESHOLD) {
  for (let i = layers2.length - 1; i >= 0; i--) {
    const layer = layers2[i];
    if (!layer || !layer.visible || layer.locked) continue;
    if (layer.kind !== "paint" && layer.kind !== "text") continue;
    if (alphaAt(layer.id) > threshold) return layer.id;
  }
  return null;
}
function pickMask(layers2, alphaAt, threshold = PICK_ALPHA_THRESHOLD) {
  for (let i = layers2.length - 1; i >= 0; i--) {
    const layer = layers2[i];
    if (!layer || !layer.visible || layer.locked || layer.kind !== "mask") continue;
    if (alphaAt(layer.id) > threshold) return layer.id;
  }
  return null;
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
   * Whether the layer can be deleted (not the last paint layer / last mask).
   * @param layerId - Layer id.
   * @returns `true` if deletable.
   */
  canDelete(layerId) {
    return canDeleteLayer(this.s.doc.layers, layerId);
  }
  /**
   * Whether another mask can be added (M8: at most `MAX_MASKS`).
   * @returns `true` if below the limit.
   */
  canAddMask() {
    return canAddMask(this.s.doc.layers);
  }
  /**
   * Whether the layer can be duplicated (paint-like).
   * @param layerId - Layer id.
   * @returns `true` if duplicable.
   */
  canDuplicate(layerId) {
    return canDuplicateLayer(this.s.doc.layers, layerId);
  }
  /**
   * Move-tool auto-select: the topmost visible, unlocked paint/text layer
   * with a visible pixel at a document point ({@link pickLayer}; reads one
   * pixel per candidate layer).
   * @param x - Document x.
   * @param y - Document y.
   * @returns Layer id, or `null` if nothing is hit.
   */
  pickAt(x, y) {
    const s = this.s;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    const rect = { x: Math.floor(x), y: Math.floor(y), width: 1, height: 1 };
    return pickLayer(s.doc.layers, (id) => s.store.get(id) ? s.store.read(id, rect)?.data.data[3] ?? 0 : 0);
  }
  /**
   * Quick Mask auto-select: the topmost visible, unlocked mask with raw
   * painted coverage at a document point ({@link pickMask}; `invert` ignored).
   * @param x - Document x.
   * @param y - Document y.
   * @returns Mask layer id, or `null` if nothing is hit.
   */
  pickMaskAt(x, y) {
    const s = this.s;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    const rect = { x: Math.floor(x), y: Math.floor(y), width: 1, height: 1 };
    return pickMask(s.doc.layers, (id) => s.store.get(id) ? s.store.read(id, rect)?.data.data[3] ?? 0 : 0);
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
    const layer = findLayer(s, layerId);
    if (!layer || !isPaintLike(layer) || s.doc.activeLayerId === layerId) return false;
    s.settleFloat();
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
    const layer = findLayer(s, layerId);
    if (!layer || layer.visible === visible) return;
    s.settleFloat();
    if (s.stroke.active && s.strokeLayerId === layerId) s.cancelStroke();
    layer.visible = visible;
    afterMetaChange(s);
  }
  /**
   * Show or hide the background (Background row eye). Like layer eyes it is
   * not undoable; hidden = checkerboard in the editor and the `background`
   * widget colour instead of the input image in the outputs.
   * @param visible - Visibility.
   */
  setBackgroundVisible(visible) {
    const s = this.s;
    if (s.doc.backgroundVisible !== false === visible) return;
    s.settleFloat();
    if (visible) delete s.doc.backgroundVisible;
    else s.doc.backgroundVisible = false;
    afterMetaChange(s);
  }
  /**
   * Lock or unlock a layer (painting on a locked layer is refused).
   * @param layerId - Layer id.
   * @param locked - Lock state.
   */
  setLocked(layerId, locked) {
    const s = this.s;
    const layer = findLayer(s, layerId);
    if (!layer || layer.locked === locked) return;
    s.settleFloat();
    if (s.stroke.active && s.strokeLayerId === layerId) s.cancelStroke();
    layer.locked = locked;
    afterMetaChange(s);
  }
  // ── Structural (undoable) ───────────────────────────────────────────────
  /**
   * Add an empty "Layer N" above the active paint layer and make it active.
   * @returns New layer id, or `null` while loading.
   */
  add() {
    return this.addLayer(createPaintLayer(nextLayerName(this.s.doc.layers)));
  }
  /**
   * Insert a prepared, empty layer (e.g. a new text layer) above the active
   * paint layer and make it active, as one undoable add.
   * @param layer - New layer (fresh id, not yet in the document).
   * @returns Its id, or `null` while loading.
   */
  addLayer(layer) {
    if (!readyCheck(this.s)) return null;
    insertLayer(this.s, layer, paintInsertIndex(this.s.doc), null);
    this.soloNew(layer);
    return layer.id;
  }
  /**
   * Insert a prepared paint layer WITH pixels (a paste) at `index` and make
   * it active, as one undoable add (the pixels live in the entry).
   * @param layer - New layer (fresh id, not yet in the document).
   * @param index - Position in `doc.layers`.
   * @param pixels - Its pixels (document coords, inside the bounds cap).
   * @returns Its id, or `null` while loading.
   */
  addWithPixels(layer, index, pixels) {
    if (!readyCheck(this.s)) return null;
    insertLayer(this.s, layer, index, pixels);
    this.soloNew(layer);
    return layer.id;
  }
  /**
   * Add an empty mask ("Mask N", next palette colour) above the current mask
   * and make it the current mask. The active paint layer is unchanged.
   * @returns New mask id, or `null` while loading or at the limit.
   */
  addMask() {
    const s = this.s;
    if (!readyCheck(s) || !canAddMask(s.doc.layers)) return null;
    const colors = s.doc.layers.filter((l) => l.kind === "mask").map((l) => l.color);
    const layer = createMaskLayer(nextMaskName(s.doc.layers), nextMaskStyle(colors, s.maskStyle()));
    const index = maskInsertIndex(s.doc.layers, findMaskLayer(s.doc, s.currentMaskId)?.id);
    s.currentMaskId = layer.id;
    insertLayer(s, layer, index, null, false);
    this.soloNew(layer);
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
    if (!readyCheck(s) || !this.canDuplicate(layerId)) return null;
    const index = s.doc.layers.findIndex((l) => l.id === layerId);
    const source = s.doc.layers[index];
    if (!source) return null;
    const layer = { ...source, id: createId(8), name: copyLayerName(source.name, s.doc.layers) };
    insertLayer(s, layer, index + 1, captureLayerPixels(s, source.id));
    this.soloNew(layer);
    return layer.id;
  }
  /**
   * Delete a paint layer or mask (not the last of its kind). The pixels stay
   * in the undo entry. Deleting the current mask makes the top mask current.
   * @param layerId - Layer (default: the active layer).
   * @returns `true` if deleted.
   */
  remove(layerId = this.s.doc.activeLayerId) {
    const s = this.s;
    if (!readyCheck(s) || !this.canDelete(layerId)) return false;
    const index = s.doc.layers.findIndex((l) => l.id === layerId);
    const layer = s.doc.layers[index];
    if (!layer) return false;
    const activeBefore = s.doc.activeLayerId;
    const pixels = captureLayerPixels(s, layerId);
    s.doc.layers.splice(index, 1);
    s.runtime.remove(layerId);
    releaseRemovedLayers(s);
    if (activeBefore === layerId) s.doc.activeLayerId = activeAfterRemoval(s.doc.layers, index) ?? activeBefore;
    if (s.currentMaskId === layerId) s.currentMaskId = null;
    recordLayerChange(s, [{ op: "remove", index, layer: { ...layer }, pixels }], activeBefore);
    return true;
  }
  /**
   * Reorder a layer next to another of the same group (paint among paint,
   * mask among masks).
   * @param layerId - Dragged layer.
   * @param targetId - Layer it is dropped next to.
   * @param above - Above (true) or below the target in the stack.
   * @returns `true` if the order changed.
   */
  move(layerId, targetId, above) {
    const s = this.s;
    if (!readyCheck(s)) return false;
    const move = resolveMove(s.doc.layers, layerId, targetId, above);
    if (!move) return false;
    const [layer] = s.doc.layers.splice(move.from, 1);
    if (!layer) return false;
    s.doc.layers.splice(move.to, 0, layer);
    recordLayerChange(s, [{ op: "move", id: layerId, ...move }], s.doc.activeLayerId);
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
    return setLayerProps(this.s, layerId, { name: trimmed });
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
    return setLayerProps(this.s, layerId, { opacity: Math.min(1, Math.max(0, opacity)) }, gesture);
  }
  /**
   * Mask display colour.
   * @param layerId - Mask layer id.
   * @param color - `#rrggbb`.
   * @param gesture - Edits with the same key merge into one undo entry (picker drag).
   * @returns `true` if changed.
   */
  setMaskColor(layerId, color, gesture) {
    if (findLayer(this.s, layerId)?.kind !== "mask" || !/^#[0-9a-f]{6}$/i.test(color)) return false;
    return setLayerProps(this.s, layerId, { color: color.toLowerCase() }, gesture);
  }
  /**
   * Per-mask invert (applied before the union, decision 5).
   * @param layerId - Mask layer id.
   * @param invert - Invert state.
   * @returns `true` if changed.
   */
  setMaskInvert(layerId, invert2) {
    if (findLayer(this.s, layerId)?.kind !== "mask") return false;
    return setLayerProps(this.s, layerId, { invert: invert2 });
  }
  // ── Internals ───────────────────────────────────────────────────────────
  /**
   * While any solo is on, a new layer takes over its group's solo so what
   * you just made is visible and editable (a new text layer would otherwise
   * be hidden while typing).
   * @param layer - Newly inserted layer.
   */
  soloNew(layer) {
    const solo = this.s.solo.current;
    if (solo.paint === null && solo.mask === null) return;
    this.s.solo.set({ ...solo, [soloGroup(layer)]: layer.id });
  }
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
    return findMaskLayer(this.s.doc, this.s.currentMaskId);
  }
  /**
   * Whether any mask layer is hidden AND has ever held paint (queue-time
   * warning: it will not be in the MASK output).
   * @returns `true` if a hidden-but-painted mask exists.
   */
  hiddenMaskHasContent() {
    return this.s.doc.layers.some((l) => l.kind === "mask" && !l.visible && this.s.runtime.get(l.id)?.hasContent === true);
  }
  /**
   * Switch the paint target (Quick Mask, `Q`); adds a mask layer if missing.
   * @param target - New target.
   */
  setPaintTarget(target) {
    this.paint.setPaintTarget(target);
  }
  /** Toggle between the paint layer and the current mask. */
  togglePaintTarget() {
    this.paint.setPaintTarget(this.s.target === "mask" ? "paint" : "mask");
  }
  /**
   * Make a mask the current mask (M8) and turn Quick Mask on.
   * @param layerId - Mask layer id.
   * @returns `false` if it is not a mask layer.
   */
  selectMask(layerId) {
    const s = this.s;
    if (s.doc.layers.find((l) => l.id === layerId)?.kind !== "mask") return false;
    const changed = findMaskLayer(s.doc, s.currentMaskId)?.id !== layerId;
    if (changed && s.stroke.active) s.cancelStroke();
    s.currentMaskId = layerId;
    if (s.target !== "mask") this.paint.setPaintTarget("mask");
    else if (changed) s.events.emit("mask", void 0);
    return true;
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
const MAX_SUPERSAMPLE = 4;
function supersampleFactor(inv) {
  const stretch = Math.max(Math.hypot(inv.a, inv.b), Math.hypot(inv.c, inv.d));
  return Math.min(MAX_SUPERSAMPLE, Math.max(1, Math.ceil(stretch - 1e-6)));
}
function resampleRgba(src, sw, sh, m, dest) {
  const out = new Uint8ClampedArray(Math.max(0, dest.width * dest.height * 4));
  const inv = invert(m);
  if (!inv) return out;
  const n = supersampleFactor(inv);
  const taps = n * n;
  const acc = [0, 0, 0, 0];
  for (let y = 0; y < dest.height; y++) {
    for (let x = 0; x < dest.width; x++) {
      acc.fill(0);
      for (let j = 0; j < n; j++) {
        const py = dest.y + y + (j + 0.5) / n;
        for (let i = 0; i < n; i++) {
          const px = dest.x + x + (i + 0.5) / n;
          const u = inv.a * px + inv.c * py + inv.e - 0.5;
          const v = inv.b * px + inv.d * py + inv.f - 0.5;
          bilinearRgba(src, sw, sh, u, v, acc);
        }
      }
      const alpha = acc[3];
      if (alpha <= 0) continue;
      const o = (y * dest.width + x) * 4;
      out[o] = Math.round(acc[0] / alpha);
      out[o + 1] = Math.round(acc[1] / alpha);
      out[o + 2] = Math.round(acc[2] / alpha);
      out[o + 3] = Math.round(alpha / taps);
    }
  }
  return out;
}
function resampleCoverage(src, sw, sh, m, dest) {
  const out = new Uint8Array(Math.max(0, dest.width * dest.height));
  const inv = invert(m);
  if (!inv) return out;
  const n = supersampleFactor(inv);
  for (let y = 0; y < dest.height; y++) {
    for (let x = 0; x < dest.width; x++) {
      let sum = 0;
      for (let j = 0; j < n; j++) {
        const py = dest.y + y + (j + 0.5) / n;
        for (let i = 0; i < n; i++) {
          const px = dest.x + x + (i + 0.5) / n;
          sum += bilinearByte(src, sw, sh, inv.a * px + inv.c * py + inv.e - 0.5, inv.b * px + inv.d * py + inv.f - 0.5);
        }
      }
      out[y * dest.width + x] = Math.round(sum / (n * n));
    }
  }
  return out;
}
function transformSelection(sel, area, m) {
  const coverage = coverageFor(sel, area);
  const dest = transformedAabb(m, area.width, area.height);
  if (dest.width <= 0 || dest.height <= 0) return null;
  return selectionFromCoverage(resampleCoverage(coverage, area.width, area.height, m, dest), dest);
}
function flipRgba(src, w, h, axis) {
  const out = new Uint8ClampedArray(src.length);
  for (let y = 0; y < h; y++) {
    const ty = axis === "v" ? h - 1 - y : y;
    for (let x = 0; x < w; x++) {
      const tx = axis === "h" ? w - 1 - x : x;
      const s = (y * w + x) * 4;
      out.set(src.subarray(s, s + 4), (ty * w + tx) * 4);
    }
  }
  return out;
}
function bilinearRgba(src, sw, sh, u, v, acc) {
  const x0 = Math.floor(u);
  const y0 = Math.floor(v);
  const fx = u - x0;
  const fy = v - y0;
  for (let k = 0; k < 4; k++) {
    const xx = x0 + (k & 1);
    const yy = y0 + (k >> 1);
    const wgt = (k & 1 ? fx : 1 - fx) * (k >> 1 ? fy : 1 - fy);
    if (wgt <= 0 || xx < 0 || yy < 0 || xx >= sw || yy >= sh) continue;
    const p = (yy * sw + xx) * 4;
    const a = src[p + 3] * wgt;
    if (a <= 0) continue;
    acc[0] = acc[0] + src[p] * a;
    acc[1] = acc[1] + src[p + 1] * a;
    acc[2] = acc[2] + src[p + 2] * a;
    acc[3] = acc[3] + a;
  }
}
function bilinearByte(src, sw, sh, u, v) {
  const x0 = Math.floor(u);
  const y0 = Math.floor(v);
  const fx = u - x0;
  const fy = v - y0;
  let sum = 0;
  for (let k = 0; k < 4; k++) {
    const xx = x0 + (k & 1);
    const yy = y0 + (k >> 1);
    const wgt = (k & 1 ? fx : 1 - fx) * (k >> 1 ? fy : 1 - fy);
    if (wgt <= 0 || xx < 0 || yy < 0 || xx >= sw || yy >= sh) continue;
    sum += src[yy * sw + xx] * wgt;
  }
  return sum;
}
const EMPTY_LAYER_NOTE$1 = "The layer is empty.";
function flipLayer(s, axis) {
  const layer = activeEditLayer(s.doc, s.target, s.currentMaskId);
  if (!layer || preparePixelEdit(s, layer) === "blocked") return false;
  const rect = layerContentRect(s, layer.id);
  const before = isEmptyRect(rect) ? null : s.store.read(layer.id, rect);
  if (!before) {
    s.events.emit("note", EMPTY_LAYER_NOTE$1);
    return false;
  }
  const { width, height } = before.rect;
  const flipped = flipRgba(before.data.data, width, height, axis);
  s.store.write(layer.id, before.rect.x, before.rect.y, new ImageData(flipped, width, height));
  const after = s.store.read(layer.id, before.rect);
  if (after) {
    const bytes = before.data.data.byteLength + after.data.data.byteLength;
    s.history.push({ kind: "patch", layerId: layer.id, x: before.rect.x, y: before.rect.y, before: before.data, after: after.data, bytes });
  }
  s.runtime.touch(layer.id);
  s.afterEdit();
  return true;
}
function flipOutsideSession(s, float, axis) {
  if (s.loading || s.stroke.active) return false;
  if (!float.active && !s.selection.current) return flipLayer(s, axis);
  if (!float.active && !float.lift(false)) return false;
  const f = float.state;
  const m = float.matrix();
  if (!f || !m) return false;
  const r = transformedAabb(m, f.area.width, f.area.height);
  const next = multiply(mirrorAbout(axis, { x: r.x + r.width / 2, y: r.y + r.height / 2 }), m);
  float.setTransform(next, float.selectionAt(next));
  float.bake();
  s.events.emit("transform", void 0);
  return true;
}
const EMPTY_FLOAT_NOTE = "No pixels are selected.";
function checkLift(s) {
  const sel = s.selection.current;
  if (s.loading || s.stroke.active || !sel) return "blocked";
  const layer = activeEditLayer(s.doc, s.target, s.currentMaskId);
  if (!layer) return "blocked";
  const note = editBlockNote(s, layer);
  if (note) {
    s.events.emit("note", note);
    return "blocked";
  }
  if (layer.kind === "text") return "confirm";
  const area = intersectRect(selectionExtent(sel, s.store.bounds), layerContentRect(s, layer.id));
  if (isEmptyRect(area)) return empty(s, EMPTY_FLOAT_NOTE) || "blocked";
  return "ok";
}
function prepareLift(s) {
  const layer = activeEditLayer(s.doc, s.target, s.currentMaskId);
  if (layer) preparePixelEdit(s, layer);
}
function liftFloat(s, copy, sel) {
  if (s.loading || s.stroke.active) return null;
  const layer = activeEditLayer(s.doc, s.target, s.currentMaskId);
  if (!layer || preparePixelEdit(s, layer) === "blocked") return null;
  const note = sel ? EMPTY_FLOAT_NOTE : EMPTY_LAYER_NOTE$1;
  const content = layerContentRect(s, layer.id);
  const area = sel ? selectionExtent(sel, s.store.bounds) : content;
  const read = isEmptyRect(area) ? null : s.store.read(layer.id, area);
  if (!read) return empty(s, note) || null;
  const coverage = sel ? coverageFor(sel, read.rect) : new Uint8Array(read.rect.width * read.rect.height).fill(255);
  const { float, rest } = liftPixels(read.data.data, coverage, !copy);
  if (!hasAlpha(float)) return empty(s, note) || null;
  const w = read.rect.width;
  const h = read.rect.height;
  const pixels = new ImageData(float, w, h);
  if (!copy) {
    s.store.write(layer.id, read.rect.x, read.rect.y, new ImageData(rest, w, h));
    s.runtime.bump(layer.id);
  }
  const surface = createSurface(w, h);
  surface.ctx.putImageData(pixels, 0, 0);
  return { layerId: layer.id, area: read.rect, original: read.data, pixels, surface, dx: 0, dy: 0, selBefore: sel, selBase: sel, xf: null, baked: null, dragBase: null, preview: null };
}
function liftKept(s) {
  if (s.loading || s.stroke.active || s.selection.current) return null;
  const layer = activeEditLayer(s.doc, s.target, s.currentMaskId);
  if (!layer || layer.kind === "text" || !s.kept.get(layer.id, s.runtime.revision(layer.id))) return null;
  if (preparePixelEdit(s, layer) === "blocked") return null;
  const kept = s.kept.get(layer.id, s.runtime.revision(layer.id));
  const content = layerContentRect(s, layer.id);
  const read = kept && !isEmptyRect(content) ? s.store.read(layer.id, content) : null;
  if (!kept || !read) return null;
  const { width: w, height: h } = read.rect;
  s.store.write(layer.id, read.rect.x, read.rect.y, new ImageData(w, h));
  s.runtime.bump(layer.id);
  const { width: pw, height: ph } = kept.area;
  const surface = createSurface(pw, ph);
  surface.ctx.putImageData(kept.pixels, 0, 0);
  return {
    layerId: layer.id,
    area: { ...kept.area },
    original: read.data,
    holeRect: read.rect,
    liftM: kept.m,
    params: kept.params,
    pixels: kept.pixels,
    surface,
    dx: 0,
    dy: 0,
    selBefore: null,
    selBase: null,
    xf: kept.m,
    baked: null,
    dragBase: null,
    preview: null
  };
}
function holeOf(f) {
  return f.holeRect ?? f.area;
}
function empty(s, note) {
  s.events.emit("note", note);
  return false;
}
function hasAlpha(px) {
  for (let p = 3; p < px.length; p += 4) if (px[p] !== 0) return true;
  return false;
}
function isPlainPlacement(f, m) {
  return !f.xf && m.a === 1 && m.b === 0 && m.c === 0 && m.d === 1;
}
function writeFloatPatch(s, f, m) {
  const plain = isPlainPlacement(f, m);
  const dest = plain ? { ...f.area, x: m.e, y: m.f } : transformedAabb(m, f.area.width, f.area.height);
  s.ensureBounds(dest, true);
  const hole = holeOf(f);
  const union = intersectRect(unionRect(hole, dest), s.store.bounds);
  const current = s.store.read(f.layerId, union);
  if (!current) return;
  const r = current.rect;
  const before = new Uint8ClampedArray(current.data.data);
  copyPixels(before, r, f.original.data, hole);
  const next = new Uint8ClampedArray(current.data.data);
  const at = plain ? dest : intersectRect(dest, r);
  const src = plain ? f.pixels.data : resampleRgba(f.pixels.data, f.area.width, f.area.height, m, at);
  compositeOver(next, r.width, r.height, src, at.width, at.height, at.x - r.x, at.y - r.y);
  s.store.write(f.layerId, r.x, r.y, new ImageData(next, r.width, r.height));
  const after = s.store.read(f.layerId, r);
  if (after) {
    const beforeData = new ImageData(before, r.width, r.height);
    const bytes = before.byteLength + after.data.data.byteLength;
    s.history.push({ kind: "patch", layerId: f.layerId, x: r.x, y: r.y, before: beforeData, after: after.data, bytes });
    recordSelectionMove(s, f.selBefore, s.selection.current, true);
  }
  s.runtime.touch(f.layerId);
}
function bakeFloat(f, m) {
  const rect = transformedAabb(m, f.area.width, f.area.height);
  const surface = createSurface(Math.max(1, rect.width), Math.max(1, rect.height));
  if (rect.width > 0 && rect.height > 0) {
    const px = resampleRgba(f.pixels.data, f.area.width, f.area.height, m, rect);
    surface.ctx.putImageData(new ImageData(px, rect.width, rect.height), 0, 0);
  }
  return { surface, rect, m };
}
function floatPreviewCanvas(s, f, m) {
  const b = s.store.bounds;
  const key = `${s.runtime.revision(f.layerId)}:${b.x},${b.y},${b.width},${b.height}`;
  if (f.preview?.key === key) return f.preview.surface.canvas;
  if (f.preview) releaseSurface(f.preview.surface);
  const surface = createSurface(b.width, b.height);
  drawFloatPreview(surface.ctx, s.store.ensure(f.layerId).canvas, f, m, b);
  f.preview = { surface, key };
  return surface.canvas;
}
function dropBake(f) {
  if (f.baked) releaseSurface(f.baked.surface);
  f.baked = null;
}
function releaseFloat(f) {
  releaseSurface(f.surface);
  dropBake(f);
  if (f.preview) releaseSurface(f.preview.surface);
  f.preview = null;
}
function isWholeShift(from, to) {
  const dx = to.e - from.e;
  const dy = to.f - from.f;
  const whole = (v) => Math.abs(v - Math.round(v)) < 1e-6;
  return from.a === to.a && from.b === to.b && from.c === to.c && from.d === to.d && whole(dx) && whole(dy);
}
function drawFloatPreview(ctx, layer, f, m, bounds) {
  ctx.drawImage(layer, 0, 0);
  if (isPlainPlacement(f, m)) {
    ctx.drawImage(f.surface.canvas, m.e - bounds.x, m.f - bounds.y);
    return;
  }
  const baked = f.baked;
  if (baked && isWholeShift(baked.m, m)) {
    ctx.drawImage(baked.surface.canvas, baked.rect.x + Math.round(m.e - baked.m.e) - bounds.x, baked.rect.y + Math.round(m.f - baked.m.f) - bounds.y);
    return;
  }
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.setTransform(m.a, m.b, m.c, m.d, m.e - bounds.x, m.f - bounds.y);
  ctx.drawImage(f.surface.canvas, 0, 0);
  ctx.restore();
}
function fieldValue(p, map, key) {
  const centre = docToImage(map, { x: p.cx, y: p.cy });
  switch (key) {
    case "x":
      return centre.x;
    case "y":
      return centre.y;
    case "w":
      return Math.abs(p.sx);
    case "h":
      return Math.abs(p.sy);
    case "angle":
      return normalizeAngle(p.angle) * 180 / Math.PI;
  }
}
function withField(p, map, key, value, linked) {
  if (!Number.isFinite(value)) return null;
  const next = { ...p };
  if (key === "x" || key === "y") {
    const img = docToImage(map, { x: p.cx, y: p.cy });
    const doc = imageToDoc(map, key === "x" ? { x: value, y: img.y } : { x: img.x, y: value });
    next.cx = doc.x;
    next.cy = doc.y;
  } else if (key === "w" || key === "h") {
    if (value <= 0) return null;
    const old = Math.abs(key === "w" ? p.sx : p.sy);
    const k = old > 0 ? value / old : 1;
    if (key === "w" || linked) next.sx *= k;
    if (key === "h" || linked) next.sy *= k;
  } else {
    next.angle = normalizeAngle(value * Math.PI / 180);
  }
  return next;
}
function dragParams(drag, w, h, at, mods, proportional) {
  const { hit, start, from } = drag;
  switch (hit.kind) {
    case "move":
      return { ...start, cx: start.cx + Math.round(at.x - from.x), cy: start.cy + Math.round(at.y - from.y) };
    case "scale":
      return scaleDrag(start, w, h, hit.handle, at, { proportional: proportional !== mods.shift, fromCentre: mods.alt });
    case "rotate":
      return rotateDrag(start, from, at, mods.shift);
    case "outside":
      return start;
  }
}
const UNIFORM_EPS = 1e-6;
function isUniform(p) {
  const ax = Math.abs(p.sx);
  const ay = Math.abs(p.sy);
  return Math.sign(p.sx) === Math.sign(p.sy) && Math.abs(ax - ay) <= UNIFORM_EPS * Math.max(ax, ay, 1);
}
function textDataAt(start, centre, p) {
  const angle = p.sx < 0 ? p.angle + Math.PI : p.angle;
  const size = clampSize(start.size * Math.abs(p.sx));
  const k = size / start.size;
  const moved = { ...start, size, x: p.cx + k * (start.x - centre.x), y: p.cy + k * (start.y - centre.y) };
  return withRotation(moved, angle * 180 / Math.PI);
}
function rasterizeText(s, layerId) {
  const layer = s.doc.layers.find((l) => l.id === layerId);
  if (layer?.kind !== "text") return false;
  rasterizeLayer(s, layer);
  s.history.joinNext(() => false);
  return true;
}
class TextTransform {
  constructor(s, layerId, start, name) {
    this.s = s;
    this.layerId = layerId;
    this.start = start;
    this.name = name;
    const lay = textLayout(start);
    this.w = Math.max(1, lay.box.width);
    this.h = Math.max(1, lay.box.height);
    this.centre = { ...lay.centre };
    this.startParams = { cx: lay.centre.x, cy: lay.centre.y, sx: 1, sy: 1, angle: (start.rotation ?? 0) * Math.PI / 180 };
  }
  s;
  layerId;
  start;
  name;
  /** Session box: unrotated edit box size, document px. */
  w;
  h;
  /** Parameters at session start. */
  startParams;
  centre;
  /**
   * Start a session on the current edit layer if it is text (a selection is
   * ignored: Photoshop transforms the text layer as a whole).
   * @param s - Editor state.
   * @returns Session, `"blocked"` (hidden / locked note shown) or `null` (not a text layer).
   */
  static begin(s) {
    const layer = activeEditLayer(s.doc, s.target, s.currentMaskId);
    if (layer?.kind !== "text" || !layer.textData) return null;
    const note = editBlockNote(s, layer);
    if (note) {
      s.events.emit("note", note);
      return "blocked";
    }
    return new TextTransform(s, layer.id, layer.textData, layer.name);
  }
  /** Whether the layer is still this session's text layer. */
  get valid() {
    return this.layer() !== void 0;
  }
  /**
   * Show parameters (re-render, no history).
   * @param p - Parameters.
   * @returns `false` (nothing changed) when `p` is not uniform.
   */
  apply(p) {
    const layer = this.layer();
    if (!layer || !isUniform(p)) return false;
    this.show(layer, textDataAt(this.start, this.centre, p));
    return true;
  }
  /**
   * End the session: ONE text step when anything changed.
   * @returns `true` if a step was recorded.
   */
  commit() {
    const layer = this.layer();
    const td = layer?.textData;
    if (!layer || !td || sameTextData(td, this.start)) return false;
    const s = this.s;
    recordTextChange(s, layer.id, { kind: "text", name: this.name, textData: this.start }, { kind: "text", name: layer.name, textData: td });
    s.runtime.touch(layer.id);
    s.afterEdit();
    s.events.emit("layers", void 0);
    return true;
  }
  /** Put the start text back. */
  cancel() {
    const layer = this.layer();
    if (layer) this.show(layer, this.start);
  }
  show(layer, td) {
    if (layer.textData && sameTextData(layer.textData, td)) return;
    layer.textData = td;
    renderTextLayer(this.s, layer);
    this.s.runtime.bump(layer.id);
    this.s.events.emit("render", void 0);
  }
  layer() {
    const layer = this.s.doc.layers.find((l) => l.id === this.layerId);
    return layer?.kind === "text" && layer.textData ? layer : void 0;
  }
}
function isScaleField(key) {
  return key === "w" || key === "h";
}
function endTextFieldEdit(edit, current, map) {
  const want = withField(edit.before, map, edit.key, fieldValue(current, map, edit.key), false);
  if (!want || isUniform(want)) return null;
  return { before: { ...edit.before }, want };
}
function rescaleFromText(p, req) {
  const kx = req.before.sx !== 0 ? req.want.sx / req.before.sx : 1;
  const ky = req.before.sy !== 0 ? req.want.sy / req.before.sy : 1;
  return { ...p, sx: p.sx * kx, sy: p.sy * ky };
}
class TransformOps {
  /**
   * @param s - Shared editor state.
   * @param float - The editor's float commands.
   */
  constructor(s, float) {
    this.s = s;
    this.float = float;
  }
  s;
  float;
  session = null;
  drag = null;
  /** A text session asked for a non-uniform change / flip (rasterize prompt pending). */
  wantRaster = null;
  /** Open unlinked W / H field session of a text session ({@link endField}). */
  fieldEdit = null;
  /** Proportion lock (options bar); Shift inverts it while dragging a handle. */
  proportional = true;
  /** Whether a session is running. */
  get active() {
    return this.current() !== null;
  }
  /** Whether a TEXT layer session is running (no float; M11b). */
  get textActive() {
    return this.current()?.text != null;
  }
  /** Whether a text session is waiting for the rasterize prompt ({@link resolvePending}). */
  get pending() {
    return this.wantRaster !== null && this.textActive;
  }
  /** Current parameters, or `null` outside a session. */
  get params() {
    return this.current()?.params ?? null;
  }
  /** Whether a handle drag is in progress. */
  get dragging() {
    return this.drag !== null && this.active;
  }
  /**
   * Float-local -> document matrix and float size of the session.
   * @returns Box geometry, or `null` outside a session.
   */
  box() {
    const session = this.current();
    if (!session) return null;
    const { w, h } = session;
    return { m: paramsMatrix(session.params, w, h), w, h };
  }
  /**
   * Start a session (see module doc). Notes explain refusals.
   * @returns `true` if a session is running afterwards.
   */
  enter() {
    if (this.active) return true;
    const s = this.s;
    if (s.loading || s.stroke.active) return false;
    s.commitTextEdit();
    this.drag = null;
    this.wantRaster = null;
    this.fieldEdit = null;
    if (!this.float.active) {
      const text = TextTransform.begin(s);
      if (text === "blocked") return false;
      if (text) {
        const p = text.startParams;
        this.session = { float: null, text, w: text.w, h: text.h, params: { ...p }, startM: paramsMatrix(p, text.w, text.h), startSel: null };
        s.events.emit("transform", void 0);
        return true;
      }
      const lifted = s.selection.current ? this.float.lift(false) : this.float.liftKept() || this.float.liftWhole();
      if (!lifted) return false;
    }
    const f = this.float.state;
    const m = this.float.matrix();
    if (!f || !m) return false;
    const { width: w, height: h } = f.area;
    const known = f.params && affineEquals(paramsMatrix(f.params, w, h), m) ? { ...f.params } : null;
    const params = known ?? decomposeAffine(m, w, h);
    this.session = { float: f, text: null, w, h, params, startM: m, startSel: s.selection.current };
    this.float.setTransform(m, void 0, params);
    s.events.emit("transform", void 0);
    return true;
  }
  /**
   * Commit the session. Whole-layer sessions land in the layer (the float's
   * commit, one undo step). Selection sessions end but the float STAYS: its
   * matrix is kept over the original lifted pixels (a later session resumes
   * from it, no accumulated resampling), the display is resampled once
   * (`FloatOps.bake`), and the float commits by the M10 rules later.
   * @returns `true` if layer pixels changed (never for a selection session).
   */
  commit() {
    const session = this.current();
    if (!session) return false;
    if (session.text) return this.endText(session.text, true);
    if (!session.float?.selBefore) return this.float.commit();
    if (this.drag) this.endDrag();
    this.apply(session.params, true);
    this.session = null;
    this.float.bake();
    this.s.events.emit("transform", void 0);
    return false;
  }
  /** Cancel the session: everything back as before it (and before its lift). */
  cancel() {
    const session = this.current();
    if (session?.text) this.endText(session.text, false);
    else if (session) this.float.cancel();
  }
  /**
   * Outside any gesture: a text session's non-uniform change / flip asks to
   * rasterize (`EditorState.confirmRasterize`). Yes = the text changes so
   * far commit, the layer is rasterized (its own step) and a whole-layer
   * pixel session continues from it (a pending flip / field W H is
   * re-applied; a drag's shape is not). No = the change is dropped (it was
   * never shown / was reverted); the text session stays.
   * @returns `true` if the session turned into a pixel session.
   */
  resolvePending() {
    const want = this.wantRaster;
    this.wantRaster = null;
    const session = this.current();
    if (!want || !session?.text || this.drag) return false;
    if (!this.s.confirmRasterize()) return false;
    const layerId = session.text.layerId;
    this.commit();
    if (!rasterizeText(this.s, layerId) || !this.float.liftWhole() || !this.enter()) return false;
    if (want.flip) this.flip(want.flip);
    const p = this.params;
    if (want.fields && p) this.apply(rescaleFromText(p, want.fields), true);
    return true;
  }
  // ── Handles ─────────────────────────────────────────────────────────────
  /**
   * Hit zone at a document point.
   * @param at - Document point.
   * @param handleTol - Handle radius, document px.
   * @param rotateTol - Rotate reach beyond a corner, document px.
   * @returns Hit (`outside` without a session).
   */
  hit(at, handleTol, rotateTol) {
    const box = this.box();
    return box ? hitTransform(box.m, box.w, box.h, at, handleTol, rotateTol) : { kind: "outside" };
  }
  /**
   * Resize cursor axis of a handle for the current rotation / flips.
   * @param handle - Handle index.
   * @returns Axis.
   */
  resizeAxis(handle) {
    const box = this.box();
    return box ? resizeAxis(box.m, box.w, box.h, handle) : "ew";
  }
  /** Hit of the drag in progress (cursor during a drag), or `null`. */
  get dragHit() {
    return this.dragging ? this.drag?.hit ?? null : null;
  }
  /**
   * Start a drag.
   * @param hit - Zone pressed ({@link hit}); `outside` starts nothing.
   * @param at - Pointer, document px.
   * @returns `true` if a drag started.
   */
  beginDrag(hit, at) {
    const session = this.current();
    if (!session || hit.kind === "outside") return false;
    this.drag = { hit, start: { ...session.params }, from: { ...at } };
    return true;
  }
  /**
   * Update the drag.
   * @param at - Pointer, document px.
   * @param mods - Shift (free scale / 15 deg snap) and Alt (around the centre).
   */
  dragTo(at, mods) {
    const drag = this.drag;
    const session = this.current();
    if (!drag || !session) return;
    this.apply(dragParams(drag, session.w, session.h, at, mods, this.proportional), false);
  }
  /** End the drag (the session stays open). */
  endDrag() {
    if (!this.drag) return;
    this.drag = null;
    const session = this.current();
    if (session) this.apply(session.params, true);
  }
  /** Abort the drag: back to its start parameters. */
  cancelDrag() {
    const drag = this.drag;
    this.drag = null;
    if (drag && this.current()) this.apply(drag.start, true);
    this.wantRaster = null;
  }
  /**
   * Arrow nudge of the session.
   * @param dx - Whole document px.
   * @param dy - Whole document px.
   * @returns `true` if a session moved.
   */
  nudge(dx, dy) {
    const session = this.current();
    if (!session || this.drag) return false;
    this.apply({ ...session.params, cx: session.params.cx + dx, cy: session.params.cy + dy }, true);
    return true;
  }
  // ── Flips ───────────────────────────────────────────────────────────────
  /**
   * Flip H / V: part of a running session; else mirror a float (lifting the
   * selection first) as a still-floating exact mirror; else mirror the whole
   * current layer about its content centre (one undo step).
   * @param axis - `"h"` or `"v"`.
   * @returns `true` if something flipped.
   */
  flip(axis) {
    const session = this.current();
    if (session?.text) {
      this.wantRaster = { flip: axis };
      return this.resolvePending();
    }
    if (session) {
      this.apply(flipParams(session.params, axis), true);
      return true;
    }
    return flipOutsideSession(this.s, this.float, axis);
  }
  // ── Option fields ───────────────────────────────────────────────────────
  /**
   * An options-bar value (`transformFields.ts`: X / Y = box centre in image
   * px, W / H = scale fractions, angle in degrees).
   * @param key - Field.
   * @returns Value, or `undefined` outside a session.
   */
  field(key) {
    const p = this.params;
    return p ? fieldValue(p, documentMap(this.s.doc, this.s.imageSize), key) : void 0;
  }
  /**
   * Set an options-bar value (same units as {@link field}); W / H keep the
   * ratio while the proportion lock is on; flips are kept. Text sessions
   * with the lock off preview W / H linked and resolve the unlinked value
   * when the field session ends ({@link endField}).
   * @param key - Field.
   * @param value - New value.
   * @returns `true` if the session changed.
   */
  setField(key, value) {
    const session = this.current();
    if (!session || this.drag) return false;
    const p = withField(session.params, documentMap(this.s.doc, this.s.imageSize), key, value, this.proportional || session.text !== null);
    if (!p) return false;
    if (session.text && !this.proportional && isScaleField(key) && this.fieldEdit?.key !== key) this.fieldEdit = { key, before: { ...session.params } };
    this.apply(p, true);
    return true;
  }
  /**
   * A field session ended (Enter / blur / scrub release). An unlinked text
   * W / H edit that is not uniform reverts to its start and becomes a
   * pending rasterize request ({@link resolvePending}, run it deferred).
   * @returns `true` if a prompt is pending.
   */
  endField() {
    const edit = this.fieldEdit;
    this.fieldEdit = null;
    const session = this.current();
    if (!edit || !session?.text || this.drag) return false;
    const req = endTextFieldEdit(edit, session.params, documentMap(this.s.doc, this.s.imageSize));
    if (!req) return false;
    this.apply(req.before, true);
    this.wantRaster = { flip: null, fields: req };
    return true;
  }
  // ── Internals ───────────────────────────────────────────────────────────
  /** End a text session: commit (one text step) or cancel. @returns `true` if a step was recorded. */
  endText(text, commit) {
    this.drag = null;
    this.session = null;
    this.wantRaster = null;
    this.fieldEdit = null;
    const changed = commit ? text.commit() : (text.cancel(), false);
    this.s.events.emit("transform", void 0);
    return changed;
  }
  /** The running session, dropping a stale one (its float was committed / cancelled). */
  current() {
    const session = this.session;
    const stale = session?.text ? !session.text.valid || this.float.active : session && this.float.state !== session.float;
    if (session && stale) {
      this.session = null;
      this.drag = null;
      return null;
    }
    return session;
  }
  /** Show parameters; `settled` = also re-rasterize the transformed selection. */
  apply(p, settled) {
    const session = this.current();
    if (!session) return;
    if (session.text) {
      if (session.text.apply(p)) {
        session.params = p;
        if (this.drag) this.wantRaster = null;
      } else this.wantRaster = { flip: null };
      this.s.events.emit("transform", void 0);
      return;
    }
    session.params = p;
    const m = paramsMatrix(p, session.w, session.h);
    if (!session.float?.selBefore) this.float.setTransform(m, void 0, p);
    else if (affineEquals(m, session.startM)) this.float.setTransform(m, session.startSel, p);
    else this.float.setTransform(m, settled ? this.float.selectionAt(m) : null, p);
    this.s.events.emit("transform", void 0);
  }
}
class FloatOps {
  /**
   * @param s - Shared editor state (installs the settle hook and the preview).
   */
  constructor(s) {
    this.s = s;
    s.settleFloat = () => {
      this.commit();
    };
    s.floatPreview = (layerId) => this.preview(layerId);
    this.transform = new TransformOps(s, this);
  }
  s;
  f = null;
  /** Free Transform sessions over this float (M11). */
  transform;
  /** The float itself (read-only view for `transformOps.ts`), or `null`. */
  get state() {
    return this.f;
  }
  /**
   * The float's full float-local -> document matrix (offset included).
   * @returns Matrix, or `null` without a float.
   */
  matrix() {
    const f = this.f;
    if (!f) return null;
    return multiply(translation(f.dx, f.dy), f.xf ?? translation(f.area.x, f.area.y));
  }
  /** Whether a float exists. */
  get active() {
    return this.f !== null;
  }
  /** Current offset of the float from where it was lifted (document px), or `null`. */
  get offset() {
    return this.f ? { dx: this.f.dx, dy: this.f.dy } : null;
  }
  /** Layer the float belongs to, or `null`. */
  get layerId() {
    return this.f?.layerId ?? null;
  }
  /**
   * Whether a document point is inside the float's (moved) selection.
   * @param x - Document x.
   * @param y - Document y.
   * @returns `true` if inside.
   */
  hit(x, y) {
    return this.f !== null && selectionHit(this.s.selection.current, x, y);
  }
  /**
   * What a lift of the current edit layer would do, decided at pointer-down
   * before anything changes (no modal dialog here): `"blocked"` (note shown:
   * locked / hidden / no selected pixels), `"confirm"` (text layer: the
   * rasterize prompt must run outside the gesture, {@link prepareLift}) or
   * `"ok"`.
   * @returns Check result.
   */
  check() {
    return this.f ? "ok" : checkLift(this.s);
  }
  /**
   * Outside any gesture: run the pixel-edit gate for a lift (the text
   * rasterize confirm; Yes = its own undo step). Nothing is lifted.
   */
  prepareLift() {
    prepareLift(this.s);
  }
  /**
   * Lift the selected pixels of the current edit layer into a float (the
   * pixel-edit gate runs first: lock / hidden notes, text rasterize prompt).
   * @param copy - `true` = copy (no hole).
   * @returns `true` if a float exists afterwards.
   */
  lift(copy) {
    if (this.f) return true;
    const sel = this.s.selection.current;
    return sel ? this.liftFrom(copy, sel) : false;
  }
  /**
   * Lift the whole content of the current edit layer (Free Transform without
   * a selection): the hole is the whole layer until commit. Same gate as {@link lift}.
   * @returns `true` if a float exists afterwards.
   */
  liftWhole() {
    return this.f ? true : this.liftFrom(false, null);
  }
  /**
   * Whole-layer lift from the layer's kept original (M11b), if it has a
   * valid one and there is no selection.
   * @returns `true` if a float exists afterwards.
   */
  liftKept() {
    return this.f ? true : this.adopt(liftKept(this.s));
  }
  /**
   * Take a float built outside a lift (an inserted image, `sourceInsert.ts`).
   * @param f - The float (its layer exists; `inserted` set).
   * @returns `false` if a float already exists.
   */
  adoptInserted(f) {
    return this.f ? false : this.adopt(f);
  }
  liftFrom(copy, sel) {
    return this.adopt(liftFloat(this.s, copy, sel));
  }
  adopt(f) {
    if (!f) return false;
    this.f = f;
    this.s.events.emit("history", void 0);
    this.s.events.emit("render", void 0);
    return true;
  }
  /**
   * Set the float's matrix (Free Transform); the offset is folded in (reset to 0).
   * @param m - Float-local -> document matrix.
   * @param sel - New selection at that matrix (`undefined` = keep the current one).
   * @param params - Session parameters that give `m` (kept for an exact restart), if any.
   */
  setTransform(m, sel, params) {
    const f = this.f;
    if (!f) return;
    const s = this.s;
    s.ensureBounds(transformedAabb(m, f.area.width, f.area.height), true);
    f.xf = m;
    f.params = params ? { ...params } : void 0;
    dropBake(f);
    f.dx = 0;
    f.dy = 0;
    if (sel !== void 0) {
      f.selBase = sel;
      s.selection.set(sel);
    }
    s.runtime.bump(f.layerId);
    s.events.emit("render", void 0);
  }
  /**
   * The lift-time selection carried through a matrix (`null` for whole-layer lifts).
   * @param m - Float-local -> document matrix.
   * @returns Transformed selection.
   */
  selectionAt(m) {
    const f = this.f;
    return f?.selBefore ? transformSelection(f.selBefore, f.area, m) : null;
  }
  /**
   * Resample the ORIGINAL lifted pixels once through the current matrix for
   * display (a transform session ended, the float stays). Later whole-px
   * moves reuse it; a new session / flip drops it (`setTransform`).
   */
  bake() {
    const f = this.f;
    const m = this.matrix();
    if (!f || !m || !f.xf) return;
    dropBake(f);
    f.baked = bakeFloat(f, m);
    this.s.runtime.bump(f.layerId);
    this.s.events.emit("render", void 0);
  }
  // ── Moving ──────────────────────────────────────────────────────────────
  /** Start a drag of the float. @returns `false` without a float. */
  beginDrag() {
    if (!this.f) return false;
    this.f.dragBase = { dx: this.f.dx, dy: this.f.dy };
    return true;
  }
  /**
   * Drag offset from the drag start (whole document px).
   * @param dx - X from the drag start.
   * @param dy - Y from the drag start.
   */
  dragTo(dx, dy) {
    const base = this.f?.dragBase;
    if (base) this.setOffset(base.dx + dx, base.dy + dy);
  }
  /** End the drag (the float stays; nothing is committed). */
  endDrag() {
    if (this.f) this.f.dragBase = null;
  }
  /** Abort the drag: back to where the drag started. */
  cancelDrag() {
    const base = this.f?.dragBase;
    if (!base || !this.f) return;
    this.f.dragBase = null;
    this.setOffset(base.dx, base.dy);
  }
  /**
   * Arrow nudge.
   * @param dx - Whole document px.
   * @param dy - Whole document px.
   * @returns `true` if a float moved.
   */
  nudge(dx, dy) {
    const f = this.f;
    if (!f || f.dragBase) return false;
    this.setOffset(f.dx + dx, f.dy + dy);
    return true;
  }
  // ── Ending ──────────────────────────────────────────────────────────────
  /**
   * Drop the float into its layer: ONE undo step (patch over source U
   * destination + the selection move). A float at its lift position cancels.
   * @returns `true` if pixels changed.
   */
  commit() {
    const f = this.f;
    if (!f) return this.transform.textActive ? this.transform.commit() : false;
    const s = this.s;
    const m = this.matrix() ?? translation(f.area.x, f.area.y);
    if (!f.inserted && affineEquals(m, f.liftM ?? translation(f.area.x, f.area.y))) {
      this.cancel();
      return false;
    }
    if (f.xf && f.selBefore) s.selection.set(this.selectionAt(m));
    this.f = null;
    const keep = f.xf !== null && isEmptyRect(layerContentRect(s, f.layerId));
    writeFloatPatch(s, f, m);
    releaseFloat(f);
    if (keep) {
      const params = f.params && affineEquals(paramsMatrix(f.params, f.area.width, f.area.height), m) ? f.params : void 0;
      s.kept.keep(f.layerId, { pixels: f.pixels, area: { ...f.area }, m, params, revision: s.runtime.revision(f.layerId) });
    }
    f.onEnd?.(true);
    s.afterEdit();
    s.events.emit("transform", void 0);
    return true;
  }
  /** Put everything back exactly as before the lift (Esc, Ctrl+Z). */
  cancel() {
    const f = this.f;
    if (!f) {
      this.transform.cancel();
      return;
    }
    const s = this.s;
    this.f = null;
    const hole = holeOf(f);
    s.store.write(f.layerId, hole.x, hole.y, f.original);
    s.runtime.bump(f.layerId);
    s.selection.set(f.selBefore);
    releaseFloat(f);
    f.onEnd?.(false);
    s.events.emit("history", void 0);
    s.events.emit("render", void 0);
    s.events.emit("transform", void 0);
  }
  /**
   * Layer pixels as they were before the lift, for saving while floating.
   * @param layerId - Layer id.
   * @returns Original pixels over the lifted area, or `null` if the layer has no float.
   */
  savedPatch(layerId) {
    const f = this.f;
    const hole = f ? holeOf(f) : null;
    return f && hole && f.layerId === layerId ? { x: hole.x, y: hole.y, data: f.original } : null;
  }
  // ── Internals ───────────────────────────────────────────────────────────
  setOffset(dx, dy) {
    const f = this.f;
    if (!f || f.dx === dx && f.dy === dy) return;
    const s = this.s;
    const m = multiply(translation(dx, dy), f.xf ?? translation(f.area.x, f.area.y));
    s.ensureBounds(transformedAabb(m, f.area.width, f.area.height), true);
    f.dx = dx;
    f.dy = dy;
    s.runtime.bump(f.layerId);
    if (f.selBase) s.selection.set(offsetSelection(f.selBase, dx, dy));
    s.events.emit("render", void 0);
  }
  preview(layerId) {
    const f = this.f;
    if (!f || f.layerId !== layerId) return null;
    return floatPreviewCanvas(this.s, f, this.matrix() ?? translation(f.area.x, f.area.y));
  }
}
const MERGE_NOTHING_NOTE = "Nothing to merge down into.";
function mergeDown(s) {
  if (!readyCheck(s)) return false;
  const plan = mergePlan(s);
  if (plan === null) return false;
  if (typeof plan === "string") {
    s.events.emit("note", plan);
    return false;
  }
  const { upper, lower, index } = plan;
  const depth = s.history.undoDepth;
  if (preparePixelEdit(s, upper) === "blocked" || preparePixelEdit(s, lower) === "blocked") {
    return false;
  }
  const entries = [];
  while (s.history.undoDepth > depth) {
    const entry = s.history.discardNewest();
    if (entry) entries.unshift(entry);
  }
  const patch = mergePixels(s, upper, lower);
  if (patch) entries.push(patch);
  entries.push(removeUpper(s, upper, lower, index));
  s.history.push({ kind: "group", entries, bytes: entries.reduce((n, e) => n + e.bytes, 0) });
  s.runtime.touch(lower.id);
  emitLayerEvents(s);
  s.afterEdit();
  return true;
}
function canMergeDown(s) {
  const plan = mergePlan(s);
  return plan !== null && typeof plan !== "string";
}
function mergePlan(s) {
  const upper = activeEditLayer(s.doc, s.target, s.currentMaskId);
  if (!upper) return null;
  const index = s.doc.layers.indexOf(upper);
  const lower = s.doc.layers[index - 1];
  if (!lower || isPaintLike(lower) !== isPaintLike(upper)) return MERGE_NOTHING_NOTE;
  return editBlockNote(s, upper) ?? editBlockNote(s, lower) ?? { upper, lower, index };
}
function mergePixels(s, upper, lower) {
  const bounds = s.store.bounds;
  const rect = upper.kind === "mask" && upper.invert === true ? bounds : intersectRect(layerContentRect(s, upper.id), bounds);
  if (isEmptyRect(rect)) return null;
  const up = s.store.read(upper.id, rect);
  const before = s.store.read(lower.id, rect);
  if (!up || !before) return null;
  const r = before.rect;
  const next = new Uint8ClampedArray(before.data.data);
  if (upper.kind === "mask") {
    mergeMaskCoverage(up.data.data, upper.invert === true, next, lower.invert === true);
  } else {
    compositeOver(next, r.width, r.height, up.data.data, r.width, r.height, 0, 0, upper.opacity);
  }
  s.store.write(lower.id, r.x, r.y, new ImageData(next, r.width, r.height));
  const after = s.store.read(lower.id, r);
  if (!after) return null;
  const bytes = before.data.data.byteLength + after.data.data.byteLength;
  return { kind: "patch", layerId: lower.id, x: r.x, y: r.y, before: before.data, after: after.data, bytes };
}
function removeUpper(s, upper, lower, index) {
  const activeBefore = s.doc.activeLayerId;
  const pixels = captureLayerPixels(s, upper.id);
  s.doc.layers.splice(index, 1);
  s.runtime.remove(upper.id);
  releaseRemovedLayers(s);
  if (activeBefore === upper.id) s.doc.activeLayerId = lower.id;
  if (upper.kind === "mask") s.currentMaskId = lower.id;
  const changes = [{ op: "remove", index, layer: { ...upper }, pixels }];
  return { kind: "layers", changes, activeBefore, activeAfter: s.doc.activeLayerId, bytes: changesBytes(changes) };
}
const pixelMover = {
  move: (s, layer, dx, dy, gesture) => translateLayerPixels(s, layer.id, dx, dy, gesture)
};
const textMover = {
  move: (s, layer, dx, dy, gesture) => moveTextLayer(s, layer, dx, dy, gesture)
};
const MOVERS = {
  paint: pixelMover,
  mask: pixelMover,
  text: textMover
};
const UNMOVABLE_LAYER_NOTE = "This layer can't be moved.";
function moverFor(layer) {
  return MOVERS[layer.kind];
}
const NUDGE_GESTURE = "move-nudge";
class LayerMoveOps {
  /**
   * @param s - Shared editor state.
   */
  constructor(s) {
    this.s = s;
  }
  s;
  /** Selection at drag start (the outline follows the drag preview live). */
  selStart = null;
  /** A drag preview is in progress. */
  get dragging() {
    return this.s.movePreview !== null;
  }
  /**
   * Start a drag of the active layer (notes when locked / hidden / unmovable).
   * @returns `false` if the layer can't be moved now.
   */
  begin() {
    const s = this.s;
    if (s.movePreview) return true;
    s.settleFloat();
    const layer = this.editable();
    if (!layer) return false;
    if (s.selection.current && layer.kind !== "text" && isEmptyRect(layerContentRect(s, layer.id))) {
      s.events.emit("note", EMPTY_FLOAT_NOTE);
      return false;
    }
    s.movePreview = { layerId: layer.id, dx: 0, dy: 0 };
    this.selStart = s.selection.current;
    return true;
  }
  /**
   * Update the drag offset (cheap: redraw only).
   * @param dx - Offset from the drag start, whole document px.
   * @param dy - Offset from the drag start, whole document px.
   */
  preview(dx, dy) {
    const p = this.s.movePreview;
    if (!p || p.dx === dx && p.dy === dy) return;
    p.dx = dx;
    p.dy = dy;
    if (this.selStart) this.s.selection.set(offsetSelection(this.selStart, dx, dy));
    this.s.events.emit("render", void 0);
  }
  /**
   * End the drag: move the layer by the preview offset as one undo entry.
   * @returns `true` if the layer moved.
   */
  commit() {
    const s = this.s;
    const p = s.movePreview;
    if (!p) return false;
    s.movePreview = null;
    this.restoreSelection();
    const moved = this.apply(p.layerId, p.dx, p.dy, void 0);
    if (!moved) s.events.emit("render", void 0);
    return moved;
  }
  /** Abort the drag (Esc, pointer cancel, tool switch); nothing changes. */
  cancel() {
    if (!this.s.movePreview) return;
    this.s.movePreview = null;
    this.restoreSelection();
    this.s.events.emit("render", void 0);
  }
  /**
   * Arrow nudge of the active layer (merges with the previous nudge).
   * @param dx - X shift, whole document px.
   * @param dy - Y shift, whole document px.
   * @returns `true` if the layer moved.
   */
  nudge(dx, dy) {
    if (this.s.movePreview) return false;
    this.s.settleFloat();
    const layer = this.editable();
    return layer ? this.apply(layer.id, dx, dy, NUDGE_GESTURE) : false;
  }
  // ── Internals ───────────────────────────────────────────────────────────
  /** Put the live-previewed outline back (commit re-applies it with the move). */
  restoreSelection() {
    if (this.selStart) this.s.selection.set(this.selStart);
    this.selStart = null;
  }
  /** The layer to move, if it can be moved now (emits the reason otherwise). */
  editable() {
    const s = this.s;
    if (s.loading || s.stroke.active) return null;
    const layer = activeEditLayer(s.doc, s.target, s.currentMaskId);
    if (!layer) return null;
    const note = blockedNote(s, layer);
    if (note) {
      s.events.emit("note", note);
      return null;
    }
    return layer;
  }
  apply(layerId, dx, dy, gesture) {
    const s = this.s;
    if (s.loading || s.stroke.active || dx === 0 && dy === 0) return false;
    const layer = s.doc.layers.find((l) => l.id === layerId);
    if (!layer || blockedNote(s, layer)) return false;
    const mover = moverFor(layer);
    if (!mover) return false;
    if (!followSelection(s, dx, dy, gesture, () => mover.move(s, layer, dx, dy, gesture))) return false;
    s.afterEdit();
    return true;
  }
}
function blockedNote(s, layer) {
  const note = editBlockNote(s, layer);
  if (note) return note;
  if (!moverFor(layer)) return UNMOVABLE_LAYER_NOTE;
  return null;
}
const MAX_DEPTH = 64;
function growUnder(coverage, layer, width, height, bbox, clip) {
  const under = new Uint8Array(width * height);
  if (bbox.width <= 0 || layer.length < width * height * 4) return { under, bbox };
  const alpha = (i) => layer[i * 4 + 3];
  const open = (i) => coverage[i] === 0 && under[i] === 0 && !(clip && clip[i] === 0);
  let queue = [];
  let minX = bbox.x;
  let minY = bbox.y;
  let maxX = bbox.x + bbox.width - 1;
  let maxY = bbox.y + bbox.height - 1;
  const mark = (i) => {
    under[i] = 255;
    queue.push(i);
    const x = i % width;
    const y = i / width | 0;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  };
  const visit = (i, floor) => {
    const x = i % width;
    const y = i / width | 0;
    const tryJoin = (n) => {
      const a = alpha(n);
      if (a > floor && a < 255 && open(n)) mark(n);
    };
    if (x > 0) tryJoin(i - 1);
    if (x < width - 1) tryJoin(i + 1);
    if (y > 0) tryJoin(i - width);
    if (y < height - 1) tryJoin(i + width);
  };
  const x0 = Math.max(0, bbox.x - 1);
  const y0 = Math.max(0, bbox.y - 1);
  const x1 = Math.min(width - 1, bbox.x + bbox.width);
  const y1 = Math.min(height - 1, bbox.y + bbox.height);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const i = y * width + x;
      if (coverage[i] === 255) visit(i, alpha(i));
    }
  }
  for (let depth = 1; depth < MAX_DEPTH && queue.length > 0; depth++) {
    const current = queue;
    queue = [];
    for (const i of current) visit(i, alpha(i));
  }
  return { under, bbox: { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 } };
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
  let under;
  if (options.antiAlias && options.under) {
    const grown = growUnder(coverage, options.under, width, height, bbox, clip);
    under = grown.under;
    bbox = grown.bbox;
  }
  if (options.antiAlias) bbox = addFringe(coverage, width, height, bbox, clip, under);
  if (clip) {
    applyClip(coverage, width, bbox, clip);
    if (under) applyClip(under, width, bbox, clip);
  }
  return under ? { coverage, bbox, under } : { coverage, bbox };
}
function clampTolerance(tolerance) {
  return Number.isFinite(tolerance) ? Math.min(255, Math.max(0, Math.round(tolerance))) : 0;
}
function markMatches(data, coverage, seed, tol, clip) {
  const p0 = seed * 4;
  const a = data[p0 + 3] ?? 0;
  const r = (data[p0] ?? 0) * a / 255;
  const g = (data[p0 + 1] ?? 0) * a / 255;
  const b = (data[p0 + 2] ?? 0) * a / 255;
  const n = coverage.length;
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    if (clip && clip[i] === 0) continue;
    const pa = data[p + 3];
    if (pa === 0 && a === 0) {
      coverage[i] = MATCH;
      continue;
    }
    const w = pa / 255;
    const dr = data[p] * w - r;
    const dg = data[p + 1] * w - g;
    const db = data[p + 2] * w - b;
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
function addFringe(coverage, width, height, bbox, clip, under) {
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
      if (coverage[i] !== 0 || clip && clip[i] === 0 || under && under[i] !== 0) continue;
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
function sampleTarget(sample, layer) {
  if (sample === "layer") return layer ? { kind: "layer", layer } : { kind: "scene", source: "all" };
  return { kind: "scene", source: sample };
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
    if (!layer || preparePixelEdit(s, layer) === "blocked") return false;
    const px = Math.floor(req.point.x);
    const py = Math.floor(req.point.y);
    const image = this.imageRectInDoc();
    if (!inside(image, px, py) && !inside(s.store.bounds, px, py)) return false;
    s.ensureBounds(image, true);
    const bounds = s.store.bounds;
    if (!inside(bounds, px, py)) return false;
    const target = sampleTarget(req.sample, layer);
    const source = this.sampleArea(bounds, target);
    if (!source) return false;
    const own = !req.antiAlias ? void 0 : target.kind === "layer" ? source : this.sampleArea(bounds, { kind: "layer", layer });
    const { coverage, bbox, under } = floodFill(source, bounds.width, bounds.height, {
      x: px - bounds.x,
      y: py - bounds.y,
      tolerance: req.tolerance,
      contiguous: req.contiguous,
      antiAlias: req.antiAlias,
      // M5: confined to (and scaled by) the selection.
      clip: s.selection.coverage(bounds),
      under: own ?? void 0
    });
    if (isEmptyRect(bbox)) return false;
    const docRect = { x: bounds.x + bbox.x, y: bounds.y + bbox.y, width: bbox.width, height: bbox.height };
    const before = s.store.read(layer.id, docRect);
    if (!before) return false;
    const next = new ImageData(new Uint8ClampedArray(before.data.data), before.data.width, before.data.height);
    const color = hexToRgb(layer.kind === "mask" ? MASK_STROKE_COLOR : req.color);
    blendCoverage(next.data, bbox, coverage, bounds.width, color, req.opacity);
    if (under) blendCoverageBehind(next.data, bbox, under, bounds.width, color, req.opacity);
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
    const source = this.sampleArea(area, sampleTarget(req.sample, targetLayer(s.doc, "paint")));
    return source ? wandSelection(source, area, req.point, req) : null;
  }
  // ── Sampling ────────────────────────────────────────────────────────────
  /**
   * Colour under a point (eyedropper).
   * @param point - Document coords.
   * @param source - Active paint layer, the visible composite, or the background only.
   * @param size - Sample window side: 1 (point), 3 or 5 (average).
   * @returns `#rrggbb`, or `null` if the window is fully transparent / off the layer.
   */
  sampleColor(point, source, size) {
    const r = Math.max(0, Math.floor((size - 1) / 2));
    const rect = { x: Math.floor(point.x) - r, y: Math.floor(point.y) - r, width: r * 2 + 1, height: r * 2 + 1 };
    const layer = targetLayer(this.s.doc, "paint");
    if (source === "layer" && !layer) return null;
    this.scratch ??= document.createElement("canvas");
    const data = this.sampleArea(rect, sampleTarget(source, layer), this.scratch);
    const rgb = data ? averageColor(data) : null;
    return rgb ? rgbToHex(rgb) : null;
  }
  /** Release the scratch canvas. */
  dispose() {
    if (this.scratch) this.scratch.width = this.scratch.height = 0;
    this.scratch = null;
  }
  // ── Internals ───────────────────────────────────────────────────────────
  /**
   * RGBA of a document area as the bucket / wand / eyedropper see it: the
   * visible composite, the background only, or one layer (transparent
   * outside the bounds). The one sampling path of all three tools.
   * @param scratch - Reusable canvas for scene reads (eyedropper drags).
   */
  sampleArea(area, target, scratch2) {
    if (target.kind === "scene") return readDocRegion(sceneFor(this.compositeInput(), target.source), area, scratch2)?.data ?? null;
    const read = this.s.store.read(target.layer.id, area);
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
  /** The current image's rect in document coords (rounded out). */
  imageRectInDoc() {
    const s = this.s;
    const map = documentMap(s.doc, s.imageSize);
    const size = s.imageSize;
    return roundOutRect(imageRectToDoc(map, { x: 0, y: 0, width: size.width, height: size.height }));
  }
  /** "What the user sees": honours solo (view only), like the stage. */
  compositeInput() {
    return visibleScene(this.s);
  }
}
function inside(r, x, y) {
  return x >= r.x && y >= r.y && x < r.x + r.width && y < r.y + r.height;
}
const WHEEL_SCALE_STEP = 1.05;
const MAX_WHEEL_DELTA = 300;
function fitScale$1(frame, image) {
  return frameMap(frame, image).scale;
}
function translatePlacement(p, frame, image, dx, dy) {
  const s = fitScale$1(frame, image);
  return { x: p.x + dx / s, y: p.y + dy / s, scale: p.scale };
}
function scalePlacementAt(p, frame, image, factor, anchor) {
  const base = frameMap(frame, image);
  const now2 = frameMap(frame, image, p);
  const k = clampPlacementScale(p.scale * factor);
  const docX = (anchor.x - now2.offsetX) / now2.scale;
  const docY = (anchor.y - now2.offsetY) / now2.scale;
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
  const s = fitScale$1(frame, image);
  return { x: p.x * s, y: p.y * s };
}
function imageOffsetToPlacement(imagePx, frame, image) {
  return imagePx / fitScale$1(frame, image);
}
const PLACEMENT_MARGIN = 50;
function validSizes(frame, image) {
  return [frame.width, frame.height, image.width, image.height].every((v) => Number.isFinite(v) && v > 0);
}
function clampShift(t, lo, hi, mid) {
  if (lo > hi) return mid;
  return Math.min(hi, Math.max(lo, t));
}
function edgeLimits(frame, image, from) {
  const m = PLACEMENT_MARGIN;
  const strict = { left: -m, top: -m, right: image.width + m, bottom: image.height + m };
  if (!from) return strict;
  const r = docRectToImage(frameMap(frame, image, normalizePlacement(from)), boundsCap(frame));
  return {
    left: Math.max(strict.left, r.x),
    top: Math.max(strict.top, r.y),
    right: Math.min(strict.right, r.x + r.width),
    bottom: Math.min(strict.bottom, r.y + r.height)
  };
}
function placementScaleRange(frame, image, from) {
  const max = PLACEMENT_MAX_SCALE;
  if (!validSizes(frame, image)) return { min: PLACEMENT_MIN_SCALE, max, feasible: true };
  const cap = docRectToImage(frameMap(frame, image), boundsCap(frame));
  const e = edgeLimits(frame, image, from);
  const min = Math.max(PLACEMENT_MIN_SCALE, (e.right - e.left) / cap.width, (e.bottom - e.top) / cap.height);
  return { min, max, feasible: min <= max };
}
function clampPlacement(p, frame, image, from) {
  const n = normalizePlacement(p);
  if (!validSizes(frame, image)) return n;
  const range = placementScaleRange(frame, image, from);
  const scale = range.feasible ? Math.min(range.max, Math.max(range.min, n.scale)) : range.max;
  const s = frameMap(frame, image).scale;
  const cap = docRectToImage(frameMap(frame, image, { x: 0, y: 0, scale }), boundsCap(frame));
  const e = edgeLimits(frame, image, from);
  const tx = clampShift(n.x * s, e.right - (cap.x + cap.width), e.left - cap.x, (image.width - cap.width) / 2 - cap.x);
  const ty = clampShift(n.y * s, e.bottom - (cap.y + cap.height), e.top - cap.y, (image.height - cap.height) / 2 - cap.y);
  return { x: tx === n.x * s ? n.x : tx / s, y: ty === n.y * s ? n.y : ty / s, scale };
}
function clampedScaleAt(p, frame, image, factor, anchor) {
  const range = placementScaleRange(frame, image, p);
  const current = p.scale > 0 && Number.isFinite(p.scale) ? p.scale : 1;
  const wanted = current * (Number.isFinite(factor) && factor > 0 ? factor : 1);
  const k = range.feasible ? Math.min(range.max, Math.max(range.min, wanted)) : range.max;
  return clampPlacement(scalePlacementAt({ ...p, scale: current }, frame, image, k / current, anchor), frame, image, p);
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
   * @param clamp - `false`: store as given (Reset, drag cancel).
   */
  set(next, commit = true, clamp2 = true) {
    const s = this.s;
    const n = normalizePlacement(next);
    const p = clamp2 ? clampPlacement(n, s.doc.frame, s.imageSize, this.current) : n;
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
    this.set(clampedScaleAt(this.current, s.doc.frame, s.imageSize, factor, anchor), commit);
  }
  /** Back to identity, unclamped ("Reset position"; may violate the rule). */
  reset() {
    this.set(IDENTITY_PLACEMENT, true, false);
  }
}
const NO_SELECTION_NOTE = "Nothing is selected.";
const EMPTY_LAYER_NOTE = "The layer has no pixels.";
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
  /**
   * Ctrl+click on a layer row (Photoshop's thumbnail Ctrl+click): the layer's
   * alpha becomes the selection coverage (soft edges stay partial), combined
   * by `mode`. A mask uses its effective coverage (per-mask invert applied,
   * as the overlay shows it). Works on hidden layers; does not change the
   * current layer, Quick Mask or solo. An empty layer notes and leaves the
   * selection unchanged.
   * @param layerId - Paint, text or mask layer id.
   * @param mode - Combination mode.
   * @returns `true` if the selection changed.
   */
  fromLayer(layerId, mode) {
    const s = this.s;
    if (s.loading || s.stroke.active) return false;
    const layer = s.doc.layers.find((l) => l.id === layerId);
    if (!layer) return false;
    s.settleFloat();
    const px = s.store.read(layer.id, s.store.bounds);
    const alpha = px ? selectionFromAlpha(px.data.data, px.rect) : null;
    if (!alpha) {
      s.events.emit("note", EMPTY_LAYER_NOTE);
      return false;
    }
    const next = layer.kind === "mask" && layer.invert === true ? invertSelection(alpha) : alpha;
    return this.apply(hardenSelection(next), mode);
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
    const rgb = hexToRgb(layer.kind === "mask" ? MASK_STROKE_COLOR : color);
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
    const white = hexToRgb(MASK_STROKE_COLOR);
    return this.editPixels(layer, (px, rect, cov, stride) => blendCoverage(px, rect, cov, stride, white, 1));
  }
  // ── Internals ───────────────────────────────────────────────────────────
  change(next) {
    const s = this.s;
    if (s.loading || s.stroke.active) return false;
    s.settleFloat();
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
  /**
   * The shared pixel-edit gate (`rasterize.ts`): lock/visibility notes, and a
   * text layer is rasterized first (the edit joins that undo step).
   */
  canEdit(layer) {
    return preparePixelEdit(this.s, layer) !== "blocked";
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
function missingFontNote(font) {
  return `Font '${font}' isn't installed; editing will use a fallback.`;
}
class TextOps {
  /**
   * @param s - Shared editor state.
   * @param layers - Layer commands (undoable add / delete / active layer).
   */
  constructor(s, layers2) {
    this.s = s;
    this.layers = layers2;
    s.commitTextEdit = () => {
      this.commit();
    };
  }
  s;
  layers;
  session = null;
  /** The open edit, or `null`. */
  get editing() {
    const e = this.session;
    const layer = e ? this.find(e.layerId) : void 0;
    return e && layer?.kind === "text" && layer.textData ? { layerId: e.layerId, textData: layer.textData } : null;
  }
  /**
   * Install the rasterize prompt (the engine has no DOM UI; `rasterize.ts`).
   * @param confirm - Returns `true` when the user agrees.
   */
  setConfirmRasterize(confirm) {
    this.s.confirmRasterize = confirm;
  }
  /**
   * Top-most visible text layer under a point.
   * @param point - Document coords.
   * @returns Layer id, or `null`.
   */
  hitTest(point) {
    return hitTestText(this.s.doc.layers, point, (td) => textLayout(td).box);
  }
  /**
   * Create an empty text layer above the active paint layer (undoable add)
   * and open it for editing. Commits any open edit first.
   * @param at - Anchor (first baseline), document coords.
   * @param style - Font, size (document px), colour, bold/italic, alignment.
   * @returns New layer id, or `null` while loading / stroking.
   */
  create(at, style) {
    this.commit();
    const s = this.s;
    if (s.loading || s.stroke.active) return null;
    const textData = { ...style, text: "", x: at.x, y: at.y };
    const layer = createTextLayer(textData);
    if (!this.layers.addLayer(layer)) return null;
    this.session = { layerId: layer.id, created: true, before: textData, beforeName: layer.name };
    s.events.emit("text", void 0);
    this.noteMissingFont(textData.font);
    return layer.id;
  }
  /**
   * Open an existing text layer for editing (makes it active). Commits any
   * other open edit first; locked / hidden layers show a note.
   * @param layerId - Text layer id.
   * @returns `true` if the edit is open.
   */
  edit(layerId) {
    if (this.session?.layerId === layerId) return true;
    this.commit();
    const s = this.s;
    s.settleFloat();
    const layer = this.find(layerId);
    if (s.loading || s.stroke.active || layer?.kind !== "text" || !layer.textData) return false;
    const note = editBlockNote(s, layer);
    if (note) {
      s.events.emit("note", note);
      return false;
    }
    this.layers.setActiveLayer(layerId);
    this.session = { layerId, created: false, before: layer.textData, beforeName: layer.name };
    s.events.emit("text", void 0);
    this.noteMissingFont(layer.textData.font);
    return true;
  }
  /**
   * Live change of the open edit (text or style); re-renders, no history.
   * @param patch - Fields to change.
   */
  update(patch) {
    const e = this.session;
    const layer = e ? this.find(e.layerId) : void 0;
    const td = layer?.kind === "text" ? layer.textData : void 0;
    if (!layer || !td) return;
    const next = { ...td, ...patch };
    if (sameTextData(next, td)) return;
    layer.textData = next;
    renderTextLayer(this.s, layer);
    this.s.runtime.bump(layer.id);
    this.s.events.emit("text", void 0);
    this.s.events.emit("render", void 0);
    if (next.font !== td.font) this.noteMissingFont(next.font);
  }
  /**
   * Rotation (degrees) of a text layer that is not being edited (Text tool
   * angle field; M11b). Consecutive changes on the same layer merge into
   * one text step (gesture `text-angle`), like arrow nudges.
   * @param layerId - Text layer id.
   * @param deg - Rotation, degrees.
   * @returns `true` if the layer changed.
   */
  setRotation(layerId, deg) {
    const s = this.s;
    if (this.session?.layerId === layerId) {
      const td2 = this.editing?.textData;
      if (td2) this.update({ rotation: withRotation(td2, deg).rotation ?? 0 });
      return td2 !== void 0;
    }
    const layer = this.find(layerId);
    const td = layer?.kind === "text" ? layer.textData : void 0;
    if (s.loading || s.stroke.active || !layer || !td) return false;
    s.settleFloat();
    const note = editBlockNote(s, layer);
    if (note) {
      s.events.emit("note", note);
      return false;
    }
    const next = withRotation(td, deg);
    if (sameTextData(next, td)) return false;
    const before = textStateOf(layer);
    layer.textData = next;
    renderTextLayer(s, layer);
    recordTextChange(s, layer.id, before, textStateOf(layer), "text-angle");
    s.runtime.touch(layer.id);
    s.afterEdit();
    return true;
  }
  /**
   * Close the open edit: record it as one undo step (or remove an empty
   * layer). No-op without an edit.
   * @returns `true` if the history gained / changed an undo step.
   */
  commit() {
    const e = this.session;
    if (!e) return false;
    this.session = null;
    const layer = this.find(e.layerId);
    let recorded = false;
    if (layer?.kind === "text" && layer.textData) {
      recorded = layer.textData.text.trim() ? this.record(layer, layer.textData, e) : this.removeEmpty(layer, e);
    }
    this.s.events.emit("text", void 0);
    return recorded;
  }
  // ── Internals ───────────────────────────────────────────────────────────
  /** Note when the edited font is not installed (the canvas falls back). */
  noteMissingFont(font) {
    if (!isFontAvailable(font)) this.s.events.emit("note", missingFontNote(font));
  }
  find(layerId) {
    return this.s.doc.layers.find((l) => l.id === layerId);
  }
  /** The newest history entry if it is this session's own "add layer". */
  ownAddEntry(layerId) {
    const top = this.s.history.mergeTarget();
    const change = top?.kind === "layers" && top.changes.length === 1 ? top.changes[0] : void 0;
    return top?.kind === "layers" && change?.op === "insert" && change.layer.id === layerId ? { entry: top, change } : null;
  }
  record(layer, td, e) {
    const s = this.s;
    const name = e.created ? nameFromText(td.text) : commitName(layer.name, e.before.text, td.text);
    const own = e.created ? this.ownAddEntry(layer.id) : null;
    if (own) {
      layer.name = name;
      own.change.layer = { ...layer };
    } else {
      if (sameTextData(td, e.before) && name === layer.name) return false;
      const before = { kind: "text", name: e.beforeName, textData: e.before };
      layer.name = name;
      recordTextChange(s, layer.id, before, textStateOf(layer));
    }
    s.runtime.touch(layer.id);
    s.afterEdit();
    emitLayerEvents(s);
    return true;
  }
  removeEmpty(layer, e) {
    const s = this.s;
    const own = e.created ? this.ownAddEntry(layer.id) : null;
    if (own) {
      s.history.discardNewest();
      s.doc.layers.splice(s.doc.layers.indexOf(layer), 1);
      s.runtime.remove(layer.id);
      releaseRemovedLayers(s);
      if (s.doc.layers.some((l) => l.id === own.entry.activeBefore)) s.doc.activeLayerId = own.entry.activeBefore;
      emitLayerEvents(s);
      s.afterEdit();
      return false;
    }
    layer.textData = e.before;
    renderTextLayer(s, layer);
    s.runtime.bump(layer.id);
    if (this.layers.remove(layer.id)) return true;
    s.events.emit("render", void 0);
    return false;
  }
}
const ENTRY_OVERHEAD_BYTES = 128;
class RegionOps {
  /**
   * @param s - Shared editor state.
   */
  constructor(s) {
    this.s = s;
  }
  s;
  /** Snapshot taken by {@link begin}; null while no gesture is open. */
  before = null;
  /** The open gesture has changed the document at least once. */
  touched = false;
  // ── Read access ─────────────────────────────────────────────────────────
  /** Selected region id; null = Main (also when the stored id no longer exists). */
  get selectedId() {
    const id = this.s.selectedRegionId;
    return id !== null && this.find(id) ? id : null;
  }
  /** Whether a field, picker or drag gesture is open. */
  get active() {
    return this.before !== null;
  }
  /**
   * Whether another region can be created.
   * @returns `true` while a slot is empty.
   */
  canAdd() {
    return nextRegionSlot(this.s.doc.regions) !== null;
  }
  /**
   * Region in a slot.
   * @param slot - Slot 1..6.
   * @returns The region, or undefined for an empty slot.
   */
  inSlot(slot) {
    return this.s.doc.regions.find((region) => region.slot === slot);
  }
  /**
   * Current rect of a region.
   * @param id - Region id.
   * @returns A copy of its rect (image px), or null.
   */
  imageRect(id) {
    const region = this.find(id);
    return region ? { ...region.rect } : null;
  }
  /**
   * Output options of Main or a region.
   * @param id - Region id, or null for Main.
   * @returns Independent copy (defaults when absent).
   */
  options(id) {
    const source = id === null ? this.s.doc.mainOutput : this.find(id)?.output;
    return cloneOutputOptions(source);
  }
  // ── Selection (not a document edit) ─────────────────────────────────────
  /**
   * Select a region or Main. Emits `outputs` + `render`, never `change`.
   * @param id - Region id, or null for Main (unknown ids select Main).
   */
  select(id) {
    const next = id !== null && this.find(id) ? id : null;
    if (next === this.selectedId) return;
    this.s.selectedRegionId = next;
    this.s.events.emit("outputs", void 0);
    this.s.events.emit("render", void 0);
  }
  // ── Transactions ────────────────────────────────────────────────────────
  /**
   * Open a gesture; repeated calls join the open one.
   * @returns Whether editing is allowed (not while loading or stroking).
   */
  begin() {
    if (this.s.loading || this.s.stroke.active) return false;
    this.s.settleFloat();
    if (!this.before) {
      this.before = captureOutputs(this.s);
      this.touched = false;
    }
    return true;
  }
  /**
   * Close the gesture as one undo step. A gesture that ends where it started
   * leaves no step (redo survives) and restores optional-field presence.
   * @returns Whether an undo step was pushed.
   */
  commit() {
    const before = this.before;
    const touched = this.touched;
    this.before = null;
    this.touched = false;
    if (!before || !touched) return false;
    const after = captureOutputs(this.s);
    const beforeKey = outputsKey(before);
    const afterKey = outputsKey(after);
    if (beforeKey === afterKey) {
      this.restore(before);
      return false;
    }
    const bytes = ENTRY_OVERHEAD_BYTES + 2 * (beforeKey.length + afterKey.length);
    this.s.history.push({ kind: "outputs", before, after, bytes });
    this.s.afterEdit();
    return true;
  }
  /** Revert the open gesture without touching undo/redo. Keeps the current selection. */
  cancel() {
    const before = this.before;
    const touched = this.touched;
    this.before = null;
    this.touched = false;
    if (before && touched) this.restore(before);
  }
  // ── Edits ───────────────────────────────────────────────────────────────
  /**
   * Create a region in the lowest empty slot (or a given one) and select it.
   * @param rect - Rect in image px (clamped to the paint area).
   * @param slot - Empty slot to fill; default = lowest empty slot.
   * @returns New region id, or null (no empty slot, slot taken, bad rect).
   */
  add(rect, slot = nextRegionSlot(this.s.doc.regions)) {
    if (slot === null || !isRegionSlot(slot) || this.inSlot(slot) || !validRect(rect)) return null;
    const id = crypto.randomUUID();
    const region = createRegion(id, slot, clampRegionRect(rect, this.s.imageSize));
    this.edit(() => {
      this.s.doc.regions.push(region);
      this.s.selectedRegionId = id;
    });
    return id;
  }
  /**
   * Fill an empty slot with the centred default rect (`+ Region N` row).
   * @param slot - Slot 1..6.
   * @returns New region id, or null if the slot is taken.
   */
  addDefault(slot) {
    return this.add(defaultRegionRect(this.s.imageSize), slot);
  }
  /**
   * Empty a region's slot; other slots keep their numbers.
   * @param id - Region id.
   */
  remove(id) {
    if (!this.find(id)) return;
    this.edit(() => {
      this.s.doc.regions = this.s.doc.regions.filter((region) => region.id !== id);
      if (this.s.selectedRegionId === id) this.s.selectedRegionId = null;
    });
  }
  /**
   * Set a region's rect.
   * @param id - Region id.
   * @param rect - Rect in image px (clamped to the paint area).
   */
  setRect(id, rect) {
    const region = this.find(id);
    if (!region || !validRect(rect)) return;
    const next = clampRegionRect(rect, this.s.imageSize);
    if (rectEquals(next, region.rect)) return;
    this.edit(() => {
      region.rect = next;
    });
  }
  /**
   * Rename a region.
   * @param id - Region id.
   * @param input - Typed name (trimmed; empty = `Region N`).
   */
  rename(id, input) {
    const region = this.find(id);
    if (!region) return;
    const name = commitRegionName(input, region.slot);
    if (region.name === name) return;
    this.edit(() => {
      region.name = name;
    });
  }
  /**
   * Show or hide a region's overlay (execution is unaffected).
   * @param id - Region id.
   * @param visible - New visibility.
   */
  setVisible(id, visible) {
    const region = this.find(id);
    if (!region || region.visible === visible) return;
    this.edit(() => {
      region.visible = visible;
    });
  }
  /**
   * Change output options of Main or a region.
   * @param id - Region id, or null for Main.
   * @param patch - Changed options (normalized).
   */
  setOptions(id, patch) {
    const region = id === null ? null : this.find(id);
    if (id !== null && !region) return;
    const old = this.options(id);
    const next = readOutputOptions({ ...old, ...patch });
    if (outputOptionsEqual(old, next)) return;
    this.edit(() => {
      if (region) region.output = next;
      else this.s.doc.mainOutput = next;
    });
  }
  // ── Internals ───────────────────────────────────────────────────────────
  find(id) {
    return this.s.doc.regions.find((region) => region.id === id);
  }
  /**
   * Apply one mutation inside the open gesture, or as its own one-step
   * gesture when none is open.
   */
  edit(mutate) {
    const own = !this.active;
    if (!this.begin()) return;
    mutate();
    this.touched = true;
    this.s.events.emit("outputs", void 0);
    this.s.events.emit("change", void 0);
    this.s.events.emit("render", void 0);
    if (own) this.commit();
  }
  /** Put the document back to a snapshot, keeping the live selection when it still exists. */
  restore(snapshot) {
    const selected = this.s.selectedRegionId;
    applyOutputs(this.s, snapshot);
    const kept = selected !== null && this.find(selected) ? selected : snapshot.selected;
    this.s.selectedRegionId = kept;
    this.s.events.emit("change", void 0);
    this.s.events.emit("render", void 0);
  }
}
function validRect(rect) {
  const finite2 = [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite);
  return finite2 && !isEmptyRect(rect);
}
class ResolutionOps {
  /**
   * @param s - Shared editor state.
   */
  constructor(s) {
    this.s = s;
  }
  s;
  /**
   * Current mismatch against the image, or `null` when no image size is known.
   * @returns Ratio and label numbers.
   */
  info() {
    const s = this.s;
    if (!s.backgroundSize) return null;
    return resolutionInfo(s.doc, s.imageSize);
  }
  /**
   * Whether the image area fits the maximum paint area (`imageFits`);
   * `true` when no image size is known.
   * @returns Fit state.
   */
  fits() {
    const s = this.s;
    if (!s.backgroundSize) return true;
    return imageFits({ frame: s.doc.frame, bounds: s.store.bounds, placement: s.doc.placement }, s.imageSize);
  }
  /**
   * What the notice should show: `null` for nothing (also for an empty
   * document, which adopts the image size anyway, and while loading);
   * `"resolution"` when the ratio is too high (takes precedence; Match fixes
   * the shape too); `"fit"` when only the image's shape doesn't fit.
   * @returns Notice case.
   */
  notice() {
    const s = this.s;
    const info = this.info();
    if (!info || s.loading || s.isEmpty) return null;
    if (info.mismatch) return { kind: "resolution", info };
    return this.fits() ? null : { kind: "fit", info };
  }
  /**
   * Whether Match image resolution would crop content (bounds side limit).
   * @returns `true` if some paint would be cut off.
   */
  wouldCrop() {
    const s = this.s;
    return matchGeometry({ frame: s.doc.frame, bounds: s.store.bounds, placement: s.doc.placement }, s.imageSize).cropped;
  }
  /**
   * Resample to the image resolution (never lowers resolution; no-op unless
   * {@link notice} applies). Callers settle floats / open edits first.
   * @returns `true` if the document changed.
   */
  match() {
    const s = this.s;
    if (!this.notice()) return false;
    if (s.stroke.active) s.cancelStroke();
    const g = matchGeometry({ frame: s.doc.frame, bounds: s.store.bounds, placement: s.doc.placement }, s.imageSize);
    const { factor, tx, ty } = g.transform;
    s.store.resample(g.bounds, factor, tx, ty);
    s.stroke.rebase(g.bounds);
    s.doc.frame = { ...g.frame };
    s.doc.bounds = { ...g.bounds };
    if (g.placement) s.doc.placement = { ...g.placement };
    else delete s.doc.placement;
    const source = s.background.kind === "image" ? "image" : "widgets";
    s.frameSource = source;
    for (const layer of s.doc.layers) {
      if (layer.kind !== "text" || !layer.textData) continue;
      layer.textData = scaleTextData(layer.textData, g.transform);
      renderTextLayer(s, layer);
    }
    for (const layer of s.doc.layers) {
      if (s.runtime.get(layer.id)?.hasContent) s.runtime.touch(layer.id);
      else s.runtime.bump(layer.id);
    }
    s.history.clear();
    s.selection.set(null);
    s.lastStrokeEnd = null;
    s.syncViewFrame();
    s.events.emit("placement", void 0);
    s.events.emit("layers", void 0);
    s.afterEdit();
    return true;
  }
}
function fitScale(source, area) {
  if (source.width <= 0 || source.height <= 0 || area.width <= 0 || area.height <= 0) return 1;
  return Math.min(1, area.width / source.width, area.height / source.height);
}
function insertParams(source, imageArea, docPerImage, place) {
  const k = fitScale(source, { width: imageArea.width / docPerImage, height: imageArea.height / docPerImage });
  const t = k * docPerImage;
  const w = source.width * t;
  const h = source.height * t;
  const tl = pasteTopLeft({ width: w, height: h }, { ...place, imageArea, original: null });
  return { cx: tl.x + w / 2, cy: tl.y + h / 2, sx: t, sy: t, angle: 0 };
}
class SourceInsertOps {
  /**
   * @param s - Shared editor state.
   * @param layers - Layer commands (undoable add + solo rule).
   * @param float - Float commands (the session runs on a float).
   * @param paintTargetOff - Turns Quick Mask off.
   * @param undo - Undo one history step (`PaintOps.undo`).
   */
  constructor(s, layers2, float, paintTargetOff, undo) {
    this.s = s;
    this.layers = layers2;
    this.float = float;
    this.paintTargetOff = paintTargetOff;
    this.undo = undo;
  }
  s;
  layers;
  float;
  paintTargetOff;
  undo;
  /**
   * New layer holding `pixels` in a Free Transform session (see module doc).
   * @param pixels - Full-resolution source pixels (straight alpha).
   * @param name - Layer name (source file name); default "Image N" (next free N).
   * @returns `true` if the session runs.
   */
  insert(pixels, name) {
    return this.start(
      pixels,
      name?.trim() || imageLayerName(this.s.doc.layers),
      (place, area, docPerImage) => insertParams({ width: pixels.width, height: pixels.height }, area, docPerImage, place)
    ) !== null;
  }
  /**
   * An oversized paste (SPEC M10 Clipboard): the same session, at native
   * size and the paste's own placement (`pastePlacement.ts`, no fit scaling).
   * @param pixels - Full source pixels (straight alpha).
   * @param name - Layer name ("Pasted N").
   * @param rect - Placed document rect of the whole paste (`pasteRect`).
   * @returns The new layer id if the session runs, else `null`.
   */
  insertPlaced(pixels, name, rect) {
    const sx = rect.width / pixels.width;
    const sy = rect.height / pixels.height;
    return this.start(pixels, name, () => ({ cx: rect.x + rect.width / 2, cy: rect.y + rect.height / 2, sx, sy, angle: 0 }));
  }
  /** Shared body of {@link insert} / {@link insertPlaced}. */
  start(pixels, name, paramsFor) {
    const s = this.s;
    if (s.loading || pixels.width <= 0 || pixels.height <= 0) return null;
    s.settleFloat();
    s.commitTextEdit();
    if (s.stroke.active) s.cancelStroke();
    if (this.float.active || this.float.transform.active) return null;
    if (s.target === "mask") this.paintTargetOff();
    const layer = createPaintLayer(name);
    const id = this.layers.addLayer(layer);
    if (!id) return null;
    const map = documentMap(s.doc, s.imageSize);
    const sel = s.selection.current;
    const place = pasteContext({ selection: sel, view: s.view.current, stage: s.view.stageSize, map, imageSize: s.imageSize }, null);
    if (sel) {
      s.selection.set(null);
      recordSelectionMove(s, sel, null, true);
    }
    const step = s.history.mergeTarget();
    const docPerImage = 1 / map.scale;
    const area = imageRectToDoc(map, frameRect(s.imageSize));
    const { width: w, height: h } = pixels;
    const params = paramsFor(place, area, docPerImage);
    const m = paramsMatrix(params, w, h);
    s.ensureBounds(transformedAabb(m, w, h), true);
    const surface = createSurface(w, h);
    surface.ctx.putImageData(pixels, 0, 0);
    const f = {
      layerId: id,
      area: { x: 0, y: 0, width: w, height: h },
      // The layer is empty: a 1 px transparent "hole" inside the bounds keeps the commit patch small.
      original: new ImageData(1, 1),
      holeRect: holeAt(s.store.bounds, params),
      params,
      pixels,
      surface,
      dx: 0,
      dy: 0,
      selBefore: null,
      selBase: null,
      xf: m,
      baked: null,
      dragBase: null,
      preview: null,
      inserted: true,
      onEnd: (landed) => this.ended(id, step, landed)
    };
    if (!this.float.adoptInserted(f)) return null;
    return this.float.transform.enter() ? id : null;
  }
  /** The inserted float ended: join its steps, or remove the layer without a trace. */
  ended(layerId, step, landed) {
    const s = this.s;
    if (!step) return;
    if (landed) {
      s.history.joinSince(step);
      return;
    }
    if (s.history.mergeTarget() !== step) return;
    this.undo();
    s.history.dropRedo();
    s.kept.drop(layerId);
    s.events.emit("history", void 0);
  }
}
function holeAt(bounds, p) {
  const clamp2 = (v, lo, size) => Math.min(lo + size - 1, Math.max(lo, Math.floor(v)));
  return { x: clamp2(p.cx, bounds.x, bounds.width), y: clamp2(p.cy, bounds.y, bounds.height), width: 1, height: 1 };
}
class Editor extends EditorBase {
  /** Layer list commands (add/delete/duplicate/reorder/rename/visibility/lock/opacity/active). */
  layerOps;
  /** Paint-bucket fill and eyedropper sampling. */
  pixelOps;
  /** Move-tool placement of the whole drawing (not undoable). */
  placement;
  /** Layer Move tool (V): move the active layer's content (undoable). */
  layerMove;
  /** Selection (session state, undoable) and its pixel commands. */
  selection;
  /** Text tool: create / edit / commit text layers (M6b). */
  text;
  /** Region rectangles, output options and metadata gesture transactions. */
  regionOps;
  /** Floating selection (M10a): lift / move / commit / cancel selected pixels. */
  float;
  /** Outline-only selection drag (selection tools, plain drag inside). */
  selectionMove;
  /** Copy / cut / paste pixels (M10b; the clipboards themselves live in the UI). */
  clipboard;
  /** Drawing-grid vs image resolution check + Match image resolution. */
  resolution;
  /** Image sources (M12): insert as a new layer in Free Transform (`sourceInsert.ts`). */
  insert;
  maskOps;
  /**
   * @param doc - Document (copied).
   * @param source - Origin of its frame size.
   * @param store - Existing pixels (for clones); a blank store is created otherwise.
   * @param colors - Colour state to start from (forks copy their source's).
   */
  constructor(doc, source, store2, colors) {
    super(doc, source, store2, colors);
    this.layerOps = new LayerOps(this.s);
    this.pixelOps = new PixelOps(this.s);
    this.placement = new PlacementOps(this.s);
    this.layerMove = new LayerMoveOps(this.s);
    this.selection = new SelectionOps(this.s);
    this.maskOps = new EditorMaskOps(this.s, this.paint);
    this.text = new TextOps(this.s, this.layerOps);
    this.regionOps = new RegionOps(this.s);
    this.float = new FloatOps(this.s);
    this.selectionMove = new SelectionMoveOps(this.s);
    this.clipboard = new ClipboardOps(this.s, this.layerOps, () => this.maskOps.setPaintTarget("paint"), (px, n, r) => this.insert.insertPlaced(px, n, r));
    this.resolution = new ResolutionOps(this.s);
    this.insert = new SourceInsertOps(this.s, this.layerOps, this.float, () => this.maskOps.setPaintTarget("paint"), () => this.paint.undo());
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
    return (this.s.history.canUndo || this.float.active || this.float.transform.active) && !this.s.stroke.active;
  }
  /** Redo available. */
  get canRedo() {
    return this.s.history.canRedo && !this.s.stroke.active && !this.float.active && !this.float.transform.active;
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
    return this.maskOps.hiddenMaskHasContent();
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
  /**
   * Canvas to SAVE for a layer: its pixels, or -- while it has a floating
   * selection -- the pixels as they were before the lift (a float is never
   * half-saved; queueing commits it first, `Editor.settle`).
   * @param layerId - Layer id.
   * @returns The canvas (a temporary copy while floating).
   */
  savedLayerCanvas(layerId) {
    const canvas = this.s.store.ensure(layerId).canvas;
    const patch = this.float.savedPatch(layerId);
    if (!patch) return canvas;
    const b = this.s.store.bounds;
    const copy = createSurface(canvas.width, canvas.height);
    copy.ctx.drawImage(canvas, 0, 0);
    copy.ctx.putImageData(patch.data, patch.x - b.x, patch.y - b.y);
    return copy.canvas;
  }
  /** Commit a floating selection, if any (before queueing / serializing). */
  settle() {
    this.s.settleFloat();
  }
  /**
   * Ctrl+E: merge the current row into the row below (`mergeDown.ts`).
   * @returns `true` if merged.
   */
  mergeDown() {
    return mergeDown(this.s);
  }
  /** @returns Whether {@link mergeDown} would merge now (footer button state). */
  canMergeDown() {
    return canMergeDown(this.s);
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
  /** Soloed layer ids (view only, `solo.ts`; not saved, not undoable, no effect on outputs). */
  get solo() {
    return this.s.solo.current;
  }
  /**
   * Solo a paint/text layer or mask (replaces its group's solo), or end it if it is the active solo.
   * @param layerId - Layer id, or `BACKGROUND_SOLO_ID` for the Background row (unknown ids are ignored).
   */
  toggleSolo(layerId) {
    const layer = layerId === BACKGROUND_SOLO_ID ? { id: layerId, kind: "paint" } : this.s.doc.layers.find((l) => l.id === layerId);
    if (layer) this.s.settleFloat();
    if (layer) this.s.solo.set(toggleSolo(this.s.solo.current, layer));
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
    this.s.settleFloat();
    this.maskOps.setPaintTarget(target);
  }
  /** Toggle between the paint layer and the current mask. */
  togglePaintTarget() {
    this.s.settleFloat();
    this.maskOps.togglePaintTarget();
  }
  /**
   * Make a mask the current mask and turn Quick Mask on (mask row click).
   * @param layerId - Mask layer id.
   * @returns `false` if it is not a mask layer.
   */
  selectMask(layerId) {
    this.s.settleFloat();
    return this.maskOps.selectMask(layerId);
  }
  /**
   * Show or hide the mask layer (adds one if missing). Hidden mask layers are
   * also excluded from the `MASK` output (saved-file contract).
   * @param visible - Visibility.
   */
  setMaskVisible(visible) {
    this.s.settleFloat();
    this.maskOps.setMaskVisible(visible);
  }
  /**
   * Where a lazily added mask layer (documents without one) gets its colour
   * and opacity; read only when a mask is created. Existing masks never change.
   * @param style - Provider (the session reads the user's settings).
   */
  setMaskStyleProvider(style) {
    this.s.maskStyle = style;
  }
  // ── Background / frame ──────────────────────────────────────────────────
  // ── Undo / redo ─────────────────────────────────────────────────────────
  /**
   * Undo the last operation; with a text edit open: commit it, then undo it
   * (a no-op edit just closes). A floating selection is cancelled instead.
   */
  undo() {
    if (this.float.active || this.float.transform.active) {
      this.float.cancel();
      return;
    }
    this.layerMove.cancel();
    if (this.regionOps.active) {
      this.regionOps.cancel();
      return;
    }
    if (!this.text.editing || this.text.commit()) this.paint.undo();
  }
  /** Redo the last undone operation (an open text edit is committed first). Ignored while floating. */
  redo() {
    if (this.float.active || this.float.transform.active) return;
    this.regionOps.cancel();
    this.text.commit();
    this.paint.redo();
  }
  /** Clear paint and output metadata in the existing single Clear history step. */
  clear() {
    this.s.settleFloat();
    this.regionOps.cancel();
    super.clear();
  }
  /**
   * Match image resolution (`resolutionOps.ts`): settle float / open edits, resample every layer, clear history.
   * @returns `true` if the document changed.
   */
  matchImageResolution() {
    this.s.settleFloat();
    this.layerMove.cancel();
    this.regionOps.cancel();
    this.text.commit();
    return this.resolution.match();
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
    const store2 = this.s.store.clone();
    for (const layer of doc.layers) {
      const patch = this.float.savedPatch(layer.id);
      if (patch) store2.write(layer.id, patch.x, patch.y, patch.data);
    }
    const copy = new Editor(doc, this.s.frameSource, store2, this.colors);
    copy.s.runtime.copyFrom(this.s.runtime);
    copy.s.maskStyle = this.s.maskStyle;
    copy.s.currentMaskId = this.s.currentMaskId;
    copy.setBackground(this.s.background, this.s.backgroundSize);
    return copy;
  }
  /** Estimated memory held (pixels + history; mask tint caches excluded). */
  get bytes() {
    return this.s.store.bytes + this.s.history.totalBytes + this.s.selection.bytes + this.s.kept.bytes;
  }
  /** Release everything. */
  dispose() {
    this.s.stroke.dispose();
    this.s.store.dispose();
    this.display.dispose();
    this.pixelOps.dispose();
    this.s.selection.dispose();
    this.s.history.clear();
    this.events.clear();
    this.colors.events.clear();
  }
}
const PAINT_OPTION_DESCRIPTORS = [
  { kind: "number", key: "size", label: "Size", title: "Brush size ([ / ])", min: 1, max: 1e3, step: 1, unit: "px", curve: "pow" },
  { kind: "number", key: "hardness", label: "Hard", title: "Hardness (Shift+[ / ])", min: 0, max: 100, step: 1, unit: "%", scale: 100 },
  { kind: "number", key: "opacity", label: "Opac", title: "Opacity (1..9, 0)", min: 1, max: 100, step: 1, unit: "%", scale: 100 },
  { kind: "number", key: "flow", label: "Flow", title: "Flow (per-dab strength)", min: 1, max: 100, step: 1, unit: "%", scale: 100 },
  { kind: "number", key: "spacing", label: "Spc", title: "Spacing (% of diameter)", min: 1, max: 400, step: 1, unit: "%", scale: 100 },
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
  /** Distance travelled since the last dab when the previous stroke ended (a Shift-click line carries it on). */
  residual = 0;
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
    const lineStart = first.shiftKey ? editor.lastStrokeEnd : null;
    if (!editor.beginStroke(style, this.docSize)) return;
    this.spacer = lineStart ? createSpacer({ x: lineStart.x, y: lineStart.y, pressure: first.pressure }, this.residual) : createSpacer();
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
    this.residual = this.spacer.residual;
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
  /** @inheritdoc -- like Photoshop's cursor, the ring shrinks with softness (`ringDiameter`). */
  cursor() {
    return { kind: "ring", diameter: ringDiameter(this.values.size, this.values.hardness) };
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
function createBrushTool(pressure = PRESSURE_DEFAULTS) {
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
      spacing: 0.25,
      ...pressure
    }
  });
}
function createEraserTool(pressure = PRESSURE_DEFAULTS) {
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
      spacing: 0.25,
      ...pressure
    }
  });
}
const SAMPLE_CHOICES = [
  { value: "layer", label: "Current layer" },
  { value: "all", label: "All layers" },
  { value: "background", label: "Background" }
];
const DESCRIPTORS$4 = [
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
  /** Sample defaults to the background (fill regions of the input image); the setting `PainterSketch.BucketSample` can change it. */
  values;
  options;
  /**
   * @param sample - Initial sample source (settings default).
   */
  constructor(sample = "background") {
    this.values = { tolerance: 32, opacity: 1, contiguous: true, antiAlias: true, sample };
    this.options = new OptionSet(DESCRIPTORS$4, this.values);
  }
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
function createFillTool(sample) {
  return new FillTool(sample);
}
const DESCRIPTORS$3 = [
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
    this.options = new OptionSet(DESCRIPTORS$3, this.values);
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
const CLICK_SLOP_PX$2 = 3;
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
  constructor(now2 = () => performance.now()) {
    this.now = now2;
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
      slop: imageLengthToDoc(map, CLICK_SLOP_PX$2 / (scale > 0 ? scale : 1)),
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
const DESCRIPTORS$2 = [
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
  /** Sample defaults to the background (select regions of the input image); the setting `PainterSketch.WandSample` can change it. */
  values;
  options;
  /**
   * @param sample - Initial sample source (settings default).
   */
  constructor(sample = "background") {
    this.values = { tolerance: 32, contiguous: true, antiAlias: true, sample };
    this.options = new OptionSet(DESCRIPTORS$2, this.values);
  }
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
function createMagicWandTool(sample) {
  return new MagicWandTool(sample);
}
const CLICK_SLOP_PX$1 = 3;
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
      slop: imageLengthToDoc(editor.frameMap, CLICK_SLOP_PX$1 / (viewScale > 0 ? viewScale : 1)),
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
const OFFSET_LIMIT$1 = 16384;
const DESCRIPTORS$1 = [
  { kind: "number", key: "x", label: "X", title: "Horizontal offset (image px; arrows nudge)", min: -OFFSET_LIMIT$1, max: OFFSET_LIMIT$1, step: 1, unit: "px" },
  { kind: "number", key: "y", label: "Y", title: "Vertical offset (image px; arrows nudge)", min: -OFFSET_LIMIT$1, max: OFFSET_LIMIT$1, step: 1, unit: "px" },
  { kind: "number", key: "scale", label: "Scale", title: "Drawing scale (wheel while dragging)", min: 5, max: 1e3, step: 0.1, unit: "%", scale: 100, curve: "pow" },
  { kind: "button", key: "reset", label: "Reset position", title: "Put the drawing back where it was painted", group: "reset" }
];
const ARROWS$2 = {
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
  descriptors = DESCRIPTORS$1;
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
  /** No keyboard shortcut; V is the layer Move tool (`moveLayer.ts`). */
  shortcut = "";
  icon = "moveDrawing";
  /** Hidden from the tool rail; activated by the layers panel footer toggle. */
  rail = false;
  /** Ctrl never swaps in the layer Move tool while moving the drawing. */
  ctrlMove = false;
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
    if (drag) editor.placement.set(drag.start, true, false);
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
    const dir = ARROWS$2[event.key];
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
const DESCRIPTORS = [
  { kind: "toggle", key: "autoSelect", label: "Auto-select", title: "Pick the layer under the pointer (hold Ctrl for a one-off pick)" }
];
const ARROWS$1 = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1]
};
class MoveLayerTool {
  id = "move-layer";
  label = "Move layer";
  shortcut = "v";
  icon = "move";
  /** Ctrl is this tool's own auto-select modifier; it never substitutes itself. */
  ctrlMove = false;
  values = { autoSelect: false };
  options = new OptionSet(DESCRIPTORS, this.values);
  /** Pointer-down position (document coords) while dragging. */
  start = null;
  /** The current drag moves a floating selection. */
  floating = false;
  /** Action the stage runs after ending this press (text rasterize confirm). */
  deferred = null;
  /** @inheritdoc */
  takeDeferred() {
    const action = this.deferred;
    this.deferred = null;
    return action;
  }
  /** @inheritdoc */
  onPointerDown(editor, samples) {
    const first = samples[0];
    if (!first) return;
    this.deferred = null;
    const float = editor.float;
    if (!float.active && editor.selectionMove.hit(first.x, first.y)) {
      const check = float.check();
      if (check === "confirm") this.deferred = () => float.prepareLift();
      if (check !== "ok" || !float.lift(first.altKey)) return;
    }
    if (float.active) {
      if (!float.beginDrag()) return;
      this.floating = true;
      this.start = { x: first.x, y: first.y };
      return;
    }
    const pick2 = (first.ctrlKey || this.values.autoSelect === true) && !editor.selection.active;
    if (pick2 && !this.autoSelect(editor, first)) return;
    if (!editor.layerMove.begin()) return;
    this.start = { x: first.x, y: first.y };
  }
  /** @inheritdoc */
  onPointerMove(editor, samples) {
    const last = samples[samples.length - 1];
    if (last) this.previewTo(editor, last);
  }
  /** @inheritdoc */
  onPointerUp(editor, sample) {
    if (!this.start) return;
    this.previewTo(editor, sample);
    this.start = null;
    if (this.floating) {
      this.floating = false;
      editor.float.endDrag();
      return;
    }
    editor.layerMove.commit();
  }
  /** @inheritdoc */
  onCancel(editor) {
    if (!this.start) return;
    this.start = null;
    if (this.floating) {
      this.floating = false;
      editor.float.cancelDrag();
      return;
    }
    editor.layerMove.cancel();
  }
  /** @inheritdoc */
  onKey(editor, event) {
    const dir = ARROWS$1[event.key];
    if (!dir) return false;
    if (this.start) return true;
    const step = nudgeStep(event.shiftKey ? 10 : 1, editor.frameMap.scale);
    if (editor.float.nudge(dir[0] * step, dir[1] * step)) return true;
    editor.layerMove.nudge(dir[0] * step, dir[1] * step);
    return true;
  }
  /** @inheritdoc */
  cursor() {
    return { kind: "icon", icon: "move" };
  }
  /**
   * Pick the layer under the pointer and make it the move target.
   * @returns alse if nothing was hit (the drag moves nothing).
   */
  autoSelect(editor, at) {
    if (editor.paintTarget === "mask") {
      const maskId = editor.layerOps.pickMaskAt(at.x, at.y);
      return maskId !== null && editor.selectMask(maskId);
    }
    const id = editor.layerOps.pickAt(at.x, at.y);
    if (!id) return false;
    editor.layerOps.setActiveLayer(id);
    return true;
  }
  /** Samples are document coords (through `Editor.frameMap`); the delta is rounded to whole px. */
  previewTo(editor, sample) {
    if (!this.start) return;
    const d = dragDelta(this.start, sample);
    if (this.floating) editor.float.dragTo(d.x, d.y);
    else editor.layerMove.preview(d.x, d.y);
  }
}
function createMoveLayerTool() {
  return new MoveLayerTool();
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
const CURATED_FONTS = [
  "sans-serif",
  "serif",
  "monospace",
  "Arial",
  "Helvetica",
  "Verdana",
  "Tahoma",
  "Trebuchet MS",
  "Segoe UI",
  "Georgia",
  "Times New Roman",
  "Courier New",
  "Impact",
  "Comic Sans MS"
];
const RECENT_FONTS_KEY = "PainterSketch.recentFonts";
const MAX_SIZE_OPTION = 1e3;
function fontSuggestions(recent) {
  const seen = new Set(recent.map((f) => f.toLowerCase()));
  return [...recent, ...CURATED_FONTS.filter((f) => !seen.has(f.toLowerCase()))];
}
function readRecentFonts() {
  try {
    return parseRecentFonts(globalThis.localStorage?.getItem(RECENT_FONTS_KEY) ?? null);
  } catch {
    return [];
  }
}
function rememberFont(font) {
  try {
    globalThis.localStorage?.setItem(RECENT_FONTS_KEY, JSON.stringify(pushRecentFont(readRecentFonts(), font)));
  } catch {
  }
}
class TextOptionSet extends OptionSet {
  constructor(descriptors, store2, changed, angle) {
    super(descriptors, store2);
    this.store = store2;
    this.changed = changed;
    this.angle = angle;
  }
  store;
  changed;
  angle;
  /** The angle field always shows the target text layer's rotation. */
  get(key) {
    return key === "angle" ? this.angle() : super.get(key);
  }
  /** @inheritdoc */
  set(key, value) {
    if (key === "angle") this.store.angle = this.angle();
    const changed = super.set(key, value);
    if (changed) this.changed(key);
    return changed;
  }
}
class TextTool {
  /**
   * @param editor - Session editor (live option/colour changes, edit sync).
   */
  constructor(editor) {
    this.editor = editor;
    const descriptors = [
      {
        kind: "text",
        key: "font",
        label: "Font",
        title: "Font family (recent fonts first; Custom font… types any installed font)",
        suggestions: () => fontSuggestions(readRecentFonts()),
        customLabel: "Custom font…",
        maxLength: MAX_FONT_LENGTH,
        previewFont: true
      },
      { kind: "number", key: "size", label: "Size", title: "Font size in image px ([ / ])", min: 1, max: MAX_SIZE_OPTION, step: 1, unit: "px", curve: "pow" },
      { kind: "toggle", key: "bold", label: "B", title: "Bold", group: "style" },
      { kind: "toggle", key: "italic", label: "I", title: "Italic", group: "style" },
      {
        kind: "select",
        key: "align",
        label: "Align",
        title: "Alignment to the click point",
        group: "style",
        choices: [
          { value: "left", label: "Left" },
          { value: "center", label: "Center" },
          { value: "right", label: "Right" }
        ]
      },
      {
        kind: "number",
        key: "angle",
        label: "Angle",
        title: "Rotation of the edited / selected text layer, degrees (Ctrl+Alt+T: rotate and scale on the canvas)",
        min: -180,
        max: 180,
        step: 0.1,
        unit: "°"
      }
    ];
    this.options = new TextOptionSet(descriptors, this.values, (key) => this.optionChanged(key), () => this.angleTarget()?.rotation ?? 0);
    editor.events.on("text", () => this.syncFromEdit());
    editor.colors.events.on("change", (colors) => {
      if (editor.text.editing) editor.text.update({ color: colors.fg });
    });
  }
  editor;
  id = "text";
  label = "Text";
  shortcut = "t";
  icon = "text";
  /** Ctrl+drag moves the text layer itself (below), so Ctrl never swaps in the Move tool. */
  ctrlMove = false;
  options;
  /** Stored option values (edited in place through {@link options}). */
  values = { font: "sans-serif", size: 48, bold: false, italic: false, align: "left", angle: 0 };
  /** Ctrl+drag move in progress: pointer-down position, document coords. */
  moveStart = null;
  /** Layer whose edit the option values were last loaded from. */
  syncedLayerId = null;
  /** Set while this tool creates a layer (its values already match). */
  creating = false;
  /** @inheritdoc */
  onPointerDown(editor, samples) {
    const p = samples[0];
    if (!p) return;
    if (p.ctrlKey) {
      this.startMove(editor, p);
      return;
    }
    const open = editor.text.editing;
    const hit = editor.text.hitTest(p);
    if (open) {
      editor.text.commit();
      if (!hit || hit === open.layerId) return;
    }
    if (editor.paintTarget === "mask") editor.setPaintTarget("paint");
    if (hit) {
      editor.text.edit(hit);
      return;
    }
    this.create(editor, p);
  }
  /** @inheritdoc */
  onPointerMove(editor, samples) {
    const last = samples[samples.length - 1];
    if (this.moveStart && last) {
      const d = dragDelta(this.moveStart, last);
      editor.layerMove.preview(d.x, d.y);
    }
  }
  /** @inheritdoc */
  onPointerUp(editor, sample) {
    if (!this.moveStart) return;
    this.onPointerMove(editor, [sample]);
    this.moveStart = null;
    editor.layerMove.commit();
  }
  /** Aborts a Ctrl+drag; otherwise commits the open edit (tool switch, detach, Esc). */
  onCancel(editor) {
    if (this.moveStart) {
      this.moveStart = null;
      editor.layerMove.cancel();
      return;
    }
    editor.text.commit();
  }
  /** An open text edit stays open between presses. @returns `true` while editing. */
  pending() {
    return this.editor.text.editing !== null && !this.moveStart;
  }
  /** @inheritdoc */
  cursor() {
    return { kind: "icon", icon: this.moveStart ? "move" : "text" };
  }
  // ── Internals ───────────────────────────────────────────────────────────
  create(editor, p) {
    const v = this.values;
    this.creating = true;
    try {
      editor.text.create(
        { x: Math.round(p.x), y: Math.round(p.y) },
        { font: v.font, size: this.docSize(editor), color: editor.colors.fg, bold: v.bold, italic: v.italic, align: v.align }
      );
    } finally {
      this.creating = false;
    }
    rememberFont(v.font);
  }
  /** Ctrl+drag: move the text under the pointer, else the active text layer. */
  startMove(editor, p) {
    editor.text.commit();
    const active = editor.doc.layers.find((l) => l.id === editor.doc.activeLayerId);
    const target = editor.text.hitTest(p) ?? (active?.kind === "text" ? active.id : null);
    if (!target) return;
    if (editor.paintTarget === "mask") editor.setPaintTarget("paint");
    editor.layerOps.setActiveLayer(target);
    if (editor.layerMove.begin()) this.moveStart = { x: p.x, y: p.y };
  }
  /** Size option (image px) in document px for the current image. */
  docSize(editor) {
    return clampSize(this.values.size / editor.frameMap.scale);
  }
  /** A user option change: apply it live to the open edit. */
  optionChanged(key) {
    const editor = this.editor;
    const v = this.values;
    if (key === "font") rememberFont(v.font);
    if (key === "angle") {
      const id = editor.text.editing?.layerId ?? editor.doc.activeLayerId;
      editor.text.setRotation(id, v.angle);
      return;
    }
    if (!editor.text.editing) return;
    if (key === "font") editor.text.update({ font: v.font });
    else if (key === "size") editor.text.update({ size: this.docSize(editor) });
    else if (key === "bold") editor.text.update({ bold: v.bold });
    else if (key === "italic") editor.text.update({ italic: v.italic });
    else if (key === "align") editor.text.update({ align: v.align });
  }
  /** Text data the angle field shows / sets: the open edit, else the active layer if it is text. */
  angleTarget() {
    const edit = this.editor.text.editing;
    if (edit) return edit.textData;
    const active = this.editor.doc.layers.find((l) => l.id === this.editor.doc.activeLayerId);
    return active?.kind === "text" ? active.textData : void 0;
  }
  /** A re-edit started: show that layer's style in the options and FG swatch. */
  syncFromEdit() {
    const edit = this.editor.text.editing;
    const id = edit?.layerId ?? null;
    if (id === this.syncedLayerId) return;
    this.syncedLayerId = id;
    if (!edit || this.creating) return;
    const td = edit.textData;
    const v = this.values;
    v.font = td.font;
    v.size = Math.min(MAX_SIZE_OPTION, Math.max(1, Math.round(td.size * this.editor.frameMap.scale)));
    v.bold = td.bold;
    v.italic = td.italic;
    v.align = td.align;
    this.editor.colors.set("fg", td.color);
  }
}
function createTextTool(editor) {
  return new TextTool(editor);
}
const CLICK_SLOP_PX = 3;
class OutlineDragTool {
  id = "selection-outline";
  label = "Move selection outline";
  shortcut = "";
  icon = "move";
  options = null;
  rail = false;
  inner = null;
  first = null;
  slop = 0;
  started = false;
  /**
   * Bind the selection tool a click is replayed to.
   * @param inner - Active selection tool.
   * @returns This tool.
   */
  wrap(inner) {
    this.inner = inner;
    return this;
  }
  /** @inheritdoc */
  onPointerDown(editor, samples) {
    const first = samples[0];
    if (!first) return;
    const scale = editor.view.current.scale;
    this.first = first;
    this.slop = imageLengthToDoc(editor.frameMap, CLICK_SLOP_PX / (scale > 0 ? scale : 1));
    this.started = false;
  }
  /** @inheritdoc */
  onPointerMove(editor, samples) {
    const last = samples[samples.length - 1];
    if (last) this.track(editor, last);
  }
  /** @inheritdoc */
  onPointerUp(editor, sample) {
    const first = this.first;
    if (!first) return;
    this.track(editor, sample);
    this.first = null;
    if (this.started) {
      this.started = false;
      editor.selectionMove.commit();
      return;
    }
    this.inner?.onPointerDown(editor, [first]);
    this.inner?.onPointerUp(editor, first);
  }
  /** @inheritdoc */
  onCancel(editor) {
    if (this.started) editor.selectionMove.cancel();
    this.started = false;
    this.first = null;
  }
  /** @inheritdoc */
  cursor() {
    return { kind: "icon", icon: "move" };
  }
  track(editor, p) {
    const first = this.first;
    if (!first) return;
    if (!this.started) {
      if (Math.hypot(p.x - first.x, p.y - first.y) <= this.slop) return;
      this.started = editor.selectionMove.begin();
      if (!this.started) return;
    }
    const d = dragDelta(first, p);
    editor.selectionMove.preview(d.x, d.y);
  }
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
const TRANSFORM_TOOL_ID = "transform";
const HANDLE_GRAB_PX = 8;
const ROTATE_REACH_PX = 16;
const OFFSET_LIMIT = 32768;
const ARROWS = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1]
};
function docPerScreenPx(editor) {
  const scale = editor.view.current.scale * editor.frameMap.scale * editor.view.graphScale;
  return scale > 0 ? 1 / scale : 1;
}
class TransformTool {
  id = TRANSFORM_TOOL_ID;
  label = "Free transform";
  shortcut = "";
  icon = "transform";
  rail = false;
  ctrlMove = false;
  options;
  pressed = false;
  /**
   * @param editor - Session editor (the options read its transform).
   */
  constructor(editor) {
    this.options = new TransformSessionOptions(editor);
  }
  /** @inheritdoc */
  onPointerDown(editor, samples) {
    const first = samples[0];
    if (!first) return;
    const t = editor.float.transform;
    const k = docPerScreenPx(editor);
    this.pressed = t.beginDrag(t.hit(first, HANDLE_GRAB_PX * k, ROTATE_REACH_PX * k), first);
  }
  /** @inheritdoc */
  onPointerMove(editor, samples) {
    const last = samples[samples.length - 1];
    if (this.pressed && last) editor.float.transform.dragTo(last, { shift: last.shiftKey, alt: last.altKey });
  }
  /** @inheritdoc */
  onPointerUp(editor, sample) {
    if (!this.pressed) return;
    this.pressed = false;
    editor.float.transform.dragTo(sample, { shift: sample.shiftKey, alt: sample.altKey });
    editor.float.transform.endDrag();
    if (editor.float.transform.pending) setTimeout(() => editor.float.transform.resolvePending(), 0);
  }
  /** @inheritdoc */
  onCancel(editor) {
    if (!this.pressed) return;
    this.pressed = false;
    editor.float.transform.cancelDrag();
  }
  /** @inheritdoc */
  onKey(editor, event) {
    const dir = ARROWS[event.key];
    if (!dir) return false;
    const step = nudgeStep(event.shiftKey ? 10 : 1, editor.frameMap.scale);
    editor.float.transform.nudge(dir[0] * step, dir[1] * step);
    return true;
  }
  /** @inheritdoc */
  cursor() {
    return { kind: "icon", icon: "move" };
  }
  /** @inheritdoc */
  cursorAt(editor, at) {
    const t = editor.float.transform;
    const k = docPerScreenPx(editor);
    const hit = t.dragHit ?? t.hit(at, HANDLE_GRAB_PX * k, ROTATE_REACH_PX * k);
    switch (hit.kind) {
      case "move":
        return { kind: "icon", icon: "move" };
      case "scale":
        return { kind: "icon", icon: `resize-${t.resizeAxis(hit.handle)}` };
      case "rotate":
        return { kind: "icon", icon: "rotate" };
      case "outside":
        return { kind: "icon", icon: "crosshair" };
    }
  }
}
const SESSION_DESCRIPTORS = [
  { kind: "number", key: "x", label: "X", title: "Box centre, image px (arrows nudge)", min: -OFFSET_LIMIT, max: OFFSET_LIMIT, step: 0.1, unit: "px", group: "pos" },
  { kind: "number", key: "y", label: "Y", title: "Box centre, image px (arrows nudge)", min: -OFFSET_LIMIT, max: OFFSET_LIMIT, step: 0.1, unit: "px", group: "pos" },
  { kind: "number", key: "w", label: "W", title: "Width scale", min: 1, max: 1e4, step: 0.1, unit: "%", scale: 100, curve: "pow", group: "size" },
  { kind: "number", key: "h", label: "H", title: "Height scale", min: 1, max: 1e4, step: 0.1, unit: "%", scale: 100, curve: "pow", group: "size" },
  { kind: "toggle", key: "lock", label: "Link", title: "Keep proportions (Shift while dragging a handle inverts)", group: "size" },
  { kind: "number", key: "angle", label: "Angle", title: "Rotation, degrees (Shift while rotating = 15 deg steps)", min: -180, max: 180, step: 0.1, unit: "°", group: "angle" },
  { kind: "button", key: "flipH", label: "Flip horizontal", icon: "flipH", group: "flip" },
  { kind: "button", key: "flipV", label: "Flip vertical", icon: "flipV", group: "flip" },
  { kind: "button", key: "commit", label: "Commit transform", title: "Commit transform (Enter)", icon: "check", group: "end" },
  { kind: "button", key: "cancel", label: "Cancel transform", title: "Cancel transform (Esc)", icon: "close", group: "end" }
];
const FIELDS = /* @__PURE__ */ new Set(["x", "y", "w", "h", "angle"]);
function isField(key) {
  return FIELDS.has(key);
}
class TransformSessionOptions {
  /**
   * @param editor - Session editor.
   */
  constructor(editor) {
    this.editor = editor;
  }
  editor;
  descriptors = SESSION_DESCRIPTORS;
  /** @inheritdoc */
  get(key) {
    const t = this.editor.float.transform;
    if (isField(key)) return t.field(key);
    if (key === "lock") return t.proportional;
    return SESSION_DESCRIPTORS.some((d) => d.key === key) ? true : void 0;
  }
  /** @inheritdoc */
  set(key, value) {
    const t = this.editor.float.transform;
    if (isField(key)) return typeof value === "number" && t.setField(key, value);
    if (key === "lock") {
      if (typeof value !== "boolean" || value === t.proportional) return false;
      t.proportional = value;
      return true;
    }
    if (value !== true) return false;
    if (key === "flipH") return t.flip("h");
    if (key === "flipV") return t.flip("v");
    if (key === "commit") {
      t.commit();
      return true;
    }
    if (key !== "cancel") return false;
    t.cancel();
    return true;
  }
  /**
   * A field session ended: an unlinked text W / H change asks to rasterize,
   * deferred past the ending event (M11b).
   * @param key - Option key.
   */
  endEdit(key) {
    const t = this.editor.float.transform;
    if (isField(key) && t.endField()) setTimeout(() => t.resolvePending(), 0);
  }
}
const BUTTON_DESCRIPTORS = [
  { kind: "button", key: "transform", label: "Free transform", title: "Transform (Ctrl+Alt+T)", icon: "transform", group: "transform" },
  { kind: "button", key: "flipH", label: "Flip horizontal", icon: "flipH", group: "transform" },
  { kind: "button", key: "flipV", label: "Flip vertical", icon: "flipV", group: "transform" }
];
class TransformButtons {
  /**
   * @param editor - Session editor.
   * @param base - The tool's own options (or `null`).
   */
  constructor(editor, base) {
    this.editor = editor;
    this.base = base;
    this.descriptors = [...base?.descriptors ?? [], ...BUTTON_DESCRIPTORS];
  }
  editor;
  base;
  descriptors;
  /** Groups of the tool's own options. */
  get groups() {
    return this.base?.groups;
  }
  /** @inheritdoc */
  get(key) {
    return BUTTON_DESCRIPTORS.some((d) => d.key === key) ? true : this.base?.get(key);
  }
  /** @inheritdoc */
  set(key, value) {
    const t = this.editor.float.transform;
    if (key === "transform") return value === true && t.enter();
    if (key === "flipH" || key === "flipV") return value === true && t.flip(key === "flipH" ? "h" : "v");
    return this.base?.set(key, value) ?? false;
  }
}
function createTransformSession(editor) {
  const tool = new TransformTool(editor);
  const wrapped = /* @__PURE__ */ new Map();
  const withButtons = (active) => {
    let options = wrapped.get(active.id);
    if (!options) {
      options = new TransformButtons(editor, active.options);
      wrapped.set(active.id, options);
    }
    return options;
  };
  return {
    tool,
    active: () => editor.float.transform.active,
    options: (active) => {
      if (editor.float.transform.active) return tool.options;
      const buttons = active.id === "move-layer" || active.combinesSelection === true && editor.selection.active;
      return buttons ? withButtons(active) : active.options;
    }
  };
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
      if (tool.rail === false || !tool.shortcut) continue;
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
    this.beforeSwitch?.();
    this.activeId = id;
    this.groups.noteActive(id);
    this.events.emit("change", void 0);
  }
  /** Notify that the active tool's options changed. */
  notifyOptions() {
    this.events.emit("change", void 0);
  }
  /** Runs before the active tool changes (commits a floating selection). */
  beforeSwitch = null;
  /**
   * Hook run before every tool switch.
   * @param hook - Callback, or `null`.
   */
  setBeforeSwitch(hook) {
    this.beforeSwitch = hook;
  }
  // ── Free Transform session ──────────────────────────────────────────────
  session = null;
  /**
   * Free Transform hooks: while a session runs its tool takes all stage
   * input and keys ({@link resolve}) and its options fill the bar.
   * @param session - Hooks (`transformTool.ts`), or `null`.
   */
  setSession(session) {
    this.session = session;
  }
  /**
   * Options the bar shows now: the transform session's, the active tool's
   * with the Transform / Flip buttons, or the active tool's own.
   * @returns Options, or `null`.
   */
  barOptions() {
    return this.session ? this.session.options(this.active) : this.active.options;
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
  // ── Ctrl = temporary layer Move ─────────────────────────────────────────
  ctrlTool = null;
  outlineTool = new OutlineDragTool();
  /**
   * Tool that takes over while Ctrl is held in tools that opt in (`Tool.ctrlMove`).
   * @param tool - Usually the layer Move tool; `null` disables.
   */
  setCtrlTool(tool) {
    this.ctrlTool = tool;
  }
  /**
   * Tool that should receive stage input / draw the cursor right now.
   * Precedence: Ctrl first -- the Ctrl tool (layer Move) while Ctrl is held
   * and the active tool opts in ({@link ctrlMoves}); then Alt -- the Alt
   * tool (eyedropper) while Alt is held and the active tool has
   * `Tool.altEyedropper`; else the active tool. So Ctrl+Alt in the brush
   * is Move, not the eyedropper.
   * With no modifier at all, a press inside the selection with a selection
   * tool drags only the outline ({@link OutlineDragTool}).
   * @param altHeld - Alt is down.
   * @param ctrlHeld - Ctrl (or Cmd) is down.
   * @param press - Pointer-down facts: Shift held, press inside the selection.
   * @returns The effective tool.
   */
  resolve(altHeld, ctrlHeld = false, press) {
    if (this.session?.active()) return this.session.tool;
    const active = this.active;
    if (press?.inSelection && !press.shift && !altHeld && !ctrlHeld && active.combinesSelection && !(active.pending?.() ?? false)) {
      return this.outlineTool.wrap(active);
    }
    if (ctrlHeld && this.ctrlTool && this.ctrlTool !== active && ctrlMoves(active)) return this.ctrlTool;
    return altHeld && active.altEyedropper && this.altTool ? this.altTool : active;
  }
}
function ctrlMoves(tool) {
  return tool.rail !== false && tool.ctrlMove !== false && !(tool.pending?.() ?? false);
}
function createDefaultTools(editor, pressure = PRESSURE_DEFAULTS, samples = SAMPLE_DEFAULTS) {
  const eyedropper = createEyedropperTool();
  const moveLayer = createMoveLayerTool();
  const registry = new ToolRegistry(
    [
      createBrushTool(pressure),
      createEraserTool(pressure),
      createFillTool(samples.bucket),
      eyedropper,
      ...createShapeTools(),
      createTextTool(editor),
      createMoveTool(editor),
      // Photoshop order: Move, then the selection tools.
      moveLayer,
      ...createMarqueeTools(),
      createLassoTool(),
      createMagicWandTool(samples.wand),
      createRegionTool()
    ],
    [SHAPE_GROUP, MARQUEE_GROUP]
  );
  registry.setAltTool(eyedropper.temporary);
  registry.setCtrlTool(moveLayer);
  registry.setBeforeSwitch(() => editor.settle());
  registry.setSession(createTransformSession(editor));
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
const RETRY_MIN_MS = 15e3;
const RETRY_MAX_MS = 12e4;
const UPLOAD_FAILED_KEY = "upload-failed";
const UPLOAD_RECOVERED_KEY = "upload-recovered";
const UPLOAD_TOAST_WINDOW_MS = 6e4;
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
  /** The current failure streak has been toasted. */
  failureNotified = false;
  /** Current automatic retry interval (0 = last batch succeeded). */
  retryDelay = 0;
  disposed = false;
  settledListeners = /* @__PURE__ */ new Set();
  /** @returns Whether an upload batch is in progress. */
  get busy() {
    return this.running !== null;
  }
  /**
   * Listen for the end of each upload batch (success or failure; not after
   * dispose). Called before the batch's `flush()` promise settles.
   * @param listener - Callback.
   * @returns Unsubscribe function.
   */
  onSettled(listener) {
    this.settledListeners.add(listener);
    return () => this.settledListeners.delete(listener);
  }
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
      if (!this.disposed) for (const listener of [...this.settledListeners]) listener();
    }
  }
  /** Stop scheduled uploads. In-flight requests finish but are ignored. */
  dispose() {
    this.disposed = true;
    this.settledListeners.clear();
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
        const file = await this.uploadLayer(layer, paintQuality);
        if (this.disposed) return;
        if (file) this.knownFiles.add(file);
        this.editor.markUploaded(layer.id, version, file);
      } catch (error) {
        failures.push(error);
      }
    }
    if (this.disposed) return;
    if (failures.length) {
      const message = uploadFailureMessage(failures[0]);
      if (!this.failureNotified) {
        notify("error", message, { key: UPLOAD_FAILED_KEY, windowMs: UPLOAD_TOAST_WINDOW_MS, details: failures });
        this.failureNotified = true;
      } else {
        log.warn("upload retry failed:", ...failures);
      }
      this.scheduleRetry();
      throw new Error(`PainterSketch: ${message}`);
    }
    this.retryDelay = 0;
    if (this.failureNotified) {
      this.failureNotified = false;
      notify("info", "Paint layers saved again.", { key: UPLOAD_RECOVERED_KEY, windowMs: UPLOAD_TOAST_WINDOW_MS });
    }
  }
  /** After a failed batch: retry with backoff unless an edit already scheduled an upload. */
  scheduleRetry() {
    this.retryDelay = Math.min(RETRY_MAX_MS, Math.max(RETRY_MIN_MS, this.retryDelay * 2));
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flushQuietly();
    }, this.retryDelay);
  }
  /** @returns The file reference for the layer's current pixels (null = empty). */
  async uploadLayer(layer, paintQuality) {
    const canvas = this.editor.savedLayerCanvas(layer.id);
    if (isCanvasEmpty(canvas)) return null;
    const currentFile = layer.file;
    const { blob: blob2, bytes, ext } = await encodeLayer(canvas, layer.kind, paintQuality).catch((error) => {
      log.warn(`encoding layer "${layer.name}" (${canvas.width}x${canvas.height}) failed:`, error);
      throw new EncodeError(layer.name);
    });
    const name = layerFileName(this.editor.doc.docId, contentHash(bytes), ext);
    const expected = `${DOCUMENT_SUBFOLDER}/${name} [input]`;
    if (currentFile === expected || this.knownFiles.has(expected)) return expected;
    return uploadImage(blob2, name);
  }
}
function isCanvasEmpty(canvas) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return false;
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  for (let i = 3; i < data.length; i += 4) if (data[i] !== 0) return false;
  return true;
}
async function uploadImage(blob2, name) {
  const body = new FormData();
  body.append("image", blob2, name);
  body.append("type", "input");
  body.append("subfolder", DOCUMENT_SUBFOLDER);
  body.append("overwrite", "true");
  const response = await api.fetchApi("/upload/image", { method: "POST", body });
  if (response.status !== 200) {
    const text = (await response.text().catch(() => "")).trim();
    throw new HttpError(response.status, response.statusText, text && !text.startsWith("<") ? text.slice(0, 200) : void 0);
  }
  const data = await response.json().catch(() => null);
  if (!isUploadResponse(data)) throw new Error("upload response is missing 'name'");
  const subfolder = data.subfolder || DOCUMENT_SUBFOLDER;
  return `${subfolder}/${data.name} [${data.type || "input"}]`;
}
function isUploadResponse(value) {
  return typeof value === "object" && value !== null && typeof value.name === "string";
}
async function restoreLayers(editor, isAlive) {
  const layers2 = editor.doc.layers.filter((l) => l.file);
  if (!layers2.length) return;
  const bounds = editor.bounds;
  const problems = [];
  editor.beginLoading();
  try {
    await Promise.all(
      layers2.map(async (layer) => {
        const item = parseAnnotatedFilename(layer.file, "input");
        if (!item) return;
        const url = viewUrl(item, (route) => api.apiURL(route));
        try {
          const image = await fetchImage(url);
          if (!isAlive()) return;
          if (image.naturalWidth !== bounds.width || image.naturalHeight !== bounds.height) {
            log.warn(
              `layer "${layer.name}" file is ${image.naturalWidth}x${image.naturalHeight}, expected ${bounds.width}x${bounds.height}:`,
              layer.file
            );
            if (!(layer.kind === "text" && layer.textData)) problems.push({ name: layer.name, kind: "stale" });
          }
          editor.restoreLayerPixels(layer.id, image);
        } catch (error) {
          if (!isAlive()) return;
          log.warn(`could not restore layer "${layer.name}" from ${layer.file}:`, error);
          if (!editor.recoverMissingLayer(layer.id)) problems.push({ name: layer.name, kind: classifyError(error) });
        }
      })
    );
  } finally {
    if (isAlive()) editor.endLoading();
  }
  const summary = isAlive() ? restoreSummary(problems) : null;
  if (summary) notify(summary.severity, summary.message, { key: `restore:${editor.doc.docId}:${summary.message}` });
}
async function fetchImage(url) {
  const response = await fetch(url);
  if (!response.ok) throw new HttpError(response.status, response.statusText);
  const objectUrl = URL.createObjectURL(await response.blob());
  try {
    return await new Promise((resolve, reject) => {
      const image = new Image();
      image.decoding = "async";
      image.onload = () => resolve(image);
      image.onerror = () => reject(new DecodeError(url));
      image.src = objectUrl;
    });
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}
const MAX_DETACHED_SESSIONS = 6;
const RECENT_SIGNATURES = 4;
const sessions = /* @__PURE__ */ new Map();
const detachedOrder = [];
function createSession(doc, source, editor) {
  releaseSession(doc.docId);
  const ed = editor ?? new Editor(doc, source);
  ed.setMaskStyleProvider(readFirstMaskStyle);
  const knownFiles = /* @__PURE__ */ new Set();
  for (const layer of ed.doc.layers) if (layer.file) knownFiles.add(layer.file);
  const session = {
    docId: doc.docId,
    editor: ed,
    tools: createDefaultTools(ed, readPressureDefaults(), readSampleDefaults()),
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
  return JSON.stringify([doc.frame, doc.layers.map((l) => [l.id, l.file]), outputMetadataSignature(doc)]);
}
function sessionMatches(session, doc) {
  const signature = fileSignature(doc);
  return outputMetadataSignature(session.editor.doc) === outputMetadataSignature(doc) && (signature === fileSignature(session.editor.doc) || session.recentSignatures.includes(signature));
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
function pendingUploads() {
  for (const session of sessions.values()) {
    if (session.alive && session.editor.dirty) return true;
  }
  return false;
}
async function flushAll() {
  const errors = [];
  await Promise.all(
    [...sessions.values()].filter((s) => s.alive && s.editor.dirty).map(
      (s) => s.uploader.flush().catch((err) => {
        errors.push(err instanceof Error ? err : new Error(String(err)));
      })
    )
  );
  return errors;
}
function sessionForManifest(doc, owner, handoff) {
  const existing = findSession(doc.docId);
  if (!existing) return createSession(doc, "document");
  const choice = chooseForManifest({
    owner: existing.owner === null ? "none" : existing.owner === owner ? "self" : "other",
    matchesRecent: sessionMatches(existing, doc),
    handedOff: existing === handoff
  });
  switch (choice) {
    case "reuse":
      return existing;
    case "restore":
      if (existing.editor.dirty) {
        notify(
          "warn",
          "Loaded the painting as saved in this workflow; newer unsaved strokes from the previous copy of this node were discarded.",
          { details: [`docId ${doc.docId}`] }
        );
      }
      return createSession(doc, "document");
    case "fork-copy":
    case "fork-restore": {
      const docId = createId();
      return choice === "fork-copy" ? createSession({ ...doc, docId }, "document", existing.editor.fork(docId)) : createSession({ ...doc, docId }, "document");
    }
  }
}
function releaseOrDetach(session, owner) {
  if (!session.alive || session.owner !== owner) return;
  if (!hasDocumentContent(session.editor.doc, session.editor.hasPaint) && !session.editor.dirty) releaseSession(session.docId);
  else {
    session.uploader.flushQuietly();
    detachSession(session, owner);
  }
}
function bindSessionUploads(node, session, syncValue) {
  const { editor } = session;
  const offChange = editor.events.on("change", () => {
    if (syncValue() && !session.uploader.busy) requestGraphSync(node, EDIT_SYNC_DELAY_MS);
    if (editor.dirty) session.uploader.schedule();
  });
  const offSettled = session.uploader.onSettled(() => requestGraphSync(node, UPLOAD_SYNC_DELAY_MS));
  return () => {
    offChange();
    offSettled();
  };
}
async function flushForQueue(session) {
  await session.ready;
  session.editor.settle();
  await session.uploader.flush();
  if (session.editor.hiddenMaskHasContent()) {
    session.editor.events.emit("note", HIDDEN_MASK_NOTE);
  }
}
class WorkflowSaver {
  /** A flush + save is in progress. */
  saving = false;
  /**
   * @param session - Session to flush first, if any.
   * @returns Resolves when done (errors are toasted, never thrown).
   */
  async save(session) {
    if (this.saving) return;
    this.saving = true;
    try {
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
    this.sources = new LayerSourceWatch(node);
    this.host = new EditorHost({
      onBecameVisible: () => this.refresh(),
      isDetached: () => this.isOffViewedGraph(),
      onDisengage: () => this.session?.uploader.flushQuietly(),
      onSave: () => void this.saver.save(this.session)
    }, this.sources.history);
    this.isolation = isolateEvents({
      root: this.host.root,
      stage: this.host.stage,
      onWheel: (event) => this.host.input.handleWheel(event),
      onChromeWheel: (event) => this.host.handleChromeWheel(event),
      onMiddlePointer: (event) => this.host.input.handlePointer(event)
    });
    this.loader = new BackgroundLoader(node, () => this.updateContent());
    this.watcher = new SourceWatcher(() => this.refresh(), () => this.tick());
    this.frame = new FrameSync(node, this.loader);
    controllers.set(node, this);
    this.attach(this.newEmptySession());
  }
  node;
  /** Editor DOM shell; its `element` is the DOM widget element. */
  host;
  session = null;
  sessionUnbind = null;
  valueCache = "";
  /**
   * An incoming value `parseDocument` rejected (unknown version, corrupt),
   * reported as our value while the editor is untouched; `null` otherwise.
   */
  unreadableValue = null;
  /**
   * Session handed off by this node's previous instance, until the widget
   * value has been applied (same task; see `handoff.ts`).
   */
  handoff = null;
  isolation;
  loader;
  watcher;
  frame;
  /** M12: `layer_source` history (per node instance, memory only). */
  sources;
  saver = new WorkflowSaver();
  disposed = false;
  /** A session for a brand-new document (mask styled by the user's "Defaults" settings). */
  newEmptySession() {
    return createSession(createEmptyDocument(minimumFrame(this.frame.fallbackFrame().size), void 0, readFirstMaskStyle()), "widgets");
  }
  // ── Widget value ────────────────────────────────────────────────────────
  /** @returns The manifest string (`""` = untouched). */
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
      this.unreadableValue = null;
      if (parsed.skippedLayers) {
        notify("warn", skippedLayersMessage(parsed.skippedLayers), { key: "skipped-layers" });
      }
      const existing = findSession(parsed.document.docId);
      const session = sessionForManifest(parsed.document, this, this.handoff);
      const handedOff = session === this.handoff;
      this.attach(session);
      this.handoff = null;
      const reusedOrForked = session === existing || session.docId !== parsed.document.docId;
      if (!handedOff && reusedOrForked && this.valueCache !== value) {
        requestGraphSync(this.node, EDIT_SYNC_DELAY_MS);
      }
      return;
    }
    this.unreadableValue = null;
    if (parsed.status === "invalid") {
      this.unreadableValue = typeof value === "string" ? value : JSON.stringify(value);
      notify("warn", invalidDocumentMessage(parsed.reason), { key: `invalid-document:${parsed.reason}` });
    }
    const handoff = this.handoff?.alive && this.handoff.owner === null ? this.handoff : null;
    this.handoff = null;
    const choice = chooseForEmpty(parsed.status, {
      hasPaint: this.session ? hasDocumentContent(this.session.editor.doc, this.session.editor.hasPaint) : false,
      handoff: handoff !== null
    });
    if (choice === "adopt" && handoff) this.attach(handoff);
    else if (choice === "reset") this.attach(this.newEmptySession());
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
    await flushForQueue(session);
    this.syncValue();
    return this.valueCache;
  }
  // ── Lifecycle (called from node hooks) ──────────────────────────────────
  /**
   * Node constructor finished: chain our own widgets' callbacks so fallback
   * frame edits apply immediately (the poll catches programmatic changes).
   */
  handleNodeCreated() {
    this.frame.chainWidgetCallbacks(() => this.updateContent());
    this.updateContent();
  }
  /**
   * Node added to a graph (before `configure` applies saved values): claim a
   * hand-off from a predecessor re-created in this task, then start listening.
   */
  handleAdded() {
    if (this.disposed || this.watcher.active) return;
    const key = handoffKey(this.node);
    const handoff = key ? takeHandoff(key) : void 0;
    if (handoff) this.adoptHandoff(handoff);
    this.watcher.start();
  }
  /**
   * Our node executed; its `ui` output carries the input image preview.
   * @param output - Execution output.
   */
  handleExecuted(output) {
    this.loader.setExecuted(output);
    this.sources.setExecuted(output);
    this.refresh();
  }
  /**
   * A link on our node changed.
   * @param type - Slot type (`LINK_INPUT` for inputs).
   * @param slot - Slot index.
   * @param isConnected - `false` when a link was removed.
   */
  handleConnectionsChange(type, slot, isConnected) {
    if (this.watcher.starting) {
      this.updateContent();
      return;
    }
    this.frame.handleLinkChange(type, slot, isConnected, this.session, () => !this.disposed && !this.isImageConnected());
    if (type === LINK_INPUT && slot === inputSlotIndex(this.node, INPUT_NAMES.layerSource)) this.sources.arm();
    this.refresh();
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
    this.syncValue();
    this.disposed = true;
    this.loader.dispose();
    this.watcher.stop();
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
      background: this.loader.background,
      lastExecuted: this.loader.lastExecuted
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
    this.loader.adopt(handoff.background, handoff.lastExecuted);
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
  attach(session) {
    if (session === this.session) {
      this.syncValue();
      return;
    }
    this.detach();
    this.session = session;
    attachSession(session, this);
    this.sessionUnbind = bindSessionUploads(this.node, session, () => this.syncValue());
    this.host.setSession(session);
    this.frame.reset();
    this.syncValue();
    this.updateContent();
    if (session.editor.dirty) session.uploader.schedule();
  }
  detach() {
    const session = this.session;
    if (!session) return;
    this.sessionUnbind?.();
    this.sessionUnbind = null;
    this.session = null;
    this.host.setSession(null);
    releaseOrDetach(session, this);
  }
  /** @returns `true` if the widget value changed. */
  syncValue() {
    const editor = this.session?.editor;
    if (!editor) return false;
    const untouched = !hasDocumentContent(editor.doc, editor.hasPaint);
    const previous = this.valueCache;
    if (!untouched) this.unreadableValue = null;
    this.valueCache = untouched ? this.unreadableValue ?? "" : stringifyDocument(editor.doc);
    const changed = this.valueCache !== previous;
    if (changed) emitDocumentChange(this.node);
    return changed;
  }
  // ── Background + content ────────────────────────────────────────────────
  /**
   * Re-resolve the background source and reload only if it changed. While
   * `image` is disconnected no source is used and in-flight loads are dropped.
   */
  refresh() {
    if (this.disposed) return;
    this.loader.refresh(this.isImageConnected());
    syncSizeWidgets(this.node);
    if (this.watcher.active && !this.watcher.starting) this.sources.refresh();
    this.updateContent();
  }
  tick() {
    if (!this.host.isVisible()) return;
    this.host.refreshScale();
    this.refresh();
  }
  /** Push background + frame to the editor when anything relevant changed. */
  updateContent() {
    const session = this.session;
    if (this.disposed || !session) return;
    this.frame.apply(session, this.isImageConnected());
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
function isReloadKey(event) {
  const key = event.key.toLowerCase();
  if (key === "f5" && !event.ctrlKey && !event.metaKey && !event.altKey) return true;
  const mod = event.ctrlKey || event.metaKey;
  if (mod && !event.altKey && key === "r") return true;
  return false;
}
function reloadConfirmText(outcome) {
  if (outcome === "saved") return null;
  if (outcome === "timeout") {
    return "PainterSketch is still uploading paint (slow or unreachable server). Reload anyway and lose the unsaved paint?";
  }
  return "PainterSketch could not upload some paint. Reload anyway and lose the unsaved paint?";
}
const RELOAD_FLUSH_TIMEOUT_MS = 3e3;
function flushQuietlyAll() {
  flushGraphSync();
  if (!pendingUploads()) return;
  flushAll().catch(() => void 0);
}
const handleReloadKey = (event) => {
  if (!isReloadKey(event)) return;
  if (!pendingUploads()) {
    flushGraphSync();
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  const timeout = new Promise((resolve) => setTimeout(() => resolve("timeout"), RELOAD_FLUSH_TIMEOUT_MS));
  const flushed = flushAll().then((errors) => errors.length ? "failed" : "saved");
  void Promise.race([flushed, timeout]).then((outcome) => {
    flushGraphSync();
    const question = reloadConfirmText(outcome);
    if (question !== null && !window.confirm(question)) return;
    location.reload();
  });
};
let installed = false;
function installPageGuards() {
  if (installed) return;
  installed = true;
  window.addEventListener("keydown", handleReloadKey, true);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushQuietlyAll();
  });
  window.addEventListener("blur", flushQuietlyAll);
  window.addEventListener("beforeunload", flushGraphSync);
}
const colorPickerCss = "/*\n * PainterSketch colour picker popover (M3.2). Scoped under .cps-* to avoid\n * collisions with ComfyUI. Injected together with editor.css by inject.ts.\n * CSS variables are inherited from .cps-root (editor.css).\n */\n\n/* ── Picker container ──────────────────────────────────────────────────── */\n\n.cps-picker {\n  display: flex;\n  flex-direction: column;\n  gap: 6px;\n  width: 200px;\n  user-select: none;\n}\n\n/* ── Title row ─────────────────────────────────────────────────────────── */\n\n.cps-picker-title {\n  font-size: 10px;\n  font-weight: 600;\n  color: var(--cps-fg-muted);\n  text-transform: uppercase;\n  letter-spacing: 0.04em;\n  padding: 0 2px;\n}\n\n/* ── SV square ─────────────────────────────────────────────────────────── */\n\n.cps-picker-sv {\n  position: relative;\n  width: 100%;\n  aspect-ratio: 1 / 1;\n  border-radius: 3px;\n  overflow: hidden;\n  cursor: crosshair;\n  touch-action: none;\n  flex: none;\n}\n\n.cps-picker-sv-canvas {\n  display: block;\n  width: 100%;\n  height: 100%;\n}\n\n/* Thumb marker on the SV square */\n.cps-picker-sv-thumb {\n  position: absolute;\n  width: 10px;\n  height: 10px;\n  border-radius: 50%;\n  border: 2px solid #fff;\n  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.6);\n  transform: translate(-50%, -50%);\n  pointer-events: none;\n  will-change: left, top;\n}\n\n/* ── Hue slider ────────────────────────────────────────────────────────── */\n\n.cps-picker-hue {\n  position: relative;\n  height: 12px;\n  border-radius: 6px;\n  background: linear-gradient(\n    to right,\n    #f00 0%,\n    #ff0 16.67%,\n    #0f0 33.33%,\n    #0ff 50%,\n    #00f 66.67%,\n    #f0f 83.33%,\n    #f00 100%\n  );\n  cursor: ew-resize;\n  touch-action: none;\n  flex: none;\n}\n\n.cps-picker-hue-thumb {\n  position: absolute;\n  top: 50%;\n  width: 14px;\n  height: 14px;\n  border-radius: 50%;\n  border: 2px solid #fff;\n  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.6);\n  transform: translate(-50%, -50%);\n  pointer-events: none;\n  will-change: left;\n}\n\n/* ── Hex input row ─────────────────────────────────────────────────────── */\n\n.cps-picker-hex-row {\n  display: flex;\n  align-items: center;\n  gap: 4px;\n}\n\n.cps-picker-hex-label {\n  font-size: 10px;\n  color: var(--cps-fg-muted);\n  flex: none;\n}\n\n.cps-picker-hex-input {\n  flex: 1 1 auto;\n  height: 20px;\n  padding: 0 4px;\n  border: 1px solid var(--cps-border);\n  border-radius: 3px;\n  background: var(--cps-input-bg);\n  color: var(--cps-fg);\n  font: inherit;\n  font-variant-numeric: tabular-nums;\n  text-transform: uppercase;\n  outline: none;\n  min-width: 0;\n}\n\n.cps-picker-hex-input:focus {\n  border-color: var(--cps-accent);\n}\n\n.cps-picker-hex-input.cps-invalid {\n  border-color: #c0392b;\n  color: #c0392b;\n}\n\n/* ── Old / new preview ─────────────────────────────────────────────────── */\n\n.cps-picker-preview {\n  display: flex;\n  height: 16px;\n  border-radius: 3px;\n  overflow: hidden;\n  border: 1px solid var(--cps-border);\n  cursor: pointer;\n  flex: none;\n}\n\n.cps-picker-preview-old,\n.cps-picker-preview-new {\n  flex: 1 1 auto;\n}\n\n.cps-picker-preview-old {\n  cursor: pointer; /* click to revert */\n}\n\n/* ── Recent colours ────────────────────────────────────────────────────── */\n\n.cps-picker-recents {\n  display: flex;\n  flex-wrap: wrap;\n  gap: 3px;\n  flex: none;\n}\n\n.cps-picker-recent {\n  width: 16px;\n  height: 16px;\n  border-radius: 2px;\n  border: 1px solid rgba(0, 0, 0, 0.35);\n  box-shadow: 0 0 0 1px color-mix(in srgb, #fff 25%, transparent);\n  cursor: pointer;\n  padding: 0;\n  background: transparent; /* set via inline style */\n  flex: none;\n}\n\n.cps-picker-recent:hover {\n  outline: 2px solid var(--cps-accent);\n  outline-offset: 1px;\n}\r\n";
const controlsCss = '/*\n * PainterSketch options bar, option controls and popovers (split from\n * editor.css to keep files small; theme variables are defined on .cps-root\n * there). Injected together by styles/inject.ts.\n */\n\n/* ── Main column: options bar + body ───────────────────────────────────── */\n\n.cps-main {\n  flex: 1 1 auto;\n  display: flex;\n  flex-direction: column;\n  min-width: 0;\n  min-height: 0;\n}\n\n.cps-bar {\n  flex: 0 0 var(--cps-bar-height);\n  display: flex;\n  align-items: center;\n  min-width: 0;\n  background: var(--cps-chrome-bg);\n  border-bottom: 1px solid var(--cps-border);\n}\n\n.cps-bar-leading,\n.cps-bar-trailing {\n  flex: none;\n  display: flex;\n  align-items: center;\n  gap: 4px;\n  padding: 0 4px;\n}\n\n.cps-bar-leading:empty {\n  display: none;\n}\n\n.cps-bar-trailing {\n  border-left: 1px solid var(--cps-border);\n}\n\n/* Outputs button, then a rule and some space before the side-panel toggle.\n   The rule is a pseudo-element so the button keeps its normal shape. */\n.cps-bar-trailing > .cps-outputs-button {\n  position: relative;\n  margin-right: 9px;\n}\n\n.cps-bar-trailing > .cps-outputs-button::after {\n  content: "";\n  position: absolute;\n  top: 3px;\n  bottom: 3px;\n  right: -7px;\n  border-right: 1px solid var(--cps-border);\n  pointer-events: none;\n}\n\n.cps-bar-scroller {\n  flex: 1 1 auto;\n  display: flex;\n  flex-wrap: nowrap;\n  align-items: center;\n  gap: 8px;\n  min-width: 0;\n  height: 100%;\n  padding: 0 6px;\n  overflow-x: auto;\n  overflow-y: hidden;\n  scrollbar-width: none;\n  white-space: nowrap;\n}\n\n.cps-bar-sep {\n  flex: none;\n  width: 1px;\n  height: 16px;\n  background: var(--cps-border);\n}\n\n/* Number option: scrubby label + value button. */\n.cps-num,\n.cps-select {\n  flex: none;\n  display: flex;\n  align-items: center;\n  gap: 3px;\n}\n\n.cps-num-label {\n  color: var(--cps-fg-muted);\n  cursor: ew-resize;\n  touch-action: none;\n}\n\n.cps-num-label:hover,\n.cps-num-label.cps-scrubbing {\n  color: var(--cps-fg);\n}\n\n.cps-num-value,\n.cps-select select,\n.cps-num-input {\n  height: 20px;\n  padding: 0 4px;\n  border: 1px solid var(--cps-border);\n  border-radius: 3px;\n  background: var(--cps-input-bg);\n  color: var(--cps-fg);\n  font: inherit;\n  font-variant-numeric: tabular-nums;\n}\n\n/* Text option (font): menu, or a field while typing a custom value. */\n.cps-text-option select {\n  max-width: 11em;\n}\n\n.cps-text-field {\n  width: 10em;\n}\n\n.cps-text-field[hidden],\n.cps-text-option select[hidden] {\n  display: none;\n}\n\n.cps-num-value {\n  min-width: 3.4em;\n  text-align: right;\n  cursor: pointer;\n}\n\n.cps-num-value:hover,\n.cps-select select:hover {\n  border-color: var(--cps-fg-muted);\n}\n\n.cps-toggle {\n  flex: none;\n  height: 20px;\n  padding: 0 6px;\n  border: 1px solid var(--cps-border);\n  border-radius: 10px;\n  background: transparent;\n  color: var(--cps-fg-muted);\n  font: inherit;\n  cursor: pointer;\n}\n\n.cps-toggle:hover {\n  background: var(--cps-hover);\n}\n\n.cps-toggle.cps-active {\n  border-color: var(--cps-accent);\n  background: var(--cps-active-bg);\n  color: var(--cps-fg);\n}\n\n/* Icon command buttons (Free Transform, flips, commit / cancel). */\n.cps-toggle.cps-icon-command {\n  display: inline-flex;\n  align-items: center;\n  justify-content: center;\n  width: 26px;\n  padding: 0;\n}\n\n.cps-dim {\n  opacity: 0.45;\n}\n\n/* Quick Mask indicator. */\n.cps-mask-badge {\n  padding: 2px 6px;\n  border-radius: 3px;\n  color: #fff;\n  font-weight: 600;\n  text-shadow: 0 0 2px rgba(0, 0, 0, 0.8);\n  white-space: nowrap;\n}\n\n/* Selection actions (shown while a selection exists). */\n.cps-selection-actions:not([hidden]) {\n  display: flex;\n  align-items: center;\n  gap: 4px;\n}\n\n.cps-selection-actions .cps-toggle {\n  display: flex;\n  align-items: center;\n  gap: 3px;\n}\n\n/* ── Popovers ──────────────────────────────────────────────────────────── */\n\n.cps-popover-host {\n  position: absolute;\n  inset: 0;\n  z-index: 10;\n  overflow: hidden;\n  pointer-events: none;\n}\n\n.cps-popover {\n  position: absolute;\n  left: 0;\n  top: 0;\n  pointer-events: auto;\n  padding: 6px;\n  background: var(--cps-surface);\n  border: 1px solid var(--cps-border);\n  border-radius: 4px;\n  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.45);\n}\n\n.cps-slider-pop {\n  display: flex;\n  align-items: center;\n  gap: 6px;\n}\n\n.cps-slider {\n  width: 120px;\n  margin: 0;\n  accent-color: var(--cps-accent);\n}\n\n.cps-num-input {\n  width: 48px;\n  text-align: right;\n  user-select: text;\n  outline: none;\n}\n\n.cps-num-input:focus {\n  border-color: var(--cps-accent);\n}\n\n.cps-num-unit {\n  min-width: 1.2em;\n  color: var(--cps-fg-muted);\n}\n\n/* Collapsed option group (pen pressure): icon button + popover. */\n.cps-option-group {\n  flex: none;\n  color: var(--cps-fg-muted);\n}\n\n.cps-option-group.cps-on {\n  color: var(--cps-accent);\n}\n\n.cps-group-pop {\n  display: flex;\n  flex-direction: column;\n  align-items: flex-start;\n  gap: 6px;\n  min-width: 120px;\n}\n\n.cps-group-title {\n  color: var(--cps-fg-muted);\n  font-weight: 600;\n}\n\n/* ── Drawing resolution notice (options bar, every tool) ──────────────── */\n\n.cps-resolution-notice {\n  display: flex;\n  align-items: center;\n  gap: 6px;\n  margin-right: 6px;\n  white-space: nowrap;\n}\n\n.cps-resolution-notice[hidden] {\n  display: none;\n}\n\n.cps-resolution-label {\n  color: var(--cps-danger);\n  font-size: 11px;\n}\n';
const editorCss = "/*\n * PainterSketch editor styles. Every selector is scoped under .cps-* so we\n * never collide with the ComfyUI frontend. Injected once by styles/inject.ts.\n * Colours come from ComfyUI's palette variables where they exist (so the\n * editor follows the user's theme), with dark fallbacks.\n */\n\n.cps-root {\n  --cps-rail-width: 36px;\n  --cps-bar-height: 28px;\n  --cps-panel-width: 216px;\n  --cps-chrome-bg: var(--comfy-menu-secondary-bg, #292929);\n  --cps-surface: var(--comfy-menu-bg, #353535);\n  --cps-input-bg: var(--comfy-input-bg, #222);\n  --cps-fg: var(--input-text, #ddd);\n  --cps-fg-muted: var(--descrip-text, #999);\n  --cps-border: var(--border-color, #4e4e4e);\n  --cps-accent: var(--p-primary-color, #3b82f6);\n  --cps-hover: color-mix(in srgb, var(--cps-fg) 12%, transparent);\n  --cps-active-bg: color-mix(in srgb, var(--cps-accent) 30%, transparent);\n  --cps-danger: var(--p-red-400, #f87171);\n\n  position: relative;\n  box-sizing: border-box;\n  display: flex;\n  flex-direction: row;\n  width: 100%;\n  height: 100%;\n  /* Nodes 2.0 ignores getMinHeight for DOM widgets; keep a usable floor. */\n  min-height: 244px;\n  min-width: 0;\n  overflow: hidden;\n  background: var(--cps-chrome-bg);\n  border: 1px solid var(--cps-border);\n  border-radius: 4px;\n  color: var(--cps-fg);\n  font: 11px/1.2 system-ui, sans-serif;\n  user-select: none;\n}\n\n.cps-root *,\n.cps-root *::before,\n.cps-root *::after {\n  box-sizing: border-box;\n}\n\n.cps-root [hidden] {\n  display: none !important;\n}\n\n.cps-focus-sink {\n  position: absolute;\n  left: 0;\n  top: 0;\n  width: 1px;\n  height: 1px;\n  padding: 0;\n  border: 0;\n  opacity: 0;\n  pointer-events: none;\n}\n\n.cps-icon {\n  display: block;\n  flex: none;\n}\n\n/* ── Shared buttons ────────────────────────────────────────────────────── */\n\n.cps-rail-button,\n.cps-icon-button {\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  padding: 0;\n  border: 1px solid transparent;\n  border-radius: 4px;\n  background: transparent;\n  color: var(--cps-fg);\n  cursor: pointer;\n}\n\n.cps-rail-button {\n  width: 28px;\n  height: 28px;\n}\n\n.cps-icon-button {\n  width: 24px;\n  height: 22px;\n}\n\n.cps-rail-button:hover:not(:disabled),\n.cps-icon-button:hover:not(:disabled) {\n  background: var(--cps-hover);\n}\n\n.cps-rail-button.cps-active,\n.cps-icon-button.cps-active {\n  border-color: var(--cps-accent);\n  background: var(--cps-active-bg);\n}\n\n.cps-rail-button:disabled {\n  color: var(--cps-fg-muted);\n  opacity: 0.5;\n  cursor: default;\n}\n\n/* ── Tool rail ─────────────────────────────────────────────────────────── */\n\n.cps-rail {\n  flex: 0 0 var(--cps-rail-width);\n  display: flex;\n  flex-direction: column;\n  min-height: 0;\n  background: var(--cps-chrome-bg);\n  border-right: 1px solid var(--cps-border);\n}\n\n/* Focus indicator: the editor owns the keyboard (set by ui/keyboard.ts). */\n.cps-root.cps-has-keys .cps-rail {\n  box-shadow: inset 2px 0 0 #fff;\n}\n\n.cps-rail-tools {\n  flex: 1 1 auto;\n  display: flex;\n  flex-direction: column;\n  align-items: center;\n  gap: 2px;\n  min-height: 0;\n  padding: 4px 0;\n  overflow-x: hidden;\n  overflow-y: auto;\n  scrollbar-width: none;\n}\n\n.cps-rail-tools::-webkit-scrollbar,\n.cps-bar-scroller::-webkit-scrollbar {\n  display: none;\n}\n\n.cps-rail-group {\n  display: flex;\n  flex-direction: column;\n  gap: 1px;\n  padding-bottom: 3px;\n  border-bottom: 1px solid color-mix(in srgb, var(--cps-border) 60%, transparent);\n}\n\n.cps-rail-group:last-child {\n  border-bottom: 0;\n}\n\n/* Copy / Cut / Paste: ruled above too (the spacer separates it from the tools). */\n.cps-rail-clipboard {\n  padding-top: 3px;\n  border-top: 1px solid color-mix(in srgb, var(--cps-border) 60%, transparent);\n}\n\n.cps-rail-spacer {\n  flex: 1 1 auto;\n}\n\n.cps-rail-swatches {\n  flex: none;\n  display: flex;\n  justify-content: center;\n  padding: 4px 0 6px;\n  border-top: 1px solid var(--cps-border);\n}\n\n/* ── FG/BG swatches (Photoshop layout) ─────────────────────────────────── */\n\n.cps-swatches {\n  position: relative;\n  width: 30px;\n  height: 30px;\n}\n\n.cps-swatch {\n  position: absolute;\n  width: 19px;\n  height: 19px;\n  padding: 0;\n  border: 1px solid #000;\n  border-radius: 2px;\n  box-shadow: 0 0 0 1px color-mix(in srgb, #fff 45%, transparent);\n  cursor: pointer;\n}\n\n.cps-swatch-fg {\n  left: 0;\n  top: 0;\n  z-index: 1;\n}\n\n.cps-swatch-bg {\n  right: 0;\n  bottom: 0;\n}\n\n.cps-swatch-swap,\n.cps-swatch-reset {\n  position: absolute;\n  width: 11px;\n  height: 11px;\n  padding: 0;\n  border: 0;\n  background: transparent;\n  color: var(--cps-fg-muted);\n  cursor: pointer;\n}\n\n.cps-swatch-swap {\n  right: 0;\n  top: 0;\n}\n\n.cps-swatch-reset {\n  left: 0;\n  bottom: 0;\n}\n\n.cps-swatch-swap:hover,\n.cps-swatch-reset:hover {\n  color: var(--cps-fg);\n}\n\n.cps-reset-bg,\n.cps-reset-fg {\n  position: absolute;\n  width: 6px;\n  height: 6px;\n  border: 1px solid var(--cps-fg-muted);\n}\n\n.cps-reset-fg {\n  left: 0;\n  top: 0;\n  background: #000;\n}\n\n.cps-reset-bg {\n  right: 0;\n  bottom: 0;\n  background: #fff;\n}\n\n/* Colours do not apply while painting the mask. */\n.cps-root.cps-quickmask .cps-swatches {\n  filter: grayscale(1);\n  opacity: 0.6;\n}\n\n.cps-native-color {\n  position: absolute;\n  left: 4px;\n  bottom: 4px;\n  width: 1px;\n  height: 1px;\n  padding: 0;\n  border: 0;\n  opacity: 0;\n  pointer-events: none;\n}\n\n/* ── Body: stage + side panel ──────────────────────────────────────────── */\n\n.cps-body {\n  flex: 1 1 auto;\n  display: flex;\n  flex-direction: row;\n  min-width: 0;\n  min-height: 0;\n}\n\n.cps-stage {\n  position: relative;\n  flex: 1 1 auto;\n  min-width: 0;\n  min-height: 0;\n  overflow: hidden;\n  background: var(--cps-input-bg);\n  touch-action: none;\n  outline: none;\n  /* Tool cursor (ui/cursors.ts via StageView.syncCursor); pan/loading below win. */\n  cursor: var(--cps-tool-cursor, crosshair);\n}\n\n.cps-stage.cps-pan-ready {\n  cursor: grab;\n}\n\n.cps-stage.cps-panning {\n  cursor: grabbing;\n}\n\n.cps-stage.cps-loading {\n  cursor: progress;\n}\n\n.cps-canvas {\n  position: absolute;\n  inset: 0;\n  display: block;\n  width: 100%;\n  height: 100%;\n  touch-action: none;\n}\n\n.cps-overlay {\n  pointer-events: none;\n}\n\n/* Text tool editor (ui/textOverlay.ts): laid out in document px, placed by a\n * transform; the canvas shows the glyphs, the textarea only the caret. */\n.cps-text-edit {\n  position: absolute;\n  left: 0;\n  top: 0;\n  box-sizing: content-box;\n  margin: 0;\n  padding: 0;\n  border: 0;\n  outline: 1px dashed rgba(128, 160, 255, 0.9);\n  background: transparent;\n  color: transparent;\n  resize: none;\n  overflow: hidden;\n  white-space: pre;\n  transform-origin: 0 0;\n  cursor: text;\n  letter-spacing: normal;\n  word-spacing: normal;\n  text-indent: 0;\n  text-transform: none;\n  font-kerning: auto;\n  touch-action: auto;\n}\n\n.cps-text-edit::selection {\n  background: rgba(80, 140, 255, 0.35);\n}\n\n.cps-note {\n  position: absolute;\n  left: 50%;\n  bottom: 8px;\n  transform: translateX(-50%);\n  max-width: calc(100% - 16px);\n  padding: 4px 8px;\n  border-radius: 4px;\n  background: rgba(0, 0, 0, 0.75);\n  color: #fff;\n  pointer-events: none;\n  white-space: nowrap;\n  overflow: hidden;\n  text-overflow: ellipsis;\n}\n\n.cps-side {\n  flex: 0 0 var(--cps-panel-width);\n  /* Fixed width: without these, the min-content width of a long nowrap\n     layer name (flex min-width: auto) would push the panel over the canvas. */\n  width: var(--cps-panel-width);\n  min-width: 0;\n  max-width: var(--cps-panel-width);\n  overflow: hidden;\n  display: flex;\n  flex-direction: column;\n  min-height: 0;\n  background: var(--cps-chrome-bg);\n  border-left: 1px solid var(--cps-border);\n}\n\n.cps-side-content {\n  flex: 1 1 auto;\n  min-height: 0;\n  min-width: 0;\n  overflow-x: hidden;\n  overflow-y: auto;\n}\n\n.cps-side-placeholder {\n  padding: 6px 8px;\n  color: var(--cps-fg-muted);\n  font-weight: 600;\n  border-bottom: 1px solid var(--cps-border);\n}\n";
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
const layersCss = `/*
 * PainterSketch layers panel (M3.3): header (title + opacity), scrolling row
 * list, footer actions. Lives inside .cps-side-content (editor.css); theme
 * variables come from .cps-root. Injected by styles/inject.ts.
 */

.cps-layers {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  min-width: 0;
  font-size: 11px;
}

.cps-layers-header {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 4px;
  padding: 4px 6px;
  border-bottom: 1px solid var(--cps-border);
}

.cps-layers-title {
  font-weight: 600;
  color: var(--cps-fg-muted);
}

.cps-layers-list {
  flex: 1 1 auto;
  min-height: 0;
  overflow-x: hidden;
  overflow-y: auto;
  overscroll-behavior: contain;
}

.cps-layers-footer {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 2px;
  padding: 3px 4px;
  border-top: 1px solid var(--cps-border);
}

/* "Move drawing" toggle sits at the left; a thin divider separates it from
   the Add/Duplicate/Delete buttons on the right. */
.cps-layers-move-drawing {
  margin-right: auto;
}

.cps-layers-footer-divider {
  width: 1px;
  height: 16px;
  background: var(--cps-border);
  flex: none;
  margin: 0 2px;
}

.cps-layers-action:disabled {
  opacity: 0.35;
  cursor: default;
}

/* ── Rows ──────────────────────────────────────────────────────────────── */

.cps-layer-row {
  position: relative;
  padding: 3px 4px;
  border-bottom: 1px solid color-mix(in srgb, var(--cps-border) 60%, transparent);
  border-left: 2px solid transparent;
  cursor: default;
  user-select: none;
  touch-action: none;
}

.cps-layer-paint,
.cps-layer-mask {
  cursor: pointer;
}

.cps-layer-row:hover:not(.cps-layer-background) {
  background: var(--cps-hover);
}

.cps-layer-row.cps-selected {
  background: var(--cps-active-bg);
  border-left-color: var(--cps-accent);
}

.cps-layer-row.cps-standby {
  border-left-color: color-mix(in srgb, var(--cps-accent) 45%, transparent);
}

/* Current mask (M8): thick left bar in the mask's own colour, always; the
   selected background adds on top while Quick Mask is on. The 2px extra
   border is taken from the padding so content doesn't shift. */
.cps-layer-row.cps-current-mask,
.cps-layer-row.cps-current-mask.cps-selected {
  border-left: 4px solid var(--cps-mask-color, var(--cps-accent));
  padding-left: 2px;
}

/* Solo (view only): small button left of the eye. */
.cps-layer-button.cps-layer-solo {
  width: 14px;
  height: 14px;
  opacity: 0.4;
}

.cps-layer-button.cps-layer-solo:hover,
.cps-layer-button.cps-layer-solo.cps-active {
  opacity: 1;
}

.cps-layer-button.cps-layer-solo.cps-active,
.cps-layer-button.cps-layer-eye.cps-solo-on {
  color: var(--cps-accent);
  opacity: 1;
}

.cps-layer-button.cps-layer-eye.cps-solo-dimmed {
  opacity: 0.25;
}

.cps-layer-row.cps-dragging {
  opacity: 0.5;
}

.cps-layer-row.cps-drop-above::before,
.cps-layer-row.cps-drop-below::after {
  content: "";
  position: absolute;
  left: 0;
  right: 0;
  height: 2px;
  background: var(--cps-accent);
  pointer-events: none;
}

.cps-layer-row.cps-drop-above::before {
  top: -1px;
}

.cps-layer-row.cps-drop-below::after {
  bottom: -1px;
}

.cps-layer-main,
.cps-layer-extra {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
}

.cps-layer-extra {
  margin: 2px 0 0 42px;
}

.cps-layer-thumb-box {
  position: relative;
  flex: 0 0 38px;
  height: 38px;
  display: flex;
  align-items: center;
  justify-content: center;
}

/* Text layer badge ("T") over the thumbnail's bottom-right corner. */
.cps-layer-text-badge {
  position: absolute;
  right: 0;
  bottom: 0;
  display: flex;
  padding: 1px;
  border-radius: 3px;
  background: var(--cps-chrome-bg);
  color: var(--cps-fg);
  pointer-events: none;
}

.cps-layer-text-badge[hidden] {
  display: none;
}

.cps-layer-thumb {
  display: block;
  /* Hard cap so a freshly-created canvas (default 300×150) never escapes the
   * thumb-box before update() applies its inline style. */
  max-width: 100%;
  max-height: 100%;
  border: 1px solid var(--cps-border);
  background-color: #fff;
  background-image:
    linear-gradient(45deg, #ccc 25%, transparent 25%, transparent 75%, #ccc 75%),
    linear-gradient(45deg, #ccc 25%, transparent 25%, transparent 75%, #ccc 75%);
  background-position: 0 0, 4px 4px;
  background-size: 8px 8px;
}

.cps-layer-name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cps-layer-row.cps-hidden-layer .cps-layer-name,
.cps-layer-row.cps-hidden-layer .cps-layer-thumb {
  opacity: 0.5;
}

.cps-layer-rename {
  display: block;
  width: 100%;
  min-width: 0;
  max-width: 100%;
  height: 18px;
  box-sizing: border-box;
  padding: 0 3px;
  border: 1px solid var(--cps-accent);
  border-radius: 3px;
  background: var(--cps-input-bg);
  color: var(--cps-fg);
  font: inherit;
}

.cps-layer-button {
  flex: none;
  width: 20px;
  height: 20px;
  color: var(--cps-fg-muted);
}

.cps-layer-button:hover:not(:disabled) {
  color: var(--cps-fg);
}

.cps-layer-eye.cps-off,
.cps-layer-lock:not(.cps-on) {
  opacity: 0.55;
}

.cps-layer-lock.cps-on {
  color: var(--cps-fg);
}

.cps-layer-lock:disabled {
  cursor: default;
  opacity: 0.55;
}

.cps-layer-swatch {
  width: 16px;
  height: 16px;
  border: 1px solid var(--cps-fg-muted);
  border-radius: 3px;
}

.cps-layer-swatch:hover:not(:disabled) {
  border-color: var(--cps-fg);
}

.cps-layer-opacity .cps-num-value {
  min-width: 3em;
  height: 18px;
}

.cps-layers .cps-native-color {
  position: absolute;
  width: 1px;
  height: 1px;
  opacity: 0;
  pointer-events: none;
}

/* Move drawing icon: the image is much finer than the drawing grid. */
.cps-layers-move-drawing.cps-resolution-warn {
  color: var(--cps-danger);
}
`;
const toolGroupsCss = "/* ── Tool group slot + flyout (ui/toolGroupSlot.ts) ─────────────────────── */\n\n.cps-rail-grouped {\n  position: relative;\n}\n\n/* Photoshop's corner triangle: this slot holds more tools. */\n.cps-rail-corner {\n  position: absolute;\n  right: 2px;\n  bottom: 2px;\n  width: 0;\n  height: 0;\n  border-left: 4px solid transparent;\n  border-bottom: 4px solid currentColor;\n  opacity: 0.7;\n  pointer-events: none;\n}\n\n.cps-tool-flyout {\n  display: flex;\n  flex-direction: column;\n  gap: 1px;\n  min-width: 120px;\n}\n\n.cps-tool-flyout-item {\n  display: flex;\n  align-items: center;\n  gap: 8px;\n  padding: 3px 6px;\n  border: 1px solid transparent;\n  border-radius: 3px;\n  background: transparent;\n  color: var(--cps-fg);\n  text-align: left;\n  cursor: pointer;\n}\n\n.cps-tool-flyout-item:hover {\n  background: var(--cps-hover);\n}\n\n.cps-tool-flyout-item.cps-active {\n  border-color: var(--cps-accent);\n  background: var(--cps-active-bg);\n}\n\n.cps-tool-flyout-key {\n  margin-left: auto;\n  color: var(--cps-fg-muted);\n}\n";
const outputsCss = '/* Side panel tabs (Layers / Outputs) and the Outputs tab cards (M9).\n   Titles, rename field, eye/delete buttons reuse the layer row classes\n   (`cps-layer-name`, `cps-layer-rename`, `cps-layer-button`). */\n\n/* ── Tabs ─────────────────────────────────────────────────────────────── */\n\n.cps-side-content {\n  display: flex;\n  flex-direction: column;\n  min-height: 0;\n}\n\n.cps-side-tabs {\n  display: flex;\n  flex: none;\n  border-bottom: 1px solid var(--cps-border);\n}\n\n.cps-side-tabs button {\n  flex: 1;\n  padding: 5px;\n  border: 0;\n  background: transparent;\n  color: var(--cps-fg-muted);\n  cursor: pointer;\n}\n\n.cps-side-tabs button.cps-active {\n  color: var(--cps-fg);\n  background: var(--cps-active-bg);\n  box-shadow: inset 0 -2px var(--cps-accent);\n}\n\n.cps-side-content > .cps-layers,\n.cps-outputs {\n  flex: 1;\n  min-height: 0;\n}\n\n.cps-side-content > [hidden],\n.cps-outputs [hidden] {\n  display: none !important;\n}\n\n/* ── Outputs list ─────────────────────────────────────────────────────── */\n\n.cps-outputs {\n  display: flex;\n  flex-direction: column;\n  font-size: 11px;\n  overflow: hidden;\n}\n\n.cps-outputs-list {\n  overflow-y: auto;\n  min-height: 0;\n  overscroll-behavior: contain;\n}\n\n.cps-outputs-hint {\n  flex: none;\n  padding: 5px 6px;\n  color: var(--cps-fg-muted);\n  line-height: 1.35;\n}\n\n/* ── Cards ────────────────────────────────────────────────────────────── */\n\n.cps-output-card {\n  padding: 3px 4px 4px;\n  border-bottom: 1px solid color-mix(in srgb, var(--cps-border) 60%, transparent);\n  border-left: 2px solid transparent;\n  user-select: none;\n}\n\n.cps-output-card:hover {\n  background: var(--cps-hover);\n}\n\n.cps-output-card.cps-selected {\n  background: var(--cps-active-bg);\n  border-left-color: var(--cps-accent);\n}\n\n.cps-output-header {\n  display: flex;\n  align-items: center;\n  gap: 2px;\n  min-height: 22px;\n}\n\n.cps-output-title {\n  flex: 1;\n  min-width: 0;\n}\n\n.cps-output-card.cps-hidden-layer .cps-output-title {\n  opacity: 0.55;\n}\n\n.cps-output-size {\n  flex: none;\n  color: var(--cps-fg-muted);\n}\n\n.cps-output-empty {\n  display: flex;\n  align-items: center;\n  gap: 4px;\n  width: 100%;\n  padding: 3px 6px;\n  border: 0;\n  border-bottom: 1px solid color-mix(in srgb, var(--cps-border) 60%, transparent);\n  background: transparent;\n  color: var(--cps-fg-muted);\n  font: inherit;\n  text-align: left;\n  cursor: pointer;\n}\n\n.cps-output-empty:hover {\n  background: var(--cps-hover);\n  color: var(--cps-fg);\n}\n\n/* ── Fields ───────────────────────────────────────────────────────────── */\n\n.cps-output-geometry {\n  display: grid;\n  grid-template-columns: repeat(4, minmax(0, 1fr));\n  gap: 0 4px;\n}\n\n.cps-output-field {\n  display: flex;\n  align-items: center;\n  gap: 3px;\n  min-width: 0;\n  margin: 2px 0;\n}\n\n.cps-output-field > span,\n.cps-output-label {\n  flex: none;\n  color: var(--cps-fg-muted);\n}\n\n.cps-output-scrub {\n  cursor: ew-resize;\n  touch-action: none;\n  user-select: none;\n}\n\n/* Number fields: no spin arrows, so 4-5 digit sizes fit (scrub the label instead). */\n.cps-output-card input[type="number"] {\n  appearance: textfield;\n  -moz-appearance: textfield;\n}\n\n.cps-output-card input[type="number"]::-webkit-inner-spin-button,\n.cps-output-card input[type="number"]::-webkit-outer-spin-button {\n  -webkit-appearance: none;\n  margin: 0;\n}\n\n.cps-output-card input,\n.cps-output-card select {\n  flex: 1;\n  min-width: 0;\n  width: 100%;\n  padding: 2px 3px;\n  font: inherit;\n  color: var(--cps-fg);\n  background: var(--cps-input-bg);\n  border: 1px solid var(--cps-border);\n  border-radius: 3px;\n}\n\n.cps-output-card input:focus {\n  outline: 1px solid var(--cps-accent);\n}\n\n.cps-output-options {\n  display: flex;\n  flex-wrap: wrap;\n  align-items: center;\n  gap: 4px;\n  margin-top: 2px;\n}\n\n.cps-output-options .cps-output-field {\n  flex: 0 1 70px;\n  margin: 0;\n}\n\n.cps-output-swatch {\n  flex: none;\n  width: 22px;\n  height: 18px;\n  padding: 0;\n  border: 1px solid var(--cps-fg-muted);\n  border-radius: 3px;\n  cursor: pointer;\n}\n\n.cps-output-options .cps-output-mode {\n  min-width: 0;\n}\n\n.cps-output-check {\n  display: inline-flex;\n  flex: none;\n  align-items: center;\n  gap: 2px;\n  color: var(--cps-fg-muted);\n  white-space: nowrap;\n  cursor: pointer;\n}\n\n.cps-output-check > input {\n  margin: 0;\n}\n\n.cps-output-check[hidden] {\n  display: none;\n}\n';
const imagesCss = "/* ── Images button + panel (ui/imagesPanel.ts, M12) ─────────────────────── */\n\n.cps-images-button {\n  position: relative;\n}\n\n.cps-images-badge {\n  position: absolute;\n  top: 0;\n  right: 0;\n  min-width: 12px;\n  height: 12px;\n  padding: 0 2px;\n  box-sizing: border-box;\n  border-radius: 6px;\n  background: var(--cps-accent);\n  color: #fff;\n  font-size: 9px;\n  line-height: 12px;\n  text-align: center;\n  pointer-events: none;\n}\n\n.cps-images-popover {\n  display: flex;\n  flex-direction: column;\n  overflow: hidden;\n}\n\n.cps-images-panel {\n  min-height: 0;\n  overflow-x: hidden;\n  overflow-y: auto;\n  overscroll-behavior: contain;\n}\n\n.cps-images-list {\n  display: flex;\n  flex-direction: column;\n  gap: 4px;\n}\n\n.cps-images-item {\n  flex: none;\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  width: 88px;\n  height: 88px;\n  padding: 2px;\n  box-sizing: border-box;\n  border: 1px solid var(--cps-border);\n  border-radius: 4px;\n  background: var(--cps-input-bg);\n  cursor: pointer;\n}\n\n.cps-images-item:hover {\n  border-color: var(--cps-accent);\n}\n\n.cps-images-thumb {\n  display: block;\n  max-width: 100%;\n  max-height: 100%;\n  object-fit: contain;\n  pointer-events: none;\n}\n";
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
${toolGroupsCss}
${outputsCss}
${imagesCss}`;
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
const REGION_OUTPUT_COUNT = 2 * MAX_REGIONS;
function regionSlotLabels(slot, source) {
  if (source === null) return [`region ${slot}`, `region ${slot} mask`];
  const region = source.find((r) => r.slot === slot);
  if (!region) return [`region ${slot} (missing)`, `region ${slot} mask (missing)`];
  const name = regionName(region);
  return [name, `${name} mask`];
}
function regionOutputLabels(source) {
  const labels = [];
  for (let slot = 1; slot <= MAX_REGIONS; slot++) {
    labels.push(...regionSlotLabels(slot, source));
  }
  return labels;
}
const REGIONS_NODE_NAME = "PainterSketchRegions";
const REGIONS_INPUT_NAME = "regions";
const helpers = /* @__PURE__ */ new Set();
function readRegionSource(helper) {
  if (!helper.graph) return null;
  const index = (helper.inputs ?? []).findIndex((input) => input.name === REGIONS_INPUT_NAME);
  if (index < 0) return null;
  const source = helper.getInputNode(index);
  if (!source || !isPainterSketch(source)) return null;
  const widget = source.widgets?.find((w) => w.name === INPUT_NAMES.document);
  if (!widget) return null;
  const parsed = parseDocument(widget.value);
  if (parsed.status === "empty") return [];
  if (parsed.status === "invalid") return null;
  return parsed.document.regions;
}
function isPainterSketch(node) {
  return node.comfyClass === NODE_NAME || node.type === NODE_NAME;
}
function updateRegionsNode(helper) {
  const outputs = helper.outputs;
  if (!outputs) return false;
  const labels = regionOutputLabels(readRegionSource(helper));
  const count = Math.min(outputs.length, REGION_OUTPUT_COUNT);
  let changed = false;
  for (let i = 0; i < count; i++) {
    const output = outputs[i];
    const label = labels[i];
    if (!output || label === void 0 || output.label === label) continue;
    output.label = label;
    changed = true;
  }
  if (!changed) return false;
  outputs.splice(0, outputs.length, ...outputs);
  helper.setDirtyCanvas?.(true, true);
  return true;
}
function refreshRegionsNodes() {
  for (const helper of helpers) updateRegionsNode(helper);
}
function handleDocumentChange(source) {
  for (const helper of helpers) {
    if (helper.graph && helper.graph === source.graph) updateRegionsNode(helper);
  }
}
let unsubscribe = null;
function installRegionsNodeHooks(nodeType) {
  unsubscribe ??= onDocumentChange(handleDocumentChange);
  const proto = nodeType.prototype;
  const onAdded = proto.onAdded;
  proto.onAdded = function(graph) {
    onAdded?.call(this, graph);
    helpers.add(this);
    updateRegionsNode(this);
  };
  const onConnectionsChange = proto.onConnectionsChange;
  proto.onConnectionsChange = function(...args) {
    onConnectionsChange?.apply(this, args);
    updateRegionsNode(this);
  };
  const onRemoved = proto.onRemoved;
  proto.onRemoved = function() {
    onRemoved?.call(this);
    helpers.delete(this);
  };
}
installPageGuards();
app.registerExtension({
  name: EXTENSION_NAME,
  settings: SETTINGS,
  afterConfigureGraph: refreshRegionsNodes,
  getCustomWidgets: () => ({
    [WIDGET_SPEC_TYPE]: (node, inputName, inputData) => createPainterSketchWidget(node, inputName, inputData)
  }),
  beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name === NODE_NAME) installNodeHooks(nodeType);
    else if (nodeData.name === REGIONS_NODE_NAME) installRegionsNodeHooks(nodeType);
  }
});
