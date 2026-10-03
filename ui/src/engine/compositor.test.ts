import { describe, expect, it } from "vitest";

import { stageDirtyRect } from "./compositor";
import { IDENTITY_MAP } from "./frameMap";

describe("stageDirtyRect (live stroke frames)", () => {
  const canvas = { width: 1000, height: 800 };

  it("maps a document rect to padded device px", () => {
    const view = { scale: 2, offsetX: 10, offsetY: 20 };
    // Stage CSS: x 10 + 2*5 = 20, width 2*10 = 20; device (pr 1.5): 30..60. Pad ceil(3) + 2 = 5.
    expect(stageDirtyRect({ x: 5, y: 5, width: 10, height: 10 }, view, IDENTITY_MAP, 1.5, canvas)).toEqual({
      x: 25,
      y: 40,
      width: 40,
      height: 40,
    });
  });

  it("cuts to the canvas and drops rects that miss it", () => {
    const view = { scale: 1, offsetX: 0, offsetY: 0 };
    expect(stageDirtyRect({ x: -50, y: -50, width: 60, height: 60 }, view, IDENTITY_MAP, 1, canvas)).toEqual({
      x: 0,
      y: 0,
      width: 13,
      height: 13,
    });
    expect(stageDirtyRect({ x: 2000, y: 0, width: 10, height: 10 }, view, IDENTITY_MAP, 1, canvas)).toBeNull();
    expect(stageDirtyRect({ x: 0, y: 0, width: 0, height: 0 }, view, IDENTITY_MAP, 1, canvas)).toBeNull();
  });

  it("follows the document -> image map", () => {
    const view = { scale: 1, offsetX: 0, offsetY: 0 };
    const map = { scale: 0.5, offsetX: 100, offsetY: 0 };
    // Image x = 100 + 0.5*20 = 110, width 5; pad ceil(0.5) + 2 = 3.
    expect(stageDirtyRect({ x: 20, y: 0, width: 10, height: 10 }, view, map, 1, canvas)).toEqual({
      x: 107,
      y: 0,
      width: 11,
      height: 8,
    });
  });
});
