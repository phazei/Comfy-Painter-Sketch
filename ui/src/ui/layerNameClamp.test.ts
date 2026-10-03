/**
 * Layer row names: at most 2 lines then an ellipsis (CSS line clamp; 1 line
 * on rows with a sub-line), the clamp lifted for the one-line rename field,
 * and 2 lines fitting the thumbnail height so the row height never changes.
 */

import { describe, expect, it } from "vitest";

import panelCss from "../styles/layerRows.css?inline";
import { LAYER_NAME_CLAMP_CLASS } from "./layerRow";
import { THUMB_HEIGHT } from "./thumbnails";

/** Declarations of the first rule whose selector is exactly `selector`. */
function rule(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) return "";
  return css.slice(start, css.indexOf("}", start));
}

const CLAMP = `.cps-layer-name.${LAYER_NAME_CLAMP_CLASS}`;

describe("layer row names", () => {
  it("clamp to 2 lines with an ellipsis; 1 line with a sub-line; the rename field lifts it", () => {
    const clamp = rule(panelCss, CLAMP);
    expect(clamp).toContain("-webkit-line-clamp: 2");
    expect(clamp).toContain("white-space: normal");
    expect(rule(panelCss, ".cps-layer-name")).toContain("text-overflow: ellipsis");
    expect(rule(panelCss, `.cps-layer-row.cps-has-sub ${CLAMP}`)).toContain("-webkit-line-clamp: 1");
    expect(rule(panelCss, `${CLAMP}.cps-renaming`)).toContain("display: block");
  });

  it("2 lines fit the thumbnail height (row height unchanged)", () => {
    const fontPx = Number(/font-size: (\d+)px/.exec(rule(panelCss, ".cps-layer-name"))?.[1]);
    const lineHeight = Number(/line-height: ([\d.]+);/.exec(rule(panelCss, CLAMP))?.[1]);
    expect(fontPx).toBe(13);
    expect(fontPx * lineHeight * 2).toBeLessThanOrEqual(THUMB_HEIGHT);
  });
});
