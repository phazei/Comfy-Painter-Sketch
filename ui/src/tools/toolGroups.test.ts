import { describe, expect, it } from "vitest";
import { ToolGroupState } from "./toolGroups";

const shapes = { id: "shape", label: "Shape", toolIds: ["line", "arrow", "rect"] };

describe("ToolGroupState", () => {
  it("starts on the first member and remembers the last-used one", () => {
    const g = new ToolGroupState([shapes]);
    expect(g.currentOf("shape")).toBe("line");
    g.noteActive("rect");
    expect(g.currentOf("shape")).toBe("rect");
    g.noteActive("brush");
    expect(g.currentOf("shape")).toBe("rect");
    expect(g.groupOf("arrow")?.id).toBe("shape");
    expect(g.groupOf("brush")).toBeUndefined();
  });

  it("cycles from the active member, wrapping", () => {
    const g = new ToolGroupState([shapes]);
    expect(g.next("shape", "line")).toBe("arrow");
    expect(g.next("shape", "rect")).toBe("line");
  });

  it("advances from the last-used member when another tool is active", () => {
    const g = new ToolGroupState([shapes]);
    g.noteActive("arrow");
    expect(g.next("shape", "brush")).toBe("rect");
    expect(g.next("nope", "brush")).toBeUndefined();
  });

  it("ignores empty groups", () => {
    const g = new ToolGroupState([{ id: "x", label: "X", toolIds: [] }]);
    expect(g.specs).toHaveLength(0);
    expect(g.currentOf("x")).toBeUndefined();
  });
});
