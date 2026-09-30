/**
 * Layer row names: at most 2 lines then an ellipsis (CSS line clamp), the
 * clamp lifted for the one-line rename field, and 2 lines fitting the
 * thumbnail box so the row height never changes.
 */

import { describe, expect, it } from "vitest";

import layersCss from "../styles/layers.css?inline";
import { LAYER_NAME_CLAMP_CLASS } from "./layerRow";
import { THUMB_BOX } from "./thumbnails";

/** Declarations of the first rule whose selector is exactly `selector`. */
function rule(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) return "";
  return css.slice(start, css.indexOf("}", start));
}

describe("layer row names", () => {
  it("clamp to 2 lines with an ellipsis; the rename field lifts it", () => {
    const clamp = rule(layersCss, `.cps-layer-name.${LAYER_NAME_CLAMP_CLASS}`);
    expect(clamp).toContain("-webkit-line-clamp: 2");
    expect(clamp).toContain("white-space: normal");
    expect(rule(layersCss, ".cps-layer-name")).toContain("text-overflow: ellipsis");
    expect(rule(layersCss, `.cps-layer-name.${LAYER_NAME_CLAMP_CLASS}.cps-renaming`)).toContain("display: block");
  });

  it("2 lines fit the thumbnail box (row height unchanged)", () => {
    const fontPx = Number(/\.cps-layers \{[^}]*font-size: (\d+)px/.exec(layersCss)?.[1]);
    const lineHeight = Number(/line-height: ([\d.]+);/.exec(rule(layersCss, `.cps-layer-name.${LAYER_NAME_CLAMP_CLASS}`))?.[1]);
    expect(fontPx * lineHeight * 2).toBeLessThanOrEqual(THUMB_BOX);
  });
});
