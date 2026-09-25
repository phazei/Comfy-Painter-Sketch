/**
 * Per-layer runtime bookkeeping (not saved): dirty/version/hasContent for
 * uploads and empty-document detection, plus a globally monotonic pixel
 * revision per layer (the mask tint cache key).
 */

import type { LayerRuntime } from "./editorTypes";

/**
 * Runtime state of every layer of one document.
 */
export class LayerRuntimeTable {
  private readonly entries = new Map<string, LayerRuntime>();
  private readonly revisions = new Map<string, number>();
  /** Last version of removed layers (see {@link LayerRuntimeTable.reinstate}). */
  private readonly removedVersions = new Map<string, number>();
  private revisionCounter = 0;

  /**
   * (Re)initialise a layer's bookkeeping: clean, version 0.
   * @param layerId - Layer id.
   * @param hasContent - Whether the layer holds (saved) paint.
   */
  reset(layerId: string, hasContent: boolean): void {
    this.entries.set(layerId, { dirty: false, version: 0, hasContent });
  }

  /**
   * Forget a deleted layer (so it no longer counts as dirty/painted). Its
   * revision is kept so a re-inserted layer never reuses a stale cache key.
   * @param layerId - Layer id.
   */
  remove(layerId: string): void {
    const rt = this.entries.get(layerId);
    if (rt) this.removedVersions.set(layerId, rt.version);
    this.entries.delete(layerId);
  }

  /**
   * (Re)install a layer that is (again) part of the document (new layer,
   * undo of a delete). The version continues past any earlier life of the
   * id, so an upload started before the delete can never mark the restored
   * pixels clean.
   * @param layerId - Layer id.
   * @param hasPixels - The layer holds pixels (dirty until uploaded).
   */
  reinstate(layerId: string, hasPixels: boolean): void {
    const version = (this.removedVersions.get(layerId) ?? 0) + 1;
    this.entries.set(layerId, { dirty: hasPixels, version, hasContent: hasPixels });
    this.bump(layerId);
  }

  /**
   * Bookkeeping of a layer.
   * @param layerId - Layer id.
   * @returns The entry or `undefined`.
   */
  get(layerId: string): LayerRuntime | undefined {
    return this.entries.get(layerId);
  }

  /**
   * Pixels of a layer were edited: new revision, dirty, next version.
   * @param layerId - Layer id.
   */
  touch(layerId: string): void {
    this.bump(layerId);
    const rt = this.entries.get(layerId);
    if (!rt) return;
    rt.dirty = true;
    rt.version++;
    rt.hasContent = true;
  }

  /**
   * Committed pixels of a layer changed without an edit (restore, cancel):
   * only invalidates caches keyed by the revision.
   * @param layerId - Layer id.
   */
  bump(layerId: string): void {
    this.revisions.set(layerId, ++this.revisionCounter);
  }

  /**
   * Current pixel revision of a layer.
   * @param layerId - Layer id.
   * @returns Revision (0 = never bumped).
   */
  revision(layerId: string): number {
    return this.revisions.get(layerId) ?? 0;
  }

  /** Whether any layer has ever held paint. */
  get hasPaint(): boolean {
    for (const r of this.entries.values()) if (r.hasContent) return true;
    return false;
  }

  /** Whether any layer needs uploading. */
  get dirty(): boolean {
    for (const r of this.entries.values()) if (r.dirty) return true;
    return false;
  }

  /**
   * Copy every entry of `other` (fork); revisions are not copied.
   * @param other - Source table.
   */
  copyFrom(other: LayerRuntimeTable): void {
    for (const [id, rt] of other.entries) this.entries.set(id, { ...rt });
  }
}
