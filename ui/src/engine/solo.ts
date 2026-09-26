/**
 * Solo (SPEC M8, view only): at most one soloed paint/text layer and one
 * soloed mask. While any solo is set, only soloed layers show (even if their
 * eye is off) -- the other group is hidden too unless it has its own solo;
 * with no solo, layers show by their eyes. Not saved, not
 * undoable, and ignored by every output path (IMAGE/MASK, uploads): only
 * the display compositor and "what the user sees" sampling use
 * {@link shownOnStage}. The pure resolution lives here so it is testable.
 */

import type { Layer } from "../document/types";

/** Soloed layer ids per group (`null` = no solo in that group). */
export interface SoloIds {
  paint: string | null;
  mask: string | null;
}

/** Solo group of a layer kind. */
export type SoloGroup = keyof SoloIds;

/**
 * Group a layer belongs to.
 * @param layer - Layer.
 * @returns `"mask"` for masks, `"paint"` for paint/text.
 */
export function soloGroup(layer: Pick<Layer, "kind">): SoloGroup {
  return layer.kind === "mask" ? "mask" : "paint";
}

/**
 * Whether a layer is drawn on the stage given the solos and its eye.
 * @param layer - Layer.
 * @param solo - Current solos.
 * @returns `true` if shown.
 */
export function shownOnStage(layer: Pick<Layer, "id" | "kind" | "visible">, solo: Readonly<SoloIds>): boolean {
  if (solo.paint === null && solo.mask === null) return layer.visible;
  return solo[soloGroup(layer)] === layer.id;
}

/**
 * Solos after toggling a layer: soloing replaces the group's solo, toggling
 * the active solo ends it.
 * @param solo - Current solos.
 * @param layer - Layer clicked.
 * @returns New solos.
 */
export function toggleSolo(solo: Readonly<SoloIds>, layer: Pick<Layer, "id" | "kind">): SoloIds {
  const group = soloGroup(layer);
  return { ...solo, [group]: solo[group] === layer.id ? null : layer.id };
}

/**
 * Drop solos whose layer no longer exists (or changed group).
 * @param solo - Current solos.
 * @param layers - Document layers.
 * @returns New solos (same values when nothing was dropped).
 */
export function pruneSolo(solo: Readonly<SoloIds>, layers: readonly Pick<Layer, "id" | "kind">[]): SoloIds {
  const keep = (group: SoloGroup): string | null => {
    const id = solo[group];
    return id !== null && layers.some((l) => l.id === id && soloGroup(l) === group) ? id : null;
  };
  return { paint: keep("paint"), mask: keep("mask") };
}

/**
 * Mutable solo state of one editor; `onChange` fires only on real changes.
 */
export class SoloState {
  private ids: SoloIds = { paint: null, mask: null };

  /**
   * @param onChange - Called after the solos changed.
   */
  constructor(private readonly onChange: () => void) {}

  /** Current solos (read-only copy). */
  get current(): Readonly<SoloIds> {
    return this.ids;
  }

  /**
   * Replace the solos.
   * @param next - New solos.
   */
  set(next: SoloIds): void {
    if (next.paint === this.ids.paint && next.mask === this.ids.mask) return;
    this.ids = { ...next };
    this.onChange();
  }

  /** End every solo. */
  clear(): void {
    this.set({ paint: null, mask: null });
  }
}
