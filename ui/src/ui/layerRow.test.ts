/**
 * Layers panel row click routing (lmask-only view) against a minimal
 * fake DOM: a click on the Background row reaches `select` (the panel ends
 * the view there; it isn't selectable), its eye doesn't; lmask thumbnail
 * Alt / plain clicks and the pixel thumbnail reach their actions.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RowActions } from "./layerRow";

// ── Fake DOM ──────────────────────────────────────────────────────────────────

class FakeElement extends EventTarget {
  children: FakeElement[] = [];
  parent: FakeElement | null = null;
  className = "";
  textContent = "";
  innerHTML = "";
  title = "";
  hidden = false;
  disabled = false;
  type = "";
  width = 0;
  height = 0;
  readonly dataset: Record<string, string> = {};
  readonly style = { width: "", height: "", setProperty: () => {}, removeProperty: () => {} };
  readonly classList = { add: () => {}, remove: () => {}, toggle: () => {}, contains: () => false };
  constructor(readonly tagName: string) {
    super();
  }
  append(...items: FakeElement[]): void {
    for (const item of items) {
      item.parent = this;
      this.children.push(item);
    }
  }
  appendChild(item: FakeElement): void {
    this.append(item);
  }
  setAttribute(): void {}
  /** Enough for `isControl`: the nearest button ancestor. */
  closest(): FakeElement | null {
    for (let el: FakeElement | null = this; el; el = el.parent) if (el.tagName === "button") return el;
    return null;
  }
  find(name: string): FakeElement[] {
    const own = this.className.split(" ").includes(name) ? [this] : [];
    return [...own, ...this.children.flatMap((c) => c.find(name))];
  }
}

beforeEach(() => {
  vi.stubGlobal("document", { createElement: (tag: string) => new FakeElement(tag) });
  vi.stubGlobal("Element", FakeElement);
});
afterEach(() => vi.unstubAllGlobals());

/** Every action records its name and arguments. */
function recorder(): { actions: RowActions; calls: unknown[][] } {
  const calls: unknown[][] = [];
  const actions = new Proxy({} as RowActions, { get: (_t, name) => (...args: unknown[]) => void calls.push([name, ...args]) });
  return { actions, calls };
}

function click(target: FakeElement, mods: Partial<MouseEvent> = {}): void {
  const event = new Event("click", { bubbles: true });
  Object.assign(event, { ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...mods });
  // No real bubbling in the fake: dispatch on the target, then on each ancestor unless stopped.
  let stopped = false;
  event.stopPropagation = () => void (stopped = true);
  for (let el: FakeElement | null = target; el && !stopped; el = el.parent) el.dispatchEvent(event);
}

describe("layer row clicks", () => {
  it("any click on the Background row reaches select (ends the lmask-only view); its eye doesn't", async () => {
    const { LayerRow } = await import("./layerRow");
    const { actions, calls } = recorder();
    const row = new LayerRow("background", "bg", actions);
    const root = row.element as unknown as FakeElement;
    click(root);
    click(root, { ctrlKey: true });
    expect(calls).toEqual([["select", "bg"], ["select", "bg"]]);
    const eye = root.find("cps-layer-eye")[0];
    if (!eye) throw new Error("no eye");
    click(eye);
    expect(calls.at(-1)).toEqual(["toggleVisible", "bg"]);
    expect(calls.filter((c) => c[0] === "select")).toHaveLength(2);
  });

  it("lmask thumbnail: Alt+click views, click targets the mask; the pixel thumbnail targets the pixels", async () => {
    const { LayerRow } = await import("./layerRow");
    const { actions, calls } = recorder();
    const row = new LayerRow("paint", "a", actions);
    row.update({ id: "a", name: "A", visible: true, locked: false, selected: true, standby: false, maskSlot: { canHave: true, mask: { enabled: true, targeted: true, viewing: false } } });
    const root = row.element as unknown as FakeElement;
    const [pixels, mask] = root.find("cps-layer-thumb-box");
    if (!pixels || !mask) throw new Error("no thumbnails");
    click(mask, { altKey: true });
    click(mask);
    click(pixels);
    expect(calls).toEqual([["toggleMaskView", "a"], ["targetMask", "a"], ["targetLayer", "a"]]);
  });

  it("lmask slot: Shift+click toggles enabled, Ctrl+click loads a selection; the add icon adds (Alt = hide all)", async () => {
    const { LayerRow } = await import("./layerRow");
    const { actions, calls } = recorder();
    const row = new LayerRow("paint", "a", actions);
    row.update({ id: "a", name: "A", visible: true, locked: false, selected: true, standby: false, maskSlot: { canHave: true, mask: { enabled: true, targeted: false, viewing: false } } });
    const root = row.element as unknown as FakeElement;
    const mask = root.find("cps-layer-mask-thumb")[0];
    const add = root.find("cps-layer-mask-add")[0];
    if (!mask || !add) throw new Error("no slot parts");
    click(mask, { shiftKey: true });
    click(mask, { ctrlKey: true });
    click(add, { altKey: true });
    click(add);
    expect(calls).toEqual([["toggleMaskEnabled", "a"], ["maskSelection", "a", "replace"], ["addLayerMask", "a", true], ["addLayerMask", "a", false]]);
  });

  it("row clicks select; Ctrl+click loads a selection; row buttons never select", async () => {
    const { LayerRow } = await import("./layerRow");
    const { actions, calls } = recorder();
    const row = new LayerRow("mask", "m", actions);
    row.update({ id: "m", name: "Mask 1", visible: true, locked: false, selected: false, standby: false, color: "#0000ff" });
    const root = row.element as unknown as FakeElement;
    click(root);
    click(root, { ctrlKey: true });
    for (const name of ["cps-layer-invert", "cps-layer-lock", "cps-layer-solo", "cps-layer-eye"]) {
      const b = root.find(name)[0];
      if (!b) throw new Error(`no ${name}`);
      click(b);
    }
    expect(calls).toEqual([
      ["select", "m"],
      ["loadSelection", "m", "replace"],
      ["toggleInvert", "m"],
      ["toggleLocked", "m"],
      ["toggleSolo", "m"],
      ["toggleVisible", "m"],
    ]);
  });

  it("Image Mask row: Duplicate button, lock badge, no lock button", async () => {
    const { LayerRow } = await import("./layerRow");
    const { actions, calls } = recorder();
    const row = new LayerRow("imageMask", "im", actions);
    row.update({ id: "im", name: "Image Mask", visible: true, locked: true, selected: false, standby: false, color: "#00ff00", canDuplicate: true });
    const root = row.element as unknown as FakeElement;
    expect(root.find("cps-layer-lock")).toHaveLength(0);
    expect(root.find("cps-layer-lock-badge")).toHaveLength(1);
    const dup = root.find("cps-layer-dup")[0];
    if (!dup) throw new Error("no duplicate");
    expect(dup.disabled).toBe(false);
    click(dup);
    expect(calls).toEqual([["duplicate", "im"]]);
    row.update({ id: "im", name: "Image Mask", visible: true, locked: true, selected: false, standby: false, color: "#00ff00", canDuplicate: false });
    expect(dup.disabled).toBe(true);
  });
});
