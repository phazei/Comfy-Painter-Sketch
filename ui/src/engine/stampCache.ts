/**
 * Cached brush stamps: a radial-gradient disc per (diameter bucket, hardness,
 * colour). Dabs draw the cached stamp scaled to their exact size, so
 * pressure-varying sizes reuse one stamp.
 */

import { stampStops } from "./brush";
import { createSurface } from "./surface";
import type { Surface } from "./surface";

/** Cached stamps kept before the oldest is dropped. */
const MAX_STAMPS = 32;

/**
 * LRU cache of stamp surfaces.
 */
export class StampCache {
  private readonly stamps = new Map<string, Surface>();

  /**
   * Get (or render) a stamp.
   *
   * @param diameter - Largest diameter it will be drawn at, px.
   * @param hardness - 0..1.
   * @param color - CSS colour.
   * @returns Square surface with the disc centred.
   */
  get(diameter: number, hardness: number, color: string): Surface {
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
      if (oldest !== undefined) this.stamps.delete(oldest);
    }
    return stamp;
  }

  /** Drop all stamps. */
  clear(): void {
    this.stamps.clear();
  }
}

function renderStamp(size: number, hardness: number, color: string): Surface {
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

/** Resolve any CSS colour to "r, g, b" via the canvas parser. */
function colorToRgb(ctx: CanvasRenderingContext2D, color: string): string {
  ctx.fillStyle = "#000000";
  ctx.fillStyle = color;
  const parsed = String(ctx.fillStyle);
  const hex = /^#([0-9a-f]{6})$/i.exec(parsed)?.[1];
  if (hex) {
    const n = parseInt(hex, 16);
    return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
  }
  const rgba = /^rgba?\(([^)]+)\)$/i.exec(parsed)?.[1];
  if (rgba) return rgba.split(",").slice(0, 3).join(",");
  return "0, 0, 0";
}
