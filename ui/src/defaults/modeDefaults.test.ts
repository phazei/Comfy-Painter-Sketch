/** Editor mode: the stored-value sanitizer, the setting entry and the Simple-mode dock rule. */
import { describe, expect, it } from "vitest";

import { hiddenInDock } from "../ui/toolDock";
import { DEFAULT_MODE, MODE_SETTING, parseMode } from "./modeDefaults";

describe("editor mode", () => {
  it("accepts only simple / advanced", () => {
    expect(parseMode("simple")).toBe("simple");
    expect(parseMode("advanced")).toBe("advanced");
    for (const junk of [undefined, null, "", "Simple", 1, {}]) expect(parseMode(junk)).toBeNull();
  });

  it("the setting defaults to Simple and offers both modes", () => {
    expect(DEFAULT_MODE).toBe("simple");
    expect(MODE_SETTING.defaultValue).toBe("simple");
    expect(MODE_SETTING.options?.map((o) => (typeof o === "string" ? o : o.value))).toEqual(["simple", "advanced"]);
  });
});

describe("Simple-mode dock", () => {
  it("hides the bucket, shapes and text unless active; Advanced hides nothing", () => {
    expect(hiddenInDock(true, "bucket", ["bucket"], "brush")).toBe(true);
    expect(hiddenInDock(true, "text", ["text"], "brush")).toBe(true);
    expect(hiddenInDock(true, "shape", ["line", "arrow", "rectangle", "ellipse"], "brush")).toBe(true);
    expect(hiddenInDock(true, "brush", ["brush"], "eraser")).toBe(false);
    expect(hiddenInDock(true, "select", ["marquee-rect", "lasso"], "brush")).toBe(false);
    expect(hiddenInDock(false, "bucket", ["bucket"], "brush")).toBe(false);
  });

  it("an advanced tool picked by its shortcut shows while active", () => {
    expect(hiddenInDock(true, "bucket", ["bucket"], "bucket")).toBe(false);
    expect(hiddenInDock(true, "shape", ["line", "arrow", "rectangle", "ellipse"], "ellipse")).toBe(false);
  });
});
