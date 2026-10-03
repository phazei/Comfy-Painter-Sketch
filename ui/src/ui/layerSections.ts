/**
 * Collapsible sections of the layers panel (design handoff "Layers tab"):
 * "COMFYUI MASKS" (cmask rows), "LAYERS" (paint + text rows) and "SOURCE"
 * (the Image / Input Mask row and Background). Pure helpers: which section a
 * row belongs to, the header titles, and the list order with headers
 * interleaved and collapsed sections' rows left out. The header elements
 * are `layerSectionHeader.ts`; headers are not rows (no `cps-layer-row`
 * class or layer id), so selection, hover and drag reordering
 * (`layerDrag.ts` queries rows by class) never see them.
 */

import type { RowKind } from "./layerRow";

/** Section ids, top -> bottom. */
export type SectionId = "masks" | "layers" | "source";

/** Display order of the sections. */
export const SECTION_ORDER: readonly SectionId[] = ["masks", "layers", "source"];

/**
 * Section a row kind belongs to.
 * @param kind - Row kind.
 * @returns Its section.
 */
export function rowSection(kind: RowKind): SectionId {
  if (kind === "mask") return "masks";
  if (kind === "paint") return "layers";
  return "source";
}

/**
 * Whether a section can collapse (masks and layers; SOURCE is fixed).
 * @param id - Section.
 * @returns `true` when it has a chevron.
 */
export function isCollapsible(id: SectionId): boolean {
  return id !== "source";
}

/**
 * Header title of a section.
 * @param id - Section.
 * @param collapsed - Section collapsed.
 * @param activeName - Active paint layer's name (the collapsed layers title).
 * @returns "COMFYUI MASKS", "LAYERS", "LAYER: {NAME}" (collapsed) or "SOURCE".
 */
export function sectionTitle(id: SectionId, collapsed: boolean, activeName?: string): string {
  if (id === "masks") return "COMFYUI MASKS";
  if (id === "source") return "SOURCE";
  return collapsed && activeName ? `LAYER: ${activeName.toUpperCase()}` : "LAYERS";
}

/**
 * List children in display order: each section's header, then its rows
 * unless collapsed. With no rows at all (no editor) the list is empty. The
 * masks and layers headers always show (they carry the "+" buttons); SOURCE
 * only with rows.
 * @param rows - Rows, top -> bottom.
 * @param kindOf - Kind of a row.
 * @param header - Header item of a section.
 * @param collapsed - Whether a section is collapsed.
 * @returns Headers and rows interleaved.
 */
export function arrangeSections<T, H>(
  rows: readonly T[],
  kindOf: (row: T) => RowKind,
  header: (id: SectionId) => H,
  collapsed: (id: SectionId) => boolean,
): Array<T | H> {
  if (rows.length === 0) return [];
  const out: Array<T | H> = [];
  for (const id of SECTION_ORDER) {
    const own = rows.filter((row) => rowSection(kindOf(row)) === id);
    if (id === "source" && own.length === 0) continue;
    out.push(header(id));
    if (!(isCollapsible(id) && collapsed(id))) out.push(...own);
  }
  return out;
}
