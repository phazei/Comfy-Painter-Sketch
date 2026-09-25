/**
 * Marching ants on the stage overlay (decision 7): the current selection's
 * cached outline (`Editor.selection.outline()`, document coords) and an
 * in-progress tool outline (marquee box, lasso path), drawn through the
 * document -> image map (`frameMap.ts` functions, so Move placement applies)
 * and the view. The document-space `Path2D` is rebuilt only when the
 * selection changes; the stage-space copy only when the transform changes.
 *
 * Animation: while something is drawn, the dash offset advances at ~8 fps
 * (a timer that asks the stage for an overlay redraw). The loop stops by
 * itself when nothing is drawn or the stage is hidden (the redraw request
 * is dropped, so no next tick is scheduled).
 */

import type { Editor } from "../engine/editor";
import { docToImage } from "../engine/frameMap";
import type { Contour } from "../engine/selectionOutline";
import type { ViewTransform } from "../engine/viewport";
import type { SelectionShape } from "../tools/types";

/** Animation step interval (~8 fps). */
const STEP_MS = 125;
/** Dash length in CSS px. */
const DASH = 4;

/**
 * Animated selection outline renderer for one stage.
 */
export class MarchingAnts {
  private phase = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private docPath: { contours: readonly Contour[]; path: Path2D } | null = null;
  private stagePath: { key: string; source: Path2D; path: Path2D } | null = null;

  /**
   * @param requestDraw - Ask for an overlay redraw (should do nothing while the stage is hidden).
   */
  constructor(private readonly requestDraw: () => void) {}

  /**
   * Draw the selection outline and an optional in-progress shape.
   * @param ctx - Overlay context (backing px, identity transform).
   * @param editor - Editor.
   * @param view - Image -> stage transform.
   * @param pr - Backing px per CSS px.
   * @param preview - In-progress tool outline (document coords), or `null`.
   */
  draw(ctx: CanvasRenderingContext2D, editor: Editor, view: ViewTransform, pr: number, preview: SelectionShape | null): void {
    const matrix = docToBacking(editor, view, pr);
    const current = this.selectionPath(editor);
    if (current) this.stroke(ctx, this.toStage(current, matrix), pr);
    if (preview) this.stroke(ctx, transformed(shapePath(preview), matrix), pr);
    if (current || preview) this.schedule();
  }

  /** Stop the animation. */
  dispose(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.docPath = null;
    this.stagePath = null;
  }

  // ── Internals ───────────────────────────────────────────────────────────

  private schedule(): void {
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.phase = (this.phase + 1) % (DASH * 2);
      this.requestDraw();
    }, STEP_MS);
  }

  private stroke(ctx: CanvasRenderingContext2D, path: Path2D, pr: number): void {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.lineWidth = Math.max(1, pr);
    ctx.strokeStyle = "#ffffff";
    ctx.setLineDash([]);
    ctx.stroke(path);
    ctx.strokeStyle = "#000000";
    ctx.setLineDash([DASH * pr, DASH * pr]);
    ctx.lineDashOffset = -this.phase * pr;
    ctx.stroke(path);
    ctx.restore();
  }

  /** Document-space path of the current selection (rebuilt per selection change). */
  private selectionPath(editor: Editor): Path2D | null {
    // The engine caches the contours per selection change; a new array
    // identity means the outline changed.
    const contours = editor.selection.outline();
    if (!contours || contours.length === 0) {
      this.docPath = null;
      return null;
    }
    const cached = this.docPath;
    if (cached && cached.contours === contours) return cached.path;
    // One closed subpath per contour, so the dashes flow along it.
    const path = new Path2D();
    for (const c of contours) {
      path.moveTo(c[0] as number, c[1] as number);
      for (let i = 2; i + 1 < c.length; i += 2) path.lineTo(c[i] as number, c[i + 1] as number);
      path.closePath();
    }
    this.docPath = { contours, path };
    return path;
  }

  /** Stage-space copy of the selection path (rebuilt when the transform changes). */
  private toStage(source: Path2D, matrix: DOMMatrix): Path2D {
    const key = `${matrix.a},${matrix.d},${matrix.e},${matrix.f}`;
    const cached = this.stagePath;
    if (cached && cached.source === source && cached.key === key) return cached.path;
    const path = transformed(source, matrix);
    this.stagePath = { key, source, path };
    return path;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Document -> backing-store px, from the editor's document map (never re-derived). */
function docToBacking(editor: Editor, view: ViewTransform, pr: number): DOMMatrix {
  const map = editor.frameMap;
  const o = docToImage(map, { x: 0, y: 0 });
  const u = docToImage(map, { x: 1, y: 1 });
  const k = view.scale * pr;
  return new DOMMatrix([k * (u.x - o.x), 0, 0, k * (u.y - o.y), (view.offsetX + view.scale * o.x) * pr, (view.offsetY + view.scale * o.y) * pr]);
}

function transformed(source: Path2D, matrix: DOMMatrix): Path2D {
  const path = new Path2D();
  path.addPath(source, matrix);
  return path;
}

/** Document-space path of an in-progress tool shape. */
function shapePath(shape: SelectionShape): Path2D {
  const path = new Path2D();
  if (shape.kind === "rect") {
    path.rect(shape.rect.x, shape.rect.y, shape.rect.width, shape.rect.height);
  } else if (shape.kind === "ellipse") {
    const { x, y, width, height } = shape.rect;
    path.ellipse(x + width / 2, y + height / 2, width / 2, height / 2, 0, 0, Math.PI * 2);
  } else {
    shape.points.forEach((p, i) => (i === 0 ? path.moveTo(p.x, p.y) : path.lineTo(p.x, p.y)));
    if (shape.closed) path.closePath();
  }
  return path;
}
