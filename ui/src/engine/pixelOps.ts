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
 * the coverage bbox.
 *
 * Sampling (bucket, wand, eyedropper) goes through one path
 * ({@link sampleTarget} + `sampleArea`): one layer, "All layers" (the
 * visible composite incl. the background) or "Background" (only the input
 * image / background-colour frame, as displayed), both via `docComposite.ts`.
 *
 * Eyedropper: always samples colours (also in Quick Mask).
 */

import { targetLayer } from "../document/masks";
import type { Layer } from "../document/types";
import { isEmptyRect, rectEquals, roundOutRect, unionRect } from "../geometry/rect";
import type { Point, Rect } from "../geometry/rect";
import type { CompositeLayer } from "./compositor";
import { readDocRegion, sceneFor } from "./docComposite";
import type { DocCompositeInput, SceneSource } from "./docComposite";
import { MASK_STROKE_COLOR } from "./editorTypes";
import type { EditorState } from "./editorState";
import { preparePixelEdit } from "./rasterize";
import { floodFill } from "./floodFill";
import { documentMap, imageRectToDoc } from "./frameMap";
import { averageColor, blendCoverage, hexToRgb, rgbToHex } from "./pixelColor";
import type { Selection } from "./selection";
import { wandSelection } from "./wand";
import type { WandOptions } from "./wand";

/**
 * Which pixels a tool looks at: one layer, everything visible, or only the
 * background (input image / background-colour frame, as displayed).
 */
export type SampleSource = "layer" | "all" | "background";

/** Where a sample is read from once the layer is known ({@link sampleTarget}). */
export type SampleTarget = { kind: "layer"; layer: Layer } | { kind: "scene"; source: SceneSource };

/**
 * Resolve a sample source: `"layer"` reads that layer's pixels (falling back
 * to everything visible when there is no layer), the others render the scene.
 * Pure; the single decision shared by bucket, wand and eyedropper.
 * @param sample - Tool option.
 * @param layer - Layer `"layer"` means (target / active paint layer), if any.
 * @returns What to read.
 */
export function sampleTarget(sample: SampleSource, layer: Layer | null | undefined): SampleTarget {
  if (sample === "layer") return layer ? { kind: "layer", layer } : { kind: "scene", source: "all" };
  return { kind: "scene", source: sample };
}

/** A magic-wand pick. */
export interface WandRequest extends WandOptions {
  /** Click position, document coords. */
  point: Point;
  /** Active paint layer, the visible composite or the background only. */
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
  /** Current (target) layer, the visible composite or the background only. */
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
    // A rasterized text layer is filled right away (the fill joins the rasterize step).
    if (!layer || preparePixelEdit(s, layer) === "blocked") return false;
    const px = Math.floor(req.point.x);
    const py = Math.floor(req.point.y);
    const image = this.imageRectInDoc();
    if (!inside(image, px, py) && !inside(s.store.bounds, px, py)) return false;
    s.ensureBounds(image, true);
    const bounds = s.store.bounds;
    if (!inside(bounds, px, py)) return false;

    const source = this.sampleArea(bounds, sampleTarget(req.sample, layer));
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
  sampleColor(point: Point, source: SampleSource, size: number): string | null {
    const r = Math.max(0, Math.floor((size - 1) / 2));
    const rect: Rect = { x: Math.floor(point.x) - r, y: Math.floor(point.y) - r, width: r * 2 + 1, height: r * 2 + 1 };
    const layer = targetLayer(this.s.doc, "paint");
    // "Current layer" with no paint layer samples nothing (unlike bucket/wand, which fall back).
    if (source === "layer" && !layer) return null;
    this.scratch ??= document.createElement("canvas");
    const data = this.sampleArea(rect, sampleTarget(source, layer), this.scratch);
    const rgb = data ? averageColor(data) : null;
    return rgb ? rgbToHex(rgb) : null;
  }

  /** Release the scratch canvas. */
  dispose(): void {
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
  private sampleArea(area: Rect, target: SampleTarget, scratch?: HTMLCanvasElement): Uint8ClampedArray | null {
    if (target.kind === "scene") return readDocRegion(sceneFor(this.compositeInput(), target.source), area, scratch)?.data ?? null;
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
  private imageRectInDoc(): Rect {
    const s = this.s;
    const map = documentMap(s.doc, s.imageSize);
    const size = s.imageSize;
    return roundOutRect(imageRectToDoc(map, { x: 0, y: 0, width: size.width, height: size.height }));
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
