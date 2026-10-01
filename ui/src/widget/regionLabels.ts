/**
 * Output labels of the `PainterSketch Regions` helper node (pure). The helper
 * has 12 fixed outputs: slot `n` feeds `IMAGE` at `2*(n-1)` and `MASK` at
 * `2*(n-1)+1`. Labels follow the source document's regions; sockets never
 * change.
 */

import { MAX_REGIONS, regionName } from "../document/regions";
import type { Region } from "../document/types";

/** Number of helper outputs (one IMAGE + MASK pair per slot). */
export const REGION_OUTPUT_COUNT = 2 * MAX_REGIONS;

/**
 * What the helper knows about its source: the source document's regions, or
 * `null` when the link can't be followed (not connected, reroute node,
 * subgraph boundary, unreadable document).
 */
export type RegionSource = readonly Pick<Region, "slot" | "name">[] | null;

// ── Labels ────────────────────────────────────────────────────────────────────

/**
 * Labels for one slot's IMAGE and MASK outputs.
 * @param slot - Slot 1..6.
 * @param source - Source regions, or null when unresolvable.
 * @returns `[image, mask]`: `name` / `name mask` for a filled slot,
 *   `Region N (missing)` / `Region N mask (missing)` for an empty one,
 *   `Region N` / `Region N mask` when the source is unresolvable.
 */
export function regionSlotLabels(slot: number, source: RegionSource): [string, string] {
  if (source === null) return [`Region ${slot}`, `Region ${slot} mask`];
  const region = source.find((r) => r.slot === slot);
  if (!region) return [`Region ${slot} (missing)`, `Region ${slot} mask (missing)`];
  const name = regionName(region);
  return [name, `${name} mask`];
}

/**
 * Labels for all 12 helper outputs, in socket order.
 * @param source - Source regions, or null when unresolvable.
 * @returns Twelve labels.
 */
export function regionOutputLabels(source: RegionSource): string[] {
  const labels: string[] = [];
  for (let slot = 1; slot <= MAX_REGIONS; slot++) {
    labels.push(...regionSlotLabels(slot, source));
  }
  return labels;
}
