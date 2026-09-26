import { describe, expect, it } from "vitest";
import { copyLayerName } from "./layerList";

const named = (...names: string[]) => names.map((name) => ({ name }));

describe("copyLayerName", () => {
  it("counts up like Photoshop and never grows the name", () => {
    expect(copyLayerName("Sky", named("Sky"))).toBe("Sky copy");
    expect(copyLayerName("Sky", named("Sky", "Sky copy"))).toBe("Sky copy 2");
    expect(copyLayerName("Sky copy", named("Sky", "Sky copy"))).toBe("Sky copy 2");
    expect(copyLayerName("Sky copy 2", named("Sky", "Sky copy", "Sky copy 2"))).toBe("Sky copy 3");
  });
  it("reuses the first free number", () => {
    expect(copyLayerName("Sky", named("Sky", "Sky copy", "Sky copy 3"))).toBe("Sky copy 2");
  });
  it("only strips a trailing copy suffix", () => {
    expect(copyLayerName("copy cat", named("copy cat"))).toBe("copy cat copy");
  });
});
