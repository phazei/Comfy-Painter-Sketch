/**
 * Lasso tool (L, SPEC Tools table + "Selection"): freehand polygon from the
 * pointer samples (decimated to ~1 image px), anti-aliased
 * (`engine/selectionRaster.ts`), one `selection` history entry.
 *
 * Alt follows Photoshop's Lasso:
 * - Mode keys at pointer-down (`selectionModifiers.ts`): with a selection,
 *   Shift add, Alt subtract, Shift+Alt intersect. A key used as a mode key
 *   only acts as a constraint after it was released and pressed again.
 * - Alt (as a constraint) = straight segments: while it is held the path
 *   gets a rubber-band segment from the last vertex to the cursor; pressing
 *   the button (or releasing it) adds a vertex. Without a selection, Alt at
 *   pointer-down starts in this polygon mode right away (Alt-click adds
 *   points).
 * - Releasing Alt with the button DOWN resumes freehand from the cursor.
 *   Releasing the button while Alt is held keeps the path open
 *   ({@link Tool.pending}): each click adds a vertex; releasing Alt with the
 *   button up, a double-click, or a click near the start closes it.
 * - Releasing the button without Alt closes the path. Esc cancels.
 *
 * A click without a drag (freehand) deselects in replace mode, like the
 * marquee. Selection tools never act as the Alt eyedropper.
 */

import type { Editor } from "../engine/editor";
import { imageLengthToDoc } from "../engine/frameMap";
import { polygonSelection } from "../engine/selectionRaster";
import type { Point } from "../geometry/rect";
import { SelectionModifiers } from "./selectionModifiers";
import type { Tool, ToolCursor, ToolOverlay, ToolPointer } from "./types";

/** Freehand samples closer than this (image px) to the previous point are dropped. */
const DECIMATE_IMAGE_PX = 1;
/** Stage CSS px: below = a click (no drag); also the "close at the start" radius is twice this. */
const CLICK_SLOP_PX = 3;
/** Two clicks within this many ms (and the click slop) close the polygon. */
const DOUBLE_CLICK_MS = 400;

/**
 * Append a point unless it is closer than `minDistance` to the last one.
 * @param points - Path (mutated).
 * @param p - New point.
 * @param minDistance - Decimation distance, document px.
 * @returns `true` if appended.
 */
export function appendDecimated(points: Point[], p: Point, minDistance: number): boolean {
  const last = points[points.length - 1];
  if (last && Math.hypot(p.x - last.x, p.y - last.y) < minDistance) return false;
  points.push({ x: p.x, y: p.y });
  return true;
}

/** One lasso path in progress (may span several presses in polygon mode). */
interface LassoPath {
  points: Point[];
  mods: SelectionModifiers;
  /** Decimation distance, document px. */
  minDistance: number;
  /** Click slop, document px. */
  slop: number;
  /** Straight-segment (polygon) mode in effect. */
  polygon: boolean;
  buttonDown: boolean;
  /** Freehand drag moved beyond the click slop. */
  moved: boolean;
  /** Rubber-band end (the pointer). */
  cursor: Point;
  /** Last click (polygon mode), for double-click detection. */
  lastClick: { at: Point; time: number } | null;
}

/**
 * The lasso.
 */
export class LassoTool implements Tool {
  readonly id = "lasso";
  readonly label = "Lasso";
  readonly shortcut = "l";
  readonly icon = "lasso";
  readonly options = null;
  readonly combinesSelection = true;
  private path: LassoPath | null = null;

  /**
   * @param now - Clock in ms (double-click detection; injectable for tests).
   */
  constructor(private readonly now: () => number = () => performance.now()) {}

  /** @inheritdoc */
  onPointerDown(editor: Editor, samples: readonly ToolPointer[]): void {
    const first = samples[0];
    if (!first) return;
    const path = this.path;
    if (path && !path.buttonDown) {
      this.pressPending(editor, path, first);
      return;
    }
    if (path) return;
    const map = editor.frameMap;
    const scale = editor.view.current.scale;
    const mods = new SelectionModifiers(first, editor.selection.active);
    this.path = {
      points: [{ x: first.x, y: first.y }],
      mods,
      minDistance: imageLengthToDoc(map, DECIMATE_IMAGE_PX),
      slop: imageLengthToDoc(map, CLICK_SLOP_PX / (scale > 0 ? scale : 1)),
      polygon: mods.update(first).fromCentre,
      buttonDown: true,
      moved: false,
      cursor: { x: first.x, y: first.y },
      lastClick: null,
    };
    if (this.path.polygon) this.path.lastClick = { at: { x: first.x, y: first.y }, time: this.now() };
    this.track(samples.slice(1));
  }

  /** @inheritdoc */
  onPointerMove(_editor: Editor, samples: readonly ToolPointer[]): void {
    this.track(samples);
  }

  /** @inheritdoc */
  onPointerUp(editor: Editor, sample: ToolPointer): void {
    const path = this.path;
    if (!path?.buttonDown) return;
    this.track([sample]);
    path.buttonDown = false;
    if (path.polygon) {
      // Alt held at release: the vertex stays, the path stays open (pending).
      appendDecimated(path.points, sample, path.minDistance);
      return;
    }
    this.finish(editor);
  }

  /** @inheritdoc */
  pending(): boolean {
    return this.path !== null && !this.path.buttonDown;
  }

  /** @inheritdoc */
  onHover(editor: Editor, sample: ToolPointer): void {
    const path = this.path;
    if (!path || path.buttonDown) return;
    path.cursor = { x: sample.x, y: sample.y };
    // Alt released with the button up: Photoshop closes the polygon.
    if (!path.mods.update(sample).fromCentre) this.finish(editor);
  }

  /** @inheritdoc */
  onCancel(): void {
    this.path = null;
  }

  /** @inheritdoc */
  cursor(): ToolCursor {
    return { kind: "icon", icon: "crosshair" };
  }

  /** @inheritdoc */
  overlay(): ToolOverlay | null {
    const path = this.path;
    if (!path) return null;
    const points = path.polygon ? [...path.points, path.cursor] : path.points;
    return points.length > 1 ? { kind: "selection", shape: { kind: "polygon", points, closed: false } } : null;
  }

  // ── Internals ───────────────────────────────────────────────────────────

  /** Button-down samples: freehand points, or the rubber band in polygon mode. */
  private track(samples: readonly ToolPointer[]): void {
    const path = this.path;
    if (!path?.buttonDown) return;
    const start = path.points[0] as Point;
    for (const p of samples) {
      const straight = path.mods.update(p).fromCentre;
      if (!path.moved && Math.hypot(p.x - start.x, p.y - start.y) > path.slop) path.moved = true;
      if (path.polygon && !straight) {
        // Alt released mid-drag: the straight segment ends here, freehand resumes.
        appendDecimated(path.points, p, path.minDistance);
      }
      path.polygon = straight;
      path.cursor = { x: p.x, y: p.y };
      if (!straight) appendDecimated(path.points, p, path.minDistance);
    }
  }

  /** A press while the polygon is pending: close (double-click / near start) or add a vertex. */
  private pressPending(editor: Editor, path: LassoPath, p: ToolPointer): void {
    const time = this.now();
    const start = path.points[0] as Point;
    const last = path.lastClick;
    const nearStart = path.points.length > 2 && Math.hypot(p.x - start.x, p.y - start.y) <= path.slop * 2;
    const double = last !== null && time - last.time <= DOUBLE_CLICK_MS && Math.hypot(p.x - last.at.x, p.y - last.at.y) <= path.slop;
    if (nearStart || double) {
      this.finish(editor);
      return;
    }
    path.lastClick = { at: { x: p.x, y: p.y }, time };
    path.buttonDown = true;
    path.polygon = path.mods.update(p).fromCentre;
    path.cursor = { x: p.x, y: p.y };
    appendDecimated(path.points, p, path.minDistance);
  }

  /** Close the path and apply it (one history entry); a bare click deselects in replace mode. */
  private finish(editor: Editor): void {
    const path = this.path;
    this.path = null;
    if (!path) return;
    const clickOnly = !path.moved && path.points.length < 3;
    if (clickOnly) {
      if (path.mods.mode === "replace") editor.selection.deselect();
      return;
    }
    editor.selection.apply(polygonSelection(path.points), path.mods.mode);
  }
}

/**
 * Create the lasso.
 * @returns The tool.
 */
export function createLassoTool(): LassoTool {
  return new LassoTool();
}
