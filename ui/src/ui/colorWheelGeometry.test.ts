import { describe, expect, it } from "vitest";

import {
  HARMONY_GROUP,
  RING_OUTER,
  RING_INNER,
  SWATCH_BOX,
  TRIANGLE,
  VARIATION_GROUP,
  clampToTriangle,
  hueToAngle,
  isRingHit,
  isTriangleHit,
  pointToHue,
  pointToSv,
  ringThumb,
  svToPoint,
  triangleWeights,
} from "./colorWheelGeometry";

describe("ring", () => {
  it("places hues like the reference: yellow on top, blue at the bottom", () => {
    expect(ringThumb(60).y).toBeLessThan(-90);
    expect(Math.abs(ringThumb(60).x)).toBeLessThan(1e-9);
    expect(ringThumb(240).y).toBeGreaterThan(90);
  });

  it("round-trips hue through the angle", () => {
    for (const hue of [0, 45, 120, 200, 359]) {
      const angle = hueToAngle(hue);
      expect(pointToHue({ x: Math.cos(angle), y: Math.sin(angle) })).toBeCloseTo(hue, 6);
    }
  });

  it("separates ring and triangle presses", () => {
    expect(isRingHit({ x: RING_INNER + 2, y: 0 })).toBe(true);
    expect(isRingHit({ x: 10, y: 10 })).toBe(false);
  });
});

describe("triangle", () => {
  it("maps the corners to pure hue, white and black", () => {
    expect(pointToSv(TRIANGLE.hue)).toEqual({ s: 1, v: 1 });
    expect(pointToSv(TRIANGLE.white).v).toBeCloseTo(1, 9);
    expect(pointToSv(TRIANGLE.white).s).toBeCloseTo(0, 9);
    expect(pointToSv(TRIANGLE.black).v).toBeCloseTo(0, 9);
  });

  it("round-trips saturation / value", () => {
    for (const [s, v] of [[0.5, 0.5], [1, 0.3], [0.2, 0.9], [0, 0.6]] as const) {
      const sv = pointToSv(svToPoint(s, v));
      expect(sv.s).toBeCloseTo(s, 9);
      expect(sv.v).toBeCloseTo(v, 9);
    }
  });

  it("clamps outside points onto the triangle", () => {
    const far = clampToTriangle({ x: 500, y: 0 });
    expect(far.x).toBeCloseTo(TRIANGLE.hue.x, 9);
    const left = clampToTriangle({ x: -100, y: 0 });
    expect(left.x).toBeCloseTo(TRIANGLE.white.x, 9);
    expect(left.y).toBeCloseTo(0, 9);
    const inside = { x: 0, y: 0 };
    expect(clampToTriangle(inside)).toBe(inside);
  });
});

describe("gaps", () => {
  const groups = [
    ["harmony (top-right)", HARMONY_GROUP, (w: { black: number }) => w.black < 0],
    ["variation (bottom-right)", VARIATION_GROUP, (w: { white: number }) => w.white < 0],
  ] as const;

  for (const [name, group, outsideEdge] of groups) {
    it(`keeps the ${name} circles between the triangle and the ring`, () => {
      for (const c of group.circles) {
        expect(outsideEdge(triangleWeights(c))).toBe(true);
        expect(Math.hypot(c.x, c.y) + c.r).toBeLessThanOrEqual(RING_INNER);
        expect(isTriangleHit(c)).toBe(false);
      }
    });

    it(`puts the ${name} button outside the ring, in line with the circles`, () => {
      const { button, circles } = group;
      expect(Math.hypot(button.x, button.y) - button.r).toBeGreaterThan(RING_OUTER);
      expect(Math.atan2(button.y, button.x)).toBeCloseTo(Math.atan2(circles[1].y, circles[1].x), 9);
    });
  }

  it("grabs nothing in the gaps", () => {
    const base = HARMONY_GROUP.circles[1];
    expect(isTriangleHit(base)).toBe(false);
    expect(isRingHit(base)).toBe(false);
    expect(isTriangleHit({ x: -70, y: 0 })).toBe(false);
    expect(isTriangleHit({ x: 0, y: 0 })).toBe(true);
    expect(isTriangleHit({ x: TRIANGLE.white.x - 2, y: 0 })).toBe(true);
  });

  it("keeps the swatch left of the triangle", () => {
    expect(SWATCH_BOX.left + SWATCH_BOX.width).toBeLessThan(TRIANGLE.white.x);
  });
});