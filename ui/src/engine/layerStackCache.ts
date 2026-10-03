/**
 * Flattened copies of unchanged layer runs, so a stage frame draws one canvas
 * per run instead of one per layer (zoom, pan and full redraws cost the same
 * with 10 layers as with 1).
 *
 * The display list (`layerDisplay.ts`) marks each layer as cacheable (with a
 * key covering everything that changes its pixels: source canvas identity,
 * revisions, opacity, layer-mask state) or live (stroke, float, Move drag:
 * changes every frame). Consecutive cacheable layers (two or more) are drawn
 * bottom -> top at their opacity into one bounds-sized canvas, rebuilt only
 * when a member's key changes. Live layers pass through in place, so the
 * stacking order and what covers what are unchanged: painting on layer 2 of
 * 3 shows [layer 1] [live layer 2] [layer 3]. Normal blending only, which is
 * associative: flattening a run gives the same picture as drawing it layer by
 * layer (up to 8-bit rounding).
 */

import type { Size } from "../geometry/rect";
import type { CompositeLayer } from "./compositor";
import { createSurface, releaseSurface } from "./surface";
import type { Surface } from "./surface";

/** One layer of the display list. */
export interface StackItem {
  layer: CompositeLayer;
  /** Pixel key of a cacheable layer; `null` = live (drawn directly every frame). */
  key: string | null;
}

/** A flattened run and the key it was drawn with. */
interface Group {
  key: string;
  surface: Surface;
}

const sourceIds = new WeakMap<object, number>();
let nextSourceId = 1;

/**
 * Stable id of a canvas / image object (part of a cache key: a replaced
 * surface after a bounds change is a different source).
 * @param source - Drawable.
 * @returns Positive integer, the same for the same object.
 */
export function sourceId(source: CanvasImageSource): number {
  let id = sourceIds.get(source);
  if (id === undefined) {
    id = nextSourceId++;
    sourceIds.set(source, id);
  }
  return id;
}

/**
 * Cache of flattened layer runs (one per stage editor).
 */
export class LayerStackCache {
  private groups: Group[] = [];

  /**
   * Replace runs of cacheable layers with their flattened copies.
   * @param items - Display list, bottom -> top, each sized to `size`.
   * @param size - Layer (bounds) size.
   * @returns Layers to composite, bottom -> top.
   */
  flatten(items: readonly StackItem[], size: Size): CompositeLayer[] {
    const out: CompositeLayer[] = [];
    let group = 0;
    let i = 0;
    while (i < items.length) {
      let end = i;
      while (end < items.length && items[end]?.key !== null) end++;
      if (end - i >= 2) {
        out.push({ source: this.drawGroup(group++, items.slice(i, end), size), opacity: 1 });
        i = end;
        continue;
      }
      const item = items[i];
      if (item) out.push(item.layer);
      i++;
    }
    // Runs that no longer exist free their memory.
    for (const unused of this.groups.splice(group)) releaseSurface(unused.surface);
    return out;
  }

  /** Release every flattened copy. */
  dispose(): void {
    for (const g of this.groups) releaseSurface(g.surface);
    this.groups = [];
  }

  /** The canvas of run `index`, redrawn when its members changed. */
  private drawGroup(index: number, run: readonly StackItem[], size: Size): HTMLCanvasElement {
    const key = `${size.width}x${size.height}|${run.map((item) => item.key).join("/")}`;
    let g = this.groups[index];
    if (g && g.key === key) return g.surface.canvas;
    if (!g || g.surface.canvas.width !== size.width || g.surface.canvas.height !== size.height) {
      if (g) releaseSurface(g.surface);
      g = { key: "", surface: createSurface(size.width, size.height) };
      this.groups[index] = g;
    }
    const { ctx, canvas } = g.surface;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const { layer } of run) {
      if (layer.opacity <= 0) continue;
      ctx.globalAlpha = layer.opacity;
      ctx.drawImage(layer.source, 0, 0, canvas.width, canvas.height);
    }
    ctx.globalAlpha = 1;
    g.key = key;
    return canvas;
  }
}
