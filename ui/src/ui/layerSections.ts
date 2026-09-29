/**
 * Section dividers of the layers panel: a thicker bar between the row groups
 * (mask layers | paint + text layers | input rows: Image / Input Mask and
 * Background). A divider sits only between two non-empty groups. Dividers
 * are plain elements in the list, not rows: they carry no `cps-layer-row`
 * class or layer id, so selection, hover and drag reordering (`layerDrag.ts`
 * queries rows by class) never see them.
 */

import type { RowKind } from "./layerRow";

/** Row group a row kind belongs to (top -> bottom order). */
export type RowGroup = "mask" | "paint" | "input";

/** CSS class of a section divider. */
export const DIVIDER_CLASS = "cps-layers-section-divider";

/**
 * Group of a row kind.
 * @param kind - Row kind.
 * @returns Its group.
 */
export function rowGroup(kind: RowKind): RowGroup {
  if (kind === "mask") return "mask";
  if (kind === "paint") return "paint";
  return "input";
}

/**
 * Row indices a divider goes before: wherever the group changes between
 * neighbouring rows (so only between two non-empty groups).
 * @param kinds - Row kinds, top -> bottom.
 * @returns Ascending indices into `kinds`.
 */
export function dividerPositions(kinds: readonly RowKind[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < kinds.length; i++) {
    const prev = kinds[i - 1];
    const kind = kinds[i];
    if (prev && kind && rowGroup(prev) !== rowGroup(kind)) out.push(i);
  }
  return out;
}

/**
 * Interleave dividers into a row list.
 * @param rows - Rows, top -> bottom.
 * @param kindOf - Kind of a row.
 * @param divider - The n-th divider (0-based, top -> bottom).
 * @returns Rows with dividers between groups.
 */
export function withDividers<T, D>(rows: readonly T[], kindOf: (row: T) => RowKind, divider: (n: number) => D): Array<T | D> {
  const at = new Set(dividerPositions(rows.map(kindOf)));
  const out: Array<T | D> = [];
  let n = 0;
  rows.forEach((row, i) => {
    if (at.has(i)) out.push(divider(n++));
    out.push(row);
  });
  return out;
}

/**
 * Divider elements for one list, reused across renders (stable identity keeps
 * the panel's "children unchanged" check cheap).
 */
export class SectionDividers {
  private readonly pool: HTMLDivElement[] = [];

  /**
   * List children for the given rows, dividers included.
   * @param rows - Rows, top -> bottom.
   * @returns Elements in display order.
   */
  arrange(rows: ReadonlyArray<{ readonly kind: RowKind; readonly element: HTMLElement }>): HTMLElement[] {
    return withDividers(
      rows,
      (r) => r.kind,
      (n) => this.divider(n),
    ).map((item) => ("kind" in item ? item.element : item));
  }

  private divider(n: number): HTMLDivElement {
    let element = this.pool[n];
    if (!element) {
      element = document.createElement("div");
      element.className = DIVIDER_CLASS;
      element.setAttribute("role", "separator");
      this.pool[n] = element;
    }
    return element;
  }
}
