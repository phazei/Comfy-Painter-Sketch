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
  return {
    x: (vw - width) / 2,
    y: (vh - height) / 2,
    width,
    height,
    scale
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
const DEFAULT_STAGE_STYLE = {
  surround: "#1e1e1e",
  checkerLight: "#cfcfcf",
  checkerDark: "#a8a8a8",
  checkerCell: 8,
  padding: 8,
  frameOutline: "rgba(0, 0, 0, 0.6)"
};
function renderStage(ctx, cssSize, pixelRatio, content, style = DEFAULT_STAGE_STYLE) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = style.surround;
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  const fit = fitContain(content.size, cssSize, style.padding);
  if (fit.width <= 0 || fit.height <= 0) return;
  if (content.kind === "image") {
    drawChecker(ctx, fit.x, fit.y, fit.width, fit.height, style);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(content.image, fit.x, fit.y, fit.width, fit.height);
  } else {
    ctx.fillStyle = content.color;
    ctx.fillRect(fit.x, fit.y, fit.width, fit.height);
  }
  ctx.strokeStyle = style.frameOutline;
  ctx.lineWidth = 1 / pixelRatio;
  ctx.strokeRect(fit.x, fit.y, fit.width, fit.height);
}
function drawChecker(ctx, x, y, width, height, style) {
  const cell = style.checkerCell;
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, width, height);
  ctx.clip();
  ctx.fillStyle = style.checkerLight;
  ctx.fillRect(x, y, width, height);
  ctx.fillStyle = style.checkerDark;
  const cols = Math.ceil(width / cell);
  const rows = Math.ceil(height / cell);
  for (let row = 0; row < rows; row++) {
    for (let col = row % 2; col < cols; col += 2) {
      ctx.fillRect(x + col * cell, y + row * cell, cell, cell);
    }
  }
  ctx.restore();
}
const PLACEHOLDER_ITEMS = [
  { id: "brush", title: "Brush (B)", path: "M4 20c2 0 4-1 4-3a2 2 0 1 0-4 0M8 17 19 6a2 2 0 0 0-3-3L5 14" },
  { id: "eraser", title: "Eraser (E)", path: "M7 20h10M4 14l8-8 6 6-8 8H7z" },
  { id: "fill", title: "Paint bucket (G)", path: "M5 11l7-7 7 7-7 7zM19 15c1 2 2 3 2 4a2 2 0 0 1-4 0c0-1 1-2 2-4" },
  { id: "mask", title: "Quick Mask (Q)", path: "M4 4h16v16H4zM12 8a4 4 0 1 0 0 8a4 4 0 1 0 0-8" }
];
function createToolRail() {
  const rail = document.createElement("div");
  rail.className = "cps-rail";
  for (const item of PLACEHOLDER_ITEMS) rail.appendChild(createRailButton(item));
  return rail;
}
function createRailButton(item) {
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
class EditorHost {
  /**
   * @param events - Owner callbacks.
   */
  constructor(events = {}) {
    this.events = events;
    this.root = document.createElement("div");
    this.root.className = "cps-root";
    this.stage = document.createElement("div");
    this.stage.className = "cps-stage";
    this.stage.tabIndex = -1;
    this.canvas = document.createElement("canvas");
    this.canvas.className = "cps-canvas";
    this.ctx = this.canvas.getContext("2d");
    this.stage.appendChild(this.canvas);
    this.root.append(createToolRail(), this.stage);
    this.resizeObserver = new ResizeObserver(() => this.handleResize());
    this.resizeObserver.observe(this.stage);
  }
  events;
  /** Root element handed to `addDOMWidget`. */
  root;
  /** Canvas area (receives wheel; later: pointer tools). */
  stage;
  canvas;
  ctx;
  resizeObserver;
  content = null;
  frameRequest = 0;
  pixelRatio = 1;
  wasVisible = false;
  disposed = false;
  // ── Public API ──────────────────────────────────────────────────────────
  /**
   * Replace what the frame shows and redraw.
   *
   * @param content - New frame content.
   */
  setContent(content) {
    this.content = content;
    this.requestRender();
  }
  /**
   * Re-check the on-screen scale (graph zoom changes don't trigger
   * ResizeObserver) and redraw if the backing store would change. Cheap;
   * safe to call from a timer.
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
  /** Stop observing and drop the canvas. Idempotent. */
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.frameRequest) cancelAnimationFrame(this.frameRequest);
    this.frameRequest = 0;
    this.resizeObserver.disconnect();
    this.canvas.width = 0;
    this.canvas.height = 0;
    this.root.remove();
  }
  // ── Internals ───────────────────────────────────────────────────────────
  handleResize() {
    const visible = this.isVisible();
    if (visible && !this.wasVisible) this.events.onBecameVisible?.();
    this.wasVisible = visible;
    this.syncBackingStore();
    this.requestRender();
  }
  /**
   * Size the backing store for the current layout size, DPR and ancestor
   * zoom. @returns `true` if the size changed.
   */
  syncBackingStore() {
    const cssWidth = this.stage.clientWidth;
    const cssHeight = this.stage.clientHeight;
    if (cssWidth <= 0 || cssHeight <= 0) return false;
    const rect = this.stage.getBoundingClientRect();
    const displayScale = rect.width > 0 ? rect.width / cssWidth : 1;
    const size = backingStoreSize({ width: cssWidth, height: cssHeight }, window.devicePixelRatio, displayScale);
    this.pixelRatio = size.ratio;
    if (this.canvas.width === size.width && this.canvas.height === size.height) return false;
    this.canvas.width = size.width;
    this.canvas.height = size.height;
    return true;
  }
  render() {
    if (!this.ctx || !this.content || !this.isVisible()) return;
    this.syncBackingStore();
    renderStage(
      this.ctx,
      { width: this.stage.clientWidth, height: this.stage.clientHeight },
      this.pixelRatio,
      this.content,
      DEFAULT_STAGE_STYLE
    );
  }
}
function normalizeDocumentValue(value) {
  if (typeof value === "string") return value;
  if (value === null || value === void 0) return "";
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return "";
    }
  }
  return String(value);
}
async function serializeDocumentValue(current) {
  return current;
}
const POINTER_EVENTS = [
  "pointerdown",
  "pointerup",
  "pointercancel",
  "mousedown",
  "mouseup",
  "dblclick",
  "contextmenu"
];
function isolateEvents(options) {
  const { root, wheelTarget, onWheel } = options;
  const controller = new AbortController();
  const { signal } = controller;
  const stop = (event) => event.stopPropagation();
  for (const type of POINTER_EVENTS) root.addEventListener(type, stop, { signal });
  wheelTarget.dataset["captureWheel"] = "true";
  let guardActive = false;
  const guard = (event) => {
    const target = event.target;
    if (!(target instanceof Node) || !wheelTarget.contains(target)) return;
    event.preventDefault();
    event.stopPropagation();
    onWheel?.(event);
  };
  const armGuard = () => {
    if (guardActive) return;
    guardActive = true;
    window.addEventListener("wheel", guard, { capture: true, passive: false });
  };
  const disarmGuard = () => {
    if (!guardActive) return;
    guardActive = false;
    window.removeEventListener("wheel", guard, { capture: true });
  };
  wheelTarget.addEventListener("pointerenter", armGuard, { signal });
  wheelTarget.addEventListener("pointermove", armGuard, { signal });
  wheelTarget.addEventListener("pointerleave", disarmGuard, { signal });
  return {
    dispose() {
      controller.abort();
      disarmGuard();
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
    this.isolation = isolateEvents({ root: this.host.root, wheelTarget: this.host.stage });
    controllers.set(node, this);
  }
  node;
  /** Editor DOM shell; its `root` is the DOM widget element. */
  host;
  documentValue = "";
  lastExecuted = null;
  /**
   * Last loaded background image. Shown only while `image` is connected;
   * kept while disconnected so reconnecting the same source needs no reload.
   */
  background = null;
  /**
   * Last known frame size, used (filled with `background`) while `image` is
   * disconnected. Set from each loaded background image; M1 seeds it from the
   * document manifest's `frame` via {@link setKnownFrame}.
   */
  knownFrame = null;
  /** Key of the most recent source we started loading (success or not). */
  requestedKey = null;
  loadSeq = 0;
  contentKey = "";
  pollTimer = null;
  listening = false;
  isolation;
  disposed = false;
  handleApiExecuted = () => this.refresh();
  // ── Widget value ────────────────────────────────────────────────────────
  /** @returns The stored document string (`""` = no document yet). */
  getValue() {
    return this.documentValue;
  }
  /**
   * Store a new document value (from workflow load, undo, paste, ...).
   *
   * @param value - Incoming value; coerced to a string.
   */
  setValue(value) {
    this.documentValue = normalizeDocumentValue(value);
  }
  /**
   * Set the frame size used when no image is connected (M1: from the
   * document manifest's `frame`, matching what Python outputs).
   *
   * @param frame - Frame size, or `null` to forget it.
   */
  setKnownFrame(frame) {
    this.knownFrame = frame ? { width: frame.width, height: frame.height } : null;
    this.updateContent();
  }
  // ── Lifecycle (called from node hooks) ──────────────────────────────────
  /**
   * Node constructor finished: widgets exist but the node is not in a graph
   * yet. Chain our own widgets' callbacks so fallback-frame edits redraw
   * immediately (the poll catches programmatic changes).
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
  /** Node was added to a graph: start listening for background changes. */
  handleAdded() {
    if (this.disposed || this.listening) return;
    this.listening = true;
    api.addEventListener("executed", this.handleApiExecuted);
    this.pollTimer = setInterval(() => this.tick(), SOURCE_POLL_MS);
    this.refresh();
  }
  /**
   * Our node executed; its `ui` output carries the input image preview.
   *
   * @param output - Execution output (`output.images`).
   */
  handleExecuted(output) {
    this.lastExecuted = output;
    this.refresh();
  }
  /** A link on our node changed. */
  handleConnectionsChange() {
    this.refresh();
  }
  /** Release everything. Idempotent. */
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.loadSeq++;
    if (this.listening) api.removeEventListener("executed", this.handleApiExecuted);
    this.listening = false;
    if (this.pollTimer !== null) clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.isolation.dispose();
    this.host.dispose();
    controllers.delete(this.node);
  }
  // ── Background resolution ───────────────────────────────────────────────
  /**
   * Re-resolve the background source and reload only if it changed. While
   * `image` is disconnected no source is used (not even our last executed
   * preview, which would no longer match the node's output) and any
   * in-flight load is abandoned.
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
  isImageConnected() {
    return isInputConnected(this.node, INPUT_NAMES.image);
  }
  tick() {
    if (!this.host.isVisible()) return;
    this.host.refreshScale();
    this.refresh();
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
      const size = { width: image.naturalWidth, height: image.naturalHeight };
      this.background = { key: source.key, image, size };
      this.knownFrame = size;
      this.updateContent();
    };
    image.onerror = () => {
      if (seq !== this.loadSeq || this.disposed) return;
      log.warn(`Could not load background image from ${source.origin} node:`, source.url);
    };
    image.src = source.url;
  }
  // ── Content ─────────────────────────────────────────────────────────────
  /** Push the current frame content to the host if it changed. */
  updateContent() {
    if (this.disposed) return;
    const content = this.currentContent();
    const key = content.kind === "image" ? `image:${this.background?.key ?? ""}` : `fill:${content.size.width}x${content.size.height}:${content.color}`;
    if (key === this.contentKey) return;
    this.contentKey = key;
    this.host.setContent(content);
  }
  /**
   * Connected: the last loaded image. Disconnected (or nothing loaded yet):
   * the last known frame size -- else the width/height widgets -- filled
   * with the `background` colour, matching the Python output.
   */
  currentContent() {
    if (this.background && this.isImageConnected()) {
      return { kind: "image", image: this.background.image, size: this.background.size };
    }
    const frame = resolveFallbackFrame(
      this.knownFrame,
      this.findWidget(INPUT_NAMES.width)?.value,
      this.findWidget(INPUT_NAMES.height)?.value,
      this.findWidget(INPUT_NAMES.background)?.value
    );
    return { kind: "fill", color: frame.color, size: frame.size };
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
const editorCss = "/*\n * PainterSketch editor styles. Every selector is scoped under .cps-* so we\n * never collide with the ComfyUI frontend. Injected once by styles/inject.ts.\n */\n\n.cps-root {\n  --cps-rail-width: 36px;\n  --cps-bg: #1e1e1e;\n  --cps-rail-bg: #262626;\n  --cps-border: #3a3a3a;\n  --cps-fg: #d0d0d0;\n  --cps-fg-muted: #7a7a7a;\n\n  box-sizing: border-box;\n  display: flex;\n  flex-direction: row;\n  width: 100%;\n  height: 100%;\n  /* Nodes 2.0 ignores getMinHeight for DOM widgets; keep a usable floor. */\n  min-height: 244px;\n  min-width: 0;\n  overflow: hidden;\n  background: var(--cps-bg);\n  border: 1px solid var(--cps-border);\n  border-radius: 4px;\n  color: var(--cps-fg);\n  font: 12px/1.2 system-ui, sans-serif;\n  user-select: none;\n}\n\n.cps-root *,\n.cps-root *::before,\n.cps-root *::after {\n  box-sizing: border-box;\n}\n\n/* ── Tool rail ─────────────────────────────────────────────────────────── */\n\n.cps-rail {\n  flex: 0 0 var(--cps-rail-width);\n  display: flex;\n  flex-direction: column;\n  align-items: center;\n  gap: 2px;\n  padding: 4px 0;\n  background: var(--cps-rail-bg);\n  border-right: 1px solid var(--cps-border);\n  overflow: hidden;\n}\n\n.cps-rail-button {\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  width: 28px;\n  height: 28px;\n  padding: 0;\n  border: 1px solid transparent;\n  border-radius: 4px;\n  background: transparent;\n  color: var(--cps-fg);\n  cursor: pointer;\n}\n\n.cps-rail-button svg {\n  width: 18px;\n  height: 18px;\n  fill: none;\n  stroke: currentColor;\n  stroke-width: 1.6;\n  stroke-linecap: round;\n  stroke-linejoin: round;\n}\n\n.cps-rail-button:disabled {\n  color: var(--cps-fg-muted);\n  cursor: default;\n}\n\n/* ── Stage ─────────────────────────────────────────────────────────────── */\n\n.cps-stage {\n  position: relative;\n  flex: 1 1 auto;\n  min-width: 0;\n  min-height: 0;\n  overflow: hidden;\n  touch-action: none;\n  outline: none;\n}\n\n.cps-canvas {\n  position: absolute;\n  inset: 0;\n  display: block;\n  width: 100%;\n  height: 100%;\n  touch-action: none;\n}\n";
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
  widget.serializeValue = () => serializeDocumentValue(controller.getValue());
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
