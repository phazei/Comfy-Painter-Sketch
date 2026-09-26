import { describe, expect, it } from "vitest";

import { createFillTool } from "../tools/fill";
import { createMagicWandTool } from "../tools/magicWand";
import {
  BUCKET_SAMPLE_ID,
  normalizeSample,
  SAMPLE_DEFAULTS,
  SAMPLE_SETTINGS,
  sampleDefaultsFrom,
  WAND_SAMPLE_ID,
} from "./sampleDefaults";

const reader = (values: Record<string, unknown>) => (id: string) => values[id];

describe("sample defaults", () => {
  it("default to the background for both tools", () => {
    expect(SAMPLE_DEFAULTS).toEqual({ bucket: "background", wand: "background" });
    expect(sampleDefaultsFrom(reader({}))).toEqual(SAMPLE_DEFAULTS);
  });

  it("read valid values independently per tool", () => {
    expect(sampleDefaultsFrom(reader({ [BUCKET_SAMPLE_ID]: "all", [WAND_SAMPLE_ID]: "layer" }))).toEqual({
      bucket: "all",
      wand: "layer",
    });
  });

  it("fall back for junk values", () => {
    expect(normalizeSample("everything", "background")).toBe("background");
    expect(normalizeSample(3, "all")).toBe("all");
    expect(sampleDefaultsFrom(reader({ [BUCKET_SAMPLE_ID]: null }))).toEqual(SAMPLE_DEFAULTS);
  });

  it("settings entries use the ids and offer every sample source", () => {
    expect(SAMPLE_SETTINGS.map((s) => s.id)).toEqual([BUCKET_SAMPLE_ID, WAND_SAMPLE_ID]);
    for (const s of SAMPLE_SETTINGS) {
      expect(s.type).toBe("combo");
      const values = (s.options ?? []).map((o) => (typeof o === "string" ? o : o.value));
      expect(values.sort()).toEqual(["all", "background", "layer"]);
    }
  });

  it("tools start with the given sample source", () => {
    expect(createFillTool().values.sample).toBe("background");
    expect(createFillTool("all").values.sample).toBe("all");
    expect(createMagicWandTool("layer").values.sample).toBe("layer");
  });
});
