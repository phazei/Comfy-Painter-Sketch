import { describe, expect, it } from "vitest";

import { INITIAL_PANEL_STATE, isPanelCollapsed, panelResized, panelSetByUser, sizeClassOf } from "./sidePanelState";

describe("side panel size classes", () => {
  it("classifies widths at the 520 px threshold", () => {
    expect(sizeClassOf(519)).toBe("narrow");
    expect(sizeClassOf(520)).toBe("wide");
  });

  it("is collapsed until measured, then follows the size class", () => {
    expect(isPanelCollapsed(INITIAL_PANEL_STATE)).toBe(true);
    expect(isPanelCollapsed(panelResized(INITIAL_PANEL_STATE, 800))).toBe(false);
    expect(isPanelCollapsed(panelResized(INITIAL_PANEL_STATE, 400))).toBe(true);
  });

  it("ignores zero widths (hidden) and same-class resizes", () => {
    const wide = panelResized(INITIAL_PANEL_STATE, 800);
    expect(panelResized(wide, 0)).toBe(wide);
    expect(panelResized(wide, 900)).toBe(wide);
  });

  it("lets a user toggle win until the size class changes", () => {
    let s = panelResized(INITIAL_PANEL_STATE, 800);
    s = panelSetByUser(s, true);
    expect(isPanelCollapsed(s)).toBe(true);
    s = panelResized(s, 700);
    expect(isPanelCollapsed(s)).toBe(true);
    s = panelResized(s, 400);
    expect(isPanelCollapsed(s)).toBe(true);
    s = panelSetByUser(s, false);
    expect(isPanelCollapsed(s)).toBe(false);
    s = panelResized(s, 450);
    expect(isPanelCollapsed(s)).toBe(false);
    s = panelResized(s, 900);
    expect(isPanelCollapsed(s)).toBe(false);
    expect(s.userCollapsed).toBeNull();
  });
});
