/**
 * Pixel-reading operations of the editor core: paint-bucket fills and
 * eyedropper sampling (SPEC "Fill and wand sampling",
 * SPEC "Tools" > "Eyedropper (I)"). Exposed as
 * {@link Editor.pixelOps}.
 *
 * Fill: the target layer follows Quick Mask (on the mask the fill
 * writes white coverage, like mask strokes). The fill area is the layer
 * bounds, first grown (chunked, capped, like painting) to cover the visible
 * image in document coords -- so a click anywhere on the image works even
 * when its aspect differs from `doc.frame`. Clicks outside both the image
 * and the bounds do nothing. One dirty-rect undo patch covering
 * the coverage bbox. With anti-alias the fill also goes behind the target
 * layer's own soft edges next to it (`fillUnder.ts`), so filling around a
 * stroke leaves no halo. On a targeted layer mask the flooded region
 * gets the foreground mask swatch instead.
 *
 * Sampling (bucket, wand, eyedropper) goes through one path
 * ({@link sampleTarget} + `sampleArea`): one layer's raw pixels (its lmask
 * not applied), "All layers" (the visible composite incl. the background,
 * lmasks applied) or "Background" (only the input image / background-colour
 * frame, as displayed), both via `docComposite.ts`. For the bucket and wand
 * "Current layer" is the current target: under Quick Mask the current mask
 * (incl. the Image / Input Mask row) as its effective coverage in gray
 * ({@link coverageGray}); a hidden target refuses with the gate's hidden
 * note ({@link hiddenNote}). Under Quick Mask "All layers" is the union of
 * the visible masks' effective coverage in gray (Image / Input Mask row
 * included while shown), not the paint composite. In the lmask-only view
 * the bucket and wand sample only the viewed mask's grayscale ({@link lmaskGray}).
 *
 * Eyedropper: always samples colours (also in Quick Mask).
 */

import { IMAGE_MASK_ID } from "../document/imageMask";
import { layerMaskKey } from "../document/layerMask";
import { targetLayer } from "../document/masks";
import type { Layer } from "../document/types";
import { isEmptyRect, rectEquals, roundOutRect, unionRect } from "../geometry/rect";
import type { Point, Rect } from "../geometry/rect";
import { readDocRegion, sceneFor, visibleScene } from "./docComposite";
import type { DocCompositeInput, SceneSource } from "./docComposite";
import { MASK_STROKE_COLOR } from "./editorTypes";
import type { EditorState } from "./editorState";
import { hiddenNote, preparePixelEdit } from "./rasterize";
import { unionMaskCoverage } from "./clipboardMath";
import { floodFill } from "./floodFill";
import { coverageInDoc } from "./imageMask";
import { imageMaskApplies } from "./imageMaskOps";
import { MASK_WHITE, targetedMaskLayer } from "./layerMask";
import { shownOnStage } from "./solo";
import { documentMap, imageRectToDoc } from "./frameMap";
import { averageColor, blendCoverage, blendCoverageBehind, hexToRgb, rgbToHex } from "./pixelColor";
import { eraseCoverage } from "./selection";
import type { Selection } from "./selection";
import { wandSelection } from "./wand";
import type { WandOptions } from "./wand";

/**
 * Which pixels a tool looks at: one layer, everything visible, or only the
 * background (input image / background-colour frame, as displayed).
 */
export type SampleSource = "layer" | "all" | "background";

/**
 * Where a sample is read from once the layer is known ({@link sampleTarget}):
 * a paint / text layer's own pixels (never its layer mask), a mask layer
 * (cmask, incl. the Image Mask row) as its effective coverage in gray, the
 * scene, or a layer mask as the grayscale the lmask-only view shows.
 */
export type SampleTarget =
  | { kind: "layer"; layer: Layer }
  | { kind: "cmask"; layer: Layer }
  | { kind: "masks" }
  | { kind: "scene"; source: SceneSource }
  | { kind: "lmask"; layer: Layer };

/**
 * Resolve a sample source: `"layer"` reads that layer's raw pixels (lmask
 * not applied, like Photoshop; a mask layer: its effective coverage as gray;
 * falling back to everything visible when there is no layer), the others
 * render the scene (lmasks applied). With a mask layer (cmask) as the layer,
 * `"all"` reads the union of every visible mask's effective coverage as gray
 * (`masks`) instead of the paint composite. In the lmask-only view the viewed
 * mask's grayscale wins over the option (what the stage shows). Pure; the
 * single decision shared by bucket, wand and eyedropper.
 * @param sample - Tool option.
 * @param layer - Layer `"layer"` means (current target / active paint layer), if any.
 * @param viewedMask - Layer whose mask the lmask-only view shows (bucket / wand), if any.
 * @returns What to read.
 */
export function sampleTarget(sample: SampleSource, layer: Layer | null | undefined, viewedMask?: Layer | null): SampleTarget {
  if (viewedMask?.layerMask) return { kind: "lmask", layer: viewedMask };
  if (sample === "all" && layer?.kind === "mask") return { kind: "masks" };
  if (sample !== "layer") return { kind: "scene", source: sample };
  if (!layer) return { kind: "scene", source: "all" };
  return layer.kind === "mask" ? { kind: "cmask", layer } : { kind: "layer", layer };
}

/**
 * Coverage as an opaque gray image for tolerance matching: R = G = B =
 * coverage, alpha 255. Pure.
 * @param coverage - One byte per pixel.
 * @returns Straight-alpha RGBA.
 */
export function coverageGray(coverage: Uint8Array): Uint8ClampedArray {
  const out = new Uint8ClampedArray(coverage.length * 4);
  for (let i = 0; i < coverage.length; i++) {
    const v = coverage[i] as number;
    out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = v;
    out[i * 4 + 3] = 255;
  }
  return out;
}

/**
 * A layer mask as the lmask-only view shows it, for tolerance matching: an
 * opaque gray image, R = G = B = the hidden amount (white = hidden; `255 -`
 * that when inverted), alpha 255. Beyond the stored pixels the mask's
 * `outside` value applies. Pure.
 * @param read - Stored mask pixels overlapping `area` (alpha = hidden amount), or `null`.
 * @param area - Integer document rect to produce.
 * @param invert - The mask is inverted.
 * @param outsideHidden - The mask's `outside` is `"hide"`.
 * @returns Straight-alpha RGBA of `area`.
 */
export function lmaskGray(read: { rect: Rect; data: ImageData } | null, area: Rect, invert: boolean, outsideHidden: boolean): Uint8ClampedArray {
  const n = area.width * area.height;
  const hidden = new Uint8Array(n).fill(outsideHidden ? 255 : 0);
  if (read) {
    const { rect, data } = read;
    for (let y = 0; y < rect.height; y++) {
      const row = (rect.y - area.y + y) * area.width + (rect.x - area.x);
      for (let x = 0; x < rect.width; x++) hidden[row + x] = data.data[(y * rect.width + x) * 4 + 3] as number;
    }
  }
  if (invert) for (let i = 0; i < n; i++) hidden[i] = 255 - (hidden[i] as number);
  return coverageGray(hidden);
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
    // On a targeted layer mask the flooded region gets the foreground mask swatch (see fillMask).
    const onMask = targetedMaskLayer(s)?.id === layer.id;
    const px = Math.floor(req.point.x);
    const py = Math.floor(req.point.y);
    const image = this.imageRectInDoc();
    if (!inside(image, px, py) && !inside(s.store.bounds, px, py)) return false;
    s.ensureBounds(image, true);
    const bounds = s.store.bounds;
    if (!inside(bounds, px, py)) return false;

    const target = sampleTarget(req.sample, layer, this.viewedMask());
    const source = this.sampleArea(bounds, target);
    if (!source) return false;
    // The target layer's own pixels, so the fill can go behind its soft edges (anti-alias only; not on a mask).
    const own = !req.antiAlias || onMask ? undefined : target.kind === "layer" ? source : this.sampleArea(bounds, { kind: "layer", layer });
    const { coverage, bbox, under } = floodFill(source, bounds.width, bounds.height, {
      x: px - bounds.x,
      y: py - bounds.y,
      tolerance: req.tolerance,
      contiguous: req.contiguous,
      antiAlias: req.antiAlias,
      // Confined to (and scaled by) the selection.
      clip: s.selection.coverage(bounds),
      under: own ?? undefined,
    });
    if (isEmptyRect(bbox)) return false;

    const docRect: Rect = { x: bounds.x + bbox.x, y: bounds.y + bbox.y, width: bbox.width, height: bbox.height };
    if (onMask) return this.fillMask(layer, docRect, bbox, coverage, bounds.width, req.opacity);
    const before = s.store.read(layer.id, docRect);
    if (!before) return false;
    const next = new ImageData(new Uint8ClampedArray(before.data.data), before.data.width, before.data.height);
    const color = hexToRgb(layer.kind === "mask" ? MASK_STROKE_COLOR : req.color);
    blendCoverage(next.data, bbox, coverage, bounds.width, color, req.opacity);
    if (under) blendCoverageBehind(next.data, bbox, under, bounds.width, color, req.opacity);
    s.store.write(layer.id, docRect.x, docRect.y, next);
    // Re-read so the patch holds exactly what the canvas stores (premultiplied round trip).
    const after = s.store.read(layer.id, docRect);
    // No change (e.g. filling a colour over itself) = no undo step and no re-upload (like fillMask / endStroke).
    if (!after || sameBytes(before.data.data, after.data.data)) return false;
    const bytes = before.data.data.byteLength + after.data.data.byteLength;
    s.history.push({ kind: "patch", layerId: layer.id, x: docRect.x, y: docRect.y, before: before.data, after: after.data, bytes });
    s.runtime.touch(layer.id);
    s.afterEdit();
    return true;
  }

  /**
   * The bucket on a targeted layer mask: the flooded region (selection-clipped,
   * times `opacity`) gets the foreground mask swatch -- white hides (white
   * paint), black reveals (erase). One patch on the mask key; no change = no step.
   * @param layer - Layer whose mask is targeted.
   * @param docRect - Coverage bbox in document coords.
   * @param bbox - The same rect in coverage coords.
   * @param coverage - Flood coverage (bounds-sized; scaled in place for reveal).
   * @param stride - Coverage row length.
   * @param opacity - 0..1.
   * @returns `true` if pixels changed.
   */
  private fillMask(layer: Layer, docRect: Rect, bbox: Rect, coverage: Uint8Array, stride: number, opacity: number): boolean {
    const s = this.s;
    const key = layerMaskKey(layer.id);
    const before = s.store.read(key, docRect);
    if (!before) return false;
    const next = new ImageData(new Uint8ClampedArray(before.data.data), before.data.width, before.data.height);
    if (s.layerMasks.fgWhite) {
      blendCoverage(next.data, bbox, coverage, stride, hexToRgb(MASK_WHITE), opacity);
    } else {
      const k = Math.min(1, Math.max(0, opacity));
      if (k < 1) for (let i = 0; i < coverage.length; i++) coverage[i] = Math.round((coverage[i] as number) * k);
      eraseCoverage(next.data, bbox, coverage, stride);
    }
    s.store.write(key, docRect.x, docRect.y, next);
    const after = s.store.read(key, docRect);
    if (!after || sameBytes(before.data.data, after.data.data)) return false;
    const bytes = before.data.data.byteLength + after.data.data.byteLength;
    s.history.push({ kind: "patch", layerId: key, x: docRect.x, y: docRect.y, before: before.data, after: after.data, bytes });
    s.runtime.touch(key);
    s.afterEdit();
    return true;
  }

  // ── Magic wand ──────────────────────────────────────────────────────────

  /**
   * Magic-wand coverage at a point (not applied: the tool combines it with
   * the current selection via `Editor.selection.apply`). Samples like the
   * bucket, over the paint bounds united with the image rect, without growing
   * the bounds (the wand edits no pixels). "Current layer" is the current
   * target: the paint layer's raw pixels, or under Quick Mask the current
   * mask's effective coverage as gray (Image / Input Mask row included); a
   * hidden target (eye off or hidden by solo) refuses with the gate's
   * hidden note. "All layers" under Quick Mask: the visible masks' union
   * (no note). In the lmask-only view the viewed mask's grayscale,
   * whatever the option (also for a hidden layer).
   * @param req - Click position, matching options and sample source.
   * @returns Selection in document coords, `null` (nothing matched / loading
   *   / outside), or `"blocked"` (hidden target; note shown, leave the selection alone).
   */
  wandSelection(req: WandRequest): Selection | null | "blocked" {
    const s = this.s;
    if (s.loading || s.stroke.active) return null;
    const area = unionRect(this.imageRectInDoc(), s.store.bounds);
    if (!inside(area, Math.floor(req.point.x), Math.floor(req.point.y))) return null;
    const target = sampleTarget(req.sample, targetLayer(s.doc, s.target, s.currentMaskId), this.viewedMask());
    const note = target.kind === "layer" || target.kind === "cmask" ? hiddenNote(s, target.layer) : null;
    if (note) {
      s.events.emit("note", note);
      return "blocked";
    }
    const source = this.sampleArea(area, target);
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
   * visible composite, the background only, one layer's raw pixels
   * (transparent outside the bounds), a mask layer's effective coverage or
   * a layer mask as opaque gray ({@link coverageGray}, {@link lmaskGray}).
   * The one sampling path of all three tools.
   * @param scratch - Reusable canvas for scene reads (eyedropper drags).
   */
  private sampleArea(area: Rect, target: SampleTarget, scratch?: HTMLCanvasElement): Uint8ClampedArray | null {
    if (target.kind === "scene") return readDocRegion(sceneFor(this.compositeInput(), target.source), area, scratch)?.data ?? null;
    if (target.kind === "cmask") return this.maskCoverageGray(target.layer, area);
    if (target.kind === "masks") return this.visibleMasksGray(area);
    if (target.kind === "lmask") {
      const mask = target.layer.layerMask;
      const read = this.s.store.read(layerMaskKey(target.layer.id), area);
      return lmaskGray(read, area, mask?.invert === true, mask?.outside === "hide");
    }
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

  /**
   * A mask layer's effective coverage (its invert applied) over `area` as
   * opaque gray. Mask layers: stored alpha, 0 beyond the stored pixels
   * before invert (like the overlay and Python). The Image / Input Mask row:
   * its image-px coverage resampled into document coords, 0 outside the
   * image (also when inverted), like its Ctrl+click selection.
   */
  private maskCoverageGray(layer: Layer, area: Rect): Uint8ClampedArray {
    const s = this.s;
    const invert = layer.invert === true;
    if (layer.id !== IMAGE_MASK_ID) return lmaskGray(s.store.read(layer.id, area), area, invert, false);
    const plane = s.imageMask.coverage;
    const size = s.imageMask.size;
    const n = area.width * area.height;
    return coverageGray(plane ? coverageInDoc(plane, size, documentMap(s.doc, size), area, invert) : new Uint8Array(n));
  }

  /**
   * "All layers" with a mask targeted: the union (max) of every mask shown
   * on the stage (eye / solo, like the overlay), each after its own invert,
   * as opaque gray. The Image / Input Mask row joins while it is shown and
   * applies to the current image ({@link imageMaskApplies}); its coverage is
   * 0 outside the image. Paint layers are not read.
   */
  private visibleMasksGray(area: Rect): Uint8ClampedArray {
    const s = this.s;
    const union = new Uint8Array(area.width * area.height);
    for (const layer of s.doc.layers) {
      if (layer.kind !== "mask" || !shownOnStage(layer, s.solo.current)) continue;
      const read = s.store.read(layer.id, area);
      unionMaskCoverage(union, area, read?.rect ?? null, read?.data.data ?? new Uint8ClampedArray(0), layer.invert === true);
    }
    const image = s.doc.imageMask;
    const plane = s.imageMask.coverage;
    if (image && plane && shownOnStage(image, s.solo.current) && imageMaskApplies(s)) {
      const size = s.imageMask.size;
      const cov = coverageInDoc(plane, size, documentMap(s.doc, size), area, image.invert === true);
      for (let i = 0; i < union.length; i++) if ((cov[i] as number) > (union[i] as number)) union[i] = cov[i] as number;
    }
    return coverageGray(union);
  }

  /** The current image's rect in document coords (rounded out). */
  private imageRectInDoc(): Rect {
    const s = this.s;
    const map = documentMap(s.doc, s.imageSize);
    const size = s.imageSize;
    return roundOutRect(imageRectToDoc(map, { x: 0, y: 0, width: size.width, height: size.height }));
  }

  /** The layer whose mask the lmask-only view shows (it is then the targeted mask), or `null`. */
  private viewedMask(): Layer | null {
    const layer = targetedMaskLayer(this.s);
    return layer && this.s.layerMasks.view === layer.id ? layer : null;
  }

  /** "What the user sees": honours solo (view only), like the stage. */
  private compositeInput(): DocCompositeInput {
    return visibleScene(this.s);
  }
}

function sameBytes(a: Uint8ClampedArray, b: Uint8ClampedArray): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function inside(r: Rect, x: number, y: number): boolean {
  return x >= r.x && y >= r.y && x < r.x + r.width && y < r.y + r.height;
}
