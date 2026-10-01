/**
 * Kept originals (SPEC "Free Transform and flips"): after a transform
 * commit lands in a layer, the layer keeps its pre-transform pixels and the
 * cumulative matrix in memory, so the next whole-layer Free Transform
 * resamples ONCE from that original (5 x 10 deg = one 50 deg resample)
 * instead of from the already-resampled result. Pastes keep the pasted
 * pixels with an identity placement.
 *
 * Validity is tied to the layer's pixel revision (`LayerRuntimeTable`):
 * an entry is only used while the revision is exactly the one recorded
 * after the commit, so ANY later change of the layer's pixels -- paint,
 * fill, lift, merge, clear, rasterize, Match image resolution, undo / redo
 * of anything touching it -- silently invalidates it. Invalid entries are
 * dropped when looked up and when their layer leaves the document. Never
 * saved (a reload starts without). Memory is capped over the editor
 * ({@link KEPT_ORIGINAL_BYTES}); the oldest entries go first.
 */

import type { Rect } from "../geometry/rect";
import type { Affine, TransformParams } from "./transformMath";

/** Memory cap for all kept originals of one editor: 128 MB. */
export const KEPT_ORIGINAL_BYTES = 128 * 1024 * 1024;

/** A layer's kept original. */
export interface KeptOriginal {
  /** Pre-transform pixels (straight alpha), `area.width x area.height`. */
  pixels: ImageData;
  /** Document rect the pixels were lifted from (float-local origin). */
  area: Rect;
  /** Cumulative float-local -> document matrix of the layer's current content. */
  m: Affine;
  /** Session parameters of `m` when known (exact restart, no decomposition noise). */
  params?: TransformParams;
  /** Layer pixel revision right after the commit (valid while unchanged). */
  revision: number;
}

/**
 * Kept originals by layer id, oldest first.
 */
export class KeptOriginals {
  private readonly entries = new Map<string, KeptOriginal>();
  private total = 0;

  /**
   * @param maxBytes - Memory cap (default {@link KEPT_ORIGINAL_BYTES}).
   */
  constructor(private readonly maxBytes: number = KEPT_ORIGINAL_BYTES) {}

  /** Bytes held. */
  get bytes(): number {
    return this.total;
  }

  /** Number of entries. */
  get size(): number {
    return this.entries.size;
  }

  /**
   * Keep (replace) a layer's original, then enforce the cap (oldest first;
   * an entry larger than the whole cap is not kept at all).
   * @param layerId - Layer id.
   * @param entry - Original.
   */
  keep(layerId: string, entry: KeptOriginal): void {
    this.drop(layerId);
    const bytes = entry.pixels.data.byteLength;
    if (bytes > this.maxBytes) return;
    this.entries.set(layerId, entry);
    this.total += bytes;
    for (const id of this.entries.keys()) {
      if (this.total <= this.maxBytes) break;
      this.drop(id);
    }
  }

  /**
   * A layer's original if still valid (dropped otherwise).
   * @param layerId - Layer id.
   * @param revision - The layer's current pixel revision.
   * @returns Entry, or `null`.
   */
  get(layerId: string, revision: number): KeptOriginal | null {
    const entry = this.entries.get(layerId);
    if (!entry) return null;
    if (entry.revision === revision) return entry;
    this.drop(layerId);
    return null;
  }

  /**
   * Whether a layer has an entry (valid or not).
   * @param layerId - Layer id.
   * @returns `true` if held.
   */
  has(layerId: string): boolean {
    return this.entries.has(layerId);
  }

  /**
   * Forget a layer's original.
   * @param layerId - Layer id.
   */
  drop(layerId: string): void {
    const entry = this.entries.get(layerId);
    if (!entry) return;
    this.total -= entry.pixels.data.byteLength;
    this.entries.delete(layerId);
  }

  /**
   * Drop entries whose layer is gone.
   * @param alive - Ids of the document's layers.
   */
  prune(alive: ReadonlySet<string>): void {
    for (const id of [...this.entries.keys()]) if (!alive.has(id)) this.drop(id);
  }

  /** Drop everything. */
  clear(): void {
    this.entries.clear();
    this.total = 0;
  }
}
