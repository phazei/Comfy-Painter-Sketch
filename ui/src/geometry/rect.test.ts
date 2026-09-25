import { describe, expect, it } from "vitest";

import { containsRect, intersectRect, isEmptyRect, roundOutRect, unionRect } from "./rect";

describe("rect helpers", () => {
  it("unions and ignores empty rects", () => {
    expect(unionRect({ x: 0, y: 0, width: 10, height: 10 }, { x: 5, y: -5, width: 10, height: 5 })).toEqual({
      x: 0,
      y: -5,
      width: 15,
      height: 15,
    });
    expect(unionRect({ x: 0, y: 0, width: 0, height: 0 }, { x: 3, y: 3, width: 1, height: 1 })).toEqual({
      x: 3,
      y: 3,
      width: 1,
      height: 1,
    });
  });

  it("intersects, returning an empty rect for disjoint inputs", () => {
    expect(intersectRect({ x: 0, y: 0, width: 10, height: 10 }, { x: 5, y: 5, width: 10, height: 10 })).toEqual({
      x: 5,
      y: 5,
      width: 5,
      height: 5,
    });
    expect(isEmptyRect(intersectRect({ x: 0, y: 0, width: 1, height: 1 }, { x: 5, y: 5, width: 1, height: 1 }))).toBe(
      true,
    );
  });

  it("rounds out and tests containment", () => {
    expect(roundOutRect({ x: 0.5, y: -0.5, width: 1, height: 1 })).toEqual({ x: 0, y: -1, width: 2, height: 2 });
    expect(containsRect({ x: 0, y: 0, width: 10, height: 10 }, { x: 2, y: 2, width: 8, height: 8 })).toBe(true);
    expect(containsRect({ x: 0, y: 0, width: 10, height: 10 }, { x: 2, y: 2, width: 9, height: 8 })).toBe(false);
  });
});
