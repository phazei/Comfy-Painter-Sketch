/**
 * Region mode pointer handling (M9). Hidden tool (`rail: false`, no
 * shortcut, no Ctrl Move / Alt eyedropper): the Outputs tab activates it and
 * any other tool leaves it (`ui/hostSync.ts`).
 *
 * - Drag on empty canvas draws a new region into the lowest empty slot.
 * - Plain drag inside a region moves it; the selected region's handles resize.
 * - Shift-drag always draws a new region, even starting inside one.
 * - A click (no drag) on empty canvas selects Main; on a region selects it.
 *
 * Selection is never a document edit; only a real drag opens a transaction.
 */

import type { Editor } from "../engine/editor";
import { docToImage } from "../engine/frameMap";
import { dragRegionRect, drawRegionRect, hitRegionHandle, insideRegion } from "../engine/regionGeometry";
import type { RegionHandle } from "../engine/regionGeometry";
import type { Point, Rect } from "../geometry/rect";
import type { Tool, ToolPointer } from "./types";

/** Tool id (used by the host to map the Outputs tab to region mode). */
export const REGION_TOOL_ID = "region";

/** Movement below this many screen px is a click. */
const CLICK_SLOP_PX = 3;

/** Handle hit half-size, screen px. */
export const HANDLE_HIT_PX = 6;

/** Note shown when drawing with all six slots filled. */
const FULL_NOTE = "All 6 region slots are used. Delete a region to draw another.";

/** One pointer gesture, fixed at pointer-down. */
interface RegionDrag {
  /** Press position, image px. */
  start: Point;
  /** `draw` = new region; `move` / `resize` = existing region `id`. */
  mode: "draw" | "move" | "resize";
  /** Region being edited (for `draw`: set once the drag creates it). */
  id: string | null;
  /** Region rect at pointer-down (move/resize). */
  rect: Rect | null;
  handle: RegionHandle | null;
  /** Passed the click slop at least once. */
  moved: boolean;
}

// ── Hit testing ───────────────────────────────────────────────────────────────

/**
 * What a plain press at `p` grabs: the selected region's handle or body
 * first, then the topmost visible region under the point.
 * @param editor - Live editor.
 * @param p - Press position, image px.
 * @returns Region grab, or null for empty canvas.
 */
function grabAt(editor: Editor, p: Point): Pick<RegionDrag, "mode" | "id" | "rect" | "handle"> | null {
  const ops = editor.regionOps;
  const regions = editor.doc.regions.filter((region) => region.visible);
  const selected = regions.find((region) => region.id === ops.selectedId);
  if (selected) {
    const tolerance = HANDLE_HIT_PX / editor.view.screenScale;
    const handle = hitRegionHandle(selected.rect, p, tolerance);
    if (handle) return { mode: "resize", id: selected.id, rect: { ...selected.rect }, handle };
    if (insideRegion(selected.rect, p)) return { mode: "move", id: selected.id, rect: { ...selected.rect }, handle: null };
  }
  const top = [...regions].reverse().find((region) => insideRegion(region.rect, p));
  return top ? { mode: "move", id: top.id, rect: { ...top.rect }, handle: null } : null;
}

// ═══════════════════════════════════════════════════════════════════════════
// Tool
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Create the region mode tool.
 * @returns Hidden tool driving `editor.regionOps`.
 */
export function createRegionTool(): Tool {
  let drag: RegionDrag | null = null;

  /** Apply the current pointer position to the open drag. */
  const update = (editor: Editor, sample: ToolPointer): void => {
    if (!drag) return;
    const ops = editor.regionOps;
    const p = docToImage(editor.frameMap, sample);
    const delta = { x: p.x - drag.start.x, y: p.y - drag.start.y };
    if (!drag.moved) {
      if (Math.hypot(delta.x, delta.y) * editor.view.screenScale < CLICK_SLOP_PX) return;
      drag.moved = true;
      if (drag.mode === "draw" && !ops.canAdd()) {
        editor.events.emit("note", FULL_NOTE);
        return;
      }
      if (!ops.begin()) {
        drag = null;
        return;
      }
    }
    if (drag.mode !== "draw" && drag.id && drag.rect) {
      ops.setRect(drag.id, dragRegionRect(drag.rect, delta, editor.imageSize, drag.handle));
      return;
    }
    if (!ops.active) return;
    const rect = drawRegionRect(drag.start, p, editor.imageSize);
    if (drag.id) ops.setRect(drag.id, rect);
    else drag.id = ops.add(rect);
  };

  return {
    id: REGION_TOOL_ID,
    label: "Regions",
    shortcut: "",
    icon: "region",
    options: null,
    rail: false,
    ctrlMove: false,
    cursor: () => ({ kind: "icon", icon: "crosshair" }),

    onPointerDown(editor, samples) {
      const sample = samples[0];
      if (!sample) return;
      const start = docToImage(editor.frameMap, sample);
      const grab = sample.shiftKey ? null : grabAt(editor, start);
      if (grab?.id) editor.regionOps.select(grab.id);
      drag = { start, moved: false, ...(grab ?? { mode: "draw", id: null, rect: null, handle: null }) };
    },

    onPointerMove(editor, samples) {
      const sample = samples.at(-1);
      if (sample) update(editor, sample);
    },

    onPointerUp(editor, sample) {
      if (!drag) return;
      update(editor, sample);
      const { moved, mode } = drag;
      drag = null;
      if (moved) editor.regionOps.commit();
      else if (mode === "draw") editor.regionOps.select(null);
    },

    onCancel(editor) {
      if (drag) editor.regionOps.cancel();
      drag = null;
    },

    pending: () => drag !== null,
  };
}
