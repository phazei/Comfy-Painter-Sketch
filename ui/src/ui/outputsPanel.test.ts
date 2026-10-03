/** Outputs tab (Main card, slot grid, selected region card) against a minimal fake DOM (no browser in the test environment). */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyDocument } from "../document/create";
import { MAX_BORDER_SIZE } from "../document/outputOptions";
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
  disabled = false;
  value = "";
  type = "";
  step = "";
  min = "";
  max = "";
  spellcheck = false;
  maxLength = 0;
  readonly attributes = new Map<string, string>();
  readonly style = { backgroundColor: "", setProperty: () => {}, removeProperty: () => {} };
  readonly classes = new Set<string>();
  readonly classList = {
    add: (name: string) => this.classes.add(name),
    remove: (name: string) => this.classes.delete(name),
    toggle: (name: string, on: boolean) => (on ? this.classes.add(name) : this.classes.delete(name)),
    contains: (name: string) => this.classes.has(name),
  };
  get valueAsNumber(): number {
    return Number(this.value);
  }
  append(...items: FakeElement[]): void {
    for (const item of items) {
      item.remove();
      item.parent = this;
      this.children.push(item);
    }
  }
  get parentElement(): FakeElement | null {
    return this.parent;
  }
  after(item: FakeElement): void {
    const parent = this.parent;
    if (!parent) return;
    item.remove();
    item.parent = parent;
    parent.children.splice(parent.children.indexOf(this) + 1, 0, item);
  }
  prepend(item: FakeElement): void {
    item.remove();
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
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
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
  /** Own classes (className string and classList). */
  has(name: string): boolean {
    return this.className.split(" ").includes(name) || this.classes.has(name);
  }
  /** Depth-first search by class. */
  find(name: string): FakeElement[] {
    const own = this.has(name) ? [this] : [];
    return [...own, ...this.children.flatMap((child) => child.find(name))];
  }
  /** Depth-first search by text. */
  findText(text: string): FakeElement[] {
    const own = this.textContent === text ? [this] : [];
    return [...own, ...this.children.flatMap((child) => child.findText(text))];
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

const classOf = (e: FakeElement) => e.className.split(" ")[0] ?? "";

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Outputs tab", () => {
  it("shows Main, the six-slot grid and the hint; no region card while Main is selected", async () => {
    const { OUTPUTS_HINT, emptySlotTitle } = await import("./outputsPanel");
    const { root } = await setup();
    expect(root.children.map(classOf)).toEqual(["cps-output-card", "cps-output-slots", "cps-outputs-hint"]);
    expect(root.children[0]!.has("cps-output-main")).toBe(true);
    expect(root.children[0]!.has("cps-selected")).toBe(true);
    expect(root.children[2]!.textContent).toBe(OUTPUTS_HINT);
    const slots = root.find("cps-output-slot");
    expect(slots.map((s) => s.textContent)).toEqual(["1", "2", "3", "4", "5", "6"]);
    expect(slots.every((s) => s.has("cps-empty") && !s.has("cps-filled"))).toBe(true);
    expect(slots[2]!.title).toBe(emptySlotTitle(3));
    expect(emptySlotTitle(3)).toBe("Add region 3 (centred) · or drag on the image");
    expect(root.find("cps-output-region")).toHaveLength(0);
  });

  it("an empty slot creates the centred region (selected, card after the grid); trash empties it (undoable)", async () => {
    const { ops, paint, root } = await setup();
    click(root.find("cps-output-slot")[2]!);
    const region = ops.inSlot(3)!;
    expect(region.rect).toEqual({ x: 25, y: 20, width: 50, height: 40 });
    expect(ops.selectedId).toBe(region.id);
    const slot = root.find("cps-output-slot")[2]!;
    expect([slot.has("cps-filled"), slot.has("cps-selected"), slot.title]).toEqual([true, true, "Region 3"]);
    expect(root.children.map(classOf)).toEqual(["cps-output-card", "cps-output-slots", "cps-output-card", "cps-outputs-hint"]);
    expect(root.children[0]!.has("cps-selected")).toBe(false);
    expect(root.find("cps-output-title").map((t) => t.textContent)).toEqual(["Main", "3 · Region 3"]);

    click(root.find("cps-output-delete")[0]!);
    expect(ops.inSlot(3)).toBeUndefined();
    expect(root.find("cps-output-region")).toHaveLength(0);
    expect(root.find("cps-output-slot")[2]!.has("cps-empty")).toBe(true);
    paint.undo();
    expect(ops.inSlot(3)).toBeDefined();
  });

  it("a filled slot selects its region without a document change; the card swaps only on a new id", async () => {
    const { s, ops, root } = await setup();
    const a = ops.addDefault(1)!;
    const b = ops.addDefault(4)!;
    const cardB = root.find("cps-output-region")[0]!;
    const changes = vi.fn();
    s.events.on("change", changes);
    click(root.find("cps-output-slot")[0]!);
    expect(ops.selectedId).toBe(a);
    expect(changes).not.toHaveBeenCalled();
    const cardA = root.find("cps-output-region")[0]!;
    expect(cardA).not.toBe(cardB);
    expect(root.find("cps-output-region")).toHaveLength(1);
    expect(root.find("cps-output-slot")[0]!.has("cps-selected")).toBe(true);
    expect(root.find("cps-output-slot")[3]!.has("cps-selected")).toBe(false);
    // Edits refresh the same card in place.
    ops.rename(a, "  face  ");
    expect(root.find("cps-output-region")[0]).toBe(cardA);
    expect(root.find("cps-output-title")[1]!.textContent).toBe("1 · face");
    expect(root.find("cps-output-slot")[0]!.title).toBe("face");
    ops.select(null);
    expect(root.find("cps-output-region")).toHaveLength(0);
    expect(root.find("cps-output-main")[0]!.has("cps-selected")).toBe(true);
    void b;
  });

  it("options: segmented mode + Alpha on line 1; line 2 only for Fill / Crop / Border", async () => {
    const { ops, root } = await setup();
    const options = root.find("cps-output-options")[0]!;
    const [line1, line2] = options.children;
    expect(line1!.children.map(classOf)).toEqual(["cps-segmented", "cps-output-pill"]);
    const segments = line1!.children[0]!.children;
    expect(segments.map((b) => b.textContent)).toEqual(["None", "Fill", "Crop", "Border"]);
    expect(segments.map((b) => b.title)).toEqual(["None", "Fill mask", "Crop to mask", "Add border"]);
    expect(segments[0]!.has("cps-active")).toBe(true);
    expect(line2!.hidden).toBe(true);

    click(segments[2]!);
    expect(ops.options(null).applyMask).toBe("crop");
    expect(segments[2]!.has("cps-active") && !segments[0]!.has("cps-active")).toBe(true);
    const shown = () => line2!.children.filter((c) => !c.hidden).map((c) => c.textContent || classOf(c));
    expect(line2!.hidden).toBe(false);
    expect(shown()).toEqual(["Padding", "cps-stepper"]);

    ops.setOptions(null, { applyMask: "border" });
    expect(shown()).toEqual(["cps-stepper", "cps-output-swatch", "cps-output-spacer", "Mask border"]);
    expect(line2!.find("cps-stepper").find((st) => !st.hidden)!.title).toBe("Border width");

    ops.setOptions(null, { applyMask: "fill" });
    expect(shown()).toEqual(["Color", "cps-output-swatch"]);
    ops.setOptions(null, { applyMask: "none" });
    expect(line2!.hidden).toBe(true);
  });

  it("steppers: padding ±8 (min 0); border ±1 up to 8 then ±4, clamped; one undo step per click", async () => {
    const { s, ops, paint, root } = await setup();
    const [pad, border] = root.find("cps-stepper");
    const buttons = (stepper: FakeElement) => stepper.find("cps-stepper-button");
    ops.setOptions(null, { applyMask: "crop" });
    const depth = s.history.undoDepth;
    click(buttons(pad!)[1]!);
    click(buttons(pad!)[1]!);
    expect(ops.options(null).cropPadding).toBe(16);
    click(buttons(pad!)[0]!);
    expect(ops.options(null).cropPadding).toBe(8);
    expect(s.history.undoDepth).toBe(depth + 3);
    ops.setOptions(null, { cropPadding: 3 });
    click(buttons(pad!)[0]!);
    expect(ops.options(null).cropPadding).toBe(0);
    expect(buttons(pad!)[0]!.disabled).toBe(true);
    paint.undo();
    expect(ops.options(null).cropPadding).toBe(3);

    const { stepBorderSize, stepPadding } = await import("./outputOptionsRow");
    expect([7, 8, 9, 12].map((v) => stepBorderSize(v, 1))).toEqual([8, 12, 13, 16]);
    expect([12, 9, 8, 2, 1].map((v) => stepBorderSize(v, -1))).toEqual([8, 5, 7, 1, 1]);
    expect(stepBorderSize(MAX_BORDER_SIZE, 1)).toBe(MAX_BORDER_SIZE);
    expect(stepPadding(4, -1)).toBe(0);
    ops.setOptions(null, { applyMask: "border", borderSize: 8 });
    click(buttons(border!)[1]!);
    expect(ops.options(null).borderSize).toBe(12);
    // The value is a typeable field.
    const input = border!.find("cps-stepper-field")[0]!.children[0]!;
    expect(input.value).toBe("12");
  });

  it("Alpha pill: undoable per output, greyed and inert (value kept) while Fill", async () => {
    const { ALPHA_TITLE, ALPHA_FILL_TITLE } = await import("./outputOptionsRow");
    const { ops, paint, root } = await setup();
    const id = ops.addDefault(1)!;
    const [mainAlpha, regionAlpha] = root.find("cps-output-alpha");
    expect(mainAlpha!.title).toBe(ALPHA_TITLE);
    expect(mainAlpha!.textContent).toBe("Alpha");
    expect(mainAlpha!.has("cps-active")).toBe(false);

    click(regionAlpha!);
    expect(ops.options(id).alpha).toBe(true);
    expect(ops.options(null).alpha).toBeUndefined();
    expect(regionAlpha!.has("cps-active")).toBe(true);

    ops.setOptions(id, { applyMask: "fill" });
    expect(regionAlpha!.has("cps-disabled")).toBe(true);
    expect(regionAlpha!.has("cps-active")).toBe(false);
    expect(regionAlpha!.title).toBe(ALPHA_FILL_TITLE);
    click(regionAlpha!);
    expect(ops.options(id).alpha).toBe(true);
    expect(mainAlpha!.has("cps-disabled")).toBe(false);
    ops.setOptions(id, { applyMask: "crop" });
    expect(regionAlpha!.has("cps-disabled")).toBe(false);
    expect(regionAlpha!.has("cps-active")).toBe(true);

    paint.undo();
    paint.undo();
    expect(ops.options(id).alpha).toBe(true);
    paint.undo();
    expect(ops.options(id).alpha).toBeUndefined();
    expect(regionAlpha!.has("cps-active")).toBe(false);
    paint.redo();
    expect(regionAlpha!.has("cps-active")).toBe(true);
    click(regionAlpha!);
    expect(ops.options(id)).not.toHaveProperty("alpha");
  });

  it("Mask border pill toggles; Main header shows W × H", async () => {
    const { ops, root } = await setup();
    ops.setOptions(null, { applyMask: "border" });
    const pill = root.find("cps-output-mask-border")[0]!;
    expect(pill.has("cps-active")).toBe(true);
    click(pill);
    expect(ops.options(null).borderMask).toBe(false);
    expect(pill.has("cps-active")).toBe(false);
    expect(root.find("cps-output-size")[0]!.textContent).toBe("100 × 80");
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
