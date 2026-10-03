/**
 * Colour wheel of the colour picker (`colorPicker.ts`, SPEC "Colour"): a hue
 * ring around a fixed saturation/value triangle (one canvas), the new / old
 * swatch in the left gap, and two circle groups: harmonies in the top-right
 * gap, variations (lighter / darker, ...) in the bottom-right gap, each with a
 * cycle button just outside the ring in line with its circles. Geometry is in
 * `colorWheelGeometry.ts`, the circles' colours in `colorSchemes.ts`.
 *
 * Holds no colour state: it reads the colour through `getHsv`, reports
 * changes through the callbacks, and the picker calls {@link ColorWheel.update}
 * after every change. A press on the ring drags the hue, a press in the
 * triangle drags inside it (clamped to it); the zone is fixed for the drag.
 * Presses in the gaps between them do nothing. Left button only, pointer
 * capture, wheel events stay in the popover.
 */

import { hsvToHex, hsvToRgb, type Hsv } from "./colorMath";
import { HARMONY_SET, VARIATION_SET, nextMode, parseMode, type SchemeSet } from "./colorSchemes";
import {
  HARMONY_GROUP,
  RING_OUTER,
  RING_WIDTH,
  SWATCH_BOX,
  TRIANGLE,
  TRIANGLE_HEIGHT,
  VARIATION_GROUP,
  WHEEL_SIZE,
  hueToAngle,
  isRingHit,
  isTriangleHit,
  pointToHue,
  pointToSv,
  ringThumb,
  svToPoint,
  triangleWeights,
  type Circle,
  type CircleGroup,
  type Point,
} from "./colorWheelGeometry";
import { setIcon } from "./icons";


/** Callbacks of {@link createColorWheel}. */
export interface ColorWheelOptions {
  /** Current colour. */
  getHsv: () => Hsv;
  /** The colour the picker opened with (`#rrggbb`, the swatch's lower half). */
  original: string;
  /** Ring / triangle drag or a circle click. */
  onChange: (hsv: Hsv) => void;
  /** Click on the swatch's lower half (back to the original colour). */
  onRevert: () => void;
}

/** Handle of a colour wheel. */
export interface ColorWheel {
  /** Wheel box (`.cps-picker-wheel`), {@link WHEEL_SIZE} square. */
  readonly element: HTMLElement;
  /** Size the canvas backing store and draw (call once it is laid out). */
  layout(): void;
  /** Redraw for the current colour (triangle only when the hue changed). */
  update(): void;
}

// ═══════════════════════════════════════════════════════════════════════════
// Component
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Build the colour wheel.
 * @param opts - Colour accessors and callbacks.
 * @returns The wheel's handle.
 */
export function createColorWheel(opts: ColorWheelOptions): ColorWheel {
  const element = div("cps-picker-wheel");
  const canvas = document.createElement("canvas");
  canvas.className = "cps-picker-wheel-canvas";
  const ringThumbEl = div("cps-picker-thumb cps-picker-thumb-ring");
  const svThumbEl = div("cps-picker-thumb cps-picker-thumb-sv");

  // ── Swatch: new colour on top, the original below (click reverts) ────────
  const swatch = div("cps-picker-swatch");
  place(swatch, SWATCH_BOX.left, SWATCH_BOX.top, SWATCH_BOX.width, SWATCH_BOX.height);
  const swatchNew = div("cps-picker-swatch-new");
  swatchNew.title = "New colour";
  const swatchOld = document.createElement("button");
  swatchOld.type = "button";
  swatchOld.className = "cps-picker-swatch-old";
  swatchOld.title = "Original colour (click to revert)";
  swatchOld.setAttribute("aria-label", "Revert to the original colour");
  swatchOld.style.backgroundColor = opts.original;
  swatchOld.addEventListener("click", () => opts.onRevert());
  swatch.append(swatchNew, swatchOld);

  // ── Circle groups: harmonies (top-right), variations (bottom-right) ──────
  const groups = [
    createCircleGroup(HARMONY_GROUP, HARMONY_SET, opts),
    createCircleGroup(VARIATION_GROUP, VARIATION_SET, opts),
  ];
  element.append(canvas, swatch, ...groups.flatMap((group) => group.elements), ringThumbEl, svThumbEl);

  // ── Drag ──────────────────────────────────────────────────────────────────
  let zone: "ring" | "triangle" = "triangle";
  const local = (event: PointerEvent): Point => {
    const rect = element.getBoundingClientRect();
    const scale = WHEEL_SIZE / (rect.width || WHEEL_SIZE);
    return {
      x: (event.clientX - rect.left) * scale - WHEEL_SIZE / 2,
      y: (event.clientY - rect.top) * scale - WHEEL_SIZE / 2,
    };
  };
  const drag = (event: PointerEvent): void => {
    const p = local(event);
    const hsv = opts.getHsv();
    if (zone === "ring") opts.onChange({ h: pointToHue(p), s: hsv.s, v: hsv.v });
    else opts.onChange({ h: hsv.h, ...pointToSv(p) });
  };
  /** Zone under a point; `null` in the gaps (and over the swatch / circles). */
  const zoneAt = (event: PointerEvent): "ring" | "triangle" | null => {
    if (event.target instanceof Element && event.target.closest("button, .cps-picker-swatch")) return null;
    const p = local(event);
    if (isRingHit(p)) return "ring";
    return isTriangleHit(p) ? "triangle" : null;
  };
  element.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    const hit = zoneAt(event);
    if (!hit) return;
    event.preventDefault();
    element.setPointerCapture(event.pointerId);
    zone = hit;
    drag(event);
  });
  element.addEventListener("pointermove", (event) => {
    if (element.hasPointerCapture(event.pointerId)) drag(event);
    else element.style.cursor = zoneAt(event) ? "crosshair" : "default";
  });
  element.addEventListener("wheel", (event) => event.stopPropagation());

  // ── Rendering ─────────────────────────────────────────────────────────────
  let drawnHue: number | null = null;
  let pixelScale = 1;

  const draw = (): void => {
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const hsv = opts.getHsv();
    drawnHue = hsv.h;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    drawTriangle(ctx, hsv.h, pixelScale);
    drawRing(ctx, pixelScale);
  };

  const update = (): void => {
    const hsv = opts.getHsv();
    if (drawnHue !== hsv.h) draw();
    const ring = ringThumb(hsv.h);
    moveThumb(ringThumbEl, ring);
    ringThumbEl.style.backgroundColor = hsvToHex({ h: hsv.h, s: 1, v: 1 });
    moveThumb(svThumbEl, svToPoint(hsv.s, hsv.v));
    svThumbEl.style.backgroundColor = hsvToHex(hsv);
    swatchNew.style.backgroundColor = hsvToHex(hsv);
    for (const group of groups) group.sync();
  };

  return {
    element,
    layout: () => {
      const rect = element.getBoundingClientRect();
      const side = Math.max(1, Math.round((rect.width || WHEEL_SIZE) * (window.devicePixelRatio || 1)));
      if (canvas.width !== side) {
        canvas.width = side;
        canvas.height = side;
      }
      pixelScale = side / WHEEL_SIZE;
      draw();
      update();
    },
    update,
  };
}

// ── Drawing ───────────────────────────────────────────────────────────────────

/** Hue ring: a conic gradient stroked as one thick arc. */
function drawRing(ctx: CanvasRenderingContext2D, k: number): void {
  const c = (WHEEL_SIZE / 2) * k;
  const gradient = ctx.createConicGradient(hueToAngle(0), c, c);
  for (let hue = 0; hue <= 360; hue += 30) gradient.addColorStop(hue / 360, hsvToHex({ h: hue % 360, s: 1, v: 1 }));
  ctx.strokeStyle = gradient;
  ctx.lineWidth = RING_WIDTH * k;
  ctx.beginPath();
  ctx.arc(c, c, (RING_OUTER - RING_WIDTH / 2) * k, 0, Math.PI * 2);
  ctx.stroke();
}

/**
 * The saturation/value triangle per pixel: colour = hue weight x pure hue +
 * white weight x white (black adds nothing); edges anti-aliased by the
 * distance to the nearest edge.
 */
function drawTriangle(ctx: CanvasRenderingContext2D, hue: number, k: number): void {
  const pure = hsvToRgb({ h: hue, s: 1, v: 1 });
  const half = WHEEL_SIZE / 2;
  const x0 = Math.floor((half + TRIANGLE.white.x - 1) * k);
  const x1 = Math.ceil((half + TRIANGLE.hue.x + 1) * k);
  const y0 = Math.floor((half + TRIANGLE.white.y - 1) * k);
  const y1 = Math.ceil((half + TRIANGLE.black.y + 1) * k);
  const width = x1 - x0;
  const height = y1 - y0;
  const image = ctx.createImageData(width, height);
  const data = image.data;
  const edge = TRIANGLE_HEIGHT * k;
  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      const p = { x: (x0 + px + 0.5) / k - half, y: (y0 + py + 0.5) / k - half };
      const w = triangleWeights(p);
      const alpha = Math.min(1, Math.min(w.hue, w.white, w.black) * edge + 0.5);
      if (alpha <= 0) continue;
      const a = Math.max(0, w.hue);
      const b = Math.max(0, w.white);
      const sum = a + b + Math.max(0, w.black) || 1;
      const white = (b / sum) * 255;
      const i = (py * width + px) * 4;
      data[i] = white + (a / sum) * pure.r;
      data[i + 1] = white + (a / sum) * pure.g;
      data[i + 2] = white + (a / sum) * pure.b;
      data[i + 3] = alpha * 255;
    }
  }
  ctx.putImageData(image, x0, y0);
}

// ── DOM helpers ───────────────────────────────────────────────────────────────

function div(className: string): HTMLDivElement {
  const element = document.createElement("div");
  element.className = className;
  return element;
}

/** Position a box given in wheel-local px (as % of the wheel, so it scales). */
function place(element: HTMLElement, left: number, top: number, width: number, height: number): void {
  const pct = (v: number): string => `${(v / WHEEL_SIZE) * 100}%`;
  element.style.left = pct(left + WHEEL_SIZE / 2);
  element.style.top = pct(top + WHEEL_SIZE / 2);
  element.style.width = pct(width);
  element.style.height = pct(height);
}

function moveThumb(thumb: HTMLElement, p: Point): void {
  thumb.style.left = `${((p.x + WHEEL_SIZE / 2) / WHEEL_SIZE) * 100}%`;
  thumb.style.top = `${((p.y + WHEEL_SIZE / 2) / WHEEL_SIZE) * 100}%`;
}

/** Place a circle-shaped element. */
function placeCircle(element: HTMLElement, circle: Circle): void {
  place(element, circle.x - circle.r, circle.y - circle.r, circle.r * 2, circle.r * 2);
}

// ── Circle groups ─────────────────────────────────────────────────────────────

/** One gap's circles + cycle button. */
interface CircleGroupView {
  /** Circles and button, to append to the wheel. */
  readonly elements: HTMLElement[];
  /** Recolour for the current colour. */
  sync(): void;
}

/**
 * Three colour circles (partner, base, partner) and the button that cycles
 * the scheme's modes. Clicking a partner takes its colour; the base is the
 * current colour and does nothing.
 */
function createCircleGroup(geometry: CircleGroup, scheme: SchemeSet, opts: ColorWheelOptions): CircleGroupView {
  let mode = loadMode(scheme);
  const circles = geometry.circles.map((circle, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = index === 1 ? "cps-picker-dot cps-picker-dot-base" : "cps-picker-dot";
    placeCircle(button, circle);
    if (index !== 1) {
      button.addEventListener("click", () => opts.onChange(scheme.colors(opts.getHsv(), mode)[index] ?? opts.getHsv()));
    }
    return button;
  });
  const cycle = document.createElement("button");
  cycle.type = "button";
  cycle.className = "cps-picker-cycle";
  placeCircle(cycle, geometry.button);
  setIcon(cycle, scheme.icon, 18);

  const sync = (): void => {
    const colors = scheme.colors(opts.getHsv(), mode);
    const [first, second] = scheme.partnerLabels(mode);
    circles.forEach((button, index) => {
      const hex = hsvToHex(colors[index] ?? opts.getHsv()).toUpperCase();
      button.style.backgroundColor = hex;
      const name = index === 0 ? first : index === 2 ? second : "Current colour";
      button.title = `${name} ${hex}`;
    });
    cycle.title = `${scheme.title}: ${scheme.label(mode)} (click for ${scheme.label(nextMode(scheme.modes, mode))})`;
    cycle.setAttribute("aria-label", cycle.title);
  };
  cycle.addEventListener("click", () => {
    mode = nextMode(scheme.modes, mode);
    saveMode(scheme, mode);
    sync();
  });
  return { elements: [...circles, cycle], sync };
}

// ── Storage ───────────────────────────────────────────────────────────────────

function loadMode(scheme: SchemeSet): string {
  try {
    return parseMode(scheme.modes, window.localStorage.getItem(scheme.storageKey));
  } catch {
    return parseMode(scheme.modes, null);
  }
}

function saveMode(scheme: SchemeSet, mode: string): void {
  try {
    window.localStorage.setItem(scheme.storageKey, mode);
  } catch {
    // Storage blocked: the choice lasts until the picker closes.
  }
}