import { describe, expect, it } from "vitest";

import { IDENTITY_PLACEMENT, PLACEMENT_MAX_SCALE } from "../document/placement";
import type { Placement } from "../document/types";
import type { Size } from "../geometry/rect";
import { boundsCap } from "./bounds";
import { docRectToImage, docToImage, frameMap, imageToDoc } from "./frameMap";
import { PLACEMENT_MARGIN, clampPlacement, clampedScaleAt, placementScaleRange } from "./placementClamp";
import { translatePlacement } from "./placementMath";

// ── Helpers ───────────────────────────────────────────────────────────────────

const EPS = 1e-6;

/** Whether the mapped max paint area covers image + margin. */
function holds(p: Placement, frame: Size, image: Size): boolean {
  const r = docRectToImage(frameMap(frame, image, p), boundsCap(frame));
  const m = PLACEMENT_MARGIN;
  return r.x <= -m + EPS && r.y <= -m + EPS && r.x + r.width >= image.width + m - EPS && r.y + r.height >= image.height + m - EPS;
}

const frame = { width: 1000, height: 1000 };
const image = { width: 1000, height: 1000 };

// ── Offsets ───────────────────────────────────────────────────────────────────

describe("clampPlacement offsets", () => {
  it("keeps a valid placement exactly", () => {
    const p = { x: 123.4, y: -56.7, scale: 1.2 };
    expect(clampPlacement(p, frame, image)).toEqual(p);
  });

  // Cap = 3000 px centred: at scale 1 the offset may move ±(1000 - 50).
  it.each([
    ["left", -5000, 0, -950, 0],
    ["right", 5000, 0, 950, 0],
    ["top", 0, -5000, 0, -950],
    ["bottom", 0, 5000, 0, 950],
  ])("stops at the %s edge", (_edge, dx, dy, ex, ey) => {
    const p = clampPlacement(translatePlacement(IDENTITY_PLACEMENT, frame, image, dx, dy), frame, image);
    expect(p.x).toBeCloseTo(ex, 9);
    expect(p.y).toBeCloseTo(ey, 9);
    expect(holds(p, frame, image)).toBe(true);
  });
});

// ── Scale ─────────────────────────────────────────────────────────────────────

describe("scale limits", () => {
  it("max is 10, min is the smallest scale satisfying the rule", () => {
    const range = placementScaleRange(frame, image);
    expect(range.max).toBe(10);
    expect(range.min).toBeCloseTo(1100 / 3000, 12);
    expect(clampPlacement({ x: 0, y: 0, scale: 50 }, frame, image).scale).toBe(PLACEMENT_MAX_SCALE);
    const small = clampPlacement({ x: 0, y: 0, scale: 0.1 }, frame, image);
    expect(small.scale).toBeCloseTo(1100 / 3000, 12);
    expect(holds(small, frame, image)).toBe(true);
  });

  it("scales around the cursor, then clamps the offset", () => {
    const anchor = { x: 200, y: 300 };
    const start = { x: 0, y: 0, scale: 1 };
    const docUnder = imageToDoc(frameMap(frame, image, start), anchor);
    const up = clampedScaleAt(start, frame, image, 2, anchor);
    expect(up.scale).toBe(2);
    const at = docToImage(frameMap(frame, image, up), docUnder);
    expect(at.x).toBeCloseTo(anchor.x, 9);
    expect(at.y).toBeCloseTo(anchor.y, 9);
    // Shrinking near a corner: scale stops at min and the offset is pulled back in.
    const down = clampedScaleAt({ x: 900, y: 900, scale: 1 }, frame, image, 0.01, { x: 0, y: 0 });
    expect(down.scale).toBeCloseTo(1100 / 3000, 12);
    expect(holds(down, frame, image)).toBe(true);
  });
});

// ── Frames ────────────────────────────────────────────────────────────────────

describe("frame cases", () => {
  it("16384-capped frame: scale must grow to cover image + margin", () => {
    const big = { width: 16384, height: 16384 };
    const range = placementScaleRange(big, big);
    expect(range.min).toBeCloseTo(16484 / 16384, 12);
    const p = clampPlacement(IDENTITY_PLACEMENT, big, big);
    expect(p.scale).toBeCloseTo(16484 / 16384, 12);
    expect(holds(p, big, big)).toBe(true);
  });

  it("infeasible: max scale, paint area centred on the image", () => {
    const tiny = { width: 16384, height: 16384 };
    const img = { width: 5, height: 5 }; // cap*s*10 = 50 < 105
    const p = clampPlacement({ x: 999, y: -999, scale: 1 }, tiny, img);
    expect(p.scale).toBe(10);
    const r = docRectToImage(frameMap(tiny, img, p), boundsCap(tiny));
    expect(r.x + r.width / 2).toBeCloseTo(2.5, 9);
    expect(r.y + r.height / 2).toBeCloseTo(2.5, 9);
    expect(r.width).toBeGreaterThanOrEqual(img.width);
  });

  it("non-1 fit: identity is clamped into the rule (strict)", () => {
    const narrow = { width: 100, height: 1000 }; // fit 1 into 1000 x 1000, cap 300 wide
    const p = clampPlacement(IDENTITY_PLACEMENT, narrow, image);
    expect(p.scale).toBeCloseTo(1100 / 300, 12);
    expect(holds(p, narrow, image)).toBe(true);
    const half = { width: 2000, height: 2000 }; // fit 0.5
    const q = clampPlacement(translatePlacement(IDENTITY_PLACEMENT, half, image, 5000, 0), half, image);
    expect(q.x * 0.5).toBeCloseTo(950, 9);
    expect(holds(q, half, image)).toBe(true);
  });
});

// ── Relative to a violating placement ─────────────────────────────────────────

describe("clamp from a violating placement", () => {
  // Frame 1024 on image 1024 x 256: fit 0.25, cap 768 wide at x 128..896 -> both
  // horizontal edges violate; vertical (-256..512) is fine.
  const f = { width: 1024, height: 1024 };
  const img = { width: 1024, height: 256 };
  const from = IDENTITY_PLACEMENT;

  it("keeps the placement when nothing changes (no jump)", () => {
    expect(clampPlacement(from, f, img, from)).toEqual(from);
  });

  it("blocks moves that worsen a violated edge, allows free axes", () => {
    const right = clampPlacement(translatePlacement(from, f, img, 100, 0), f, img, from);
    expect(right.x).toBeCloseTo(0, 9);
    expect(right.scale).toBe(1);
    const down = clampPlacement(translatePlacement(from, f, img, 0, 30), f, img, from);
    expect(down.y * 0.25).toBeCloseTo(30, 9);
  });

  it("allows scaling up (improves both edges) and blocks scaling down", () => {
    const anchor = { x: 512, y: 128 };
    expect(clampedScaleAt(from, f, img, 1.2, anchor).scale).toBeCloseTo(1.2, 12);
    expect(clampedScaleAt(from, f, img, 0.5, anchor).scale).toBe(1);
  });

  it("once satisfied, the strict rule applies", () => {
    const ok = clampPlacement({ x: 0, y: 0, scale: 2 }, f, img);
    expect(holds(ok, f, img)).toBe(true);
    expect(clampPlacement({ ...ok, scale: 0.5 }, f, img, ok).scale).toBeCloseTo((1024 + 100) / 768, 12);
  });
});