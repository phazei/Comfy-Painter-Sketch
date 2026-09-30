/**
 * What the compositor draws each frame: visible paint layers (with the live
 * stroke preview for the layer being painted) and visible mask layers as
 * cached tints ({@link MaskTint}) that re-tint only the region the stroke
 * dirtied since the last frame. A Move-tool drag shows its layer offset
 * (`EditorState.movePreview`) without touching pixels; a floating selection
 * shows inside its layer (`EditorState.floatPreview`, `floatOps.ts`). Solo (`solo.ts`,
 * view only) decides which layers count as shown here. The M13a Image Mask
 * is the bottom overlay, drawn over the image rect (`imageMaskOps.ts`).
 * A paint layer with an enabled layer mask (M14) is drawn through its cached
 * masked composite; the Alt+click mask view replaces the whole list with the
 * mask alone (`layerMask.ts`).
 */

import { maskDisplayColor } from "../document/masks";
import type { Point } from "../geometry/rect";
import type { CompositeLayer, MaskOverlay } from "./compositor";
import type { EditorState } from "./editorState";
import { imageMaskApplies } from "./imageMaskOps";
import { maskedSource, maskViewSource } from "./layerMask";
import { MaskTint } from "./maskTint";
import { shownOnStage } from "./solo";

/**
 * Display lists for the compositor, with per-mask tint caches.
 */
export class LayerDisplay {
  private readonly tints = new Map<string, MaskTint>();

  /**
   * @param s - Shared editor state.
   */
  constructor(private readonly s: EditorState) {}

  /**
   * Visible paint layers to composite.
   * @returns Bottom -> top layers.
   */
  compositeLayers(): CompositeLayer[] {
    const s = this.s;
    // M14 Alt+click view: the mask alone, grayscale (display only).
    const view = maskViewSource(s);
    if (view) return [{ source: view, opacity: 1 }];
    const out: CompositeLayer[] = [];
    for (const layer of s.doc.layers) {
      if (layer.kind === "mask" || !shownOnStage(layer, s.solo.current)) continue;
      const surface = s.store.ensure(layer.id);
      const raw = s.floatPreview(layer.id) ?? (s.strokeLayerId === layer.id && s.stroke.active ? s.stroke.updatePreview(surface).canvas : surface.canvas);
      // An enabled layer mask shows the layer through its cached masked composite (`layerMask.ts`).
      const source = layer.layerMask ? maskedSource(s, layer, raw, true) : raw;
      const offset = this.moveOffset(layer.id);
      out.push(offset ? { source, opacity: layer.opacity, offset } : { source, opacity: layer.opacity });
    }
    return out;
  }

  /** Move-tool drag offset of a layer (document px), or `undefined`. */
  private moveOffset(layerId: string): Point | undefined {
    const p = this.s.movePreview;
    return p && p.layerId === layerId && (p.dx !== 0 || p.dy !== 0) ? { x: p.dx, y: p.dy } : undefined;
  }

  /**
   * Visible mask layers as tinted overlays (drawn above all paint).
   * @returns Bottom -> top overlays.
   */
  maskOverlays(): MaskOverlay[] {
    const s = this.s;
    if (s.layerMasks.view !== null) return [];
    const image = this.imageMaskOverlay();
    const out: MaskOverlay[] = image ? [image] : [];
    const bounds = s.store.bounds;
    for (const layer of s.doc.layers) {
      if (layer.kind !== "mask" || !shownOnStage(layer, s.solo.current)) continue;
      const surface = s.store.ensure(layer.id);
      const stroking = s.strokeLayerId === layer.id && s.stroke.active;
      const source = s.floatPreview(layer.id) ?? (stroking ? s.stroke.updatePreview(surface).canvas : surface.canvas);
      const tint = this.tintFor(layer.id);
      const color = maskDisplayColor(layer);
      const invert = layer.invert === true;
      const key = { bounds, color, invert, revision: s.runtime.revision(layer.id) };
      const canvas = tint.update(source, key, stroking ? s.stroke.lastRefreshed : null);
      const offset = this.moveOffset(layer.id);
      out.push({ tint: canvas, color, opacity: layer.opacity, invert, ...(offset ? { offset } : {}) });
    }
    return out;
  }

  /** The Image Mask row's overlay (bottom of the masks, image px), if shown. */
  private imageMaskOverlay(): MaskOverlay | null {
    const s = this.s;
    const mask = s.doc.imageMask;
    if (!mask || !shownOnStage(mask, s.solo.current) || !imageMaskApplies(s)) return null;
    const source = s.imageMask.canvas();
    if (!source) return null;
    const color = maskDisplayColor(mask);
    const invert = mask.invert === true;
    const key = { bounds: { x: 0, y: 0, width: mask.width, height: mask.height }, color, invert, revision: s.imageMask.revision };
    return { tint: this.tintFor(mask.id).update(source, key, null), color, opacity: mask.opacity, invert, imageSpace: true };
  }

  private tintFor(id: string): MaskTint {
    let tint = this.tints.get(id);
    if (!tint) {
      tint = new MaskTint();
      this.tints.set(id, tint);
    }
    return tint;
  }

  /** Release the tint caches. */
  dispose(): void {
    for (const tint of this.tints.values()) tint.dispose();
    this.tints.clear();
  }
}
