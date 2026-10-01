/**
 * Undoable region / output-option editing (SPEC "Outputs and regions (editor)").
 * A gesture (drag, field session, picker) is one transaction: `begin`
 * snapshots the metadata, `commit` pushes one `outputs` history entry (or
 * nothing for a no-op),
 * `cancel` reverts. Transactions copy at most six small records, never pixels.
 *
 * Events: edits emit `outputs` + `change` + `render`; selection emits only
 * `outputs` + `render` (selecting is not a document edit, so nothing uploads).
 */

import { cloneOutputOptions, outputOptionsEqual, readOutputOptions } from "../document/outputOptions";
import {
  clampRegionRect,
  commitRegionName,
  createRegion,
  defaultRegionRect,
  isRegionSlot,
  nextRegionSlot,
} from "../document/regions";
import type { OutputOptions, Region } from "../document/types";
import { isEmptyRect, rectEquals } from "../geometry/rect";
import type { Rect } from "../geometry/rect";
import type { EditorState } from "./editorState";
import { applyOutputs, captureOutputs, outputsKey } from "./regionHistory";
import type { OutputMetadata } from "./regionHistory";

/** Fixed cost of one `outputs` history entry, bytes (plus 2 per JSON char). */
const ENTRY_OVERHEAD_BYTES = 128;

// ═══════════════════════════════════════════════════════════════════════════
// RegionOps
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Engine API for region geometry, selection and per-output options.
 */
export class RegionOps {
  /** Snapshot taken by {@link begin}; null while no gesture is open. */
  private before: OutputMetadata | null = null;
  /** The open gesture has changed the document at least once. */
  private touched = false;

  /**
   * @param s - Shared editor state.
   */
  constructor(private readonly s: EditorState) {}

  // ── Read access ─────────────────────────────────────────────────────────

  /** Selected region id; null = Main (also when the stored id no longer exists). */
  get selectedId(): string | null {
    const id = this.s.selectedRegionId;
    return id !== null && this.find(id) ? id : null;
  }

  /** Whether a field, picker or drag gesture is open. */
  get active(): boolean {
    return this.before !== null;
  }

  /**
   * Whether another region can be created.
   * @returns `true` while a slot is empty.
   */
  canAdd(): boolean {
    return nextRegionSlot(this.s.doc.regions) !== null;
  }

  /**
   * Region in a slot.
   * @param slot - Slot 1..6.
   * @returns The region, or undefined for an empty slot.
   */
  inSlot(slot: number): Region | undefined {
    return this.s.doc.regions.find((region) => region.slot === slot);
  }

  /**
   * Current rect of a region.
   * @param id - Region id.
   * @returns A copy of its rect (image px), or null.
   */
  imageRect(id: string): Rect | null {
    const region = this.find(id);
    return region ? { ...region.rect } : null;
  }

  /**
   * Output options of Main or a region.
   * @param id - Region id, or null for Main.
   * @returns Independent copy (defaults when absent).
   */
  options(id: string | null): OutputOptions {
    const source = id === null ? this.s.doc.mainOutput : this.find(id)?.output;
    return cloneOutputOptions(source);
  }

  // ── Selection (not a document edit) ─────────────────────────────────────

  /**
   * Select a region or Main. Emits `outputs` + `render`, never `change`.
   * @param id - Region id, or null for Main (unknown ids select Main).
   */
  select(id: string | null): void {
    const next = id !== null && this.find(id) ? id : null;
    if (next === this.selectedId) return;
    this.s.selectedRegionId = next;
    this.s.events.emit("outputs", undefined);
    this.s.events.emit("render", undefined);
  }

  // ── Transactions ────────────────────────────────────────────────────────

  /**
   * Open a gesture; repeated calls join the open one.
   * @returns Whether editing is allowed (not while loading or stroking).
   */
  begin(): boolean {
    if (this.s.loading || this.s.stroke.active) return false;
    this.s.settleFloat();
    if (!this.before) {
      this.before = captureOutputs(this.s);
      this.touched = false;
    }
    return true;
  }

  /**
   * Close the gesture as one undo step. A gesture that ends where it started
   * leaves no step (redo survives) and restores optional-field presence.
   * @returns Whether an undo step was pushed.
   */
  commit(): boolean {
    const before = this.before;
    const touched = this.touched;
    this.before = null;
    this.touched = false;
    if (!before || !touched) return false;
    const after = captureOutputs(this.s);
    const beforeKey = outputsKey(before);
    const afterKey = outputsKey(after);
    if (beforeKey === afterKey) {
      this.restore(before);
      return false;
    }
    const bytes = ENTRY_OVERHEAD_BYTES + 2 * (beforeKey.length + afterKey.length);
    this.s.history.push({ kind: "outputs", before, after, bytes });
    this.s.afterEdit();
    return true;
  }

  /** Revert the open gesture without touching undo/redo. Keeps the current selection. */
  cancel(): void {
    const before = this.before;
    const touched = this.touched;
    this.before = null;
    this.touched = false;
    if (before && touched) this.restore(before);
  }

  // ── Edits ───────────────────────────────────────────────────────────────

  /**
   * Create a region in the lowest empty slot (or a given one) and select it.
   * @param rect - Rect in image px (clamped to the region area).
   * @param slot - Empty slot to fill; default = lowest empty slot.
   * @returns New region id, or null (no empty slot, slot taken, bad rect).
   */
  add(rect: Rect, slot: number | null = nextRegionSlot(this.s.doc.regions)): string | null {
    if (slot === null || !isRegionSlot(slot) || this.inSlot(slot) || !validRect(rect)) return null;
    const id = crypto.randomUUID();
    const region = createRegion(id, slot, clampRegionRect(rect, this.s.imageSize));
    this.edit(() => {
      this.s.doc.regions.push(region);
      this.s.selectedRegionId = id;
    });
    return id;
  }

  /**
   * Fill an empty slot with the centred default rect (`+ Region N` row).
   * @param slot - Slot 1..6.
   * @returns New region id, or null if the slot is taken.
   */
  addDefault(slot: number): string | null {
    return this.add(defaultRegionRect(this.s.imageSize), slot);
  }

  /**
   * Empty a region's slot; other slots keep their numbers.
   * @param id - Region id.
   */
  remove(id: string): void {
    if (!this.find(id)) return;
    this.edit(() => {
      this.s.doc.regions = this.s.doc.regions.filter((region) => region.id !== id);
      if (this.s.selectedRegionId === id) this.s.selectedRegionId = null;
    });
  }

  /**
   * Set a region's rect.
   * @param id - Region id.
   * @param rect - Rect in image px (clamped to the region area).
   */
  setRect(id: string, rect: Rect): void {
    const region = this.find(id);
    if (!region || !validRect(rect)) return;
    const next = clampRegionRect(rect, this.s.imageSize);
    if (rectEquals(next, region.rect)) return;
    this.edit(() => {
      region.rect = next;
    });
  }

  /**
   * Rename a region.
   * @param id - Region id.
   * @param input - Typed name (trimmed; empty = `Region N`).
   */
  rename(id: string, input: string): void {
    const region = this.find(id);
    if (!region) return;
    const name = commitRegionName(input, region.slot);
    if (region.name === name) return;
    this.edit(() => {
      region.name = name;
    });
  }

  /**
   * Show or hide a region's overlay (execution is unaffected).
   * @param id - Region id.
   * @param visible - New visibility.
   */
  setVisible(id: string, visible: boolean): void {
    const region = this.find(id);
    if (!region || region.visible === visible) return;
    this.edit(() => {
      region.visible = visible;
    });
  }

  /**
   * Change output options of Main or a region.
   * @param id - Region id, or null for Main.
   * @param patch - Changed options (normalized).
   */
  setOptions(id: string | null, patch: Partial<OutputOptions>): void {
    const region = id === null ? null : this.find(id);
    if (id !== null && !region) return;
    const old = this.options(id);
    const next = readOutputOptions({ ...old, ...patch });
    if (outputOptionsEqual(old, next)) return;
    this.edit(() => {
      if (region) region.output = next;
      else this.s.doc.mainOutput = next;
    });
  }

  // ── Internals ───────────────────────────────────────────────────────────

  private find(id: string): Region | undefined {
    return this.s.doc.regions.find((region) => region.id === id);
  }

  /**
   * Apply one mutation inside the open gesture, or as its own one-step
   * gesture when none is open.
   */
  private edit(mutate: () => void): void {
    const own = !this.active;
    if (!this.begin()) return;
    mutate();
    this.touched = true;
    this.s.events.emit("outputs", undefined);
    this.s.events.emit("change", undefined);
    this.s.events.emit("render", undefined);
    if (own) this.commit();
  }

  /** Put the document back to a snapshot, keeping the live selection when it still exists. */
  private restore(snapshot: OutputMetadata): void {
    const selected = this.s.selectedRegionId;
    applyOutputs(this.s, snapshot);
    const kept = selected !== null && this.find(selected) ? selected : snapshot.selected;
    this.s.selectedRegionId = kept;
    this.s.events.emit("change", undefined);
    this.s.events.emit("render", undefined);
  }
}

/** Finite, positive-size rect. */
function validRect(rect: Rect): boolean {
  const finite = [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite);
  return finite && !isEmptyRect(rect);
}
