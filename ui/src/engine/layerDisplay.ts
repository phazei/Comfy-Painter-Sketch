/**
 * What the compositor draws each frame: visible paint layers (with the live
 * stroke preview for the layer being painted) and visible mask layers as
 * cached tints ({@link MaskTint}) that re-tint only the region the stroke
 * dirtied since the last frame. A Move-tool drag shows its layer offset
 * (`EditorState.movePreview`) without touching pixels.
 */

import { maskDisplayColor } from "../document/masks";
import type { Point } from "../geometry/rect";
import type { CompositeLayer, MaskOverlay } from "./compositor";
import type { EditorState } from "./editorState";
import { MaskTint } from "./maskTint";

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
    const out: CompositeLayer[] = [];
    for (const layer of s.doc.layers) {
      if (!layer.visible || layer.kind === "mask") continue;
      const surface = s.store.ensure(layer.id);
      const source = s.strokeLayerId === layer.id && s.stroke.active ? s.stroke.updatePreview(surface).canvas : surface.canvas;
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
    const out: MaskOverlay[] = [];
    const bounds = s.store.bounds;
    for (const layer of s.doc.layers) {
      if (!layer.visible || layer.kind !== "mask") continue;
      const surface = s.store.ensure(layer.id);
      const stroking = s.strokeLayerId === layer.id && s.stroke.active;
      const source = stroking ? s.stroke.updatePreview(surface).canvas : surface.canvas;
      let tint = this.tints.get(layer.id);
      if (!tint) {
        tint = new MaskTint();
        this.tints.set(layer.id, tint);
      }
      const color = maskDisplayColor(layer);
      const invert = layer.invert === true;
      const key = { bounds, color, invert, revision: s.runtime.revision(layer.id) };
      const canvas = tint.update(source, key, stroking ? s.stroke.lastRefreshed : null);
      const offset = this.moveOffset(layer.id);
      out.push({ tint: canvas, color, opacity: layer.opacity, invert, ...(offset ? { offset } : {}) });
    }
    return out;
  }

  /** Release the tint caches. */
  dispose(): void {
    for (const tint of this.tints.values()) tint.dispose();
    this.tints.clear();
  }
}
