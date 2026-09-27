import { describe, expect, it } from "vitest";

import { COBWEB_TILE, cobwebPattern, cobwebSegments } from "./cobweb";

describe("cobwebSegments", () => {
  it("is deterministic per seed", () => {
    expect(cobwebSegments(COBWEB_TILE, 7)).toEqual(cobwebSegments(COBWEB_TILE, 7));
    expect(cobwebSegments(COBWEB_TILE, 7)).not.toEqual(cobwebSegments(COBWEB_TILE, 8));
  });

  it("keeps every segment inside the tile", () => {
    for (const size of [256, COBWEB_TILE, 512]) {
      for (const seed of [1, 2, 3, 0x5eb]) {
        const segs = cobwebSegments(size, seed);
        expect(segs.length).toBeGreaterThan(50);
        for (const s of segs) {
          for (const v of [s.x1, s.y1, s.x2, s.y2]) {
            expect(v).toBeGreaterThanOrEqual(0);
            expect(v).toBeLessThanOrEqual(size);
          }
        }
      }
    }
  });

  it("has spokes and spiral threads", () => {
    const segs = cobwebSegments();
    expect(segs.some((s) => s.spoke)).toBe(true);
    expect(segs.some((s) => !s.spoke)).toBe(true);
  });
});

describe("cobwebPattern", () => {
  it("returns null without a canvas", () => {
    const ctx = { createPattern: () => null } as unknown as CanvasRenderingContext2D;
    expect(cobwebPattern(ctx)).toBeNull();
  });
});
