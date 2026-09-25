/**
 * Pixel-reading operations of the editor core: paint-bucket fills and
 * eyedropper sampling (SPEC Tools table, M4). Exposed as
 * {@link Editor.pixelOps}.
 *
 * Fill: the target layer follows Quick Mask (decision 6; on the mask the fill
 * writes white coverage, like mask strokes). The fill area is the layer
 * bounds, first grown (chunked, capped, like painting) to cover the visible
 * image in document coords -- so a click anywhere on the image works even
 * when its aspect differs from `doc.frame`. Clicks outside both the image
 * and the bounds do nothing. One dirty-rect undo patch (decision 10) covering
 * the coverage bbox. Sampling "all layers" reads `docComposite.ts`.
 *
 * Eyedropper: always samples colours (also in Quick Mask): the active paint
 * layer, or the visible composite incl. the background.
 */

import { targetLayer } from "../document/masks";
import type { Layer } from "../document/types";
import { isEmptyRect, rectEquals, roundOutRect, unionRect } from "../geometry/rect";
import type { Point, Rect } from "../geometry/rect";
import type { CompositeLayer } from "./compositor";
import { readDocRegion } from "./docComposite";
import type { DocCompositeInput } from "./docComposite";
import { HIDDEN_MASK_NOTE, LOCKED_LAYER_NOTE, MASK_STROKE_COLOR } from "./editorTypes";
import type { EditorState } from "./editorState";
import { floodFill } from "./floodFill";
import { documentMap } from "./frameMap";
import { averageColor, blendCoverage, hexToRgb, rgbToHex } from "./pixelColor";
import type { Selection } from "./selection";
import { wandSelection } from "./wand";
import type { WandOptions } from "./wand";

/** Which pixels a tool looks at. */
export type SampleSource = "layer" | "all";

/** A magic-wand pick. */
export interface WandRequest extends WandOptions {
  /** Click position, document coords. */
  point: Point;
  /** Active paint layer or the visible composite. */
  sample: SampleSource;
}

/** A paint-bucket fill. */
export interface FillRequest {
  /** Click position, document coords. */
  point: Point;
  /** 0-255 per-channel tolerance. */
  tolerance: number;
  contiguous: boolean;
  antiAlias: boolean;
  /** Current (target) layer or the visible composite. */
  sample: SampleSource;
  /** 0..1 */
  opacity: number;
  /** Fill colour (ignored on masks: white coverage). */
  color: string;
}

/**
 * Bucket fill and colour sampling over a shared {@link EditorState}.
 */
export class PixelOps {
  /** Small reusable canvas for eyedropper reads. */
  private scratch: HTMLCanvasElement | null = null;

  /**
   * @param s - Shared editor state.
   */
  constructor(private readonly s: EditorState) {}

  // ── Fill ────────────────────────────────────────────────────────────────

  /**
   * Flood fill the paint target from a point, as one undo step.
   * @param req - Fill parameters.
   * @returns `true` if pixels changed.
   */
  fill(req: FillRequest): boolean {
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
      clip: s.selection.coverage(bounds),
    });
    if (isEmptyRect(bbox)) return false;

    const docRect: Rect = { x: bounds.x + bbox.x, y: bounds.y + bbox.y, width: bbox.width, height: bbox.height };
    const before = s.store.read(layer.id, docRect);
    if (!before) return false;
    const next = new ImageData(new Uint8ClampedArray(before.data.data), before.data.width, before.data.height);
    const color = hexToRgb(layer.kind === "mask" ? MASK_STROKE_COLOR : req.color);
    blendCoverage(next.data, bbox, coverage, bounds.width, color, req.opacity);
    s.store.write(layer.id, docRect.x, docRect.y, next);
    // Re-read so the patch holds exactly what the canvas stores (premultiplied round trip).
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
  wandSelection(req: WandRequest): Selection | null {
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
  sampleColor(point: Point, source: SampleSource, size: number): string | null {
    const s = this.s;
    const r = Math.max(0, Math.floor((size - 1) / 2));
    const rect: Rect = { x: Math.floor(point.x) - r, y: Math.floor(point.y) - r, width: r * 2 + 1, height: r * 2 + 1 };
    let data: ImageData | null | undefined;
    if (source === "layer") {
      const layer = targetLayer(s.doc, "paint");
      data = layer ? s.store.read(layer.id, rect)?.data : null;
    } else {
      this.scratch ??= document.createElement("canvas");
      data = readDocRegion(this.compositeInput(), rect, this.scratch);
    }
    const rgb = data ? averageColor(data.data) : null;
    return rgb ? rgbToHex(rgb) : null;
  }

  /** Release the scratch canvas. */
  dispose(): void {
    if (this.scratch) this.scratch.width = this.scratch.height = 0;
    this.scratch = null;
  }

  // ── Internals ───────────────────────────────────────────────────────────

  /**
   * RGBA of a document area as the bucket / wand see it: the visible
   * composite, or one layer (transparent outside the bounds).
   */
  private sampleArea(area: Rect, sample: SampleSource, layer: Layer | null): Uint8ClampedArray | null {
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
  private canEdit(layer: Layer): boolean {
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
  private imageRectInDoc(): Rect {
    const s = this.s;
    const map = documentMap(s.doc, s.imageSize);
    const size = s.imageSize;
    return roundOutRect({
      x: -map.offsetX / map.scale,
      y: -map.offsetY / map.scale,
      width: size.width / map.scale,
      height: size.height / map.scale,
    });
  }

  private compositeInput(): DocCompositeInput {
    const s = this.s;
    const layers: CompositeLayer[] = [];
    for (const layer of s.doc.layers) {
      if (!layer.visible || layer.kind === "mask") continue;
      layers.push({ source: s.store.ensure(layer.id).canvas, opacity: layer.opacity });
    }
    return {
      background: s.background,
      imageSize: s.imageSize,
      map: documentMap(s.doc, s.imageSize),
      bounds: s.store.bounds,
      layers,
    };
  }
}

function inside(r: Rect, x: number, y: number): boolean {
  return x >= r.x && y >= r.y && x < r.x + r.width && y < r.y + r.height;
}
