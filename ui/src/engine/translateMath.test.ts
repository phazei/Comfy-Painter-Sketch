import { describe, expect, it } from "vitest";

import { containsRect, intersectRect, unionRect } from "../geometry/rect";
import type { Rect } from "../geometry/rect";
import { alphaBounds, dragDelta, mergeTranslate, nudgeStep, offsetRect, planTranslate, translateStep } from "./translateMath";
import type { TranslateRecord } from "./translateMath";

/** Sparse pixel model of one layer: bounds + opaque pixels in document coords. */
class Grid {
  readonly px = new Map<string, number>();
  constructor(public bounds: Rect) {}
  set(x: number, y: number, v: number): void {
    this.px.set(`${x},${y}`, v);
  }
  /** Like `EditorState.ensureBounds(r, false)`. */
  ensure(r: Rect): void {
    this.bounds = unionRect(this.bounds, r);
  }
  /** Like `shiftRegion`: move pixels in `from` (clipped to bounds); drop what lands outside. */
  shift(from: Rect, dx: number, dy: number): void {
    const src = intersectRect(from, this.bounds);
    const moved: [number, number, number][] = [];
    for (const [key, v] of this.px) {
      const [x = 0, y = 0] = key.split(",").map(Number);
      if (x < src.x || y < src.y || x >= src.x + src.width || y >= src.y + src.height) continue;
      this.px.delete(key);
      moved.push([x + dx, y + dy, v]);
    }
    const b = this.bounds;
    for (const [x, y, v] of moved) if (x >= b.x && y >= b.y && x < b.x + b.width && y < b.y + b.height) this.set(x, y, v);
  }
  snapshot(): string {
    return [...this.px.entries()].sort().join(";");
  }
}

const frame = { width: 100, height: 100 };
const frameBounds: Rect = { x: 0, y: 0, width: 100, height: 100 };

describe("dragDelta / nudgeStep", () => {
  it("rounds drag deltas to whole document px without -0", () => {
    expect(dragDelta({ x: 10.2, y: 5 }, { x: 13.7, y: 4.6 })).toEqual({ x: 4, y: 0 });
    expect(Object.is(dragDelta({ x: 1, y: 1 }, { x: 0.8, y: 1.2 }).x, -0)).toBe(false);
    expect(dragDelta({ x: 0, y: 0 }, { x: -2.6, y: -0.4 })).toEqual({ x: -3, y: 0 });
  });

  it("converts image px nudges to document px, at least 1", () => {
    expect(nudgeStep(1, 1)).toBe(1);
    expect(nudgeStep(10, 1)).toBe(10);
    // Image shown at 1/4 of the document: 1 image px = 4 doc px.
    expect(nudgeStep(1, 0.25)).toBe(4);
    expect(nudgeStep(10, 0.25)).toBe(40);
    // Image 4x the document: never below 1.
    expect(nudgeStep(1, 4)).toBe(1);
    expect(nudgeStep(10, 4)).toBe(3);
    expect(nudgeStep(1, 0)).toBe(1);
  });
});

describe("alphaBounds", () => {
  it("finds the bbox of non-transparent pixels", () => {
    const w = 5;
    const h = 4;
    const data = new Uint8ClampedArray(w * h * 4);
    expect(alphaBounds(data, w, h).width).toBe(0);
    data[(1 * w + 3) * 4 + 3] = 1;
    data[(2 * w + 1) * 4 + 3] = 255;
    expect(alphaBounds(data, w, h)).toEqual({ x: 1, y: 1, width: 3, height: 2 });
    // RGB without alpha doesn't count.
    data[(3 * w + 4) * 4] = 255;
    expect(alphaBounds(data, w, h)).toEqual({ x: 1, y: 1, width: 3, height: 2 });
  });
});

describe("planTranslate", () => {
  const content: Rect = { x: 10, y: 10, width: 20, height: 20 };

  it("does nothing for a zero delta or an empty layer", () => {
    expect(planTranslate(frameBounds, content, 0, 0, frame).kind).toBe("none");
    expect(planTranslate(frameBounds, { x: 0, y: 0, width: 0, height: 0 }, 5, 5, frame).kind).toBe("none");
  });

  it("stays a lossless translate when bounds already cover the target", () => {
    const plan = planTranslate(frameBounds, content, 50, -5, frame);
    expect(plan.kind).toBe("translate");
    if (plan.kind === "none") return;
    expect(plan.bounds).toEqual(frameBounds);
    expect(plan.target).toEqual({ x: 60, y: 5, width: 20, height: 20 });
  });

  it("grows bounds (chunked, capped) to cover the moved content", () => {
    const plan = planTranslate(frameBounds, content, 90, 0, frame);
    expect(plan.kind).toBe("translate");
    if (plan.kind === "none") return;
    expect(containsRect(plan.bounds, plan.target)).toBe(true);
    // 256 px chunk, capped at 3x the frame centred on it (x -100..200).
    expect(plan.bounds).toEqual({ x: 0, y: 0, width: 200, height: 100 });
  });

  it("falls back to a patch when the cap would clip", () => {
    const plan = planTranslate(frameBounds, content, 250, 0, frame);
    expect(plan.kind).toBe("patch");
    if (plan.kind === "none") return;
    expect(plan.region).toEqual({ x: 10, y: 10, width: 270, height: 20 });
  });
});

describe("translate entry apply / revert", () => {
  function paint(): Grid {
    const g = new Grid({ ...frameBounds });
    g.set(10, 10, 1);
    g.set(29, 29, 2);
    g.set(15, 20, 3);
    return g;
  }
  const content: Rect = { x: 10, y: 10, width: 20, height: 20 };

  /** Commit like `translateLayerPixels` (translate path). */
  function commit(g: Grid, record: TranslateRecord): void {
    const plan = planTranslate(g.bounds, record.content, record.dx, record.dy, frame);
    expect(plan.kind).toBe("translate");
    if (plan.kind === "none") return;
    g.bounds = plan.bounds;
    g.shift(record.content, record.dx, record.dy);
  }

  function apply(g: Grid, record: TranslateRecord, forward: boolean): void {
    const step = translateStep(record, forward);
    g.ensure(step.to);
    g.shift(step.from, step.dx, step.dy);
  }

  it("undo and redo are exact, also after later bounds growth", () => {
    const g = paint();
    const original = g.snapshot();
    const record: TranslateRecord = { dx: 85, dy: -7, content };
    commit(g, record);
    const moved = g.snapshot();
    expect(g.px.size).toBe(3);
    g.ensure({ x: -300, y: -300, width: 10, height: 10 }); // later growth (a stroke elsewhere)
    apply(g, record, false);
    expect(g.snapshot()).toBe(original);
    apply(g, record, true);
    expect(g.snapshot()).toBe(moved);
  });

  it("re-applying grows bounds to where the content lands", () => {
    const g = paint();
    const record: TranslateRecord = { dx: -40, dy: 0, content };
    const original = g.snapshot();
    commit(g, record);
    // Bounds that only cover the moved content (e.g. restored from a snapshot).
    g.bounds = offsetRect(content, -40, 0);
    apply(g, record, false);
    expect(containsRect(g.bounds, content)).toBe(true);
    expect(g.snapshot()).toBe(original);
  });

  it("merged nudges undo as one step", () => {
    const g = paint();
    const original = g.snapshot();
    const record: TranslateRecord = { dx: 1, dy: 0, content };
    commit(g, record);
    for (const [dx, dy] of [[1, 0], [0, 10], [-1, 0]] as const) {
      const now = offsetRect(content, record.dx, record.dy);
      commit(g, { dx, dy, content: now });
      mergeTranslate(record, dx, dy);
    }
    expect(record).toMatchObject({ dx: 1, dy: 10 });
    expect(record.content).toEqual(content);
    apply(g, record, false);
    expect(g.snapshot()).toBe(original);
  });

  it("describes both directions", () => {
    expect(translateStep({ dx: 3, dy: -2, content }, true)).toEqual({ from: content, to: offsetRect(content, 3, -2), dx: 3, dy: -2 });
    expect(translateStep({ dx: 3, dy: 0, content }, false)).toEqual({ from: offsetRect(content, 3, 0), to: content, dx: -3, dy: 0 });
  });
});
