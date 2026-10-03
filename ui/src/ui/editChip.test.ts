/** Edit chip model (`chipModel`): the Background row selection, and region mode still winning. */
import { describe, expect, it } from "vitest";
import { REGION_TOOL_ID } from "../tools/region";
import type { EditorSession } from "../widget/sessions";
import { BACKGROUND_SWATCH, chipModel } from "./editChip";

/** Minimal session: what `chipModel` reads. */
function session(background: { kind: "fill"; color: string } | { kind: "image" }, tool = "brush"): EditorSession {
  const editor = {
    backgroundSelected: true,
    background,
    paintTarget: "paint",
    regionOps: { selectedId: null },
    doc: { regions: [], layers: [], activeLayerId: "" },
  };
  return { tools: { active: { id: tool } }, editor } as unknown as EditorSession;
}

describe("chipModel", () => {
  it("Background selected: 'Background · Read-only', swatch = fill colour or stripes", () => {
    expect(chipModel(session({ kind: "fill", color: "#123456" }))).toEqual({ name: "Background", part: "Read-only", swatch: "#123456", ring: false });
    expect(chipModel(session({ kind: "image" })).swatch).toBe(BACKGROUND_SWATCH);
  });

  it("region mode still wins", () => {
    expect(chipModel(session({ kind: "fill", color: "#123456" }, REGION_TOOL_ID))).toMatchObject({ name: "Main", part: "Outputs" });
  });
});
