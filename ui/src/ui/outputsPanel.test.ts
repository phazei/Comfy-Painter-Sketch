/** Outputs tab slot cards against a minimal fake DOM (no browser in the test environment). */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyDocument } from "../document/create";
import type { Editor } from "../engine/editor";
import { EditorState } from "../engine/editorState";
import { FrameOps } from "../engine/frameOps";
import { PaintOps } from "../engine/paintOps";
import { RegionOps } from "../engine/regionOps";
import type { PopoverHost } from "./popover";

// ── Fake DOM ──────────────────────────────────────────────────────────────────

class FakeElement extends EventTarget {
  children: FakeElement[] = [];
  parent: FakeElement | null = null;
  className = "";
  textContent = "";
  innerHTML = "";
  title = "";
  hidden = false;
  value = "";
  type = "";
  step = "";
  min = "";
  max = "";
  spellcheck = false;
  maxLength = 0;
  readonly style = { backgroundColor: "", setProperty: () => {}, removeProperty: () => {} };
  readonly classes = new Set<string>();
  readonly classList = {
    add: (name: string) => this.classes.add(name),
    toggle: (name: string, on: boolean) => (on ? this.classes.add(name) : this.classes.delete(name)),
    contains: (name: string) => this.classes.has(name),
  };
  get valueAsNumber(): number {
    return Number(this.value);
  }
  append(...items: FakeElement[]): void {
    for (const item of items) {
      item.parent?.children.splice(item.parent.children.indexOf(item), 1);
      item.parent = this;
      this.children.push(item);
    }
  }
  prepend(item: FakeElement): void {
    item.parent = this;
    this.children.unshift(item);
  }
  replaceChildren(...items: FakeElement[]): void {
    this.children = [];
    this.append(...items);
  }
  remove(): void {
    if (!this.parent) return;
    this.parent.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = null;
  }
  setAttribute(): void {}
  focus(): void {}
  blur(): void {}
  select(): void {}
  closest(): null {
    return null;
  }
  getContext(): object {
    const values: Record<string | symbol, unknown> = { canvas: this };
    return new Proxy(values, { get: (t, k) => (k in t ? t[k] : () => undefined) });
  }
  /** Depth-first search by class. */
  find(name: string): FakeElement[] {
    const own = this.className.split(" ").includes(name) || this.classes.has(name) ? [this] : [];
    return [...own, ...this.children.flatMap((child) => child.find(name))];
  }
}

beforeEach(() => {
  vi.stubGlobal("document", { createElement: () => new FakeElement() });
  vi.stubGlobal("Element", FakeElement);
});
afterEach(() => vi.unstubAllGlobals());

async function setup() {
  const { OutputsPanel } = await import("./outputsPanel");
  const s = new EditorState(createEmptyDocument({ width: 100, height: 80 }, "panel001"), "widgets");
  const ops = new RegionOps(s);
  const paint = new PaintOps(s, new FrameOps(s));
  const editor = {
    regionOps: ops,
    events: s.events,
    get doc() {
      return s.doc;
    },
    get imageSize() {
      return s.imageSize;
    },
  } as unknown as Editor;
  const popovers = { close: () => false, closeAnchoredIn: () => {} } as unknown as PopoverHost;
  const panel = new OutputsPanel({ popovers, beforeEdit: () => {}, releaseFocus: () => {} });
  panel.setEditor(editor);
  const root = panel.element as unknown as FakeElement;
  return { s, ops, paint, root };
}

function click(element: FakeElement): void {
  element.dispatchEvent(new Event("click"));
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Outputs tab slot cards", () => {
  it("always shows Main plus six slots; empty slots are `+ Region N` rows", async () => {
    const { root } = await setup();
    expect(root.find("cps-output-main")).toHaveLength(1);
    const empty = root.find("cps-output-empty");
    expect(empty).toHaveLength(6);
    expect(empty.map((row) => row.children[1]?.textContent)).toEqual([1, 2, 3, 4, 5, 6].map((n) => `Region ${n}`));
    expect(empty.every((row) => !row.hidden)).toBe(true);
  });

  it("clicking `+ Region N` fills that slot (undoable); delete collapses it again", async () => {
    const { ops, paint, root } = await setup();
    click(root.find("cps-output-empty")[2]!);
    expect(ops.inSlot(3)).toBeDefined();
    expect(root.find("cps-output-empty")[2]!.hidden).toBe(true);
    const title = root.find("cps-output-title").map((t) => t.textContent);
    expect(title).toEqual(["Main", "3 · Region 3"]);
    click(root.find("cps-output-delete")[0]!);
    expect(ops.inSlot(3)).toBeUndefined();
    expect(root.find("cps-output-empty")[2]!.hidden).toBe(false);
    expect(root.find("cps-output-card")).toHaveLength(1);
    paint.undo();
    expect(root.find("cps-output-title")[1]!.textContent).toBe("3 · Region 3");
  });

  it("selection marks the card without a document change; cards follow renames in place", async () => {
    const { s, ops, root } = await setup();
    const id = ops.addDefault(1)!;
    const card = root.find("cps-output-card")[1]!;
    expect(card.classes.has("cps-selected")).toBe(true);
    const changes = vi.fn();
    s.events.on("change", changes);
    ops.select(null);
    expect(card.classes.has("cps-selected")).toBe(false);
    expect(root.find("cps-output-main")[0]!.classes.has("cps-selected")).toBe(true);
    expect(changes).not.toHaveBeenCalled();
    ops.rename(id, "  face  ");
    expect(root.find("cps-output-card")[1]).toBe(card);
    expect(root.find("cps-output-title")[1]!.textContent).toBe("1 · face");
  });

  it("does not re-sync on render events", async () => {
    const { s, ops, root } = await setup();
    ops.addDefault(2);
    const title = root.find("cps-output-title")[1]!;
    s.doc.regions[0]!.name = "changed behind the panel";
    s.events.emit("render", undefined);
    expect(title.textContent).toBe("2 · Region 2");
  });
});
