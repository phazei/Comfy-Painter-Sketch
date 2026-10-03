/**
 * Side panel against a minimal fake DOM: hide grace (pointer crossing the
 * gap), hover keeps it, shrink / tab-click expand, height cap, events.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

class FakeElement extends EventTarget {
  children: FakeElement[] = [];
  className = "";
  textContent = "";
  innerHTML = "";
  title = "";
  hidden = false;
  type = "";
  readonly style: Record<string, string> = {};
  readonly classes = new Set<string>();
  readonly classList = {
    toggle: (name: string, on?: boolean) => void ((on ?? !this.classes.has(name)) ? this.classes.add(name) : this.classes.delete(name)),
  };
  constructor(readonly tagName: string) {
    super();
  }
  append(...items: FakeElement[]): void {
    this.children.push(...items);
  }
  appendChild(item: FakeElement): void {
    this.children.push(item);
  }
  replaceChildren(...items: FakeElement[]): void {
    this.children = [...items];
  }
  setAttribute(): void {}
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("document", { createElement: (tag: string) => new FakeElement(tag) });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function panel(): Promise<{ side: import("./sidePanel").SidePanel; root: FakeElement; events: unknown[][] }> {
  const { SidePanel } = await import("./sidePanel");
  const side = new SidePanel();
  const events: unknown[][] = [];
  side.events.on("visible", (v) => events.push(["visible", v]));
  side.events.on("shrink", (v) => events.push(["shrink", v]));
  side.events.on("tab", (v) => events.push(["tab", v]));
  return { side, root: side.element as unknown as FakeElement, events };
}

describe("SidePanel visibility", () => {
  it("starts hidden; shows at once; hides after the grace", async () => {
    const { side, root, events } = await panel();
    const { HIDE_GRACE_MS } = await import("./sidePanel");
    expect(root.hidden).toBe(true);
    side.setVisible(true);
    expect(root.hidden).toBe(false);
    side.setVisible(false);
    vi.advanceTimersByTime(HIDE_GRACE_MS - 1);
    expect(side.visible).toBe(true);
    vi.advanceTimersByTime(1);
    expect(root.hidden).toBe(true);
    expect(events).toEqual([["visible", true], ["visible", false]]);
  });

  it("entering the panel cancels the grace; leaving restarts it", async () => {
    const { side, root } = await panel();
    const { HIDE_GRACE_MS } = await import("./sidePanel");
    side.setVisible(true);
    side.setVisible(false);
    root.dispatchEvent(new Event("pointerenter"));
    vi.advanceTimersByTime(HIDE_GRACE_MS * 4);
    expect(root.hidden).toBe(false);
    root.dispatchEvent(new Event("pointerleave"));
    vi.advanceTimersByTime(HIDE_GRACE_MS);
    expect(root.hidden).toBe(true);
  });

  it("a show during the grace keeps it up", async () => {
    const { side, root } = await panel();
    const { HIDE_GRACE_MS } = await import("./sidePanel");
    side.setVisible(true);
    side.setVisible(false);
    side.setVisible(true);
    vi.advanceTimersByTime(HIDE_GRACE_MS * 2);
    expect(root.hidden).toBe(false);
  });
});

describe("SidePanel tabs, shrink, height", () => {
  it("tab click expands a shrunk panel; showTab does not", async () => {
    const { side, events } = await panel();
    const a = new FakeElement("div");
    const b = new FakeElement("div");
    const extra = new FakeElement("div");
    side.setTabs([
      { id: "layers", label: "Layers", panel: a as unknown as HTMLElement, headerExtra: extra as unknown as HTMLElement },
      { id: "outputs", label: "Outputs", panel: b as unknown as HTMLElement, title: "Outputs (O)" },
    ]);
    expect(side.activeTab).toBe("layers");
    expect([a.hidden, b.hidden, extra.hidden]).toEqual([false, true, false]);
    side.setShrunk(true);
    side.showTab("outputs");
    expect(side.shrunk).toBe(true);
    expect(extra.hidden).toBe(true);
    const seg = (side.element as unknown as FakeElement).children[0]?.children[0];
    const layersButton = seg?.children[0];
    if (!layersButton) throw new Error("no tab button");
    layersButton.dispatchEvent(new Event("click"));
    expect(side.shrunk).toBe(false);
    expect(side.activeTab).toBe("layers");
    expect(events).toEqual([["tab", "layers"], ["shrink", true], ["tab", "outputs"], ["shrink", false], ["tab", "layers"]]);
  });

  it("height cap sets / clears max-height", async () => {
    const { side, root } = await panel();
    side.setHeightCap(580.4);
    expect(root.style["maxHeight"]).toBe("580px");
    side.setHeightCap(null);
    expect(root.style["maxHeight"]).toBe("");
  });
});
