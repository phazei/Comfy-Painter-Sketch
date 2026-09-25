import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
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
    layers: [layer]
  };
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
  return {
    status: "ok",
    repaired,
    document: {
      version: DOCUMENT_VERSION,
      docId,
      frame,
      bounds,
      regions: regions ?? [],
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
    opacity: clamp01(value["opacity"], 1),
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
function clamp01(value, fallback) {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(1, Math.max(0, value));
}
function stringifyDocument(doc) {
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
    layers: doc.layers.map((l) => ({ ...l, ...l.textData ? { textData: { ...l.textData } } : {} }))
  };
}
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
const IDENTITY_MAP = { scale: 1, offsetX: 0, offsetY: 0 };
function frameMap(frame, image) {
  const { width: fw, height: fh } = frame;
  const { width: W, height: H } = image;
  if (!(fw > 0 && fh > 0 && W > 0 && H > 0) || ![fw, fh, W, H].every(Number.isFinite)) return { ...IDENTITY_MAP };
  const scale = Math.min(W / fw, H / fh);
  return { scale, offsetX: (W - fw * scale) / 2, offsetY: (H - fh * scale) / 2 };
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
    root.addEventListener("pointerenter", this.enter);
    root.addEventListener("pointerleave", this.leave);
  }
  root;
  handlers;
  active = false;
  hovered = false;
  held = false;
  spaceDown = false;
  previousFocus = null;
  sink;
  keydown = (event) => this.handleKeyDown(event);
  keyup = (event) => this.handleKeyUp(event);
  blur = () => this.setSpace(false);
  /** Whether Space is held (pan). */
  get isSpaceDown() {
    return this.spaceDown;
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
  /** Remove listeners and the focus sink. */
  dispose() {
    this.hovered = false;
    this.held = false;
    this.sync();
    this.root.removeEventListener("pointerenter", this.enter);
    this.root.removeEventListener("pointerleave", this.leave);
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
  sync() {
    const shouldBeActive = this.hovered || this.held;
    if (shouldBeActive === this.active) return;
    this.active = shouldBeActive;
    if (shouldBeActive) {
      window.addEventListener("keydown", this.keydown, true);
      window.addEventListener("keyup", this.keyup, true);
      window.addEventListener("blur", this.blur);
      this.takeFocus();
    } else {
      window.removeEventListener("keydown", this.keydown, true);
      window.removeEventListener("keyup", this.keyup, true);
      window.removeEventListener("blur", this.blur);
      this.setSpace(false);
      this.returnFocus();
    }
  }
  takeFocus() {
    const current = document.activeElement;
    if (current && current !== document.body && !this.root.contains(current) && isTextField(current)) return;
    this.previousFocus = current && !this.root.contains(current) ? current : null;
    this.sink.focus({ preventScroll: true });
  }
  returnFocus() {
    if (document.activeElement !== this.sink) return;
    this.sink.blur();
    const previous = this.previousFocus;
    this.previousFocus = null;
    if (previous instanceof HTMLElement && previous.isConnected && !isTextField(previous)) {
      previous.focus({ preventScroll: true });
    }
  }
  handleKeyDown(event) {
    if (this.isForeignTextTarget(event.target)) return;
    if (event.key === " " || event.code === "Space") {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      event.preventDefault();
      event.stopPropagation();
      this.setSpace(true);
      return;
    }
    if (this.handlers.onKeyDown(event)) {
      event.preventDefault();
      event.stopPropagation();
    }
  }
  handleKeyUp(event) {
    if (event.key === " " || event.code === "Space") {
      if (this.isForeignTextTarget(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      this.setSpace(false);
    }
  }
  setSpace(down) {
    if (this.spaceDown === down) return;
    this.spaceDown = down;
    this.handlers.onSpaceChange(down);
  }
  /** Text fields other than our sink keep their keys (hex field, text tool...). */
  isForeignTextTarget(target) {
    return target instanceof Element && target !== this.sink && isTextField(target);
  }
}
function isTextField(element) {
  if (element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) return true;
  if (element instanceof HTMLInputElement) {
    return !["range", "checkbox", "radio", "button", "color"].includes(element.type);
  }
  return element instanceof HTMLElement && element.isContentEditable;
}
const NUMBER_FIELDS = [
  { key: "size", label: "Size", min: 1, max: 500, scale: 1 },
  { key: "hardness", label: "Hard", min: 0, max: 100, scale: 100 },
  { key: "opacity", label: "Opac", min: 1, max: 100, scale: 100 },
  { key: "flow", label: "Flow", min: 1, max: 100, scale: 100 }
];
class OptionsBar {
  /**
   * @param onChange - Called after the user edits an option.
   */
  constructor(onChange) {
    this.onChange = onChange;
    this.element = document.createElement("div");
    this.element.className = "cps-options";
    for (const field of NUMBER_FIELDS) {
      const label = document.createElement("label");
      label.className = "cps-opt";
      label.title = field.label;
      const name = document.createElement("span");
      name.textContent = field.label;
      const input = document.createElement("input");
      input.type = "range";
      input.min = String(field.min);
      input.max = String(field.max);
      input.step = "1";
      const value = document.createElement("span");
      value.className = "cps-opt-value";
      input.addEventListener("input", () => {
        if (!this.options) return;
        this.options[field.key] = Number(input.value) / field.scale;
        value.textContent = input.value;
        this.onChange();
      });
      label.append(name, input, value);
      this.element.appendChild(label);
      this.ranges.set(field.key, { input, value });
    }
    this.colorWrap = document.createElement("label");
    this.colorWrap.className = "cps-opt";
    this.colorWrap.title = "Color";
    this.color = document.createElement("input");
    this.color.type = "color";
    this.color.className = "cps-color";
    this.color.addEventListener("input", () => {
      if (!this.options || this.options.color === void 0) return;
      this.options.color = this.color.value;
      this.onChange();
    });
    this.colorWrap.appendChild(this.color);
    this.element.appendChild(this.colorWrap);
    this.pressureSize = this.toggle("P→size", "Pen pressure controls size", (v) => {
      if (this.options) this.options.pressureSize = v;
    });
    this.pressureOpacity = this.toggle("P→opac", "Pen pressure controls opacity", (v) => {
      if (this.options) this.options.pressureOpacity = v;
    });
  }
  onChange;
  element;
  options = null;
  ranges = /* @__PURE__ */ new Map();
  color;
  colorWrap;
  pressureSize;
  pressureOpacity;
  /**
   * Show options of a tool (or hide when `null`).
   * @param options - Options object (edited in place).
   */
  bind(options) {
    this.options = options;
    this.element.hidden = options === null;
    this.refresh();
  }
  /** Re-read values from the bound options (after shortcuts changed them). */
  refresh() {
    const options = this.options;
    if (!options) return;
    for (const field of NUMBER_FIELDS) {
      const entry = this.ranges.get(field.key);
      if (!entry) continue;
      const v = String(Math.round(options[field.key] * field.scale));
      entry.input.value = v;
      entry.value.textContent = v;
    }
    this.colorWrap.hidden = options.color === void 0;
    if (options.color !== void 0) this.color.value = options.color;
    this.pressureSize.checked = options.pressureSize;
    this.pressureOpacity.checked = options.pressureOpacity;
  }
  toggle(text, title, apply) {
    const label = document.createElement("label");
    label.className = "cps-opt cps-opt-toggle";
    label.title = title;
    const input = document.createElement("input");
    input.type = "checkbox";
    input.addEventListener("change", () => {
      apply(input.checked);
      this.onChange();
    });
    const span = document.createElement("span");
    span.textContent = text;
    label.append(input, span);
    this.element.appendChild(label);
    return input;
  }
}
function handleShortcut(event, session, effects) {
  const { editor, tools } = session;
  const ctrl = event.ctrlKey || event.metaKey;
  const key = event.key.toLowerCase();
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
  const options = tools.active.options;
  if (event.code === "BracketLeft" || event.code === "BracketRight" || key === "[" || key === "]") {
    if (!options) return false;
    const up = event.code === "BracketRight" || key === "]" || key === "}";
    if (event.shiftKey) options.hardness = stepHardness(options.hardness, up);
    else options.size = stepSize(options.size, up);
    effects.optionsChanged();
    return true;
  }
  const digit = /^Digit([0-9])$/.exec(event.code)?.[1] ?? (/^[0-9]$/.test(key) ? key : null);
  if (digit !== null && !event.shiftKey) {
    if (!options) return false;
    setOpacity(options, digit === "0" ? 1 : Number(digit) / 10);
    effects.optionsChanged();
    return true;
  }
  if (!event.shiftKey && key.length === 1) {
    const tool = tools.byShortcut(key);
    if (tool) {
      if (tool.id !== tools.active.id) {
        effects.cancelDrag();
        tools.setActive(tool.id);
      }
      return true;
    }
  }
  return false;
}
function run(action) {
  action();
  return true;
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
function setOpacity(options, value) {
  options.opacity = value;
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
function dabSize(pressure, dyn) {
  if (!dyn.pressureSize) return Math.max(MIN_SIZE, dyn.size);
  const p = curvePressure(pressure, dyn.gamma);
  const min = Math.min(1, Math.max(0, dyn.minSizeRatio));
  return Math.max(MIN_SIZE, dyn.size * (min + (1 - min) * p));
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
    stage.addEventListener("pointerleave", () => this.host.setHover(null), { signal });
  }
  stage;
  host;
  drag = null;
  controller = new AbortController();
  /**
   * Wheel over the stage (already stopped by the isolation guard): zoom
   * around the cursor.
   * @param event - Wheel event.
   */
  handleWheel(event) {
    const session = this.host.session();
    if (!session) return;
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? this.stage.clientHeight : 1;
    const delta = (Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX) * unit;
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
  /** Abort any drag in progress (tool switch, detach). */
  cancel() {
    const drag = this.drag;
    this.drag = null;
    if (drag?.kind === "tool") {
      const session = this.host.session();
      if (session) session.tools.active.onCancel(session.editor);
    }
    this.host.setDragging(false);
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
    this.drag = { kind: "tool", pointerId: event.pointerId };
    session.tools.active.onPointerDown(session.editor, this.samples(event, session));
  }
  move(event) {
    const point = this.toStage(event);
    this.host.setHover(point);
    const drag = this.drag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.stopPropagation();
    const session = this.host.session();
    if (!session) return;
    if (drag.kind === "pan") {
      session.editor.view.pan(point.x - drag.last.x, point.y - drag.last.y);
      drag.last = point;
      this.host.viewChanged();
      return;
    }
    session.tools.active.onPointerMove(session.editor, this.samples(event, session));
  }
  up(event, cancelled) {
    const drag = this.drag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    this.drag = null;
    this.stage.classList.remove("cps-panning");
    this.release(event.pointerId);
    this.host.setDragging(false);
    if (drag.kind !== "tool") return;
    const session = this.host.session();
    if (!session) return;
    const tool = session.tools.active;
    if (cancelled) tool.onCancel(session.editor);
    else tool.onPointerUp(session.editor, this.samples(event, session)[0] ?? this.sample(event, session));
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
const ICONS = {
  brush: "M4 20c2 0 4-1 4-3a2 2 0 1 0-4 0M8 17 19 6a2 2 0 0 0-3-3L5 14",
  eraser: "M7 20h10M4 14l8-8 6 6-8 8H7z",
  undo: "M9 14 4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3",
  redo: "M15 14l5-5-5-5M20 9H10a6 6 0 0 0 0 12h3",
  // Four corner brackets indicating "fit to view".
  fit: "M4 9V5h4M20 9V5h-4M4 15v4h4M20 15v4h-4",
  clear: "M4 7h16M10 11v6M14 11v6M5 7l1 13h12l1-13M9 7V4h6v3"
};
class ToolRail {
  /**
   * @param actions - Button handlers.
   */
  constructor(actions) {
    this.actions = actions;
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
  actions;
  element;
  toolButtons = /* @__PURE__ */ new Map();
  toolBox;
  undoButton;
  redoButton;
  /**
   * Rebuild tool buttons.
   * @param tools - Tools in order.
   * @param activeId - Active tool id.
   */
  setTools(tools, activeId) {
    this.toolBox.replaceChildren();
    this.toolButtons.clear();
    for (const tool of tools) {
      const button = railButton(
        tool.id,
        `${tool.label} (${tool.shortcut.toUpperCase()})`,
        () => this.actions.selectTool(tool.id)
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
  setActive(activeId) {
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
  setHistory(canUndo, canRedo) {
    this.undoButton.disabled = !canUndo;
    this.redoButton.disabled = !canRedo;
  }
}
function railButton(icon, title, onClick) {
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
const NOTE_MS = 5e3;
class EditorHost {
  /**
   * @param events - Owner callbacks.
   */
  constructor(events = {}) {
    this.events = events;
    this.root = document.createElement("div");
    this.root.className = "cps-root";
    this.rail = new ToolRail({
      selectTool: (id) => {
        this.input.cancel();
        this.session?.tools.setActive(id);
      },
      undo: () => this.session?.editor.undo(),
      redo: () => this.session?.editor.redo(),
      fit: () => {
        this.session?.editor.view.fit();
        this.requestRender();
      },
      clear: () => this.confirmClear()
    });
    this.optionsBar = new OptionsBar(() => this.optionsChanged());
    this.stage = document.createElement("div");
    this.stage.className = "cps-stage";
    this.stage.tabIndex = -1;
    this.canvas = document.createElement("canvas");
    this.canvas.className = "cps-canvas";
    this.ctx = this.canvas.getContext("2d");
    this.overlay = document.createElement("canvas");
    this.overlay.className = "cps-canvas cps-overlay";
    this.overlayCtx = this.overlay.getContext("2d");
    this.note = document.createElement("div");
    this.note.className = "cps-note";
    this.note.hidden = true;
    this.stage.append(this.canvas, this.overlay, this.note);
    const main = document.createElement("div");
    main.className = "cps-main";
    main.append(this.optionsBar.element, this.stage);
    this.root.append(this.rail.element, main);
    this.input = new StageInput(this.stage, {
      session: () => this.session,
      isSpaceDown: () => this.keyboard.isSpaceDown,
      setDragging: (dragging) => this.keyboard.setHeld(dragging),
      setHover: (point) => {
        this.hover = point;
        this.requestOverlay();
      },
      viewChanged: () => this.requestRender()
    });
    this.keyboard = new KeyboardScope(this.root, {
      onKeyDown: (event) => this.session ? handleShortcut(event, this.session, {
        optionsChanged: () => this.optionsChanged(),
        viewChanged: () => this.requestRender(),
        cancelDrag: () => this.input.cancel()
      }) : false,
      onSpaceChange: (down) => this.stage.classList.toggle("cps-pan-ready", down)
    });
    this.resizeObserver = new ResizeObserver(() => this.handleResize());
    this.resizeObserver.observe(this.stage);
  }
  events;
  /** Root element handed to `addDOMWidget`. */
  root;
  /** Canvas area. */
  stage;
  /** Pointer/wheel router (the isolation guard forwards to it). */
  input;
  canvas;
  ctx;
  overlay;
  overlayCtx;
  note;
  rail;
  optionsBar;
  keyboard;
  resizeObserver;
  session = null;
  unbind = [];
  frameRequest = 0;
  overlayRequest = 0;
  pixelRatio = 1;
  hover = null;
  wasVisible = false;
  noteTimer = null;
  disposed = false;
  // ── Public API ──────────────────────────────────────────────────────────
  /**
   * Show a session (or nothing).
   * @param session - Session to bind.
   */
  setSession(session) {
    if (session === this.session) return;
    this.input.cancel();
    for (const off of this.unbind) off();
    this.unbind = [];
    this.session = session;
    if (session) {
      const { editor, tools } = session;
      this.unbind.push(
        editor.events.on("render", () => this.requestRender()),
        editor.events.on("history", () => this.syncHistory()),
        editor.events.on("note", (text) => this.showNote(text)),
        tools.events.on("change", () => this.syncTools())
      );
      this.rail.setTools(tools.list(), tools.active.id);
      this.syncTools();
      this.syncHistory();
      this.syncView();
    }
    this.requestRender();
  }
  /**
   * Re-check the on-screen scale (graph zoom changes don''t trigger
   * ResizeObserver) and redraw if the backing store would change.
   */
  refreshScale() {
    if (this.syncBackingStore()) this.requestRender();
  }
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
  /** Tear down listeners and canvases. Idempotent. */
  dispose() {
    if (this.disposed) return;
    this.setSession(null);
    this.disposed = true;
    if (this.frameRequest) cancelAnimationFrame(this.frameRequest);
    if (this.overlayRequest) cancelAnimationFrame(this.overlayRequest);
    if (this.noteTimer !== null) clearTimeout(this.noteTimer);
    this.resizeObserver.disconnect();
    this.input.dispose();
    this.keyboard.dispose();
    this.canvas.width = this.canvas.height = 0;
    this.overlay.width = this.overlay.height = 0;
    this.root.remove();
  }
  // ── Sync ────────────────────────────────────────────────────────────────
  syncTools() {
    const session = this.session;
    if (!session) return;
    this.rail.setActive(session.tools.active.id);
    this.optionsBar.bind(session.tools.active.options);
    this.requestOverlay();
  }
  syncHistory() {
    const editor = this.session?.editor;
    this.rail.setHistory(editor?.canUndo ?? false, editor?.canRedo ?? false);
  }
  optionsChanged() {
    this.optionsBar.refresh();
    this.session?.tools.notifyOptions();
    this.requestOverlay();
  }
  /** Clear button: confirm, then one undoable Clear (SPEC Behavior Notes). */
  confirmClear() {
    const editor = this.session?.editor;
    if (!editor || editor.loading) return;
    if (!window.confirm("Clear all paint? This can be undone.")) return;
    this.input.cancel();
    editor.clear();
  }
  showNote(text) {
    this.note.textContent = text;
    this.note.hidden = false;
    if (this.noteTimer !== null) clearTimeout(this.noteTimer);
    this.noteTimer = setTimeout(() => {
      this.note.hidden = true;
      this.noteTimer = null;
    }, NOTE_MS);
  }
  // ── Sizing ──────────────────────────────────────────────────────────────
  handleResize() {
    const visible = this.isVisible();
    if (visible && !this.wasVisible) this.events.onBecameVisible?.();
    this.wasVisible = visible;
    this.syncBackingStore();
    this.requestRender();
  }
  stageSize() {
    return { width: this.stage.clientWidth, height: this.stage.clientHeight };
  }
  displayScale() {
    const rect = this.stage.getBoundingClientRect();
    return this.stage.clientWidth > 0 && rect.width > 0 ? rect.width / this.stage.clientWidth : 1;
  }
  /** Push stage size + graph zoom into the view (re-fits in fit mode). */
  syncView() {
    if (!this.session || !this.isVisible()) return;
    this.session.editor.view.setStage(this.stageSize(), this.displayScale());
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
  // ── Rendering ───────────────────────────────────────────────────────────
  render() {
    const session = this.session;
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
      layers: editor.compositeLayers()
    });
    this.stage.classList.toggle("cps-loading", editor.loading);
    this.drawOverlay();
  }
  requestOverlay() {
    if (this.disposed || this.overlayRequest) return;
    this.overlayRequest = requestAnimationFrame(() => {
      this.overlayRequest = 0;
      this.drawOverlay();
    });
  }
  /** Brush-size ring at the hover position (cheap; separate canvas). */
  drawOverlay() {
    const ctx = this.overlayCtx;
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.overlay.width, this.overlay.height);
    const session = this.session;
    const hover = this.hover;
    const panning = this.stage.classList.contains("cps-panning") || this.stage.classList.contains("cps-pan-ready");
    if (!session || !hover || panning) return;
    const cursor = session.tools.active.cursor();
    if (cursor.kind !== "ring") return;
    const pr = this.pixelRatio;
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
  const { root, stage, onWheel, onMiddlePointer } = options;
  const controller = new AbortController();
  const { signal } = controller;
  const stop = (event) => event.stopPropagation();
  for (const type of ROOT_STOPPED) root.addEventListener(type, stop, { signal });
  stage.addEventListener("auxclick", (e) => e.preventDefault(), { signal });
  stage.dataset["captureWheel"] = "true";
  let hovering = false;
  let middleDrag = false;
  let armed = false;
  const inStage = (target) => target instanceof Node && stage.contains(target);
  const wheelGuard = (event) => {
    if (!inStage(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
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
  stage.addEventListener("pointerenter", enter, { signal });
  stage.addEventListener("pointermove", enter, { signal });
  stage.addEventListener(
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
function normalizeHexColor(value, fallback = FALLBACK_DEFAULTS.color) {
  if (typeof value !== "string") return fallback;
  const hex = value.trim().replace(/^#/, "").toLowerCase();
  if (!/^[0-9a-f]+$/.test(hex)) return fallback;
  if (hex.length === 3 || hex.length === 4) {
    return `#${[...hex].map((c) => c + c).join("")}`;
  }
  if (hex.length === 6 || hex.length === 8) return `#${hex}`;
  return fallback;
}
function sanitizeDimension(value, fallback) {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(MAX_FRAME_SIDE, Math.max(MIN_FRAME_SIDE, Math.round(n)));
}
function resolveFallbackFrame(knownFrame, width, height, color) {
  const known = knownFrame && knownFrame.width > 0 && knownFrame.height > 0 ? { width: Math.round(knownFrame.width), height: Math.round(knownFrame.height) } : null;
  return {
    size: known ?? {
      width: sanitizeDimension(width, FALLBACK_DEFAULTS.width),
      height: sanitizeDimension(height, FALLBACK_DEFAULTS.height)
    },
    color: normalizeHexColor(color)
  };
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
const EMPTY = { x: 0, y: 0, width: 0, height: 0 };
class StrokeBuffer {
  buffer = null;
  preview = null;
  bounds = EMPTY;
  style = null;
  strokeRect = EMPTY;
  pendingPreview = EMPTY;
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
   * Refresh the preview inside the region dirtied since the last call.
   * @param layer - Target layer surface.
   * @returns Preview surface to draw instead of the layer.
   */
  updatePreview(layer) {
    const { buffer, preview } = this.surfaces();
    const r = intersectRect(roundOutRect(this.pendingPreview), this.bounds);
    this.pendingPreview = EMPTY;
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
    this.buffer = null;
    this.preview = null;
    this.style = null;
  }
  // ── Internals ───────────────────────────────────────────────────────────
  compositeBuffer(ctx, buffer, x, y, width, height) {
    if (!this.style) return;
    ctx.save();
    ctx.globalAlpha = this.style.opacity;
    ctx.globalCompositeOperation = this.style.mode === "erase" ? "destination-out" : "source-over";
    ctx.drawImage(buffer.canvas, x, y, width, height, x, y, width, height);
    ctx.restore();
  }
  end() {
    const r = this.touched;
    if (this.buffer && !isEmptyRect(r)) {
      this.buffer.ctx.clearRect(r.x - this.bounds.x, r.y - this.bounds.y, r.width, r.height);
    }
    this.style = null;
    this.strokeRect = EMPTY;
    this.pendingPreview = EMPTY;
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
class Editor {
  events = new Emitter();
  view = new ViewState();
  stamps = new StampCache();
  docState;
  store;
  history = new HistoryStack();
  stroke = new StrokeBuffer();
  runtime = /* @__PURE__ */ new Map();
  backgroundState = { kind: "fill", color: "#ffffff" };
  backgroundSize = null;
  frameSourceState;
  strokeLayerId = null;
  strokeDiameter = 1;
  loadingCount = 0;
  pendingBackgroundSize = null;
  /** Where the previous stroke ended, document coords (Shift+click line start). */
  lastStrokeEnd = null;
  /**
   * @param doc - Document (copied).
   * @param source - Origin of its frame size.
   * @param store - Existing pixels (for clones); a blank store is created otherwise.
   */
  constructor(doc, source, store) {
    this.docState = cloneDocument(doc);
    this.frameSourceState = source;
    this.store = store ?? new LayerStore(doc.bounds);
    for (const layer of doc.layers) {
      this.store.ensure(layer.id);
      this.runtime.set(layer.id, { dirty: false, version: 0, hasContent: layer.file !== null });
    }
    this.syncViewFrame();
  }
  // ── Read access ─────────────────────────────────────────────────────────
  /** Current document (treat as read-only). */
  get doc() {
    return this.docState;
  }
  /** Where the frame size came from. */
  get frameSource() {
    return this.frameSourceState;
  }
  /** Undo available. */
  get canUndo() {
    return this.history.canUndo && !this.stroke.active;
  }
  /** Redo available. */
  get canRedo() {
    return this.history.canRedo && !this.stroke.active;
  }
  /** Layer files are being restored; painting is disabled. */
  get loading() {
    return this.loadingCount > 0;
  }
  /** Whether any layer has ever held paint. */
  get hasPaint() {
    for (const r of this.runtime.values()) if (r.hasContent) return true;
    return false;
  }
  /** Whether any layer needs uploading. */
  get dirty() {
    for (const r of this.runtime.values()) if (r.dirty) return true;
    return false;
  }
  /** Background drawn under the paint. */
  get background() {
    return this.backgroundState;
  }
  /**
   * Size of what the view shows: the background image, or `doc.frame` when
   * there is no image (disconnected -> `background` fill, s = 1).
   */
  get imageSize() {
    const size = this.backgroundSize;
    if (this.backgroundState.kind === "image" && size) return { ...size };
    return { ...this.docState.frame };
  }
  /** Document -> image transform (same as Python's frame-mismatch placement). */
  get frameMap() {
    return frameMap(this.docState.frame, this.imageSize);
  }
  /**
   * Runtime state of a layer.
   * @param layerId - Layer id.
   * @returns Bookkeeping or `undefined`.
   */
  layerRuntime(layerId) {
    return this.runtime.get(layerId);
  }
  /**
   * Canvas of a layer (for export/upload).
   * @param layerId - Layer id.
   * @returns The canvas.
   */
  layerCanvas(layerId) {
    return this.store.ensure(layerId).canvas;
  }
  /** Current paint bounds (document coords). */
  get bounds() {
    return this.store.bounds;
  }
  /**
   * Visible layers to composite, using the live stroke preview for the layer
   * being painted.
   * @returns Bottom -> top layers.
   */
  compositeLayers() {
    const out = [];
    for (const layer of this.docState.layers) {
      if (!layer.visible || layer.kind === "mask") continue;
      const surface = this.store.ensure(layer.id);
      const source = this.strokeLayerId === layer.id && this.stroke.active ? this.stroke.updatePreview(surface).canvas : surface.canvas;
      out.push({ source, opacity: layer.opacity });
    }
    return out;
  }
  // ── Background / frame ──────────────────────────────────────────────────
  /**
   * Set what is drawn under the paint. The view re-fits to the new image size
   * (in fit mode); layer pixels are untouched.
   * @param background - Image or fill.
   * @param imageSize - Natural size when `background` is an image.
   */
  setBackground(background, imageSize) {
    this.backgroundState = background;
    this.backgroundSize = background.kind === "image" && imageSize ? { ...imageSize } : null;
    this.syncViewFrame();
    this.events.emit("render", void 0);
  }
  /**
   * A new background image size arrived. An empty document (no paint, no
   * history) adopts it; otherwise nothing changes -- the document is simply
   * drawn through {@link frameMap} (decision 4). Deferred while layer files
   * are loading.
   * @param size - Image size.
   */
  handleBackgroundSize(size) {
    if (this.loading) {
      this.pendingBackgroundSize = { ...size };
      return;
    }
    const frame = this.docState.frame;
    if (size.width === frame.width && size.height === frame.height) {
      this.frameSourceState = "image";
      return;
    }
    if (this.isEmpty) this.adoptFrame(size, "image");
  }
  /**
   * Adopt `size` only for an empty document whose frame came from widgets
   * (the `width`/`height` widgets apply to fresh documents only).
   * @param size - Widget frame size.
   */
  handleWidgetFrame(size) {
    if (this.loading || !this.isEmpty || this.frameSourceState !== "widgets") return;
    const frame = this.docState.frame;
    if (size.width !== frame.width || size.height !== frame.height) this.adoptFrame(size, "widgets");
  }
  /**
   * Replace the frame of an empty document (no history).
   * @param size - New frame.
   * @param source - Origin of the size.
   */
  adoptFrame(size, source) {
    if (this.stroke.active) this.cancelStroke();
    const frame = { width: Math.round(size.width), height: Math.round(size.height) };
    this.docState.frame = frame;
    this.docState.bounds = frameRect(frame);
    this.frameSourceState = source;
    this.store.reset(this.docState.bounds);
    for (const layer of this.docState.layers) {
      this.store.ensure(layer.id);
      layer.file = null;
      this.runtime.set(layer.id, { dirty: false, version: 0, hasContent: false });
    }
    this.history.clear();
    this.lastStrokeEnd = null;
    this.syncViewFrame();
    this.events.emit("history", void 0);
    this.events.emit("change", void 0);
    this.events.emit("render", void 0);
  }
  /**
   * Clear all paint (every layer, masks included; the layer list is kept) and
   * reset the frame to the current image size (or the current fallback frame
   * when no image is shown). One undoable step that restores the full prior
   * state; the snapshot counts against the history memory cap.
   */
  clear() {
    if (this.loading) return;
    if (this.stroke.active) this.cancelStroke();
    const size = this.imageSize;
    const frame = { width: Math.max(1, Math.round(size.width)), height: Math.max(1, Math.round(size.height)) };
    const source = this.backgroundState.kind === "image" && this.backgroundSize ? "image" : this.frameSourceState;
    const before = this.captureSnapshot();
    const after = { frame, bounds: frameRect(frame), source, pixels: null };
    this.applySnapshot(after);
    this.history.push({ kind: "clear", before, after, bytes: snapshotBytes(before) });
    this.lastStrokeEnd = null;
    this.afterEdit();
  }
  // ── Restore bookkeeping (persistence) ───────────────────────────────────
  /** Mark the start of an async layer restore (disables painting). */
  beginLoading() {
    this.loadingCount++;
  }
  /** Mark the end of an async layer restore; applies a deferred frame change. */
  endLoading() {
    this.loadingCount = Math.max(0, this.loadingCount - 1);
    this.events.emit("render", void 0);
    if (!this.loading && this.pendingBackgroundSize) {
      const size = this.pendingBackgroundSize;
      this.pendingBackgroundSize = null;
      this.handleBackgroundSize(size);
    }
  }
  /**
   * Draw a restored PNG into a layer (not an undo step, not dirty).
   * @param layerId - Layer id.
   * @param image - Decoded PNG (sized to `bounds`).
   */
  restoreLayerPixels(layerId, image) {
    const surface = this.store.ensure(layerId);
    surface.ctx.clearRect(0, 0, surface.canvas.width, surface.canvas.height);
    surface.ctx.drawImage(image, 0, 0);
    this.events.emit("render", void 0);
  }
  /**
   * Record a finished upload.
   * @param layerId - Layer id.
   * @param version - Layer version that was uploaded.
   * @param file - Stored file reference (`null` for an empty layer).
   */
  markUploaded(layerId, version, file) {
    const layer = this.docState.layers.find((l) => l.id === layerId);
    const rt = this.runtime.get(layerId);
    if (!layer || !rt) return;
    layer.file = file;
    if (rt.version === version) rt.dirty = false;
    this.events.emit("change", void 0);
  }
  // ── Strokes ─────────────────────────────────────────────────────────────
  /**
   * Start a stroke on the active layer.
   * @param style - Stroke appearance.
   * @param maxDiameter - Largest dab diameter this stroke can produce, document px.
   * @returns `false` if painting is not possible (loading, locked, hidden).
   */
  beginStroke(style, maxDiameter) {
    if (this.loading || this.stroke.active) return false;
    const layer = this.docState.layers.find((l) => l.id === this.docState.activeLayerId);
    if (!layer || layer.locked || !layer.visible || layer.kind === "mask") return false;
    this.strokeLayerId = layer.id;
    this.strokeDiameter = Math.max(1, maxDiameter);
    this.stroke.begin(this.store.ensure(layer.id), this.store.bounds, style);
    this.events.emit("history", void 0);
    return true;
  }
  /**
   * Add dabs to the current stroke, growing bounds when they go off-frame.
   * @param dabs - Dabs in document coords.
   */
  addDabs(dabs) {
    if (!this.stroke.active || dabs.length === 0) return;
    let need = { x: 0, y: 0, width: 0, height: 0 };
    for (const dab of dabs) {
      const r = dab.size / 2 + 1;
      need = unionRect(need, { x: dab.x - r, y: dab.y - r, width: r * 2, height: r * 2 });
    }
    this.ensureBounds(need, true);
    this.stroke.addDabs(dabs, this.stamps, this.strokeDiameter);
    this.events.emit("render", void 0);
  }
  /**
   * Commit the stroke to its layer as one undo step.
   * @param end - Where the stroke ended, document coords (for Shift+click lines).
   */
  endStroke(end) {
    const layerId = this.strokeLayerId;
    if (!this.stroke.active || !layerId) return;
    const rect = this.stroke.touched;
    const surface = this.store.ensure(layerId);
    if (isEmptyRect(rect)) {
      this.stroke.cancel();
    } else {
      const before = this.store.read(layerId, rect);
      this.stroke.commit(surface);
      const after = this.store.read(layerId, rect);
      if (before && after) {
        const bytes = before.data.data.byteLength + after.data.data.byteLength;
        this.history.push({ kind: "patch", layerId, x: before.rect.x, y: before.rect.y, before: before.data, after: after.data, bytes });
        this.touchLayer(layerId);
      }
    }
    this.strokeLayerId = null;
    if (end) this.lastStrokeEnd = { ...end };
    this.afterEdit();
  }
  /** Abort the current stroke. */
  cancelStroke() {
    this.stroke.cancel();
    this.strokeLayerId = null;
    this.events.emit("history", void 0);
    this.events.emit("render", void 0);
  }
  // ── Undo / redo ─────────────────────────────────────────────────────────
  /** Undo the last operation. */
  undo() {
    if (!this.canUndo) return;
    const entry = this.history.undo();
    if (entry) this.applyEntry(entry, "before");
    this.afterEdit();
  }
  /** Redo the last undone operation. */
  redo() {
    if (!this.canRedo) return;
    const entry = this.history.redo();
    if (entry) this.applyEntry(entry, "after");
    this.afterEdit();
  }
  // ── Cloning / teardown ──────────────────────────────────────────────────
  /**
   * Independent copy with a new document id (used when a node is duplicated
   * while its source is still live). History is not copied.
   * @param docId - New id.
   * @returns New editor.
   */
  fork(docId) {
    const doc = cloneDocument(this.docState);
    doc.docId = docId;
    const copy = new Editor(doc, this.frameSourceState, this.store.clone());
    for (const [id, rt] of this.runtime) copy.runtime.set(id, { ...rt });
    copy.setBackground(this.backgroundState, this.backgroundSize);
    return copy;
  }
  /** Estimated memory held (pixels + history). */
  get bytes() {
    return this.store.bytes + this.history.totalBytes;
  }
  /** Release everything. */
  dispose() {
    this.stroke.dispose();
    this.store.dispose();
    this.history.clear();
    this.stamps.clear();
    this.events.clear();
  }
  // ── Internals ───────────────────────────────────────────────────────────
  /** No paint ever and nothing in history that depends on the frame. */
  get isEmpty() {
    return !this.hasPaint && !this.history.canUndo && !this.history.canRedo;
  }
  /** The view fits the image, not the document frame. */
  syncViewFrame() {
    this.view.setFrame(this.imageSize);
  }
  captureSnapshot() {
    const pixels = /* @__PURE__ */ new Map();
    for (const layer of this.docState.layers) pixels.set(layer.id, this.store.snapshot(layer.id));
    return { frame: { ...this.docState.frame }, bounds: this.store.bounds, source: this.frameSourceState, pixels };
  }
  applySnapshot(state) {
    this.docState.frame = { ...state.frame };
    this.docState.bounds = { ...state.bounds };
    this.frameSourceState = state.source;
    this.store.reset(state.bounds);
    for (const layer of this.docState.layers) {
      const data = state.pixels?.get(layer.id);
      if (data) this.store.write(layer.id, state.bounds.x, state.bounds.y, data);
      else this.store.ensure(layer.id);
      this.touchLayer(layer.id);
    }
    this.syncViewFrame();
  }
  applyEntry(entry, side) {
    if (entry.kind === "clear") {
      this.applySnapshot(side === "before" ? entry.before : entry.after);
      this.lastStrokeEnd = null;
      return;
    }
    if (!this.docState.layers.some((l) => l.id === entry.layerId)) return;
    const data = side === "before" ? entry.before : entry.after;
    this.ensureBounds({ x: entry.x, y: entry.y, width: data.width, height: data.height }, false);
    this.store.write(entry.layerId, entry.x, entry.y, data);
    this.touchLayer(entry.layerId);
  }
  /**
   * Grow bounds to cover `need`. Chunked + capped for strokes; exact and
   * uncapped when re-applying history.
   */
  ensureBounds(need, chunked) {
    const current = this.store.bounds;
    if (containsRect(current, need)) return;
    const next = chunked ? growBounds(current, need, this.docState.frame) : unionRect(current, need);
    if (containsRect(next, current) && (next.width !== current.width || next.height !== current.height)) {
      this.store.rebase(next);
      this.stroke.rebase(next);
      this.docState.bounds = { ...next };
    }
  }
  touchLayer(layerId) {
    const rt = this.runtime.get(layerId);
    if (!rt) return;
    rt.dirty = true;
    rt.version++;
    rt.hasContent = true;
  }
  afterEdit() {
    this.events.emit("history", void 0);
    this.events.emit("change", void 0);
    this.events.emit("render", void 0);
  }
}
function snapshotBytes(state) {
  let bytes = 0;
  if (state.pixels) for (const data of state.pixels.values()) bytes += data.data.byteLength;
  return bytes;
}
const PRESSURE_CURVE = { minSizeRatio: 0.1, gamma: 1 };
class PaintTool {
  /**
   * @param id - Tool id.
   * @param label - Display label.
   * @param shortcut - Single-key shortcut.
   * @param mode - Paint or erase.
   * @param defaults - Initial options.
   */
  constructor(id, label, shortcut, mode, defaults) {
    this.id = id;
    this.label = label;
    this.shortcut = shortcut;
    this.mode = mode;
    this.options = { ...defaults };
  }
  id;
  label;
  shortcut;
  mode;
  options;
  spacer = null;
  last = null;
  /** Current stroke's full-pressure diameter in document px. */
  docSize = 1;
  /** @inheritdoc */
  onPointerDown(editor, samples) {
    const first = samples[0];
    if (!first) return;
    const style = {
      mode: this.mode,
      opacity: this.options.opacity,
      hardness: this.options.hardness,
      color: this.options.color ?? "#000000"
    };
    this.docSize = imageLengthToDoc(editor.frameMap, this.options.size);
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
    return { kind: "ring", diameter: this.options.size };
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
    return {
      size: this.docSize,
      flow: this.options.flow,
      spacing: this.options.spacing,
      pressureSize: this.options.pressureSize,
      pressureOpacity: this.options.pressureOpacity,
      ...PRESSURE_CURVE
    };
  }
}
function createBrushTool() {
  return new PaintTool("brush", "Brush", "b", "paint", {
    size: 24,
    hardness: 0.8,
    opacity: 1,
    flow: 1,
    spacing: 0.1,
    pressureSize: true,
    pressureOpacity: false,
    color: "#000000"
  });
}
function createEraserTool() {
  return new PaintTool("eraser", "Eraser", "e", "erase", {
    size: 48,
    hardness: 0.8,
    opacity: 1,
    flow: 1,
    spacing: 0.1,
    pressureSize: true,
    pressureOpacity: false
  });
}
class ToolRegistry {
  events = new Emitter();
  tools = /* @__PURE__ */ new Map();
  activeId;
  /**
   * @param tools - Tools in rail order; the first becomes active.
   */
  constructor(tools) {
    for (const tool of tools) this.tools.set(tool.id, tool);
    this.activeId = tools[0]?.id ?? "";
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
    for (const tool of this.tools.values()) if (tool.shortcut === key) return tool;
    return void 0;
  }
  /**
   * Activate a tool.
   * @param id - Tool id.
   */
  setActive(id) {
    if (!this.tools.has(id) || id === this.activeId) return;
    this.activeId = id;
    this.events.emit("change", void 0);
  }
  /** Notify that the active tool's options changed. */
  notifyOptions() {
    this.events.emit("change", void 0);
  }
}
function createDefaultTools() {
  return new ToolRegistry([createBrushTool(), createEraserTool()]);
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
function layerFileName(docId, hash) {
  const prefix = docId.replace(/[^a-z0-9]/gi, "").slice(0, 8) || "doc";
  return `ps-${prefix}-${hash}.png`;
}
function notify(severity, detail) {
  const toast = app.extensionManager?.toast;
  if (toast && typeof toast.add === "function") {
    toast.add({ severity, summary: "PainterSketch", detail, life: severity === "error" ? 8e3 : 5e3 });
  }
  if (severity === "info") return;
  if (severity === "error") log.error(detail);
  else log.warn(detail);
}
const AUTO_UPLOAD_DELAY_MS = 1e3;
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
  /** Upload soon (debounced). Failures are reported, never thrown. */
  schedule() {
    if (this.disposed) return;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush().catch(() => void 0);
    }, AUTO_UPLOAD_DELAY_MS);
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
    for (const layer of [...this.editor.doc.layers]) {
      const rt = this.editor.layerRuntime(layer.id);
      if (!rt?.dirty) continue;
      const version = rt.version;
      try {
        const file = await this.uploadLayer(layer.id, layer.file);
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
  async uploadLayer(layerId, currentFile) {
    const canvas = this.editor.layerCanvas(layerId);
    if (isCanvasEmpty(canvas)) return null;
    const blob = await canvasToPng(canvas);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const name = layerFileName(this.editor.doc.docId, contentHash(bytes));
    const expected = `${DOCUMENT_SUBFOLDER}/${name} [input]`;
    if (currentFile === expected || this.knownFiles.has(expected)) return expected;
    return uploadPng(blob, name);
  }
}
function canvasToPng(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("PNG encoding failed")), "image/png");
  });
}
function isCanvasEmpty(canvas) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return false;
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  for (let i = 3; i < data.length; i += 4) if (data[i] !== 0) return false;
  return true;
}
async function uploadPng(blob, name) {
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
    tools: createDefaultTools(),
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
    this.host = new EditorHost({ onBecameVisible: () => this.refresh() });
    this.isolation = isolateEvents({
      root: this.host.root,
      stage: this.host.stage,
      onWheel: (event) => this.host.input.handleWheel(event),
      onMiddlePointer: (event) => this.host.input.handlePointer(event)
    });
    controllers.set(node, this);
    this.attach(createSession(createEmptyDocument(this.fallbackFrame().size), "widgets"));
  }
  node;
  /** Editor DOM shell; its `root` is the DOM widget element. */
  host;
  session = null;
  sessionUnbind = null;
  valueCache = "";
  lastExecuted = null;
  /** Last loaded background image; shown only while `image` is connected. */
  background = null;
  /** Key of the most recent source we started loading (success or not). */
  requestedKey = null;
  loadSeq = 0;
  contentKey = "";
  pollTimer = null;
  startTimer = null;
  listening = false;
  isolation;
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
    if (typeof value === "string" && value === this.valueCache) return;
    const parsed = parseDocument(value);
    if (parsed.status === "ok") {
      this.attach(this.sessionFor(parsed.document));
      return;
    }
    if (parsed.status === "invalid") {
      notify("warn", `Could not read the saved painting (${parsed.reason}); starting with an empty canvas.`);
    }
    if (parsed.status === "invalid" || this.session?.editor.hasPaint) {
      this.attach(createSession(createEmptyDocument(this.fallbackFrame().size), "widgets"));
    }
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
    return this.valueCache;
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
  /** Node added to a graph: start listening (after `configure` finishes). */
  handleAdded() {
    if (this.disposed || this.listening) return;
    this.listening = true;
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
  /** A link on our node changed. */
  handleConnectionsChange() {
    this.refresh();
  }
  /** Release node-bound resources; the session is only detached. Idempotent. */
  dispose() {
    if (this.disposed) return;
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
  }
  // ── Sessions ────────────────────────────────────────────────────────────
  /** Pick/create the session for a parsed manifest. */
  sessionFor(doc) {
    const existing = findSession(doc.docId);
    if (!existing) return createSession(doc, "document");
    const ownedElsewhere = existing.owner !== null && existing.owner !== this;
    const matches = sessionMatches(existing, doc);
    if (ownedElsewhere) {
      const docId = createId();
      return matches ? createSession({ ...doc, docId }, "document", existing.editor.fork(docId)) : createSession({ ...doc, docId }, "document");
    }
    return matches ? existing : createSession(doc, "document");
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
    else detachSession(session, this);
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
      this.requestedKey = this.background?.key ?? null;
    }
    this.updateContent();
  }
  tick() {
    if (!this.host.isVisible()) return;
    this.host.refreshScale();
    this.refresh();
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
    const seq = ++this.loadSeq;
    const image = new Image();
    image.decoding = "async";
    image.onload = () => {
      if (seq !== this.loadSeq || this.disposed) return;
      if (!image.naturalWidth || !image.naturalHeight) return;
      this.background = {
        key: source.key,
        image,
        size: { width: image.naturalWidth, height: image.naturalHeight }
      };
      this.updateContent();
    };
    image.onerror = () => {
      if (seq !== this.loadSeq || this.disposed) return;
      log.warn(`Could not load background image from ${source.origin} node:`, source.url);
    };
    image.src = source.url;
  }
  // ── Content ─────────────────────────────────────────────────────────────
  /**
   * Push background + frame decisions to the editor when anything relevant
   * changed. Connected: the loaded image (an empty editor adopts a new size;
   * otherwise it is only a display mapping). Disconnected: the `background` colour over the document's
   * frame; `width`/`height` only resize a fresh, empty, widget-sized document.
   */
  updateContent() {
    const session = this.session;
    if (this.disposed || !session) return;
    const { editor } = session;
    const bg = this.isImageConnected() ? this.background : null;
    if (bg) {
      const key2 = `${session.docId}|image|${bg.key}`;
      if (key2 === this.contentKey) return;
      this.contentKey = key2;
      editor.setBackground({ kind: "image", image: bg.image }, bg.size);
      editor.handleBackgroundSize(bg.size);
      return;
    }
    const frame = this.fallbackFrame();
    const key = `${session.docId}|fill|${frame.color}|${frame.size.width}x${frame.size.height}`;
    if (key === this.contentKey) return;
    this.contentKey = key;
    editor.setBackground({ kind: "fill", color: frame.color }, null);
    editor.handleWidgetFrame(frame.size);
  }
  /**
   * Frame used while disconnected: the document's frame once it has paint or
   * its size came from an image/manifest (SPEC Behavior Notes), else the
   * `width`/`height` widgets.
   */
  fallbackFrame() {
    const editor = this.session?.editor;
    const known = editor && (editor.hasPaint || editor.frameSource !== "widgets") ? editor.doc.frame : null;
    return resolveFallbackFrame(
      known,
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
    getController(this)?.handleConnectionsChange();
  };
  const onRemoved = proto.onRemoved;
  proto.onRemoved = function() {
    onRemoved?.call(this);
    getController(this)?.dispose();
  };
  proto.onDrawBackground = function() {
  };
}
const editorCss = '/*\n * PainterSketch editor styles. Every selector is scoped under .cps-* so we\n * never collide with the ComfyUI frontend. Injected once by styles/inject.ts.\n */\n\n.cps-root {\n  --cps-rail-width: 36px;\n  --cps-bg: #1e1e1e;\n  --cps-rail-bg: #262626;\n  --cps-border: #3a3a3a;\n  --cps-fg: #d0d0d0;\n  --cps-fg-muted: #7a7a7a;\n  --cps-accent: #3b82f6;\n\n  position: relative;\n  box-sizing: border-box;\n  display: flex;\n  flex-direction: row;\n  width: 100%;\n  height: 100%;\n  /* Nodes 2.0 ignores getMinHeight for DOM widgets; keep a usable floor. */\n  min-height: 244px;\n  min-width: 0;\n  overflow: hidden;\n  background: var(--cps-bg);\n  border: 1px solid var(--cps-border);\n  border-radius: 4px;\n  color: var(--cps-fg);\n  font: 11px/1.2 system-ui, sans-serif;\n  user-select: none;\n}\n\n.cps-root *,\n.cps-root *::before,\n.cps-root *::after {\n  box-sizing: border-box;\n}\n\n.cps-focus-sink {\n  position: absolute;\n  left: 0;\n  top: 0;\n  width: 1px;\n  height: 1px;\n  padding: 0;\n  border: 0;\n  opacity: 0;\n  pointer-events: none;\n}\n\n/* ── Tool rail ─────────────────────────────────────────────────────────── */\n\n.cps-rail {\n  flex: 0 0 var(--cps-rail-width);\n  display: flex;\n  flex-direction: column;\n  align-items: center;\n  gap: 2px;\n  padding: 4px 0;\n  background: var(--cps-rail-bg);\n  border-right: 1px solid var(--cps-border);\n  overflow: hidden;\n}\n\n.cps-rail-group {\n  display: flex;\n  flex-direction: column;\n  gap: 2px;\n}\n\n.cps-rail-spacer {\n  flex: 1 1 auto;\n}\n\n.cps-rail-button {\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  width: 28px;\n  height: 28px;\n  padding: 0;\n  border: 1px solid transparent;\n  border-radius: 4px;\n  background: transparent;\n  color: var(--cps-fg);\n  cursor: pointer;\n}\n\n.cps-rail-button:hover:not(:disabled) {\n  background: #333;\n}\n\n.cps-rail-button.cps-active {\n  border-color: var(--cps-accent);\n  background: #2d3a52;\n}\n\n.cps-rail-button svg {\n  width: 18px;\n  height: 18px;\n  fill: none;\n  stroke: currentColor;\n  stroke-width: 1.6;\n  stroke-linecap: round;\n  stroke-linejoin: round;\n}\n\n.cps-rail-button:disabled {\n  color: var(--cps-fg-muted);\n  cursor: default;\n}\n\n/* ── Main column: options strip + stage ────────────────────────────────── */\n\n.cps-main {\n  flex: 1 1 auto;\n  display: flex;\n  flex-direction: column;\n  min-width: 0;\n  min-height: 0;\n}\n\n.cps-options {\n  flex: 0 0 auto;\n  display: flex;\n  flex-wrap: wrap;\n  align-items: center;\n  gap: 2px 8px;\n  padding: 3px 6px;\n  background: var(--cps-rail-bg);\n  border-bottom: 1px solid var(--cps-border);\n}\n\n.cps-options[hidden] {\n  display: none;\n}\n\n.cps-opt {\n  display: flex;\n  align-items: center;\n  gap: 4px;\n  white-space: nowrap;\n}\n\n.cps-opt[hidden] {\n  display: none;\n}\n\n.cps-opt input[type="range"] {\n  width: 64px;\n  margin: 0;\n}\n\n.cps-opt-value {\n  min-width: 2.2em;\n  color: var(--cps-fg-muted);\n  font-variant-numeric: tabular-nums;\n}\n\n.cps-color {\n  width: 22px;\n  height: 18px;\n  padding: 0;\n  border: 1px solid var(--cps-border);\n  background: none;\n  cursor: pointer;\n}\n\n.cps-opt-toggle input {\n  margin: 0;\n}\n\n/* ── Stage ─────────────────────────────────────────────────────────────── */\n\n.cps-stage {\n  position: relative;\n  flex: 1 1 auto;\n  min-width: 0;\n  min-height: 0;\n  overflow: hidden;\n  touch-action: none;\n  outline: none;\n  cursor: crosshair;\n}\n\n.cps-stage.cps-pan-ready {\n  cursor: grab;\n}\n\n.cps-stage.cps-panning {\n  cursor: grabbing;\n}\n\n.cps-stage.cps-loading {\n  cursor: progress;\n}\n\n.cps-canvas {\n  position: absolute;\n  inset: 0;\n  display: block;\n  width: 100%;\n  height: 100%;\n  touch-action: none;\n}\n\n.cps-overlay {\n  pointer-events: none;\n}\n\n.cps-note {\n  position: absolute;\n  left: 50%;\n  bottom: 8px;\n  transform: translateX(-50%);\n  max-width: calc(100% - 16px);\n  padding: 4px 8px;\n  border-radius: 4px;\n  background: rgba(0, 0, 0, 0.75);\n  color: #fff;\n  pointer-events: none;\n  white-space: nowrap;\n  overflow: hidden;\n  text-overflow: ellipsis;\n}\n\n.cps-note[hidden] {\n  display: none;\n}\n';
const STYLE_ELEMENT_ID = "cps-styles";
function injectStyles() {
  if (document.getElementById(STYLE_ELEMENT_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ELEMENT_ID;
  style.textContent = editorCss;
  document.head.appendChild(style);
}
function createPainterSketchWidget(node, inputName, inputData) {
  injectStyles();
  const options = inputData[1] ?? {};
  const controller = new PainterSketchController(node);
  controller.setValue(options.default ?? "");
  const widget = node.addDOMWidget(inputName, DOM_WIDGET_TYPE, controller.host.root, {
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
  getCustomWidgets: () => ({
    [WIDGET_SPEC_TYPE]: (node, inputName, inputData) => createPainterSketchWidget(node, inputName, inputData)
  }),
  beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_NAME) return;
    installNodeHooks(nodeType);
  }
});
