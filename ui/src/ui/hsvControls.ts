/**
 * Drag widgets of the colour picker (`colorPicker.ts`): the saturation/value
 * square (canvas) and the horizontal hue slider. Both drag with pointer
 * capture (left button only) and keep wheel events from leaving the popover.
 *
 * They hold no colour state: they read the current HSV through `getHsv` and
 * report changes through `onChange`; the picker re-renders them via
 * `draw` / `position`.
 */

import { clamp01, hsvToHex, type Hsv } from "./colorMath";

/** SV square handle. */
export interface SvSquare {
  /** Wrapper element (`.cps-picker-sv`). */
  readonly element: HTMLElement;
  /** Repaint the gradient for the current hue. */
  draw(): void;
  /** Move the thumb to the current saturation/value. */
  position(): void;
  /** Sync the canvas backing resolution to its CSS size. */
  resize(): void;
}

/** Hue slider handle. */
export interface HueSlider {
  /** Wrapper element (`.cps-picker-hue`). */
  readonly element: HTMLElement;
  /** Move the thumb to the current hue. */
  position(): void;
}

/**
 * Left-button drag with pointer capture on `target`; `update` runs on press
 * and on every captured move. Wheel events stop at `target`.
 */
function bindCaptureDrag(target: HTMLElement, update: (event: PointerEvent) => void): void {
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
  // Stop events leaking up past the popover (belt and suspenders)
  target.addEventListener("wheel", (e) => e.stopPropagation());
}

/**
 * Build the saturation (x) / value (y) square.
 * @param getHsv - Current colour.
 * @param onChange - Called with the new colour while dragging.
 * @returns The square's handle.
 */
export function createSvSquare(getHsv: () => Hsv, onChange: (hsv: Hsv) => void): SvSquare {
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

      // White -> hue gradient (left to right = saturation)
      const satGrad = ctx.createLinearGradient(0, 0, w, 0);
      satGrad.addColorStop(0, "#ffffff");
      satGrad.addColorStop(1, hsvToHex({ h: getHsv().h, s: 1, v: 1 }));
      ctx.fillStyle = satGrad;
      ctx.fillRect(0, 0, w, h);

      // Transparent -> black gradient (top to bottom = value)
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
    },
  };
}

/**
 * Build the horizontal hue slider (0-360 left to right).
 * @param getHsv - Current colour.
 * @param onChange - Called with the new colour while dragging.
 * @returns The slider's handle.
 */
export function createHueSlider(getHsv: () => Hsv, onChange: (hsv: Hsv) => void): HueSlider {
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
      thumb.style.left = `${(getHsv().h / 360) * 100}%`;
    },
  };
}
